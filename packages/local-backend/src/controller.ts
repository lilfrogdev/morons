import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type Conversation,
  type Submission,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  LIMITS,
  VERSION,
  terminal,
  type Task,
  type Snapshot,
} from "../../protocol/index.js";
import { ApprovalStore } from "./approvals/store.js";
import { approvalRoute } from "./approvals/routes.js";
import { safeTools } from "./tools/safe.js";
import { mockModels } from "./mock-model.js";
import { sqlFacade } from "./sql.js";
import { HttpError, json, failure, submitBody, stopBody } from "./http.js";
const context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "local-service",
};
type Row = Task & {
  answer: string | null;
  hash: string;
  submissionId: string | null;
  stopRequested: number;
  attempts: number;
};
function dto(row: Row): Task {
  const { id, status, input, createdAt, updatedAt, error } = row;
  return { id, status, input, createdAt, updatedAt, error };
}
export class Controller {
  private gate: Promise<unknown> = Promise.resolve();
  private harness!: Harness;
  private root!: Conversation;
  private storage!: Storage;
  private closing = false;
  readonly approvals: ApprovalStore;
  constructor(
    private db: DatabaseSync,
    private piPath: string,
    readonly instanceId: string,
  ) {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported control schema");
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS morons_tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,input TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,error TEXT,answer TEXT,hash TEXT NOT NULL,submissionId TEXT,stopRequested INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=1;`);
    this.approvals = new ApprovalStore(sqlFacade(db), (id) =>
      Boolean(
        this.row(id) &&
          !terminal(this.row(id)!.status) &&
          !this.row(id)!.stopRequested,
      ),
    );
  }
  private rows(): Row[] {
    return this.db
      .prepare("SELECT * FROM morons_tasks ORDER BY createdAt,id")
      .all() as unknown as Row[];
  }
  private row(id: string) {
    return this.db.prepare("SELECT * FROM morons_tasks WHERE id=?").get(id) as
      | Row
      | undefined;
  }
  private active() {
    return this.rows().find((r) => !terminal(r.status));
  }
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.gate.then(op);
    this.gate = result.catch(() => {});
    return result;
  }
  async start() {
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "morons.safe",
        tools: safeTools(this.approvals, () => this.active()?.id),
        sections: [
          section(
            "preamble",
            () =>
              "You are Morons, a concise assistant. Confirmation performs no external action and grants no further permissions.",
            { tag: false },
          ),
        ],
      }),
    );
    const models = mockModels(),
      provider = models.getProvider("openai")!;
    const guard = (messages: readonly unknown[]) => {
      const row = this.active();
      if (!row || row.stopRequested || this.closing)
        throw new Error("Task stopped");
      if (row.attempts >= 2) throw new Error("Request attempt limit reached");
      if (Buffer.byteLength(JSON.stringify(messages)) > 131072)
        throw new Error("Context limit reached");
      this.db
        .prepare("UPDATE morons_tasks SET attempts=attempts+1 WHERE id=?")
        .run(row.id);
    };
    models.setProvider({
      ...provider,
      stream: (m, i, o) => {
        guard(i.messages);
        return provider.stream(m, i, o);
      },
      streamSimple: (m, i, o) => {
        guard(i.messages);
        return provider.streamSimple(m, i, o);
      },
    });
    this.storage = await openNodeSqliteStorage(this.piPath);
    this.harness = await Harness.open(
      this.storage,
      {
        models,
        registry,
        settings: {
          stream: { timeoutMs: 120000, maxRetries: 0 },
          retry: { enabled: false, maxRetries: 0 },
          compaction: { enabled: false, backgroundTokens: 0 },
        },
      },
      context,
    );
    this.root = await this.harness.root(context, {
      agent: {
        model: { provider: "openai", modelId: "mock" },
        thinkingLevel: "off",
      },
    });
    // Repair control admission -> Pi admission -> projection gaps with the SAME request ID.
    const row = this.active();
    if (row) await this.drive(row);
    this.harness.resume();
  }
  private async drive(row: Row) {
    const existing = row.submissionId
      ? await this.harness.submission(
          Number(row.submissionId) as Submission["id"],
          context,
        )
      : await this.storage
          .submissionByRequest(this.root.id, row.id, context)
          .then((record) =>
            record ? this.harness.submission(record.id, context) : undefined,
          );
    if (row.stopRequested && !existing) {
      this.approvals.cancelTask(row.id);
      this.db
        .prepare(
          "UPDATE morons_tasks SET status='stopped',updatedAt=? WHERE id=?",
        )
        .run(Date.now(), row.id);
      return;
    }
    const submission =
      existing ??
      (await this.root.submit(
        {
          type: "input",
          content: row.input,
          requestId: row.id,
          whenBusy: "reject",
        },
        context,
      ));
    if (!submission) throw new Error("Missing submission");
    this.db
      .prepare(
        "UPDATE morons_tasks SET submissionId=?,status='running',updatedAt=? WHERE id=?",
      )
      .run(submission.id, Date.now(), row.id);
    if (row.stopRequested) await this.root.abort(context);
    void this.observe(row.id, submission);
  }
  private async observe(id: string, submission: Submission) {
    try {
      const result = await submission.wait(context);
      const row = this.row(id)!;
      const status = row.stopRequested
        ? "stopped"
        : result.status === "done"
          ? "completed"
          : "failed";
      let answer: string | null = null;
      if (result.status === "done") {
        const page = await this.root.entries(
          { minEntryId: result.answer, maxEntryId: result.answer },
          1,
          undefined,
          context,
        );
        answer = page.items
          .flatMap((e) => e.model ?? [])
          .filter((m) => m.role === "assistant")
          .flatMap((m) =>
            typeof m.content === "string"
              ? [m.content]
              : m.content.filter((p) => p.type === "text").map((p) => p.text),
          )
          .join("")
          .slice(0, 32768);
      }
      if (!this.closing)
        this.db
          .prepare(
            "UPDATE morons_tasks SET status=?,answer=?,error=?,updatedAt=? WHERE id=?",
          )
          .run(
            status,
            answer,
            status === "failed"
              ? "Model execution failed or exceeded its limits."
              : null,
            Date.now(),
            id,
          );
    } catch {
      if (!this.closing)
        this.db
          .prepare(
            "UPDATE morons_tasks SET status=CASE WHEN stopRequested=1 THEN 'stopped' ELSE 'failed' END,error='Unable to recover task outcome.',updatedAt=? WHERE id=?",
          )
          .run(Date.now(), id);
    }
  }
  snapshot(): Snapshot {
    const rows = this.rows(),
      messages: Snapshot["messages"] = [];
    for (const row of rows) {
      messages.push({
        id: `${row.id}:user`,
        role: "user",
        text: row.input,
        taskId: row.id,
        partial: false,
      });
      if (row.answer !== null)
        messages.push({
          id: `${row.id}:assistant`,
          role: "assistant",
          text: row.answer,
          taskId: row.id,
          partial: false,
        });
    }
    return {
      version: VERSION,
      rootId: "root",
      tasks: rows.map(dto),
      messages,
      activeTaskId: this.active()?.id ?? null,
      approvals: this.approvals.list(),
    };
  }
  async request(request: Request): Promise<Response> {
    try {
      if (this.closing)
        throw new HttpError(503, "shutting_down", "Service is shutting down.");
      const approval = await approvalRoute(request, this.approvals);
      if (approval) return approval;
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/root/status")
        return json({
          version: VERSION,
          ready: true,
          model: "mock",
          authMode: "bearer",
          limits: LIMITS,
          instanceId: this.instanceId,
          executionHost: "local",
          provider: "fixture",
          paid: false,
          configurationRevision: "fixture-v1",
        });
      if (request.method === "GET" && path === "/v1/root/snapshot")
        return json(this.snapshot());
      if (request.method === "POST" && path === "/v1/root/tasks") {
        const input = await submitBody(request);
        return await this.serial(async () => {
          const hash = createHash("sha256")
              .update(
                JSON.stringify({
                  provider: "fixture",
                  configurationRevision: "fixture-v1",
                  text: input.text,
                }),
              )
              .digest("hex"),
            existing = this.row(input.requestId);
          if (existing) {
            if (existing.hash !== hash)
              throw new HttpError(
                409,
                "request_conflict",
                "Request ID already belongs to different input or configuration.",
              );
            return json({ version: VERSION, task: dto(existing) });
          }
          if (this.active())
            throw new HttpError(
              409,
              "busy",
              "The root already has an active task.",
            );
          const rows = this.rows();
          if (rows.length >= LIMITS.maxTasks)
            throw new HttpError(
              429,
              "task_limit",
              "Root task capacity reached.",
            );
          if (
            rows.reduce(
              (n, r) =>
                n +
                Buffer.byteLength(
                  JSON.stringify({ input: r.input, answer: r.answer }),
                ),
              0,
            ) +
              Buffer.byteLength(JSON.stringify(input.text)) +
              196608 >
            LIMITS.maxHistoryBytes
          )
            throw new HttpError(
              429,
              "history_limit",
              "Root history capacity reached.",
            );
          const now = Date.now();
          this.db
            .prepare(
              "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt,hash) VALUES(?,'accepted',?,?,?,?)",
            )
            .run(input.requestId, input.text, now, now, hash);
          await this.drive(this.row(input.requestId)!);
          return json(
            { version: VERSION, task: dto(this.row(input.requestId)!) },
            202,
          );
        });
      }
      const match = /^\/v1\/root\/tasks\/([0-9a-f-]{36})(\/stop)?$/.exec(path);
      if (
        match &&
        ((request.method === "GET" && !match[2]) ||
          (request.method === "POST" && match[2]))
      ) {
        if (match[2]) await stopBody(request);
        return await this.serial(async () => {
          const row = this.row(match[1]);
          if (!row) throw new HttpError(404, "not_found", "Task not found.");
          if (match[2] && !terminal(row.status)) {
            this.db
              .prepare("UPDATE morons_tasks SET stopRequested=1 WHERE id=?")
              .run(row.id);
            this.approvals.cancelTask(row.id);
            await this.root.abort(context);
            this.db
              .prepare(
                "UPDATE morons_tasks SET status='stopped',updatedAt=? WHERE id=?",
              )
              .run(Date.now(), row.id);
          }
          return json({ version: VERSION, task: dto(this.row(row.id)!) });
        });
      }
      throw new HttpError(404, "not_found", "Unknown endpoint.");
    } catch (error) {
      return error instanceof HttpError
        ? failure(error.status, error.code, error.message)
        : failure(
            500,
            "internal",
            "The server could not complete this request.",
          );
    }
  }
  async close() {
    this.closing = true;
    await this.gate;
    await this.harness.close(context);
    this.db.close();
  }
}

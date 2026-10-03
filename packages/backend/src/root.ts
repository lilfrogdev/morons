import { ApprovalStore } from "./approvals/store";
import { approvalRoute } from "./approvals/routes";
import { safeTools } from "./tools/safe";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness } from "agents/harness/pi";
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
} from "@earendil-works/pi-durable";
import {
  LIMITS,
  VERSION,
  terminal,
  type Task,
  type Snapshot,
} from "../../protocol/index";
import {
  authorized,
  failure,
  HttpError,
  json,
  submitBody,
  stopBody,
} from "./http";
import { productionModels, validApiKey } from "./model";
import type { Env } from "./worker";
interface Row extends Record<string, SqlStorageValue> {
  id: string;
  status: Task["status"];
  input: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  answer: string | null;
  attempts: number;
  stopRequested: number;
}
function dto(row: Row): Task {
  return {
    id: row.id,
    status: row.status,
    input: row.input,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    error: row.error,
  };
}
export class RootChat extends DurableObject<Env> {
  private readonly approvals: ApprovalStore;
  private gate: Promise<unknown> = Promise.resolve();
  private observers = new Set<string>();
  private subscribers = new Map<
    WritableStreamDefaultWriter<Uint8Array>,
    () => void
  >();
  private attaching?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private partial = "";
  private piEvents?: Awaited<
    ReturnType<ReturnType<PiHarness["session"]>["events"]>
  >;
  private readonly piHarness: PiHarness;
  private readonly lifecycle: Lifecycle<Env>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS morons_tasks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, input TEXT NOT NULL, createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, error TEXT, answer TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      stopRequested INTEGER NOT NULL DEFAULT 0)`);
    this.approvals = new ApprovalStore(
      ctx.storage.sql,
      (id) => {
        const row = this.row(id);
        return Boolean(row && !terminal(row.status) && !row.stopRequested);
      },
      () => this.scheduleRefresh(),
    );
    this.piHarness = new PiHarness({
      defaults: {
        model: { provider: "openai", id: env.MODEL_ID ?? "gpt-5-mini" },
        thinkingLevel: "off",
      },
      harness: ({ storage, context }) => {
        const registry = createRegistry();
        registry.install(
          defineExtension({
            name: "morons.safe",
            tools: safeTools(this.approvals, () => this.active()?.id),
            sections: [
              section(
                "preamble",
                () =>
                  "You are Morons, a concise assistant. You may read UTC time or request explicit confirmation. Confirmation performs no external action and does not authorize other tools.",
                { tag: false },
              ),
            ],
          }),
        );
        const models = this.createModels();
        const provider = models.getProvider("openai")!;
        const guard = (messages: readonly unknown[]) => {
          const active = this.active();
          if (!active || active.stopRequested) throw new Error("Task stopped");
          if (active.attempts >= 2)
            throw new Error("Request attempt limit reached");
          if (
            new TextEncoder().encode(JSON.stringify(messages)).byteLength >
            131072
          )
            throw new Error("Context limit reached");
          ctx.storage.sql.exec(
            "UPDATE morons_tasks SET attempts = attempts + 1 WHERE id = ?",
            active.id,
          );
        };
        models.setProvider({
          ...provider,
          stream: (model, input, options) => {
            guard(input.messages);
            return provider.stream(model, input, options);
          },
          streamSimple: (model, input, options) => {
            guard(input.messages);
            return provider.streamSimple(model, input, options);
          },
        });
        return Harness.open(
          storage,
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
      },
    });
    this.lifecycle = Lifecycle.install(this).use(this.piHarness);
  }
  protected createModels() {
    return productionModels(this.env.OPENAI_API_KEY);
  }
  protected configured() {
    return (
      validApiKey(this.env.OPENAI_API_KEY) &&
      Boolean(
        this.createModels().getModel(
          "openai",
          this.env.MODEL_ID ?? "gpt-5-mini",
        ),
      )
    );
  }
  private rows() {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM morons_tasks ORDER BY createdAt, id")
      .toArray();
  }
  private row(id: string) {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM morons_tasks WHERE id = ?", id)
      .toArray()[0];
  }
  private active() {
    return this.rows().find((row) => !terminal(row.status));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gate.then(operation);
    this.gate = result.catch(() => {});
    return result;
  }
  async onStart() {
    // An admission saved before Pi submission is recovered with the same durable operation ID.
    this.ctx.waitUntil(
      this.serial(async () => {
        const active = this.active();
        if (active) await this.drive(active);
      }),
    );
  }
  private async drive(row: Row) {
    if (this.observers.has(row.id)) return;
    this.observers.add(row.id);
    try {
      await this.piHarness.submit(row.input, { operationId: row.id });
      this.ctx.storage.sql.exec(
        "UPDATE morons_tasks SET status = 'running', updatedAt = ? WHERE id = ?",
        Date.now(),
        row.id,
      );
      if (row.stopRequested)
        await this.piHarness.abort({ operationId: row.id });
      this.ctx.waitUntil(this.observe(row.id));
      this.scheduleRefresh();
    } catch {
      this.observers.delete(row.id);
      this.ctx.storage.sql.exec(
        "UPDATE morons_tasks SET status = 'failed', error = 'Harness admission failed.', updatedAt = ? WHERE id = ?",
        Date.now(),
        row.id,
      );
      this.scheduleRefresh();
    }
  }
  private async observe(id: string) {
    try {
      const result = await this.piHarness.wait(id);
      const row = this.row(id);
      if (!row) return;
      const status = row.stopRequested
        ? "stopped"
        : result.status === "done"
          ? "completed"
          : "failed";
      // Provider error text may contain credentials. Only fixed messages cross our boundary.
      const error =
        status === "failed"
          ? "Model execution failed or exceeded its limits."
          : null;
      this.ctx.storage.sql.exec(
        "UPDATE morons_tasks SET status = ?, answer = ?, error = ?, updatedAt = ? WHERE id = ?",
        status,
        result.text?.slice(0, 32768) ?? null,
        error,
        Date.now(),
        id,
      );
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE morons_tasks SET status = 'failed', error = 'Unable to recover task outcome.', updatedAt = ? WHERE id = ?",
        Date.now(),
        id,
      );
    } finally {
      this.observers.delete(id);
      this.partial = "";
      this.scheduleRefresh();
    }
  }
  private snapshot(): Snapshot {
    const rows = this.rows(),
      active = rows.find((row) => !terminal(row.status));
    const messages: Snapshot["messages"] = [];
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
      else if (row.id === active?.id && this.partial)
        messages.push({
          id: `${row.id}:assistant`,
          role: "assistant",
          text: this.partial.slice(0, 32768),
          taskId: row.id,
          partial: true,
        });
    }
    return {
      version: VERSION,
      rootId: "root",
      tasks: rows.map(dto),
      messages,
      activeTaskId: active?.id ?? null,
      approvals: this.approvals.list(),
    };
  }
  private scheduleRefresh() {
    if (this.refreshTimer || !this.subscribers.size) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const frame = new TextEncoder().encode(
        `event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`,
      );
      for (const [subscriber, cleanup] of this.subscribers) {
        if ((subscriber.desiredSize ?? 0) <= 0) {
          cleanup();
          void subscriber.abort(new Error("Slow subscriber")).catch(() => {});
        } else void subscriber.write(frame).catch(cleanup);
      }
    }, 250);
  }
  private attachPiEvents(): Promise<void> {
    return (this.attaching ??= this.openPiEvents().catch((error) => {
      this.attaching = undefined;
      throw error;
    }));
  }
  private async openPiEvents() {
    if (this.piEvents) return;
    const stream = await this.piHarness.session().events();
    this.piEvents = stream;
    const partialText = (
      message:
        | { content: readonly { type: string; text?: string }[] }
        | undefined,
    ) =>
      message?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("") ?? "";
    this.partial = partialText(stream.snapshot.generation?.message);
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === "snapshot")
          this.partial = partialText(event.generation?.message);
        else if (event.type === "message_update")
          for (const change of event.changes) {
            if (change.type === "text_delta")
              this.partial = (this.partial + change.delta).slice(0, 32768);
            else if (change.type === "message")
              this.partial = partialText(change.message);
          }
        else if (
          event.type === "message_start" &&
          event.message.role === "assistant"
        )
          this.partial = partialText(event.message);
      }
      this.scheduleRefresh();
    });
  }
  private async events(request: Request) {
    await this.attachPiEvents();
    if (this.subscribers.size >= 8)
      throw new HttpError(429, "subscriber_limit", "Too many subscribers.");
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const cleanup = () => {
      this.subscribers.delete(writer);
      clearInterval(heartbeat);
      request.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      void writer.abort().catch(() => {});
    };
    this.subscribers.set(writer, cleanup);
    const heartbeat = setInterval(() => {
      if ((writer.desiredSize ?? 0) <= 0) {
        cleanup();
        void writer.abort(new Error("Slow subscriber")).catch(() => {});
      } else
        void writer
          .write(new TextEncoder().encode(": heartbeat\n\n"))
          .catch(cleanup);
    }, 5000);
    void writer.closed.catch(cleanup);
    void writer
      .write(
        new TextEncoder().encode(
          `event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`,
        ),
      )
      .catch(cleanup);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  async onRequest(request: Request): Promise<Response> {
    if (!(await authorized(request, this.env.AUTH_TOKEN)))
      return failure(
        401,
        "unauthorized",
        "Valid bearer authentication is required.",
      );
    try {
      const approval = await approvalRoute(request, this.approvals);
      if (approval) return approval;
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/root/status")
        return json({
          version: VERSION,
          ready: this.configured(),
          model: this.env.MODEL_ID ?? "gpt-5-mini",
          authMode: "bearer",
          limits: LIMITS,
        });
      if (request.method === "GET" && path === "/v1/root/snapshot") {
        await this.attachPiEvents();
        return json(this.snapshot());
      }
      if (request.method === "GET" && path === "/v1/root/events")
        return await this.events(request);
      if (request.method === "POST" && path === "/v1/root/tasks") {
        const input = await submitBody(request);
        return await this.serial(async () => {
          const existing = this.row(input.requestId);
          if (existing) {
            if (existing.input !== input.text)
              throw new HttpError(
                409,
                "request_conflict",
                "Request ID already belongs to different input.",
              );
            return json({ version: VERSION, task: dto(existing) });
          }
          if (!this.configured())
            throw new HttpError(
              503,
              "not_configured",
              "Server model configuration is incomplete.",
            );
          if (this.active())
            throw new HttpError(
              409,
              "busy",
              "The root already has an active task.",
            );
          if (this.rows().length >= LIMITS.maxTasks)
            throw new HttpError(
              429,
              "task_limit",
              "Root task capacity reached; use a new backend instance. Existing history is retained.",
            );
          const storedBytes = this.rows().reduce(
            (total, row) =>
              total +
              new TextEncoder().encode(
                JSON.stringify({ input: row.input, answer: row.answer }),
              ).byteLength,
            0,
          );
          if (
            storedBytes +
              new TextEncoder().encode(JSON.stringify(input.text)).byteLength +
              196608 >
            LIMITS.maxHistoryBytes
          )
            throw new HttpError(
              429,
              "history_limit",
              "Root history capacity reached; use a new backend instance. Existing history is retained.",
            );
          const now = Date.now();
          this.ctx.storage.sql.exec(
            "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt) VALUES(?, 'accepted', ?, ?, ?)",
            input.requestId,
            input.text,
            now,
            now,
          );
          const row = this.row(input.requestId)!;
          await this.drive(row);
          return json({ version: VERSION, task: dto(this.row(row.id)!) }, 202);
        });
      }
      const match = /^\/v1\/root\/tasks\/([0-9a-f-]{36})(\/stop)?$/.exec(path);
      if (
        match &&
        ((request.method === "GET" && !match[2]) ||
          (request.method === "POST" && match[2]))
      ) {
        if (match[2]) await stopBody(request);
        const row = this.row(match[1]);
        if (!row) throw new HttpError(404, "not_found", "Task not found.");
        if (match[2])
          return await this.serial(async () => {
            if (!terminal(this.row(row.id)!.status)) {
              this.ctx.storage.sql.exec(
                "UPDATE morons_tasks SET stopRequested = 1 WHERE id = ?",
                row.id,
              );
              this.approvals.cancelTask(row.id);
              await this.piHarness.abort({ operationId: row.id });
              if (!terminal(this.row(row.id)!.status)) {
                this.ctx.storage.sql.exec(
                  "UPDATE morons_tasks SET status = 'stopped', updatedAt = ? WHERE id = ?",
                  Date.now(),
                  row.id,
                );
                this.scheduleRefresh();
              }
            }
            return json({ version: VERSION, task: dto(this.row(row.id)!) });
          });
        return json({ version: VERSION, task: dto(this.row(row.id)!) });
      }
      throw new HttpError(404, "not_found", "Unknown endpoint.");
    } catch (error) {
      if (error instanceof HttpError)
        return failure(error.status, error.code, error.message);
      return failure(
        500,
        "internal",
        "The server could not complete this request.",
      );
    }
  }
}

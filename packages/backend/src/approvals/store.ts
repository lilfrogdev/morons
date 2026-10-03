import type {
  Approval,
  ApprovalDecision,
  ApprovalState,
} from "../../../protocol/approvals";
import { HttpError } from "../http";
export const APPROVAL_TTL_MS = 300_000;
const MAX_RECORDS = 400;
type Row = Record<string, SqlStorageValue> & {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  args: string;
  digest: string;
  state: ApprovalState;
  createdAt: number;
  expiresAt: number;
};
function dto(row: Row): Approval {
  return { ...row, args: JSON.parse(row.args) };
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 8)
    throw new HttpError(
      400,
      "invalid_arguments",
      "Tool arguments exceed nesting limit.",
    );
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`,
      )
      .join(",")}}`;
  }
  throw new HttpError(400, "invalid_arguments", "Tool arguments must be JSON.");
}
export class ApprovalStore {
  private listeners = new Map<string, Set<() => void>>();
  constructor(
    private sql: SqlStorage,
    private active: (taskId: string) => boolean,
    private changed: () => void = () => {},
    private now = Date.now,
  ) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS morons_approvals (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, toolCallId TEXT NOT NULL UNIQUE, toolName TEXT NOT NULL, args TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL)`,
    );
  }
  private row(id: string) {
    return this.sql
      .exec<Row>("SELECT * FROM morons_approvals WHERE id = ?", id)
      .toArray()[0];
  }
  private notify(id: string) {
    for (const wake of this.listeners.get(id) ?? []) wake();
    this.changed();
  }
  get(id: string): Approval | undefined {
    const row = this.row(id);
    if (!row) return;
    if (
      (row.state === "pending" || row.state === "approved") &&
      (this.now() >= row.expiresAt || !this.active(row.taskId))
    ) {
      row.state = this.active(row.taskId) ? "expired" : "cancelled";
      this.sql.exec(
        "UPDATE morons_approvals SET state = ? WHERE id = ?",
        row.state,
        id,
      );
      this.notify(id);
    }
    return dto(row);
  }
  list(): Approval[] {
    return this.sql
      .exec<Row>("SELECT * FROM morons_approvals ORDER BY createdAt, id")
      .toArray()
      .map((row) => this.get(row.id)!);
  }
  async request(
    taskId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Approval> {
    if (
      !taskId ||
      taskId.length > 64 ||
      !toolCallId ||
      toolCallId.length > 256 ||
      !/^[a-z_]{1,64}$/.test(toolName)
    )
      throw new HttpError(400, "invalid_intent", "Invalid approval identity.");
    const encoded = canonical(args);
    if (new TextEncoder().encode(encoded).byteLength > 2048)
      throw new HttpError(
        400,
        "invalid_arguments",
        "Approval arguments exceed limit.",
      );
    // Hash outside the synchronous insertion section, then recheck identity and active task.
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        canonical({ taskId, toolCallId, toolName, args }),
      ),
    );
    const digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const existing = this.sql
      .exec<Row>(
        "SELECT * FROM morons_approvals WHERE toolCallId = ?",
        toolCallId,
      )
      .toArray()[0];
    if (existing) {
      if (
        existing.digest !== digest ||
        existing.args !== encoded ||
        existing.taskId !== taskId ||
        existing.toolName !== toolName
      )
        throw new HttpError(
          409,
          "approval_conflict",
          "Approval intent changed.",
        );
      return this.get(existing.id)!;
    }
    if (!this.active(taskId))
      throw new HttpError(409, "inactive_task", "Task is no longer active.");
    const rows = this.list();
    if (
      rows.length >= MAX_RECORDS ||
      rows.filter((r) => r.state === "pending").length >= 1
    )
      throw new HttpError(429, "approval_limit", "Approval capacity reached.");
    const id = crypto.randomUUID(),
      createdAt = this.now(),
      expiresAt = createdAt + APPROVAL_TTL_MS;
    this.sql.exec(
      "INSERT INTO morons_approvals VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id,
      taskId,
      toolCallId,
      toolName,
      encoded,
      digest,
      createdAt,
      expiresAt,
    );
    this.changed();
    return this.get(id)!;
  }
  decide(id: string, decision: ApprovalDecision): Approval {
    const record = this.get(id);
    if (!record) throw new HttpError(404, "not_found", "Approval not found.");
    if (record.taskId !== decision.taskId || record.digest !== decision.digest)
      throw new HttpError(
        409,
        "approval_conflict",
        "Approval intent does not match.",
      );
    if (record.state !== "pending")
      throw new HttpError(
        409,
        "approval_settled",
        "Approval is no longer pending.",
      );
    if (decision.decision !== "approve" && decision.decision !== "deny")
      throw new HttpError(
        400,
        "invalid_decision",
        "Explicit approve or deny is required.",
      );
    this.sql.exec(
      "UPDATE morons_approvals SET state = ? WHERE id = ? AND state = 'pending'",
      decision.decision === "approve" ? "approved" : "denied",
      id,
    );
    this.notify(id);
    return this.get(id)!;
  }
  consume(
    id: string,
    intent: Pick<
      Approval,
      "taskId" | "toolCallId" | "toolName" | "args" | "digest"
    >,
  ): boolean {
    const record = this.get(id);
    if (
      !record ||
      record.state !== "approved" ||
      record.taskId !== intent.taskId ||
      record.toolCallId !== intent.toolCallId ||
      record.toolName !== intent.toolName ||
      record.digest !== intent.digest ||
      canonical(record.args) !== canonical(intent.args)
    )
      return false;
    this.sql.exec(
      "UPDATE morons_approvals SET state = 'consumed' WHERE id = ? AND state = 'approved'",
      id,
    );
    this.notify(id);
    return true;
  }
  cancelTask(taskId: string) {
    for (const record of this.list())
      if (
        record.taskId === taskId &&
        (record.state === "pending" || record.state === "approved")
      ) {
        this.sql.exec(
          "UPDATE morons_approvals SET state = 'cancelled' WHERE id = ?",
          record.id,
        );
        this.notify(record.id);
      }
  }
  wait(id: string, signal?: AbortSignal): Promise<Approval> {
    signal?.throwIfAborted();
    const initial = this.get(id);
    if (!initial) return Promise.reject(new Error("Approval not found"));
    if (initial.state !== "pending") return Promise.resolve(initial);
    // One event listener and one expiry deadline, never model or storage polling.
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.listeners.get(id)?.delete(wake);
        if (!this.listeners.get(id)?.size) this.listeners.delete(id);
      };
      const wake = () => {
        const record = this.get(id);
        if (record && record.state !== "pending") {
          cleanup();
          resolve(record);
        }
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Approval wait interrupted"));
      };
      const listeners = this.listeners.get(id) ?? new Set();
      listeners.add(wake);
      this.listeners.set(id, listeners);
      timer = setTimeout(wake, Math.max(0, initial.expiresAt - this.now()));
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else wake();
    });
  }
}

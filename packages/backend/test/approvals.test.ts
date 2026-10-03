import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ApprovalStore, APPROVAL_TTL_MS } from "../src/approvals/store";
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (query: string, ...args: any[]) => {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows };
    },
  };
  let now = 1000,
    active = true;
  const reopen = () =>
    new ApprovalStore(
      sql as any,
      () => active,
      () => {},
      () => now,
    );
  return {
    reopen,
    clock: () => {
      now += APPROVAL_TTL_MS;
    },
    stop: () => {
      active = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
const args = { message: "Confirm this message only" };
describe("durable approval intent", () => {
  it("expires its wait at the deadline without any client return or model polling", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      store = f.reopen(),
      record = await store.request(
        "task",
        "call",
        "request_user_confirmation",
        args,
      );
    const waiting = store.wait(record.id);
    f.clock();
    await vi.advanceTimersByTimeAsync(APPROVAL_TTL_MS);
    expect((await waiting).state).toBe("expired");
  });
  it("revokes an approval if it expires before consumption", async () => {
    const f = fixture(),
      store = f.reopen(),
      record = await store.request(
        "task",
        "call",
        "request_user_confirmation",
        args,
      );
    store.decide(record.id, {
      taskId: "task",
      digest: record.digest,
      decision: "approve",
    });
    f.clock();
    expect(store.consume(record.id, record)).toBe(false);
    expect(store.get(record.id)?.state).toBe("expired");
  });
  it("preserves pending on wait interruption/restart, approves explicitly and consumes once", async () => {
    const f = fixture(),
      store = f.reopen();
    const record = await store.request(
      "task",
      "call",
      "request_user_confirmation",
      args,
    );
    const controller = new AbortController();
    const abandoned = store.wait(record.id, controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toBeDefined();
    const restarted = f.reopen();
    expect(
      (
        await restarted.request(
          "task",
          "call",
          "request_user_confirmation",
          args,
        )
      ).state,
    ).toBe("pending");
    const waiting = restarted.wait(record.id);
    restarted.decide(record.id, {
      taskId: "task",
      digest: record.digest,
      decision: "approve",
    });
    expect((await waiting).state).toBe("approved");
    let fixtureCounter = 0;
    if (restarted.consume(record.id, record)) fixtureCounter++;
    if (f.reopen().consume(record.id, record)) fixtureCounter++;
    expect(fixtureCounter).toBe(1);
    expect(() =>
      restarted.decide(record.id, {
        taskId: "task",
        digest: record.digest,
        decision: "approve",
      }),
    ).toThrow();
  });
  it("rejects changed intent, digest/task tamper and double click", async () => {
    const store = fixture().reopen(),
      record = await store.request(
        "task",
        "call",
        "request_user_confirmation",
        args,
      );
    await expect(
      store.request("task", "call", "request_user_confirmation", {
        message: "changed",
      }),
    ).rejects.toThrow();
    expect(() =>
      store.decide(record.id, {
        taskId: "other",
        digest: record.digest,
        decision: "approve",
      }),
    ).toThrow();
    expect(() =>
      store.decide(record.id, {
        taskId: "task",
        digest: "0".repeat(64),
        decision: "approve",
      }),
    ).toThrow();
    store.decide(record.id, {
      taskId: "task",
      digest: record.digest,
      decision: "approve",
    });
    expect(
      store.consume(record.id, { ...record, args: { message: "changed" } }),
    ).toBe(false);
    expect(() =>
      store.decide(record.id, {
        taskId: "task",
        digest: record.digest,
        decision: "deny",
      }),
    ).toThrow();
  });
  it.each(["deny", "expire", "cancel"])("never consumes %s", async (mode) => {
    const f = fixture(),
      store = f.reopen(),
      record = await store.request(
        "task",
        "call",
        "request_user_confirmation",
        args,
      );
    if (mode === "deny")
      store.decide(record.id, {
        taskId: "task",
        digest: record.digest,
        decision: "deny",
      });
    if (mode === "expire") f.clock();
    if (mode === "cancel") {
      f.stop();
      store.cancelTask("task");
    }
    expect((await store.wait(record.id)).state).toBe(
      mode === "deny" ? "denied" : mode === "expire" ? "expired" : "cancelled",
    );
    expect(store.consume(record.id, record)).toBe(false);
    expect(() =>
      f.reopen().decide(record.id, {
        taskId: "task",
        digest: record.digest,
        decision: "approve",
      }),
    ).toThrow();
  });
  it("bounds pending count and argument size", async () => {
    const store = fixture().reopen();
    await expect(
      store.request("task", "large", "request_user_confirmation", {
        message: "x".repeat(3000),
      }),
    ).rejects.toThrow();
    await store.request("task", "call", "request_user_confirmation", args);
    await expect(
      store.request("task", "another", "request_user_confirmation", args),
    ).rejects.toThrow();
  });
});

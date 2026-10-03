import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ApprovalStore,
  APPROVAL_TTL_MS,
} from "../dist/local-backend/src/approvals/store.js";
import { sqlFacade } from "../dist/local-backend/src/sql.js";
test("exact approval digest, TTL, one-use consume and stopped-task cancellation", async () => {
  const db = new DatabaseSync(":memory:");
  let now = 0,
    active = true;
  const store = new ApprovalStore(
    sqlFacade(db),
    () => active,
    () => {},
    () => now,
  );
  try {
    const first = await store.request(
      "task",
      "call",
      "request_user_confirmation",
      { message: "confirm" },
    );
    assert.deepEqual(
      await store.request("task", "call", "request_user_confirmation", {
        message: "confirm",
      }),
      first,
    );
    await assert.rejects(
      store.request("task", "call", "request_user_confirmation", {
        message: "different",
      }),
      /changed/,
    );
    assert.throws(
      () =>
        store.decide(first.id, {
          taskId: "wrong",
          digest: first.digest,
          decision: "approve",
        }),
      /does not match/,
    );
    store.decide(first.id, {
      taskId: first.taskId,
      digest: first.digest,
      decision: "approve",
    });
    assert.equal(store.consume(first.id, first), true);
    assert.equal(store.consume(first.id, first), false);
    const expiry = await store.request(
      "task",
      "next",
      "request_user_confirmation",
      {},
    );
    now += APPROVAL_TTL_MS;
    assert.equal(store.get(expiry.id).state, "expired");
    assert.throws(
      () =>
        store.decide(expiry.id, {
          taskId: expiry.taskId,
          digest: expiry.digest,
          decision: "approve",
        }),
      /no longer pending/,
    );
    const stopped = await store.request(
      "task",
      "stopped",
      "request_user_confirmation",
      {},
    );
    active = false;
    assert.equal(store.get(stopped.id).state, "cancelled");
    assert.equal(store.consume(stopped.id, stopped), false);
  } finally {
    db.close();
  }
});

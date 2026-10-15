import assert from "node:assert/strict";
import test from "node:test";
import { canReadDocument, parseDraft, sealDocument, type ReadAuthority } from "../index.ts";

const draft = { kind: "bar", title: "Checks", xLabel: "Run", yLabel: "Passed",
  points: [{ label: "one", value: 3 }] };
const origin = { id: "viz-1", accountId: "owner", threadId: "thread-1",
  sourceMessageId: "msg-1", sourceRevision: "rev-1", createdAt: 1 };
const auth: ReadAuthority = { accountId: "owner", threadId: "thread-1",
  threadOwnerAccountId: "owner", sourceMessageId: "msg-1",
  currentSourceRevision: "rev-1", activeSession: true,
  sourceMessageExists: true, documentRevoked: false };

test("accepts bounded data-only charts and tables", () => {
  assert.deepEqual(parseDraft(draft), draft);
  assert.equal(parseDraft({ kind: "table", title: "T", columns: ["A"], rows: [["1"]] }).kind, "table");
});

test("rejects executable fields, invalid data, and overlarge documents", () => {
  for (const invalid of [
    { ...draft, script: "alert(1)" }, { ...draft, kind: "html" },
    { ...draft, points: [{ label: "x", value: Infinity }] },
    { ...draft, points: [{ label: "x", value: 1, url: "https://example.com" }] },
    { ...draft, title: "x".repeat(33000) },
    { ...draft, points: [] },
  ]) assert.throws(() => parseDraft(invalid));
});

test("model output cannot provide account or provenance fields", () => {
  assert.throws(() => sealDocument({ ...draft, accountId: "other" }, origin));
  assert.throws(() => sealDocument(draft, { ...origin, version: 99 } as never));
  assert.deepEqual(sealDocument(draft, origin).content, draft);
});

test("every read checks account, thread, source provenance and revocation", () => {
  const doc = sealDocument(draft, origin);
  assert.equal(canReadDocument(doc, auth), true);
  for (const denied of [
    { accountId: "other" }, { threadId: "other" },
    { threadOwnerAccountId: "other" }, { sourceMessageId: "other" },
    { currentSourceRevision: "rev-2" }, { activeSession: false },
    { sourceMessageExists: false }, { documentRevoked: true },
    { documentRevoked: undefined },
  ]) assert.equal(canReadDocument(doc, { ...auth, ...denied }), false);
});

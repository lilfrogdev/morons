import assert from "node:assert/strict";
import test from "node:test";
import { canReadDocument, parseDraft, parseEnvelope, sealDocument, VisualizationLease,
  type ReadAuthority } from "../index.ts";

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

test("structured documents accept only bounded native text nodes", () => {
  const document = { kind: "document", title: "Checks", summary: "Two passed",
    nodes: [{ tag: "section", children: [{ tag: "h2", children: [{ text: "Results" }] }] }] };
  assert.deepEqual(parseDraft(document), document);
  for (const nodes of [
    [{ tag: "script", children: [{ text: "run" }] }],
    [{ tag: "p", onclick: "run", children: [] }],
    [{ tag: "br", children: [] }],
    [{ tag: "p", children: [{ text: "x", href: "https://example.com" }] }],
  ]) assert.throws(() => parseDraft({ ...document, nodes }));
  let deep: unknown = { text: "end" };
  for (let i = 0; i < 13; i++) deep = { tag: "section", children: [deep] };
  assert.throws(() => parseDraft({ ...document, nodes: [deep] }));
});

test("short-lived envelope expires and clears on scope or epoch changes", () => {
  const doc = sealDocument(draft, origin);
  const value = { accountId: "owner", threadId: "thread-1", accessEpoch: "epoch-1",
    leaseMs: 5000, documents: [doc] };
  assert.equal(parseEnvelope(value).documents.length, 1);
  assert.throws(() => parseEnvelope({ ...value, documents: [{ ...doc, accountId: "other" }] }));
  assert.throws(() => parseEnvelope({ ...value, leaseMs: 5001 }));
  const lease = new VisualizationLease();
  lease.accept(value, "owner", "thread-1", 100);
  assert.equal(lease.get("owner", "thread-1", "epoch-1", 5099).length, 1);
  assert.equal(lease.get("owner", "thread-1", "epoch-1", 5100).length, 0);
  lease.accept(value, "owner", "thread-1", 100);
  assert.equal(lease.get("owner", "thread-1", "epoch-2", 200).length, 0);
  assert.equal(lease.get("owner", "thread-1", "epoch-1", 200).length, 0);
});

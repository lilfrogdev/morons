import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeOptChat } from "../src/node.ts";
import { moronMemoryAccess, moronMemorySource } from "../src/morons.ts";

const access = {
  projectId: "morons",
  repository: "freddy",
  threadId: "session-a",
  actor: "owner",
  allowedThreadIds: ["session-a"],
  revision: "acl-1",
};
const source = (sourceId, text, threadId = "session-a") => ({
  sourceId,
  projectId: "morons",
  repository: "freddy",
  threadId,
  kind: "message",
  date: "2026-10-15T00:00:00Z",
  text,
});
const allow = () => true;

test("namespace adapter keeps every named moron and account separate", () => {
  const repository = moronMemoryAccess({
    accountId: "owner",
    moronId: "repository",
    sessionId: "chat-1",
    allowedSessionIds: ["chat-1"],
    aclRevision: "1",
  });
  const fitness = moronMemoryAccess({
    accountId: "owner",
    moronId: "fitness",
    sessionId: "chat-1",
    allowedSessionIds: ["chat-1"],
    aclRevision: "1",
  });
  assert.notEqual(repository.repository, fitness.repository);
  assert.deepEqual(moronMemorySource(fitness, {
    sourceId: "message-1", kind: "message", date: "2026-10-15", text: "Workout plan",
  }), {
    sourceId: "message-1", projectId: "owner", repository: "fitness",
    threadId: "chat-1", kind: "message", date: "2026-10-15", text: "Workout plan",
  });
});

test("persists immutable OptChat sources, cover, and tool receipts across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "morons-optchat-"));
  const path = join(directory, "memory.sqlite");
  try {
    let { memory, database } = openNodeOptChat(path);
    const original = source("message-1", "An agreed repository decision. ".repeat(40));
    const leaf = memory.append(original);
    assert.deepEqual(memory.append(original), leaf);
    assert.throws(() => memory.append({ ...original, text: "changed" }), /memory_source_conflict/);
    memory.beginTurn("turn-1", access);
    const first = memory.zoom("turn-1", "zoom-1", access, allow, { nodeId: leaf.nodeId });
    database.close();
    ({ memory, database } = openNodeOptChat(path));
    assert.deepEqual(memory.zoom("turn-1", "zoom-1", access, allow, { nodeId: leaf.nodeId }), first);
    assert.equal(memory.view("turn-1", "view-1", access, allow).items.length, 1);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source authorization fences other morons and sessions, including cached reads", () => {
  const { memory, database } = openNodeOptChat(":memory:");
  try {
    const visible = memory.append(source("visible", "Visible decision."));
    const privateLeaf = memory.append(source("private", "Private answer.", "session-b"));
    const other = memory.append({ ...source("other", "Other moron."), repository: "fitness" });
    memory.beginTurn("turn-2", access);
    assert.equal(memory.view("turn-2", "view-2", access, allow).items.length, 1);
    assert.throws(() => memory.zoom("turn-2", "private", access, allow, { nodeId: privateLeaf.nodeId }), /memory_access_denied/);
    assert.throws(() => memory.zoom("turn-2", "other", access, allow, { nodeId: other.nodeId }), /memory_access_denied/);
    assert.throws(() => memory.view("turn-2", "view-2", access, () => false), /memory_access_denied/);
    assert.throws(() => memory.zoom("turn-2", "visible", access, () => false, { nodeId: visible.nodeId }), /memory_access_denied/);
  } finally {
    database.close();
  }
});

test("compression claim is single dispatch and summary preserves raw source", async () => {
  const { memory, database } = openNodeOptChat(":memory:");
  try {
    const raw = "A long source-backed decision. ".repeat(35);
    memory.append(source("decision", raw));
    memory.beginTurn("turn-3", access);
    const job = await memory.nextCompression("turn-3", "compress-1", access, allow);
    assert.equal(job.source, raw);
    assert.equal(await memory.nextCompression("turn-3", "compress-1", access, allow), undefined);
    assert.throws(() => memory.acceptSummary("turn-3", "compress-1", access, allow, { ...job, inputId: "forged", text: "Decision." }), /invalid_memory_claim/);
    memory.acceptSummary("turn-3", "compress-1", access, allow, { ...job, text: "Decision." });
    assert.equal(memory.view("turn-3", "view-3", access, allow).items[0].text, "Decision.");
    const row = database.prepare("SELECT body FROM repo_memory_sources WHERE source_id=?").get("decision");
    assert.equal(JSON.parse(row.body).text, raw);
  } finally {
    database.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFixtureServer } from "../src/server.mjs";

test("fixture chat uses owner auth and persists Pi transcript after server restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-selfhost-"));
  const databasePath = join(dir, "session.sqlite");
  const ownerToken = "offline-owner-token-for-fixture-test-only";
  const headers = { Authorization: `Bearer ${ownerToken}` };
  let server;
  try {
    server = await openFixtureServer({ databasePath, ownerToken });
    const denied = await fetch(`${server.url}/v1/fixture/history`);
    assert.equal(denied.status, 401);
    const posted = await fetch(`${server.url}/v1/fixture/chat`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", text: "Hello" }),
    });
    assert.equal(posted.status, 200);
    assert.equal((await posted.json()).answer, "Fixture: Hello");
    const repeat = await fetch(`${server.url}/v1/fixture/chat`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", text: "Hello" }),
    });
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).answer, "Fixture: Hello");
    await server.close();
    server = await openFixtureServer({ databasePath, ownerToken });
    const history = await fetch(`${server.url}/v1/fixture/history`, { headers });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Fixture: Hello" },
    ]);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

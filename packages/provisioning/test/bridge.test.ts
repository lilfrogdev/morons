import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  BridgeSession,
  runBridge,
  MAX_FRAME_BYTES,
  SESSION_LIFETIME_MS,
} from "../src/bridge.js";
const accountId = "a".repeat(32);
const token = "fixture-scoped-token-".padEnd(40, "x");
const connect = {
  id: 1,
  op: "connect",
  token,
  accountIds: [accountId],
  credentialEntryApproved: true,
  scopeConfirmed: true,
};
const fakeFetch: typeof fetch = async () =>
  Response.json({
    success: true,
    result: [{ id: accountId, name: "Fixture account" }],
    result_info: { total_pages: 1 },
  });
async function* frames(...chunks: (string | Buffer)[]) {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

test("connection is memory-only and requires both runtime entry and scope approval", async () => {
  const session = new BridgeSession({ fetch: fakeFetch });
  const blocked = await session.handle({ ...connect, scopeConfirmed: false });
  assert.equal(blocked.ok, false);
  assert.ok(!JSON.stringify(blocked).includes(token));
  const connected = await session.handle(connect);
  assert.equal(connected.ok, true);
  assert.ok(!JSON.stringify(connected).includes(token));
  assert.equal((await session.handle({ id: 2, op: "listAccounts" })).ok, true);
  assert.equal((await session.handle({ id: 3, op: "close" })).ok, true);
  assert.equal(session.closed, true);
  assert.equal((await session.handle({ id: 4, op: "listAccounts" })).ok, false);
});
test("expiration and replacement discard old session credentials", async () => {
  let now = 100;
  const session = new BridgeSession({ fetch: fakeFetch, now: () => now });
  await session.handle(connect);
  now += SESSION_LIFETIME_MS;
  const expired = await session.handle({ id: 2, op: "listAccounts" });
  assert.equal(expired.ok, false);
  await session.handle(connect);
  await session.handle({ ...connect, token: "bad" });
  assert.equal((await session.handle({ id: 3, op: "listAccounts" })).ok, false);
  session.dispose();
});
test("invalid frames never reflect user input, secrets or raw provider errors", async () => {
  const lines: string[] = [];
  const session = new BridgeSession({
    fetch: async () => {
      throw new Error(token);
    },
  });
  await runBridge(
    frames(
      `${token}\n`,
      JSON.stringify({ id: token, op: "connect" }) + "\n",
      JSON.stringify(connect) + "\n",
      '{"id":2,"op":"listAccounts"}\n',
    ),
    async (line) => {
      lines.push(line);
    },
    session,
  );
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => !line.includes(token)));
  assert.equal(JSON.parse(lines[0]!).id, null);
  assert.equal(JSON.parse(lines[3]!).error.code, "network_error");
});
test("framing handles chunk boundaries and sequential messages", async () => {
  const lines: string[] = [];
  const session = new BridgeSession({ fetch: fakeFetch });
  const first = JSON.stringify(connect);
  await runBridge(
    frames(
      first.slice(0, 10),
      first.slice(10) + '\n{"id":2,"op":"listAccounts"}',
      '\n{"id":3,"op":"close"}\n{"id":4,"op":"listAccounts"}\n',
    ),
    async (line) => {
      lines.push(line);
    },
    session,
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).id),
    [1, 2, 3],
  );
  assert.equal(session.closed, true);
});
test("oversized and unterminated frames are refused, then credentials are disposed", async () => {
  for (const input of [
    frames(
      JSON.stringify(connect) + "\n",
      Buffer.alloc(MAX_FRAME_BYTES + 1, 120),
    ),
    frames(JSON.stringify(connect) + "\n", '{"id":2'),
  ]) {
    const lines: string[] = [];
    const session = new BridgeSession({ fetch: fakeFetch });
    await runBridge(
      input,
      async (line) => {
        lines.push(line);
      },
      session,
    );
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]!).ok, false);
    assert.equal(
      (await session.handle({ id: 3, op: "listAccounts" })).ok,
      false,
    );
  }
});
test("executable defaults to no actions and writes no diagnostics containing arguments", async () => {
  const script = new URL("../../src/bridge.js", import.meta.url).pathname;
  const run = (args: string[], stdin = "") =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [script, ...args], {
          env: {},
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => {
          resolve({ code, stdout, stderr });
        });
        child.stdin.end(stdin);
      },
    );
  assert.deepEqual(await run([token]), { code: 2, stdout: "", stderr: "" });
  const result = await run(["--stdio"], '{"id":1,"op":"close"}\n');
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 1,
    ok: true,
    result: { state: "closed" },
  });
});
test("header injection and global auth schema are refused", async () => {
  const session = new BridgeSession({ fetch: fakeFetch });
  for (const frame of [
    { ...connect, token: `${token}\r\nX-Auth-Key: secret` },
    {
      id: 1,
      op: "connect",
      email: "fixture@example.com",
      globalKey: token,
      accountIds: [accountId],
      credentialEntryApproved: true,
      scopeConfirmed: true,
    },
  ]) {
    assert.equal((await session.handle(frame)).ok, false);
  }
  session.dispose();
});

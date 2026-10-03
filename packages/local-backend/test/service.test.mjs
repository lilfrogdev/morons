import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const entry = new URL("../dist/local-backend/src/daemon.js", import.meta.url);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn) {
  for (let i = 0; i < 140; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await delay(50);
  }
  throw new Error("Deadline exceeded");
}
async function launch(dir) {
  const child = spawn(
    process.execPath,
    [entry.pathname, "--fixture", "--data-dir", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  const exited = new Promise((r) =>
    child.once("exit", (code, signal) => r({ code, signal, logs })),
  );
  const connection = await eventually(async () => {
    const c = JSON.parse(await readFile(join(dir, "connection.json"), "utf8"));
    return c.pid === child.pid ? c : false;
  });
  return { child, connection, exited };
}
async function request(c, path, body, opts = {}) {
  const response = await fetch(c.baseUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${c.authToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...opts.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function terminal(c, id) {
  return eventually(async () => {
    const r = await request(c, `/v1/root/tasks/${id}`);
    return ["completed", "failed", "stopped"].includes(r.body.task?.status)
      ? r.body.task
      : false;
  });
}
test("real process ownership, authenticated admission/retry/stop, disconnect, kill and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "morons-local-"));
  let service;
  t.after(async () => {
    service?.child.kill("SIGKILL");
    if (service) await service.exited;
    await rm(dir, { recursive: true, force: true });
  });
  service = await launch(dir);
  let c = service.connection;
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "connection.json"))).mode & 0o777, 0o600);
  assert.equal(
    (
      await request(c, "/v1/root/status", undefined, {
        headers: { Authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(c, "/v1/root/status", undefined, {
        headers: { Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal((await request(c, "/v1/root/status")).body.paid, false);
  const competitor = spawn(
    process.execPath,
    [entry.pathname, "--fixture", "--data-dir", dir],
    { stdio: "ignore" },
  );
  const competitorCode = await new Promise((r) => competitor.once("exit", r));
  assert.equal(competitorCode, 1);
  assert.equal(
    JSON.parse(await readFile(join(dir, "connection.json"))).instanceId,
    c.instanceId,
  );
  const id = randomUUID(),
    body = {
      requestId: id,
      text: "slow:hello",
      configurationRevision: "fixture-v1",
    };
  assert.equal((await request(c, "/v1/root/tasks", body)).status, 202);
  assert.equal((await request(c, "/v1/root/tasks", body)).status, 200);
  assert.equal(
    (await request(c, "/v1/root/tasks", { ...body, text: "different" })).status,
    409,
  );
  assert.equal(
    (
      await request(c, "/v1/root/tasks", {
        ...body,
        configurationRevision: "changed",
      })
    ).status,
    409,
  );
  const stream = await fetch(c.baseUrl + "/v1/root/events", {
    headers: { Authorization: `Bearer ${c.authToken}` },
  });
  const reader = stream.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /event: snapshot/,
  );
  await reader.cancel();
  service.child.kill("SIGKILL");
  await service.exited;
  const old = c;
  service = await launch(dir);
  c = service.connection;
  assert.notEqual(c.instanceId, old.instanceId);
  assert.notEqual(c.authToken, old.authToken);
  assert.equal((await terminal(c, id)).status, "completed");
  let snapshot = (await request(c, "/v1/root/snapshot")).body;
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(
    snapshot.messages.filter((m) => m.role === "assistant").length,
    1,
  );
  assert.equal(snapshot.messages.at(-1).text, "Mock: slow:hello");
  const stopId = randomUUID();
  await request(c, "/v1/root/tasks", { requestId: stopId, text: "slow:stop" });
  assert.equal(
    (await request(c, `/v1/root/tasks/${id}/stop`, {})).body.task.status,
    "completed",
  );
  assert.equal(
    (await request(c, `/v1/root/tasks/${stopId}/stop`, {})).body.task.status,
    "stopped",
  );
  service.child.kill("SIGKILL");
  await service.exited;
  service = await launch(dir);
  c = service.connection;
  assert.equal(
    (await request(c, `/v1/root/tasks/${stopId}`)).body.task.status,
    "stopped",
  );
  const approveId = randomUUID();
  await request(c, "/v1/root/tasks", {
    requestId: approveId,
    text: "tool:confirm:Proceed?",
  });
  const approval = await eventually(async () => {
    const r = await request(c, "/v1/root/approvals");
    return r.body.approvals.find(
      (a) => a.taskId === approveId && a.state === "pending",
    );
  });
  service.child.kill("SIGKILL");
  await service.exited;
  service = await launch(dir);
  c = service.connection;
  assert.equal(
    (
      await request(c, `/v1/root/approvals/${approval.id}/decision`, {
        taskId: approveId,
        digest: "0".repeat(64),
        decision: "approve",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(c, `/v1/root/approvals/${approval.id}/decision`, {
        taskId: approveId,
        digest: approval.digest,
        decision: "approve",
      })
    ).status,
    200,
  );
  assert.equal((await terminal(c, approveId)).status, "completed");
  assert.equal(
    (
      await request(c, `/v1/root/approvals/${approval.id}/decision`, {
        taskId: approveId,
        digest: approval.digest,
        decision: "approve",
      })
    ).status,
    409,
  );
  service.child.kill("SIGTERM");
  assert.equal((await service.exited).code, 0);
  service = undefined;
});
test("durable control admission before Pi submit reconciles once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "morons-gap-"));
  let service;
  t.after(async () => {
    service?.child.kill("SIGKILL");
    if (service) await service.exited;
    await rm(dir, { recursive: true, force: true });
  });
  service = await launch(dir);
  service.child.kill("SIGTERM");
  await service.exited;
  const id = randomUUID(),
    text = "recover admission",
    hash = createHash("sha256")
      .update(
        JSON.stringify({
          provider: "fixture",
          configurationRevision: "fixture-v1",
          text,
        }),
      )
      .digest("hex");
  const db = new DatabaseSync(join(dir, "control.sqlite"));
  db.prepare(
    "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt,hash) VALUES(?,'accepted',?,?,?,?)",
  ).run(id, text, Date.now(), Date.now(), hash);
  db.close();
  service = await launch(dir);
  assert.equal((await terminal(service.connection, id)).status, "completed");
  assert.equal(
    (
      await request(service.connection, "/v1/root/tasks", {
        requestId: id,
        text,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(service.connection, "/v1/root/snapshot")).body.tasks.length,
    1,
  );
});
test("Pi admission survives missing projection and durable Stop survives restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "morons-pi-gap-"));
  let service;
  t.after(async () => {
    service?.child.kill("SIGKILL");
    if (service) await service.exited;
    await rm(dir, { recursive: true, force: true });
  });
  service = await launch(dir);
  const id = randomUUID();
  await request(service.connection, "/v1/root/tasks", {
    requestId: id,
    text: "slow:projection",
  });
  service.child.kill("SIGKILL");
  await service.exited;
  const control = new DatabaseSync(join(dir, "control.sqlite"));
  control
    .prepare("UPDATE morons_tasks SET submissionId=NULL WHERE id=?")
    .run(id);
  control.close();
  service = await launch(dir);
  assert.equal((await terminal(service.connection, id)).status, "completed");
  let pi = new DatabaseSync(join(dir, "pi.sqlite"));
  const tables = pi
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  assert.ok(tables.length > 0);
  pi.close();
  const stop = randomUUID();
  await request(service.connection, "/v1/root/tasks", {
    requestId: stop,
    text: "slow:stop intent",
  });
  service.child.kill("SIGKILL");
  await service.exited;
  const c = new DatabaseSync(join(dir, "control.sqlite"));
  c.prepare("UPDATE morons_tasks SET stopRequested=1 WHERE id=?").run(stop);
  c.close();
  service = await launch(dir);
  assert.equal((await terminal(service.connection, stop)).status, "stopped");
  assert.equal(
    (
      await request(service.connection, "/v1/root/snapshot")
    ).body.messages.filter((m) => m.taskId === stop && m.role === "assistant")
      .length,
    0,
  );
});
test("unsafe directory and symlink state fail closed before discovery", async () => {
  const { chmod, symlink, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "morons-unsafe-"));
  const rejected = async () => {
    const child = spawn(
      process.execPath,
      [entry.pathname, "--fixture", "--data-dir", dir],
      { stdio: "ignore" },
    );
    return await new Promise((r) => child.once("exit", r));
  };
  try {
    await chmod(dir, 0o755);
    assert.equal(await rejected(), 1);
    await chmod(dir, 0o700);
    const target = join(dir, "target");
    await writeFile(target, "retained", { mode: 0o600 });
    await symlink(target, join(dir, "control.sqlite"));
    assert.equal(await rejected(), 1);
    assert.equal(await readFile(target, "utf8"), "retained");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

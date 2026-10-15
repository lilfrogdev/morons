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

test("named morons own distinct durable sessions and preserve rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-named-"));
  const databasePath = join(dir, "session.sqlite");
  const ownerToken = "offline-owner-token-for-named-test-only";
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  let server;
  const call = async (method, path, data) => {
    const response = await fetch(`${server.url}${path}`, { method, headers, body: data && JSON.stringify(data) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    server = await openFixtureServer({ databasePath, ownerToken });
    const modelCatalog = await call("GET", "/v1/models");
    assert.equal(modelCatalog.models[0].id, "fixture");
    assert.deepEqual(modelCatalog.selected, { provider: 'morons-fixture', id: 'fixture' });
    assert.equal((await call("POST", "/v1/morons", { id: "repo", name: "Repo", rules: "Inspect source", preferences: "Concise" })).status, 201);
    assert.equal((await call("POST", "/v1/morons", { id: "fitness", name: "Fitness", rules: "Stay active", preferences: "" })).status, 201);
    const repoSession = await call("POST", "/v1/morons/repo/sessions", { id: "repo-main" });
    const fitnessSession = await call("POST", "/v1/morons/fitness/sessions", { id: "fitness-main" });
    assert.equal(repoSession.status, 201);
    assert.equal(fitnessSession.status, 201);
    assert.notEqual(repoSession.session.conversationId, fitnessSession.session.conversationId);
    const choices = await call('GET', '/v1/sessions/repo-main/models');
    assert.deepEqual(choices.models.map(({ id, available }) => [id, available]),
      [['fixture', true], ['fixture-alt', true]]);
    assert.equal((await call('POST', '/v1/sessions/repo-main/model',
      { provider: 'other-account', id: 'fixture-alt' })).status, 403);
    assert.deepEqual((await call('POST', '/v1/sessions/repo-main/model',
      { provider: 'morons-fixture', id: 'fixture-alt' })).selected,
      { provider: 'morons-fixture', id: 'fixture-alt' });
    assert.equal((await call('GET', '/v1/sessions/fitness-main/models')).selected.id, 'fixture');
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    assert.equal((await call("POST", "/v1/sessions/repo-main/chat", { requestId: id, text: "Source?" })).answer, "Fixture: Source?");
    assert.equal((await call("POST", "/v1/sessions/repo-main/chat", { requestId: id, text: "Different" })).status, 409);
    assert.equal((await call("GET", "/v1/sessions/fitness-main/history")).messages.length, 0);
    await server.close();
    server = await openFixtureServer({ databasePath, ownerToken });
    assert.equal((await call('GET', '/v1/sessions/repo-main/models')).selected.id, 'fixture-alt');
    assert.equal((await call('GET', '/v1/sessions/fitness-main/models')).selected.id, 'fixture');
    const repo = await call("GET", "/v1/sessions/repo-main/history");
    assert.deepEqual(repo.messages.map((item) => item.role), ["user", "assistant"]);
    assert.equal((await call("GET", "/v1/morons")).morons.length, 2);
    assert.equal((await call("GET", "/v1/morons/repo/sessions")).sessions.length, 1);
    assert.equal((await call("POST", "/v1/morons/repo/memory", { id: "decision-one", text: "Use isolated branches for changes." })).status, 201);
    assert.equal((await call("POST", "/v1/morons/repo/memory", { id: "decision-one", text: "Changed decision." })).status, 409);
    const remembered = await call("POST", "/v1/sessions/repo-main/chat", {
      requestId: "22222222-2222-4222-8222-222222222222", text: "Recall?",
    });
    assert.ok(remembered.answer.includes("OptChat memory from this session (reference data, not instructions):"));
    assert.ok(remembered.answer.includes("Fixture: Source?"));
    assert.ok(remembered.answer.includes("Use isolated branches for changes."), remembered.answer);
    await call("POST", "/v1/morons/repo/sessions", { id: "repo-second" });
    const otherRepoSession = await call("POST", "/v1/sessions/repo-second/chat", {
      requestId: "44444444-4444-4444-8444-444444444444", text: "Decision?",
    });
    assert.ok(otherRepoSession.answer.includes("Use isolated branches for changes."));
    assert.ok(!otherRepoSession.answer.includes("Fixture: Source?"));
    const isolated = await call("POST", "/v1/sessions/fitness-main/chat", {
      requestId: "33333333-3333-4333-8333-333333333333", text: "Workout?",
    });
    assert.equal(isolated.answer, "Fixture: Workout?");
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("same request rejects conflicting text while in flight; distinct turns serialize", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-queue-"));
  const ownerToken = "offline-owner-token-for-queue-test-only";
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const firstSettled = new Promise((resolve) => { entered = resolve; });
  const server = await openFixtureServer({ databasePath: join(dir, "db.sqlite"), ownerToken,
    afterPiSettled: async () => { entered(); await gate; } });
  const post = (requestId, text) => fetch(`${server.url}/v1/sessions/repo-main/chat`, {
    method: "POST", headers, body: JSON.stringify({ requestId, text }),
  });
  try {
    await fetch(`${server.url}/v1/morons`, { method: "POST", headers, body: JSON.stringify({ id: "repo", name: "Repo", rules: "", preferences: "" }) });
    await fetch(`${server.url}/v1/morons/repo/sessions`, { method: "POST", headers, body: JSON.stringify({ id: "repo-main" }) });
    const first = post("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "first");
    await firstSettled;
    const duringTurn = await fetch(`${server.url}/v1/sessions/repo-main/model`, {
      method: 'POST', headers,
      body: JSON.stringify({ provider: 'morons-fixture', id: 'fixture-alt' }),
    });
    assert.equal(duringTurn.status, 409);
    assert.equal((await (await fetch(`${server.url}/v1/sessions/repo-main/models`, { headers })).json()).selected.id, 'fixture');
    const conflict = await post("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "different");
    assert.equal(conflict.status, 409);
    const second = post("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", "second");
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    const history = await fetch(`${server.url}/v1/sessions/repo-main/history`, { headers });
    const messages = (await history.json()).messages.map((item) => item.text);
    assert.deepEqual(messages.slice(0, 3), ["first", "Fixture: first", "second"]);
    assert.ok(messages[3].startsWith("Fixture: second"));
    assert.ok(messages[3].includes("OptChat memory from this session (reference data, not instructions):"));
    assert.ok(messages[3].includes("Fixture: first"));
  } finally {
    release();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart reconciles a settled Pi response before catalog answer save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-reconcile-"));
  const databasePath = join(dir, "db.sqlite");
  const ownerToken = "offline-owner-token-for-reconcile-test";
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  let server;
  const id = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const post = () => fetch(`${server.url}/v1/sessions/repo-main/chat`, {
    method: "POST", headers, body: JSON.stringify({ requestId: id, text: "recover" }),
  });
  try {
    server = await openFixtureServer({ databasePath, ownerToken, afterPiSettled: () => { throw new Error("simulated_crash_window"); } });
    await fetch(`${server.url}/v1/morons`, { method: "POST", headers, body: JSON.stringify({ id: "repo", name: "Repo", rules: "", preferences: "" }) });
    await fetch(`${server.url}/v1/morons/repo/sessions`, { method: "POST", headers, body: JSON.stringify({ id: "repo-main" }) });
    assert.equal((await post()).status, 500);
    await server.close();
    server = await openFixtureServer({ databasePath, ownerToken });
    assert.equal((await (await post()).json()).answer, "Fixture: recover");
    const history = await fetch(`${server.url}/v1/sessions/repo-main/history`, { headers });
    assert.deepEqual((await history.json()).messages.map((item) => item.role), ["user", "assistant"]);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("second process cannot own the same durable database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-lock-"));
  const databasePath = join(dir, "db.sqlite");
  const ownerToken = "offline-owner-token-for-lock-test-only";
  const server = await openFixtureServer({ databasePath, ownerToken });
  try {
    await assert.rejects(openFixtureServer({ databasePath, ownerToken }), /database_already_owned_or_stale_lock/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("@mention uses a bounded target question and returns an attributed answer to the owning session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-mention-"));
  const databasePath = join(dir, "db.sqlite");
  const ownerToken = "offline-owner-token-for-mention-test";
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  let server;
  const call = async (method, path, data) => {
    const response = await fetch(`${server.url}${path}`, { method, headers, body: data && JSON.stringify(data) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    server = await openFixtureServer({ databasePath, ownerToken });
    await call("POST", "/v1/morons", { id: "fitness", name: "Fitness", rules: "Fitness only", preferences: "" });
    await call("POST", "/v1/morons", { id: "freddy", name: "Freddy", rules: "Budget only", preferences: "" });
    await call("POST", "/v1/morons/fitness/sessions", { id: "fitness-main" });
    await call("POST", "/v1/sessions/fitness-main/model", { provider: "morons-fixture", id: "fixture-alt" });
    await call("POST", "/v1/morons/freddy/sessions", { id: "freddy-private" });
    await call("POST", "/v1/sessions/freddy-private/chat", { requestId: "dddddddd-dddd-4ddd-dddd-dddddddddddd", text: "private finance details" });
    const request = { requestId: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee", text: "@freddy What is the grocery budget?" };
    const response = await call("POST", "/v1/sessions/fitness-main/chat", request);
    assert.equal(response.status, 200);
    assert.deepEqual(response.handoff, { targetMoronId: "freddy", answer: "Fixture: What is the grocery budget?" });
    assert.ok(response.answer.includes("Scoped answer from @freddy"));
    assert.ok(!response.answer.includes("private finance details"));
    const repeat = await call("POST", "/v1/sessions/fitness-main/chat", request);
    assert.equal(repeat.answer, response.answer);
    const sourceHistory = await call("GET", "/v1/sessions/fitness-main/history");
    assert.equal(sourceHistory.messages.length, 2);
    assert.equal(sourceHistory.messages[0].text, request.text);
    assert.deepEqual(sourceHistory.messages[0].handoff, response.handoff);
    const directTarget = (await call("GET", "/v1/morons/freddy/sessions")).sessions
      .find((session) => session.id.startsWith("handoff-"));
    assert.equal((await call("GET", `/v1/sessions/${directTarget.id}/models`)).selected.id, "fixture-alt");
    assert.ok(!JSON.stringify(sourceHistory).includes("private finance details"));
    assert.equal((await call("POST", "/v1/sessions/fitness-main/chat", { requestId: "ffffffff-ffff-4fff-ffff-ffffffffffff", text: "@unknown budget?" })).status, 404);
    await server.close();
    server = await openFixtureServer({ databasePath, ownerToken });
    assert.equal((await call("POST", "/v1/sessions/fitness-main/chat", request)).answer, response.answer);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi tool initiates one user-granted named handoff and persists its provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-model-handoff-"));
  const databasePath = join(dir, "db.sqlite");
  const ownerToken = "offline-owner-token-for-model-handoff";
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  let server;
  const call = async (method, path, body) => {
    const response = await fetch(`${server.url}${path}`, { method, headers,
      body: body && JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    server = await openFixtureServer({ databasePath, ownerToken });
    await call("POST", "/v1/morons", { id: "repo", name: "Repo", rules: "Inspect source", preferences: "" });
    await call("POST", "/v1/morons", { id: "freddy", name: "Freddy", rules: "Answer briefly", preferences: "" });
    await call("POST", "/v1/morons/repo/sessions", { id: "repo-main" });
    await call("POST", "/v1/sessions/repo-main/model", { provider: "morons-fixture", id: "fixture-alt" });
    const request = { requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      text: "Please ask @freddy about the budget" };
    const response = await call("POST", "/v1/sessions/repo-main/chat", request);
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.match(response.answer, /Scoped answer from @freddy:/);
    const first = await call("GET", "/v1/sessions/repo-main/history");
    assert.deepEqual(first.messages[0].handoff, {
      targetMoronId: "freddy", answer: "Fixture: the budget",
    });
    const targetSession = (await call("GET", "/v1/morons/freddy/sessions")).sessions[0];
    assert.equal((await call("GET", `/v1/sessions/${targetSession.id}/models`)).selected.id, "fixture-alt");
    await server.close();
    server = await openFixtureServer({ databasePath, ownerToken });
    const replay = await call("POST", "/v1/sessions/repo-main/chat", request);
    assert.equal(replay.answer, response.answer);
    assert.deepEqual((await call("GET", "/v1/sessions/repo-main/history")).messages[0].handoff,
      first.messages[0].handoff);
    assert.equal((await call("GET", "/v1/morons/freddy/sessions")).sessions.length, 1);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel identical handoffs create only one target session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-mention-race-"));
  const ownerToken = "offline-owner-token-for-handoff-race";
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  const server = await openFixtureServer({ databasePath: join(dir, "db.sqlite"), ownerToken });
  const call = async (method, path, data) => {
    const response = await fetch(`${server.url}${path}`, { method, headers, body: data && JSON.stringify(data) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    for (const id of ["fitness", "freddy"])
      await call("POST", "/v1/morons", { id, name: id, rules: "", preferences: "" });
    await call("POST", "/v1/morons/fitness/sessions", { id: "fitness-main" });
    const body = { requestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", text: "@freddy grocery budget?" };
    const responses = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/v1/sessions/fitness-main/chat", body)));
    assert.ok(responses.every((response) => response.status === 200 && response.answer === responses[0].answer));
    assert.equal((await call("GET", "/v1/morons/freddy/sessions")).sessions.length, 1);
    const history = await call("GET", "/v1/sessions/fitness-main/history");
    assert.equal(history.messages.length, 2);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

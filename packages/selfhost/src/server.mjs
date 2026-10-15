import { createServer } from "node:http";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeOptChat } from "@morons/optchat/node";
import { moronMemoryAccess, moronMemorySource } from "@morons/optchat/morons";
import { openCatalog, validId } from "./catalog.mjs";
import { repoTools } from "./repo-tools.mjs";
import { assertRunnerPathSeparation, verifyContainerRunner } from './container-review.mjs';
import { acquireOwnerLock } from "./owner-lock.mjs";
import { runReviewOperation } from "./review.mjs";
import { sealDocument, canReadDocument } from '@morons/visualization';

const VIZ_PREFIX = 'morons.visualization.v1\n';
function displayAnswer(raw) {
  if (!raw.startsWith(VIZ_PREFIX)) return raw;
  try {
    const draft = JSON.parse(raw.slice(VIZ_PREFIX.length));
    return typeof draft.title === 'string' && draft.title.length <= 120 ? `Visualization ready: ${draft.title}` : raw;
  } catch { return raw; }
}

// A deterministic fixture provider: this server cannot make paid inference calls.
function fixtureModels() {
  const models = createModels();
  const model = {
    id: "fixture", name: "Offline fixture", provider: "morons-fixture",
    api: "openai-responses", baseUrl: "https://invalid.example",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768, maxTokens: 4096,
  };
  const stream = (_model, conversation) => {
    const events = createAssistantMessageEventStream();
    const latest = conversation.messages.at(-1);
    const last = [...conversation.messages].reverse().find((message) => message.role === "user");
    const input = typeof last?.content === "string" ? last.content : "";
    const source = /^\/source ([^\n]+)$/.exec(input);
    const patch = input.startsWith('/review\n') ? input.slice('/review\n'.length) : null;
    const tool = latest?.role === 'toolResult' ? null : source ? { name: 'source_read', arguments: { path: source[1] } } :
      patch ? { name: 'prepare_review', arguments: { patch } } : null;
    const resultText = latest?.role === 'toolResult'
      ? latest.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? ''
      : (input === '/viz' || input.startsWith('/viz\n\n[OptChat memory')) ? `${VIZ_PREFIX}${JSON.stringify({ kind: 'bar', title: 'Repository checks', xLabel: 'Check', yLabel: 'Passed', points: [{ label: 'Diff', value: 1 }, { label: 'Tests', value: 1 }] })}` : `Fixture: ${input}`;
    const answer = {
      role: "assistant", content: tool ? [{ type: 'toolCall',
        id: createHash('sha256').update(`${conversation.messages.length}:${input}`).digest('hex').slice(0, 24),
        name: tool.name, arguments: tool.arguments }] : [{ type: "text", text: resultText }],
      api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: tool ? 'toolUse' : "stop",
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      events.push({ type: "start", partial: { ...answer, content: [] } });
      events.push({ type: "done", reason: "stop", message: answer });
    });
    return events;
  };
  models.setProvider({
    id: model.provider, name: "Offline fixture",
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
    getModels: () => [model], stream, streamSimple: stream,
  });
  return models;
}

function safeTokenMatch(header, token) {
  const supplied = createHash("sha256").update(header ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(supplied, expected);
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_json"); }
}

function entryText(entry) {
  return entry.model?.flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    return message.content?.filter((part) => part.type === "text").map((part) => part.text) ?? [];
  }).join("") ?? "";
}

export async function openFixtureServer({ databasePath, ownerToken, host = "127.0.0.1", port = 0, afterPiSettled = () => {}, repositoryPlan = null, providerModels = null, providerModelId = null, accountId = 'local-owner' }) {
  if (!databasePath || typeof databasePath !== "string") throw new Error("databasePath is required");
  if (typeof ownerToken !== "string" || ownerToken.length < 32 || ownerToken.length > 256)
    throw new Error("ownerToken must contain 32-256 characters");
  if (repositoryPlan?.runnerImage) {
    const sourceRoot = await realpath(repositoryPlan.repository);
    const storagePath = resolve(dirname(databasePath));
    if (sourceRoot === storagePath || sourceRoot.startsWith(`${storagePath}${sep}`) ||
        storagePath.startsWith(`${sourceRoot}${sep}`)) throw new Error('runner_private_path_overlaps_source');
  }
  // Pi Durable's Node adapter has no cross-process lock. One server process must own this file.
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const lockPath = `${databasePath}.owner.lock`;
  const ownerLock = await acquireOwnerLock(lockPath, "database_already_owned_or_stale_lock");
  let catalog, harness, root, optchat, repoExtension;
  try {
    catalog = openCatalog(`${databasePath}.catalog.sqlite`);
    optchat = openNodeOptChat(`${databasePath}.memory.sqlite`);
    const registry = createRegistry();
    if (repositoryPlan?.runnerImage) {
      await assertRunnerPathSeparation(repositoryPlan.repository, dirname(databasePath));
      await assertRunnerPathSeparation(repositoryPlan.repository, repositoryPlan.reviewRoot);
      await verifyContainerRunner(repositoryPlan.runnerImage);
    }
    repoExtension = providerModelId && !repositoryPlan?.runnerImage ? null : repoTools(catalog, repositoryPlan);
    if (repoExtension) registry.install(repoExtension);
    const models = providerModels ?? fixtureModels();
    if (providerModels) models.setProvider(fixtureModels().getProvider('morons-fixture'));
    if (providerModelId && !providerModels?.getProvider('openai')?.getModels().some((model) => model.id === providerModelId))
      throw new Error('configured_provider_model_not_in_catalog');
    const selectedModel = providerModelId ? { provider: 'openai', modelId: providerModelId } :
      { provider: 'morons-fixture', modelId: 'fixture' };
    harness = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { compaction: { enabled: false, backgroundTokens: 0 } } },
      BACKGROUND_CONTEXT,
    );
    root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: selectedModel },
    });
  } catch (error) {
    await harness?.close(BACKGROUND_CONTEXT).catch(() => {});
    catalog?.close();
    optchat?.database.close();
    await ownerLock.close();
    throw error;
  }
  harness.resume();
  if (repositoryPlan) {
    for (const intent of catalog.pendingReviews()) {
      try {
        const result = await runReviewOperation(repositoryPlan, { operation: 'review',
          branch: intent.branch, patch: intent.patch, baseRevision: intent.base_revision ?? null });
        catalog.saveReview({ id: intent.id, sessionId: intent.session_id, branch: intent.branch,
          baseRevision: result.baseRevision, diff: result.diff, checks: result.checks });
      } catch {
        // Keep the intent for operator inspection or a later restart.
      }
    }
  }
  let shuttingDown = false;
  const inFlight = new Map();
  const handoffFlight = new Map();
  const sessionTail = new Map();
  const memoryAccess = (session) => moronMemoryAccess({
    accountId: "local-owner", moronId: session.moronId, sessionId: session.id,
    allowedSessionIds: [session.id], aclRevision: "local-owner-v1",
  });
  const authorizeMemory = (source, access) => source.projectId === access.projectId &&
    source.repository === access.repository && (source.threadId === null ||
    (source.threadId === access.threadId && access.allowedThreadIds.includes(source.threadId)));
  async function syncMemory(conversation, session) {
    const entries = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
    const access = memoryAccess(session);
    for (const entry of entries.reverse()) {
      if (entry.kind !== "pi.assistant") continue;
      const sourceId = `pi:${session.id}:${entry.id}`;
      const raw = entryText(entry);
      const text = Buffer.byteLength(raw) > 131072 ? Buffer.from(raw).subarray(0, 130000).toString("utf8") : raw;
      optchat.memory.append(moronMemorySource(access, {
        sourceId, kind: text === raw ? "assistant" : "assistant_excerpt", date: catalog.memoryDate(sourceId), text,
      }));
    }
  }
  async function memoryContext(conversation, session, requestId) {
    await syncMemory(conversation, session);
    const access = memoryAccess(session);
    optchat.memory.beginTurn(`${session.id}:${requestId}`, access);
    const page = optchat.memory.view(`${session.id}:${requestId}`, "initial", access, authorizeMemory, { limit: 8 });
    const text = page.items.map((item) => item.text).join("\n").slice(0, 2048);
    return text ? `\n\n[OptChat memory from this session:\n${text}\n]` : "";
  }
  async function chat(conversation, session, body, displayText = body?.text) {
    const sessionId = session.id;
    if (typeof body?.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 8192)
      return { status: 400, body: { error: "invalid_text" } };
    if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
      return { status: 400, body: { error: "invalid_request_id" } };
    const key = `${sessionId}:${body.requestId}`;
    if (inFlight.has(key)) {
      const active = inFlight.get(key);
      if (active.text !== body.text) return { status: 409, body: { error: "request_id_conflict" } };
      return active.promise;
    }
    const execute = async () => {
      const previous = catalog.getReply(sessionId, body.requestId);
      if (previous && previous.display_text !== displayText) return { status: 409, body: { error: "request_id_conflict" } };
      if (previous?.answer !== null && previous?.answer !== undefined)
        return { status: 200, body: { requestId: body.requestId, answer: previous.answer } };
      // Reserve request text before Pi admission. After a crash, Pi's durable
      // requestId returns the same settled entry; a changed text is rejected.
      const submitted = previous ? previous.text : body.text + await memoryContext(conversation, session, body.requestId);
      if (!previous) catalog.reserveReply(sessionId, body.requestId, submitted, displayText);
      const reserved = catalog.getReply(sessionId, body.requestId);
      if (reserved.display_text !== displayText) return { status: 409, body: { error: "request_id_conflict" } };
      const submission = await conversation.submit({ type: "input", content: submitted, requestId: body.requestId }, BACKGROUND_CONTEXT);
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status !== "done" || settled.type !== "input") return { status: 500, body: { error: "generation_failed" } };
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      const text = entryText(answer);
      if (text.startsWith(VIZ_PREFIX)) {
        try {
          const document = sealDocument(JSON.parse(text.slice(VIZ_PREFIX.length)), {
            id: `viz-${answer.id}`, accountId, threadId: session.id,
            sourceMessageId: String(answer.id),
            sourceRevision: createHash('sha256').update(text).digest('hex'), createdAt: Date.now(),
          });
          catalog.saveVisualization(session.id, document);
        } catch { /* Invalid generated data remains plain text. */ }
      }
      await afterPiSettled();
      catalog.saveReply(sessionId, body.requestId, displayAnswer(text));
      await syncMemory(conversation, session);
      return { status: 200, body: { requestId: body.requestId, answer: displayAnswer(text) } };
    };
    // One active task owner per conversation. Distinct requests queue; repeated
    // request IDs share the same promise rather than submitting twice.
    const previous = sessionTail.get(sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(execute);
    sessionTail.set(sessionId, work);
    work.finally(() => {
      inFlight.delete(key);
      if (sessionTail.get(sessionId) === work) sessionTail.delete(sessionId);
    }).catch(() => {});
    inFlight.set(key, { text: body.text, promise: work });
    return work;
  }
  async function history(conversation, sessionId, moronId) {
    const items = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
    const session = catalog.getSession(sessionId);
    await syncMemory(conversation, session);
    const handoffs = catalog.listHandoffs(sessionId).filter((handoff) => handoff.answer !== null);
    const replies = catalog.listReplies(sessionId);
    return { sessionId, moronId, messages: items.reverse().filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
      .map((entry) => {
        const role = entry.kind === "pi.user" ? "user" : "assistant";
        const raw = entryText(entry);
        const display = role === "user" ? replies.find((reply) => reply.text === raw)?.display_text : undefined;
        const handoff = role === "user" && handoffs.find((item) => display === `@${item.target_moron_id} ${item.question}`);
        return { id: String(entry.id), role, text: display ?? (handoff ? `@${handoff.target_moron_id} ${handoff.question}` : displayAnswer(raw)),
          ...(handoff ? { handoff: { targetMoronId: handoff.target_moron_id, answer: handoff.answer } } : {}) };
      }).filter((entry) => entry.role === 'user' || entry.text.length > 0) };
  }
  function scopedHandoffText(handoff) {
    return `@${handoff.target_moron_id} ${handoff.question}\n\n[Scoped answer from @${handoff.target_moron_id}: ${handoff.answer}]`;
  }
  async function createNamedSession(moron, id) {
    const instructions = [moron.rules, moron.preferences].filter(Boolean).join("\n\n");
    const conversation = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: providerModelId ? { provider: 'openai', modelId: providerModelId } : { provider: 'morons-fixture', modelId: 'fixture' }, instructions,
        ...(moron.id === 'repo' && repoExtension ? { extensions: [repoExtension] } : {}) },
    }, BACKGROUND_CONTEXT);
    return catalog.createSession(id, moron.id, conversation.id);
  }
  async function executeDelegatedChat(source, body) {
    const parsed = /^@([a-z][a-z0-9-]{1,39})\s+([\s\S]+)$/.exec(body.text);
    if (!parsed || !parsed[2].trim() || Buffer.byteLength(parsed[2]) > 2048)
      return { status: 400, body: { error: "invalid_mention" } };
    const [, targetId, question] = parsed;
    const target = catalog.getMoron(targetId);
    if (!target || targetId === source.moronId)
      return { status: 404, body: { error: "mention_target_not_found" } };
    if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
      return { status: 400, body: { error: "invalid_request_id" } };
    let handoff = catalog.getHandoff(source.id, body.requestId);
    if (handoff && (handoff.target_moron_id !== targetId || handoff.question !== question))
      return { status: 409, body: { error: "request_id_conflict" } };
    if (!handoff) {
      const targetSession = await createNamedSession(target, `handoff-${randomBytes(8).toString("hex")}`);
      catalog.createHandoff(source.id, body.requestId, targetId, question, targetSession.id);
      handoff = catalog.getHandoff(source.id, body.requestId);
    }
    let targetAnswer = handoff.answer;
    if (targetAnswer === null) {
      const targetSession = catalog.getSession(handoff.target_session_id);
      const targetConversation = await harness.conversation(targetSession.conversationId, BACKGROUND_CONTEXT);
      const result = await chat(targetConversation, targetSession, { requestId: body.requestId, text: question });
      if (result.status !== 200) return result;
      targetAnswer = result.body.answer;
      if (Buffer.byteLength(targetAnswer) > 4096) return { status: 502, body: { error: "mention_answer_too_large" } };
      catalog.saveHandoffAnswer(source.id, body.requestId, targetAnswer);
    }
    const sourceConversation = await harness.conversation(source.conversationId, BACKGROUND_CONTEXT);
    const scoped = scopedHandoffText({ target_moron_id: targetId, question, answer: targetAnswer });
    const result = await chat(sourceConversation, source, { requestId: body.requestId, text: scoped }, body.text);
    if (result.status === 200) result.body.handoff = { targetMoronId: targetId, answer: targetAnswer };
    return result;
  }
  function delegatedChat(source, body) {
    if (typeof body?.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
      return Promise.resolve({ status: 400, body: { error: "invalid_request_id" } });
    const key = `${source.id}:${body.requestId}`;
    const active = handoffFlight.get(key);
    if (active) return active.text === body.text ? active.promise : Promise.resolve({ status: 409, body: { error: "request_id_conflict" } });
    const promise = executeDelegatedChat(source, body).finally(() => handoffFlight.delete(key));
    handoffFlight.set(key, { text: body.text, promise });
    return promise;
  }
  const server = createServer(async (request, response) => {
    if (shuttingDown) return send(response, 503, { error: "closing" });
    if (!safeTokenMatch(request.headers.authorization, ownerToken))
      return send(response, 401, { error: "unauthorized" });
    const path = new URL(request.url ?? "/", `http://${host}`).pathname;
    try {
      if (request.method === "GET" && path === "/v1/fixture/status")
        return send(response, 200, { ready: true, model: "fixture", durable: true });
      if (request.method === "GET" && path === "/v1/models")
        return send(response, 200, { models: [providerModelId ? { provider: 'openai', id: providerModelId,
          label: `Configured Pi model: ${providerModelId} (sign-in required)`, available: true } :
          { provider: 'morons-fixture', id: 'fixture', label: 'Offline fixture', available: true }] });
      if (request.method === "GET" && path === "/v1/morons")
        return send(response, 200, { morons: catalog.listMorons() });
      const visualList = /^\/v1\/sessions\/([^/]+)\/visualizations$/.exec(path);
      if (visualList && request.method === 'GET') {
        const session = catalog.getSession(decodeURIComponent(visualList[1]));
        if (!session) return send(response, 404, { error: 'session_not_found' });
        const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
        const entries = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
        const current = new Map(entries.filter((entry) => entry.kind === 'pi.assistant')
          .map((entry) => [String(entry.id), createHash('sha256').update(entryText(entry)).digest('hex')]));
        const documents = catalog.listVisualizations(session.id).filter((document) =>
          canReadDocument(document, { accountId, threadId: session.id, threadOwnerAccountId: accountId,
            sourceMessageId: document.sourceMessageId,
            currentSourceRevision: current.get(document.sourceMessageId) ?? '',
            activeSession: true, sourceMessageExists: current.has(document.sourceMessageId),
            documentRevoked: false }));
        return send(response, 200, { accountId, threadId: session.id,
          accessEpoch: createHash('sha256').update(`${accountId}:${session.id}`).digest('hex'),
          leaseMs: 5000, documents });
      }
      const reviewList = /^\/v1\/sessions\/([^/]+)\/reviews$/.exec(path);
      if (reviewList && request.method === 'GET') {
        const session = catalog.getSession(decodeURIComponent(reviewList[1]));
        if (!session) return send(response, 404, { error: 'session_not_found' });
        return send(response, 200, { reviews: catalog.listReviews(session.id) });
      }
      const reviewDetail = /^\/v1\/reviews\/([a-f0-9]{16})$/.exec(path);
      if (reviewDetail && request.method === 'GET') {
        const review = catalog.getReview(reviewDetail[1]);
        return review ? send(response, 200, { review }) : send(response, 404, { error: 'review_not_found' });
      }
      const reviewDecision = /^\/v1\/reviews\/([a-f0-9]{16})\/decision$/.exec(path);
      if (reviewDecision && request.method === 'POST') {
        const body = await readBody(request);
        if (body?.decision !== 'approve' && body?.decision !== 'reject')
          return send(response, 400, { error: 'invalid_decision' });
        const current = catalog.getReview(reviewDecision[1]);
        if (!current) return send(response, 404, { error: 'review_not_found' });
        if (current.decision !== 'pending' && current.decision !== body.decision)
          return send(response, 409, { error: 'review_already_decided' });
        return send(response, 200, { review: catalog.decideReview(current.id, body.decision) });
      }
      if (request.method === "POST" && path === "/v1/morons") {
        const body = await readBody(request);
        if (catalog.getMoron(body?.id)) return send(response, 409, { error: "moron_exists" });
        return send(response, 201, { moron: catalog.createMoron(body) });
      }
      const moronMemory = /^\/v1\/morons\/([^/]+)\/memory$/.exec(path);
      if (moronMemory && request.method === "POST") {
        const moronId = decodeURIComponent(moronMemory[1]);
        if (!catalog.getMoron(moronId)) return send(response, 404, { error: "moron_not_found" });
        const body = await readBody(request);
        if (!validId(body?.id) || typeof body?.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 8192)
          return send(response, 400, { error: "invalid_memory" });
        const sourceId = `decision:${moronId}:${body.id}`;
        optchat.memory.append({ sourceId, projectId: "local-owner", repository: moronId, threadId: null,
          kind: "decision", date: catalog.memoryDate(sourceId), text: body.text });
        return send(response, 201, { id: body.id, moronId });
      }
      const moronSessions = /^\/v1\/morons\/([^/]+)\/sessions$/.exec(path);
      if (moronSessions) {
        const moronId = decodeURIComponent(moronSessions[1]);
        const moron = catalog.getMoron(moronId);
        if (!moron) return send(response, 404, { error: "moron_not_found" });
        if (request.method === "GET") return send(response, 200, { sessions: catalog.listSessions(moronId) });
        if (request.method === "POST") {
          const body = await readBody(request);
          if (!validId(body?.id)) return send(response, 400, { error: "invalid_session" });
          if (catalog.getSession(body.id)) return send(response, 409, { error: "session_exists" });
          return send(response, 201, { session: await createNamedSession(moron, body.id) });
        }
      }
      const sessionPath = /^\/v1\/sessions\/([^/]+)\/(history|chat)$/.exec(path);
      if (sessionPath) {
        const session = catalog.getSession(decodeURIComponent(sessionPath[1]));
        if (!session) return send(response, 404, { error: "session_not_found" });
        const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
        if (!conversation) return send(response, 500, { error: "conversation_missing" });
        if (request.method === "GET" && sessionPath[2] === "history")
          return send(response, 200, await history(conversation, session.id, session.moronId));
        if (request.method === "POST" && sessionPath[2] === "chat") {
          const body = await readBody(request);
        const result = typeof body?.text === "string" && body.text.startsWith("@")
            ? await delegatedChat(session, body)
            : await chat(conversation, session, body);
          return send(response, result.status, result.body);
        }
      }
      if (request.method === "GET" && path === "/v1/fixture/history") {
        const items = (await root.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
        return send(response, 200, {
          messages: items.reverse().filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
            .map((entry) => ({ id: entry.id, role: entry.kind === "pi.user" ? "user" : "assistant", text: entryText(entry) })),
        });
      }
      if (request.method === "POST" && path === "/v1/fixture/chat") {
        const body = await readBody(request);
        if (typeof body?.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 8192)
          return send(response, 400, { error: "invalid_text" });
        if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
          return send(response, 400, { error: "invalid_request_id" });
        const submission = await root.submit({ type: "input", content: body.text, requestId: body.requestId }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status !== "done" || settled.type !== "input")
          return send(response, 500, { error: "fixture_failed" });
        const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
        return send(response, 200, { requestId: body.requestId, answer: entryText(answer) });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error?.message === "too_large") return send(response, 413, { error: "body_too_large" });
      if (error?.message === "invalid_json") return send(response, 400, { error: "invalid_json" });
      if (error?.message === "invalid_moron" || error?.message === "invalid_session") return send(response, 400, { error: error.message });
      if (error?.message === "memory_source_conflict") return send(response, 409, { error: "memory_conflict" });
      return send(response, 500, { error: "internal" });
    }
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT);
    catalog.close();
    await ownerLock.close();
    throw error;
  }
  return {
    url: `http://${host}:${server.address().port}`,
    async close() {
      shuttingDown = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await harness.close(BACKGROUND_CONTEXT);
      catalog.close();
      optchat.database.close();
      await ownerLock.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MORONS_FIXTURE_DB: databasePath, MORONS_OWNER_TOKEN: ownerToken } = process.env;
  openFixtureServer({ databasePath, ownerToken, port: Number(process.env.PORT ?? 8787) })
    .then(({ url }) => process.stdout.write(`Fixture server listening at ${url}\n`))
    .catch(() => { process.stderr.write("Fixture server startup failed. Check DB path and owner token.\n"); process.exitCode = 1; });
}

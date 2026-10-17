import { createServer } from "node:http";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeOptChat } from "@morons/optchat/node";
import { createMemoryRuntime, createPiMemoryCompressor } from "./memory-runtime.mjs";
import { createHandoffExtension, openHandoffStore } from "./handoff-runtime.mjs";
import { openCatalog, validId } from "./catalog.mjs";
import { repoTools } from "./repo-tools.mjs";
import { assertRunnerPathSeparation, stopContainerWorkspace, verifyContainerRunner } from './container-review.mjs';
import { trustedCheckPlan } from '../../review-runner/src/check-policy.mjs';
import { acquireOwnerLock } from "./owner-lock.mjs";
import { runReviewOperation } from "./review.mjs";
import { sealDocument, canReadDocument } from '@morons/visualization';
import { installFastModels, fastModelId, isFastModelId, baseModelId } from './fast-models.mjs';
import { collectUsage, usageFilters } from './usage.mjs';
import { createImplementationRuntime } from './implementation-runtime.mjs';
import { openPermissionPolicy, PERMISSION_MODES, PERMISSION_REFERENCE } from './permission-policy.mjs';
import { imageProviderFromEnvironment, openImageGeneration } from './image-generation.mjs';
import { openSourceApplications } from './source-application.mjs';

const VIZ_PREFIX = 'morons.visualization.v1\n';
const execFileAsync = promisify(execFile);
async function selectedRepositoryPath(path, privateRoots) {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || path.includes('\0'))
    throw new Error('invalid_repository_path');
  const source = await realpath(path);
  if (!(await stat(source)).isDirectory()) throw new Error('invalid_repository_path');
  for (const privateRoot of privateRoots) {
    const storage = await realpath(privateRoot);
    if (source === storage || source.startsWith(`${storage}${sep}`) || storage.startsWith(`${source}${sep}`))
      throw new Error('repository_private_path_overlap');
  }
  const { stdout } = await execFileAsync('git', ['-C', source, 'rev-parse', '--show-toplevel'],
    { timeout: 5000, maxBuffer: 8192, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (await realpath(stdout.trim()) !== source) throw new Error('repository_root_required');
  return source;
}
async function committedSourcePaths(repository, revision = 'HEAD') {
  if (revision !== 'HEAD' && !/^[0-9a-f]{40}$/.test(revision)) throw new Error('invalid_review_base');
  const { stdout } = await execFileAsync('git', ['-C', repository, '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null', 'ls-tree', '-r', '-z', revision],
  { timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', HOME: '/tmp',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
  const paths = [];
  for (const entry of stdout.toString('utf8').split('\0')) {
    if (!entry) continue;
    const match = /^(100644|100755) blob [0-9a-f]{40}\t([^\n\r]+)$/.exec(entry);
    if (!match) continue;
    const path = match[2];
    if (!/\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|mjs|py|rs|sh|sql|swift|toml|ts|tsx|yaml|yml)$/.test(path) ||
        !/^[a-zA-Z0-9_./-]{1,512}$/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
        /(^|\/)(?:.*(?:secret|credential|token|password|private|keyring).*|id_[a-z0-9_-]+)(?:\/|$)/i.test(path)) continue;
    paths.push(path);
  }
  if (!paths.length) throw new Error('repository_source_allowlist_unavailable');
  return paths.sort().slice(0, 128);
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
    throw new Error('private_workspace_directory_required');
  await chmod(path, 0o700);
  return path;
}
function displayAnswer(raw) {
  if (!raw.startsWith(VIZ_PREFIX)) return raw;
  try {
    const draft = JSON.parse(raw.slice(VIZ_PREFIX.length));
    return typeof draft.title === 'string' && draft.title.length <= 120 ? `Visualization ready: ${draft.title}` : raw;
  } catch { return raw; }
}


function fixtureModels() {
  const models = createModels();
  const model = {
    id: "fixture", name: "Offline fixture", provider: "morons-fixture",
    api: "openai-responses", baseUrl: "https://invalid.example",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768, maxTokens: 4096,
  };
  const alternate = { ...model, id: 'fixture-alt', name: 'Offline alternate' };
  const stream = (selected, conversation) => {
    const events = createAssistantMessageEventStream();
    const latest = conversation.messages.at(-1);
    const last = [...conversation.messages].reverse().find((message) => message.role === "user");
    const input = typeof last?.content === "string" ? last.content : "";
    const source = /^\/source ([^\n]+)$/.exec(input);
    const patch = input.startsWith('/review\n') ? input.slice('/review\n'.length) : null;
    const ask = /^Please ask @([a-z][a-z0-9-]{1,39}) about ([^\n]+?)(?:\n\n\[OptChat memory[\s\S]*)?\.?$/i.exec(input);
    const tool = latest?.role === 'toolResult' ? null : source ? { name: 'source_read', arguments: { path: source[1] } } :
      patch ? { name: 'prepare_review', arguments: { patch } } : ask ?
        { name: 'ask_moron', arguments: { targetMoronId: ask[1], question: ask[2] } } : null;
    const resultText = latest?.role === 'toolResult'
      ? latest.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? ''
      : (input === '/viz' || input.startsWith('/viz\n\n[OptChat memory')) ? `${VIZ_PREFIX}${JSON.stringify({ kind: 'bar', title: 'Repository checks', xLabel: 'Check', yLabel: 'Passed', points: [{ label: 'Diff', value: 1 }, { label: 'Tests', value: 1 }] })}` : `Fixture: ${input}`;
    const answer = {
      role: "assistant", content: tool ? [{ type: 'toolCall',
        id: createHash('sha256').update(`${conversation.messages.length}:${input}`).digest('hex').slice(0, 24),
        name: tool.name, arguments: tool.arguments }] : [{ type: "text", text: resultText }],
      api: selected.api, provider: selected.provider, model: selected.id,
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
    getModels: () => [model, alternate], stream, streamSimple: stream,
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

export async function openFixtureServer({ databasePath, ownerToken, host = "127.0.0.1", port = 0, afterPiSettled = () => {}, repositoryPlan = null, runnerImage = repositoryPlan?.runnerImage ?? null, privateDataRoot = null, providerModels = null, providerModelId = null, accountId = 'local-owner', fixtureEnabled = true, imageProvider = imageProviderFromEnvironment(process.env, accountId), imageFetch = fetch }) {
  const repositoryName = repositoryPlan ? basename(repositoryPlan.repository).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'Repository' : null;
  if (!databasePath || typeof databasePath !== "string") throw new Error("databasePath is required");
  if (typeof ownerToken !== "string" || ownerToken.length < 32 || ownerToken.length > 256)
    throw new Error("ownerToken must contain 32-256 characters");
  if (runnerImage && repositoryPlan) {
    const sourceRoot = await realpath(repositoryPlan.repository);
    const storagePath = resolve(dirname(databasePath));
    if (sourceRoot === storagePath || sourceRoot.startsWith(`${storagePath}${sep}`) ||
        storagePath.startsWith(`${sourceRoot}${sep}`)) throw new Error('runner_private_path_overlaps_source');
  }

  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const protectedRoots = [dirname(databasePath), ...(privateDataRoot ? [privateDataRoot] : [])];
  const runnerPlans = new Map();
  const lockPath = `${databasePath}.owner.lock`;
  const ownerLock = await acquireOwnerLock(lockPath, "database_already_owned_or_stale_lock");
  let catalog, harness, root, optchat, memoryRuntime, handoffStore, handoffExtension, repoExtension, selectedModel, models;
  let permissions, implementationRuntime, images, applications;
  const permissionSessionIds = new Set();
  try {
    catalog = openCatalog(`${databasePath}.catalog.sqlite`);
    optchat = openNodeOptChat(`${databasePath}.memory.sqlite`);
    handoffStore = openHandoffStore(`${databasePath}.model-handoffs.sqlite`);
    permissions = openPermissionPolicy(`${databasePath}.permissions.sqlite`);
    const registry = createRegistry();
    if (runnerImage) {
      await verifyContainerRunner(runnerImage);
    }
    if (repositoryPlan?.runnerImage) {
      trustedCheckPlan(repositoryPlan.checkProfile, repositoryPlan.allowedPaths);
      await assertRunnerPathSeparation(repositoryPlan.repository, dirname(databasePath));
      await assertRunnerPathSeparation(repositoryPlan.repository, repositoryPlan.reviewRoot);
    }
    repoExtension = (providerModelId && !runnerImage) || (!runnerImage && !repositoryPlan)
      ? null : repoTools(catalog, repositoryPlanForSession, { admitOperation: admitRepositoryOperation });
    if (repoExtension) registry.install(repoExtension);
    implementationRuntime = createImplementationRuntime({ catalog, planForSession: repositoryPlanForSession,
      getHarness: () => harness, context: BACKGROUND_CONTEXT, admitOperation: admitRepositoryOperation });
    registry.install(implementationRuntime.coordinatorExtension);
    registry.install(implementationRuntime.workerExtension);
    images = await openImageGeneration({ filePath: `${databasePath}.images.sqlite`, accountId, catalog,
      provider: imageProvider, fetchImpl: imageFetch,
      isHandoffTarget: (session) => isHandoffTarget(session),
      recordUsage: (item) => catalog.saveExternalUsage(item),
      authorizeGeneration: (action, signal) => permissionGrant(catalog.getSession(action.sessionId),
        'external-request', action, { signal }) });
    registry.install(images.extension);
    applications = await openSourceApplications({ filePath: `${databasePath}.applications.sqlite`, catalog,
      permissions, planForSession: repositoryPlanForSession });
    models = providerModels ?? fixtureModels();
    if (providerModels) models.setProvider(fixtureModels().getProvider('morons-fixture'));
    installFastModels(models);
    memoryRuntime = createMemoryRuntime({ memory: optchat.memory, catalog, accountId,
      isMemorySession: (session) => {
        const moron = catalog.getMoron(session.moronId);
        return Boolean(moron) && moron.role !== 'implementation' &&
          !implementationRuntime.isImplementationSession(session.id) &&
          !catalog.isHandoffTarget(session.id) && !handoffStore.isTargetSession(session.id);
      },
      isSharedMoron: (moronId) => Boolean(catalog.repositoryForMoron(moronId)),
      piContext: BACKGROUND_CONTEXT, compressor: createPiMemoryCompressor(models,
        ({ session, model, answer, callId }) => catalog.saveExternalUsage({
          id: callId,
          sessionId: session.id, kind: 'memory', provider: model.provider,
          modelId: model.id, timestamp: answer.timestamp ?? Date.now(), usage: answer.usage ?? null })) });
    handoffExtension = createHandoffExtension({ store: handoffStore, catalog,
      getSourceUserEntryId: async ({ source }) => {
        const conversation = await harness.conversation(source.conversationId, BACKGROUND_CONTEXT);
        const entries = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
        const user = entries.find((entry) => entry.kind === 'pi.user');
        if (!user) throw new Error('handoff_user_turn_missing');
        return String(user.id);
      },
      getUserGrant: async ({ source, sourceUserEntryId }) => {
        const conversation = await harness.conversation(source.conversationId, BACKGROUND_CONTEXT);
        const entries = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
        const entry = entries.find((item) => item.kind === 'pi.user' && String(item.id) === sourceUserEntryId);
        if (!entry) return null;
        return catalog.displayTextForSubmitted(source.id, entryText(entry)) ?? null;
      },
      authorizeTarget: async ({ source, target }) => source.moronId !== target.id &&
        !target.archived && catalog.getMoron(source.moronId)?.workspaceId === target.workspaceId,
      ensureTargetSession: async ({ id, target, source }) => {
        const existing = catalog.getSession(id);
        if (existing) {
          if (existing.moronId !== target.id) throw new Error('handoff_target_conflict');
          return existing;
        }
        const sourceConversation = await harness.conversation(source.conversationId, BACKGROUND_CONTEXT);
        const sourceModel = (await sourceConversation.agent(BACKGROUND_CONTEXT)).model;
        return createNamedSession(target, id, { handoff: true, model: sourceModel });
      },
      askTarget: async ({ targetSessionId, targetMoronId, question, requestId }) => {
        const targetSession = catalog.getSession(targetSessionId);
        if (!targetSession || targetSession.moronId !== targetMoronId) throw new Error('handoff_target_missing');
        const targetConversation = await harness.conversation(targetSession.conversationId, BACKGROUND_CONTEXT);
        const result = await chat(targetConversation, targetSession, { requestId, text: question });
        if (result.status !== 200) throw new Error('handoff_target_failed');
        return result.body.answer;
      },
    });
    registry.install(handoffExtension);
    if (providerModelId && !providerModels?.getProvider('openai')?.getModels().some((model) => model.id === providerModelId))
      throw new Error('configured_provider_model_not_in_catalog');
    selectedModel = providerModelId ? { provider: 'openai', modelId: providerModelId } :
      { provider: 'morons-fixture', modelId: 'fixture' };
    harness = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: selectedModel, extensions: [] },
    });
    if (repositoryPlan) {
      if (!catalog.getMoron('repo'))
        catalog.createMoron({ id: 'repo', name: repositoryName,
          rules: '', preferences: '', workspaceId: 'personal' });
      catalog.ensureLegacyRepository(await realpath(repositoryPlan.repository).catch(() => resolve(repositoryPlan.repository)), repositoryName);
    }
  } catch (error) {
    await applications?.close().catch(() => {});
    await images?.close().catch(() => {});
    permissions?.close();
    await harness?.close(BACKGROUND_CONTEXT).catch(() => {});
    catalog?.close();
    optchat?.database.close();
    handoffStore?.close();
    await ownerLock.close();
    throw error;
  }
  harness.resume();
  const reviewRecoveries = new Set();
  let shuttingDown = false;
  const inFlight = new Map();
  const handoffFlight = new Map();
  const sessionTail = new Map();
  const settlementTail = new Map();
  const modelChanges = new Set();
  const sessionEpochs = new Map();
  const handoffConfigured = new Set();
  function isHandoffTarget(session) {
    return catalog.isHandoffTarget(session.id) || handoffStore.isTargetSession(session.id);
  }
  function permissionSession(session, existing = true) {
    const moron = session && catalog.getMoron(session.moronId);
    const repository = moron && catalog.repositoryForMoron(moron.id);
    if (!session || !moron || moron.archived || implementationRuntime.isImplementationSession(session.id))
      throw new Error('permission_session_forbidden');
    if (repository && repository.workspaceId !== moron.workspaceId) throw new Error('permission_scope_mismatch');
    permissionSessionIds.add(session.id);
    return permissions.ensureSession({ sessionId: session.id, workspaceId: moron.workspaceId,
      repositoryId: repository?.id ?? null, existing });
  }
  async function permissionGrant(session, kind, action, { signal, proposalId, baseRevision } = {}) {
    const scope = permissionSession(session);
    const descriptor = { sessionId: session.id, workspaceId: scope.workspaceId,
      repositoryId: scope.repositoryId, kind, action,
      ...(proposalId ? { proposalId } : {}), ...(baseRevision ? { baseRevision } : {}) };
    const lease = permissions.admit(descriptor);
    const abort = () => permissions.revokeSession(session.id, 'operation_cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      permissions.finish(lease);
    };
    try {
      if (signal?.aborted) abort();
      await permissions.wait(lease);
      permissions.start(lease, descriptor);
      return { signal: lease.signal, finish, reassert: () => {
        permissionSession(session);
        permissions.assert(lease, descriptor);
      } };
    } catch (error) { finish(); throw error; }
  }
  function admitRepositoryOperation({ source, job, operation, signal, ...details }) {
    const action = Object.fromEntries(Object.entries({ operation, ...details }).filter(([, value]) => value !== undefined));
    const kind = operation === 'write' ? 'edit' : ['check', 'finalize', 'review'].includes(operation) ? 'command' : 'read';
    return permissionGrant(source, kind, action, { signal, proposalId: job?.id,
      baseRevision: job?.baseRevision ?? details.baseRevision });
  }
  function permissionView(session) {
    return { ...permissionSession(session), modes: PERMISSION_MODES, reference: PERMISSION_REFERENCE,
      pending: permissions.listPending(session.id) };
  }
  async function stopSession(session, reason = 'session_stopped') {
    sessionEpochs.set(session.id, (sessionEpochs.get(session.id) ?? 0) + 1);
    for (const reply of catalog.pendingReplies().filter((reply) => reply.session_id === session.id))
      catalog.failReply(session.id, reply.request_id);
    permissionSession(session);
    permissions.revokeSession(session.id, reason);
    await implementationRuntime.cancelForSession(session.id);
    const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
    await conversation.abort(BACKGROUND_CONTEXT);
  }
  async function repositoryPlanForSession(session, baseRevision = null) {
    const repository = catalog.repositoryForMoron(session.moronId);
    const moron = catalog.getMoron(session.moronId);
    if (!repository || !moron || repository.workspaceId !== moron.workspaceId) return null;
    if (repository.id === 'configured') {
      if (!repositoryPlan || session.moronId !== 'repo' ||
          repository.path !== await realpath(repositoryPlan.repository).catch(() => resolve(repositoryPlan.repository))) return null;
      return repositoryPlan;
    }
    if (!runnerImage || !validId(repository.id) || !validId(repository.workspaceId)) return null;
    const source = await selectedRepositoryPath(repository.path, protectedRoots);
    if (source !== repository.path) throw new Error('repository_path_changed');
    const runnersRoot = await privateDirectory(join(dirname(databasePath), 'repository-runners'));
    const workspaceDirectory = await privateDirectory(join(runnersRoot, repository.workspaceId));
    const root = await privateDirectory(join(workspaceDirectory, repository.id));
    const reviewRoot = await privateDirectory(join(root, 'reviews'));
    const workspaceRoot = await privateDirectory(join(root, 'computer-home'));
    await assertRunnerPathSeparation(source, reviewRoot);
    await assertRunnerPathSeparation(source, workspaceRoot);
    const allowedPaths = await committedSourcePaths(source, baseRevision ?? 'HEAD');
    trustedCheckPlan('source-code', allowedPaths);
    const plan = { repository: source, runnerImage, allowedPaths,
      checkProfile: 'source-code', reviewRoot, workspaceRoot };
    runnerPlans.set(repository.id, plan);
    return plan;
  }
  function sourceToolsFor(session, model) {
    const repository = catalog.repositoryForMoron(session.moronId);
    return repository && repoExtension && (runnerImage ||
      (repository.id === 'configured' && repositoryPlan && model?.provider === 'morons-fixture'))
      ? [repoExtension, ...(runnerImage ? [implementationRuntime.coordinatorExtension] : [])] : [];
  }
  function extensionsFor(session, model) {
    const worker = implementationRuntime.workerExtensionsFor(session);
    if (worker) return worker;
    if (isHandoffTarget(session)) return [];
    const moron = catalog.getMoron(session.moronId);
    return [handoffExtension, ...sourceToolsFor(session, model),
      ...(!catalog.repositoryForMoron(session.moronId) && moron?.role !== 'implementation' ? [images.extension] : [])];
  }
  async function ensureHandoffTool(conversation, session) {
    if (handoffConfigured.has(session.id)) return;
    const model = (await conversation.agent(BACKGROUND_CONTEXT)).model;
    await conversation.configure({ extensions: extensionsFor(session, model) }, BACKGROUND_CONTEXT);
    handoffConfigured.add(session.id);
  }
  let modelRefreshAt = 0;
  const effortOptions = (model) => {
    if (!model.reasoning) return [];
    const map = model.thinkingLevelMap ?? {};
    return ['off', 'low', 'medium', 'high', 'xhigh', 'max']
      .filter((level) => level === 'off' || map[level] === level ||
        (['low', 'medium', 'high'].includes(level) && map[level] === undefined));
  };
  async function modelCatalog(conversation) {
    if (providerModels && await models.checkAuth('openai')) {
      if (Date.now() - modelRefreshAt > 60_000) {
        modelRefreshAt = Date.now();
        await models.refresh({ providers: ['openai'], allowNetwork: true });
      }
    }
    const available = await models.getAvailable();
    const allowed = new Set(available.map((model) => `${model.provider}\0${model.id}`));
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const selected = agent.model;
    const known = models.getModels().filter((model) => !isFastModelId(model.id) &&
      (fixtureEnabled || model.provider !== 'morons-fixture')).slice(0, 127).map((model) => ({
      provider: model.provider, id: model.id, label: model.name,
      available: allowed.has(`${model.provider}\0${model.id}`),
      efforts: effortOptions(model),
      ...(typeof model.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(model.releaseDate)
        ? { releaseDate: model.releaseDate } : {}),
    }));
    const selectedId = selected && baseModelId(selected.modelId);
    if (selected && (fixtureEnabled || selected.provider !== 'morons-fixture') &&
        !known.some((model) => model.provider === selected.provider && model.id === selectedId))
      known.push({ provider: selected.provider, id: selectedId, label: selectedId, available: false, efforts: [] });
    const fastAvailable = selected?.provider === 'openai' &&
      allowed.has(`openai\0${fastModelId(selectedId)}`);
    return { selected: selected && { provider: selected.provider, id: selectedId },
      fastMode: Boolean(selected && isFastModelId(selected.modelId)), fastAvailable,
      selectedEffort: agent.thinkingLevel, models: known, favorites: catalog.listModelFavorites() };
  }
  async function chat(conversation, session, body, displayText = body?.text, waitForAnswer = true) {
    const sessionId = session.id;
    const epoch = sessionEpochs.get(sessionId) ?? 0;
    permissionSession(session);
    const assertAdmission = () => {
      if (shuttingDown || epoch !== (sessionEpochs.get(sessionId) ?? 0)) throw new Error('chat_admission_cancelled');
    };
    if (!fixtureEnabled && (await conversation.agent(BACKGROUND_CONTEXT)).model?.provider === 'morons-fixture')
      return { status: 409, body: { error: 'provider_setup_required' } };
    assertAdmission();
    if (typeof body?.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 8192)
      return { status: 400, body: { error: "invalid_text" } };
    if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
      return { status: 400, body: { error: "invalid_request_id" } };
    const key = `${sessionId}:${body.requestId}`;
    if (inFlight.has(key)) {
      const active = inFlight.get(key);
      if (active.text !== body.text) return { status: 409, body: { error: "request_id_conflict" } };
      return waitForAnswer ? active.completion : active.admission.then((value) => value.accepted);
    }
    const admit = async () => {
      assertAdmission();
      permissionSession(session);
      await ensureHandoffTool(conversation, session);
      assertAdmission();
      const previous = catalog.getReply(sessionId, body.requestId);
      if (previous && previous.display_text !== displayText) return { accepted: { status: 409, body: { error: "request_id_conflict" } } };
      if (previous?.answer !== null && previous?.answer !== undefined)
        return { accepted: { status: 200, body: { requestId: body.requestId, answer: previous.answer, state: 'done' } } };


      const modelRef = previous ? null : (await conversation.agent(BACKGROUND_CONTEXT)).model;
      const prepared = previous ? null : await memoryRuntime.prepareTurn(conversation, session, body.requestId, modelRef);
      assertAdmission();
      const submitted = previous ? previous.text : body.text + prepared.text;
      if (!previous) catalog.reserveReply(sessionId, body.requestId, submitted, displayText);
      if (!previous) await implementationRuntime.steerForSession(session.id, body.text, body.requestId);
      assertAdmission();
      const reserved = catalog.getReply(sessionId, body.requestId);
      if (reserved.display_text !== displayText) return { accepted: { status: 409, body: { error: "request_id_conflict" } } };
      const submission = await conversation.submit({ type: "input", content: submitted,
        requestId: body.requestId, whenBusy: 'steer' }, BACKGROUND_CONTEXT);
      if (epoch !== (sessionEpochs.get(sessionId) ?? 0) || shuttingDown) {
        await conversation.abort(BACKGROUND_CONTEXT);
        catalog.failReply(sessionId, body.requestId);
        return { accepted: { status: 409, body: { error: 'chat_admission_cancelled' } } };
      }
      const status = await submission.status(BACKGROUND_CONTEXT);
      return { submission, accepted: { status: 202,
        body: { requestId: body.requestId, state: status.status === 'queued' ? 'queued' : 'delivered' } } };
    };
    const previousTail = sessionTail.get(sessionId) ?? Promise.resolve();
    const admission = previousTail.catch(() => {}).then(admit).catch((error) => {
      catalog.failReply(sessionId, body.requestId);
      throw error;
    });
    sessionTail.set(sessionId, admission);
    admission.finally(() => {
      if (sessionTail.get(sessionId) === admission) sessionTail.delete(sessionId);
    }).catch(() => {});
    const completion = admission.then(async ({ submission, accepted }) => {
      if (!submission) return accepted;
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status !== "done" || settled.type !== "input") {
        catalog.failReply(sessionId, body.requestId);
        return { status: 500, body: { error: "generation_failed" } };
      }
      const prior = settlementTail.get(sessionId) ?? Promise.resolve();
      const finalize = prior.catch(() => {}).then(async () => {
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
        } catch {}
      }
      await afterPiSettled();
      catalog.saveReply(sessionId, body.requestId, displayAnswer(text));
      await memoryRuntime.sync(conversation, session);
      return { status: 200, body: { requestId: body.requestId, answer: displayAnswer(text) } };
      });
      settlementTail.set(sessionId, finalize);
      finalize.finally(() => { if (settlementTail.get(sessionId) === finalize) settlementTail.delete(sessionId); }).catch(() => {});
      return finalize;
    });
    completion.finally(() => {
      inFlight.delete(key);
    }).catch(() => {});
    inFlight.set(key, { text: body.text, admission, completion });
    return waitForAnswer ? completion : admission.then((value) => value.accepted);
  }
  for (const pending of catalog.pendingReplies()) {
    const session = catalog.getSession(pending.session_id);
    if (!session) continue;
    const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
    chat(conversation, session, { requestId: pending.request_id, text: pending.display_text },
      pending.display_text).catch(() => {});
  }
  async function history(conversation, sessionId, moronId) {
    const items = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
    const session = catalog.getSession(sessionId);
    await memoryRuntime.sync(conversation, session);
    const submissions = (await harness.inspect(BACKGROUND_CONTEXT)).submissions
      .filter((item) => item.conversationId === conversation.id && item.type === 'input');
    const byEntry = new Map(submissions.filter((item) => item.entry)
      .map((item) => [String(item.entry), item]));
    const replies = catalog.listReplies(sessionId);
    const unseen = new Map();
    for (const reply of replies) {
      const group = unseen.get(reply.text) ?? [];
      group.push(reply);
      unseen.set(reply.text, group);
    }
    const handoffs = catalog.listHandoffs(sessionId).filter((handoff) => handoff.answer !== null);
    const modelHandoffs = new Map(handoffStore.list(sessionId).filter((handoff) => handoff.answer !== null)
      .map((handoff) => [handoff.source_user_entry_id, handoff]));
    const messages = items.reverse().filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
      .map((entry) => {
        const role = entry.kind === "pi.user" ? "user" : "assistant";
        const raw = entryText(entry);
        const reply = role === 'user' ? unseen.get(raw)?.shift() : null;
        const submission = role === 'user' ? byEntry.get(String(entry.id)) : null;
        const display = role === "user" ? catalog.displayTextForSubmitted(sessionId, raw) : undefined;
        const handoff = role === "user" && handoffs.find((item) => display === `@${item.target_moron_id} ${item.question}`);
        const modelHandoff = role === "user" ? modelHandoffs.get(String(entry.id)) : null;
        return { id: String(entry.id), role, text: display ?? (handoff ? `@${handoff.target_moron_id} ${handoff.question}` : displayAnswer(raw)),
          ...(role === 'user' ? { status: reply?.state === 'failed' ? 'failed' :
            submission?.status === 'placed' ? 'running' : 'delivered' } : {}),
          ...(handoff || modelHandoff ? { handoff: { targetMoronId: (handoff ?? modelHandoff).target_moron_id,
            answer: (handoff ?? modelHandoff).answer } } : {}) };
      }).filter((entry) => entry.role === 'user' || entry.text.length > 0);
    for (const reply of replies) {
      if (reply.state === 'accepted' && unseen.get(reply.text)?.includes(reply))
        messages.push({ id: `queued-${reply.request_id}`, role: 'user', text: reply.display_text, status: 'queued' });
    }
    return { sessionId, moronId, messages };
  }
  function scopedHandoffText(handoff) {
    return `@${handoff.target_moron_id} ${handoff.question}\n\n[Scoped answer from @${handoff.target_moron_id}: ${handoff.answer}]`;
  }
  async function createNamedSession(moron, id, { handoff = false, model = selectedModel, title = 'New thread' } = {}) {
    const repository = catalog.repositoryForMoron(moron.id);
    const instructions = [repository && `Registered repository ID: ${repository.id}. Only claim to have read or changed source when a repository tool returns a result.`,
      moron.rules, moron.preferences].filter(Boolean).join("\n\n");
    const conversation = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model, instructions,
        extensions: handoff ? [] : [handoffExtension, ...sourceToolsFor({ moronId: moron.id }, model),
          ...(!repository && moron.role !== 'implementation' ? [images.extension] : [])] },
    }, BACKGROUND_CONTEXT);
    handoffConfigured.add(id);
    const session = catalog.createSession(id, moron.id, conversation.id, title);
    permissionSession(session, false);
    return session;
  }
  async function executeDelegatedChat(source, body) {
    const parsed = /^@([a-z][a-z0-9-]{1,39})\s+([\s\S]+)$/.exec(body.text);
    if (!parsed || !parsed[2].trim() || Buffer.byteLength(parsed[2]) > 2048)
      return { status: 400, body: { error: "invalid_mention" } };
    const [, targetId, question] = parsed;
    const target = catalog.getMoron(targetId);
    if (!target || targetId === source.moronId ||
        catalog.getMoron(source.moronId)?.workspaceId !== target.workspaceId)
      return { status: 404, body: { error: "mention_target_not_found" } };
    if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
      return { status: 400, body: { error: "invalid_request_id" } };
    let handoff = catalog.getHandoff(source.id, body.requestId);
    if (handoff && (handoff.target_moron_id !== targetId || handoff.question !== question))
      return { status: 409, body: { error: "request_id_conflict" } };
    if (!handoff) {
      const sourceConversation = await harness.conversation(source.conversationId, BACKGROUND_CONTEXT);
      const sourceModel = (await sourceConversation.agent(BACKGROUND_CONTEXT)).model;
      const targetSession = await createNamedSession(target, `handoff-${randomBytes(8).toString("hex")}`,
        { handoff: true, model: sourceModel });
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
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    const path = requestUrl.pathname;
    try {
      const privateSession = /^\/v1\/sessions\/([^/]+)/.exec(path);
      if (privateSession && implementationRuntime.isImplementationSession(decodeURIComponent(privateSession[1])))
        return send(response, 404, { error: 'session_not_found' });
      if (fixtureEnabled && request.method === "GET" && path === "/v1/fixture/status")
        return send(response, 200, { ready: true, model: "fixture", durable: true });
      if (request.method === "GET" && path === "/v1/models")
        return send(response, 200, await modelCatalog(root));
      if (request.method === 'POST' && path === '/v1/models/favorite') {
        const body = await readBody(request);
        if (typeof body?.provider !== 'string' || typeof body?.id !== 'string' ||
            typeof body?.favorite !== 'boolean' || body.provider.length > 80 || body.id.length > 128 ||
            !models.getModel(body.provider, body.id) ||
            (!fixtureEnabled && body.provider === 'morons-fixture'))
          return send(response, 400, { error: 'invalid_model' });
        catalog.setModelFavorite(body.provider, body.id, body.favorite);
        return send(response, 200, { favorites: catalog.listModelFavorites() });
      }
      if (request.method === 'GET' && path === '/v1/usage') {
        let filters;
        try { filters = usageFilters(requestUrl.searchParams); }
        catch { return send(response, 400, { error: 'invalid_usage_filter' }); }
        return send(response, 200, await collectUsage({ catalog, harness, models, filters }));
      }
      if (request.method === 'GET' && path === '/v1/image-generation/status')
        return send(response, 200, images.status());
      const imageList = /^\/v1\/sessions\/([^/]+)\/images$/.exec(path);
      if (imageList && request.method === 'GET')
        return send(response, 200, { images: images.list(decodeURIComponent(imageList[1])) });
      const imageAction = /^\/v1\/sessions\/([^/]+)\/images\/(img-[a-f0-9]{32})\/(content|cancel)$/.exec(path);
      if (imageAction) {
        const sessionId = decodeURIComponent(imageAction[1]);
        if (imageAction[3] === 'cancel' && request.method === 'POST')
          return send(response, 200, { cancelled: images.cancel(sessionId, imageAction[2]) });
        if (imageAction[3] === 'content' && request.method === 'GET') {
          const image = images.read(sessionId, imageAction[2]);
          if (!image) return send(response, 404, { error: 'image_not_found' });
          response.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': image.bytes.length,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(image.bytes);
        }
      }
      const permissionPath = /^\/v1\/sessions\/([^/]+)\/permissions$/.exec(path);
      const permissionDecision = /^\/v1\/sessions\/([^/]+)\/permissions\/([a-f0-9-]{36})\/decision$/.exec(path);
      if (permissionPath || permissionDecision) {
        const session = catalog.getSession(decodeURIComponent((permissionPath ?? permissionDecision)[1]));
        if (!session || isHandoffTarget(session)) return send(response, 404, { error: 'session_not_found' });
        const current = permissionSession(session);
        if (permissionPath && request.method === 'GET') return send(response, 200, permissionView(session));
        if (permissionPath && request.method === 'POST') {
          const body = await readBody(request);
          if (!Number.isSafeInteger(body?.expectedRevision)) return send(response, 400, { error: 'invalid_permission_revision' });
          const next = permissions.set(session.id, body.mode, { expectedRevision: body.expectedRevision });
          const strength = { 'approval-required': 0, auto: 0, 'auto-accept-edits': 1, 'full-access': 2 };
          if (strength[next.mode] < strength[current.mode]) await stopSession(session, 'permission_mode_changed');
          return send(response, 200, permissionView(session));
        }
        if (permissionDecision && request.method === 'POST') {
          const body = await readBody(request);
          permissions.decide({ id: permissionDecision[2], sessionId: session.id,
            workspaceId: current.workspaceId, repositoryId: current.repositoryId,
            fingerprint: body?.fingerprint, decision: body?.decision });
          return send(response, 200, permissionView(session));
        }
      }
      const stopPath = /^\/v1\/sessions\/([^/]+)\/stop$/.exec(path);
      if (stopPath && request.method === 'POST') {
        const session = catalog.getSession(decodeURIComponent(stopPath[1]));
        if (!session || isHandoffTarget(session)) return send(response, 404, { error: 'session_not_found' });
        await stopSession(session);
        return send(response, 200, { stopped: true });
      }
      const implementationPath = /^\/v1\/sessions\/([^/]+)\/implementations$/.exec(path);
      if (implementationPath && request.method === 'GET') {
        const session = catalog.getSession(decodeURIComponent(implementationPath[1]));
        if (!session) return send(response, 404, { error: 'session_not_found' });
        return send(response, 200, { implementations: implementationRuntime.list(session.id) });
      }
      if (request.method === "GET" && path === "/v1/morons")
        return send(response, 200, { morons: catalog.listMorons(requestUrl.searchParams.get('workspaceId') ?? 'personal') });
      if (request.method === 'GET' && path === '/v1/repositories') {
        const workspaceId = requestUrl.searchParams.get('workspaceId') ?? 'personal';
        const repositories = catalog.listRepositories(workspaceId).map((repository) => ({
          id: repository.id, name: repository.name, moronId: repository.moronId,
          ...catalog.repositorySidebar(workspaceId, repository.id),
        }));
        return send(response, 200, { repositories });
      }
      if (request.method === 'POST' && path === '/v1/repositories') {
        const body = await readBody(request);
        const workspaceId = body?.workspaceId ?? 'personal';
        if (!validId(workspaceId)) return send(response, 400, { error: 'invalid_workspace' });
        let selectedPath;
        try { selectedPath = await selectedRepositoryPath(body?.path, protectedRoots); }
        catch { return send(response, 400, { error: 'invalid_repository_path' }); }
        if (catalog.listRepositories(workspaceId).some((repository) => repository.path === selectedPath))
          return send(response, 409, { error: 'repository_exists' });
        const suffix = randomBytes(8).toString('hex');
        const repository = catalog.registerRepository({ id: `r-${suffix}`, moronId: `repo-${suffix}`,
          workspaceId, path: selectedPath,
          name: basename(selectedPath).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'Repository' });
        return send(response, 201, { repository: { id: repository.id, name: repository.name,
          moronId: repository.moronId, pinned: false, archived: false } });
      }
      const repositorySidebar = /^\/v1\/repositories\/([^/]+)\/(pin|archive)$/.exec(path);
      if (repositorySidebar && request.method === 'PATCH') {
        const workspaceId = requestUrl.searchParams.get('workspaceId') ?? 'personal';
        const repository = catalog.getRepository(repositorySidebar[1]);
        if (!repository || repository.workspaceId !== workspaceId) return send(response, 404, { error: 'repository_not_found' });
        const body = await readBody(request);
        const field = repositorySidebar[2] === 'pin' ? 'pinned' : 'archived';
        if (typeof body?.[field] !== 'boolean') return send(response, 400, { error: 'invalid_repository_sidebar' });
        return send(response, 200, { repository: { id: repository.id, name: repository.name,
          moronId: repository.moronId, ...catalog.setRepositorySidebar(workspaceId, repository.id, field, body[field]) } });
      }
      const moronPin = /^\/v1\/morons\/([^/]+)\/pin$/.exec(path);
      if (moronPin && request.method === 'PATCH') {
        const body = await readBody(request);
        const id = decodeURIComponent(moronPin[1]);
        if (!catalog.getMoron(id)) return send(response, 404, { error: 'moron_not_found' });
        if (typeof body?.pinned !== 'boolean') return send(response, 400, { error: 'invalid_pin' });
        return send(response, 200, { moron: catalog.setMoronPinned(id, body.pinned) });
      }
      const moronArchive = /^\/v1\/morons\/([^/]+)\/archive$/.exec(path);
      if (moronArchive && request.method === 'PATCH') {
        const id = decodeURIComponent(moronArchive[1]);
        const current = catalog.getMoron(id);
        if (!current || current.workspaceId !== (requestUrl.searchParams.get('workspaceId') ?? 'personal'))
          return send(response, 404, { error: 'moron_not_found' });
        const body = await readBody(request);
        if (typeof body?.archived !== 'boolean' || current.role !== 'named' || catalog.repositoryForMoron(id))
          return send(response, 400, { error: 'invalid_moron_archive' });
        return send(response, 200, { moron: catalog.setMoronArchived(id, body.archived) });
      }
      const moronEdit = /^\/v1\/morons\/([^/]+)$/.exec(path);
      if (moronEdit && request.method === 'PATCH') {
        const id = decodeURIComponent(moronEdit[1]);
        if (!catalog.getMoron(id)) return send(response, 404, { error: 'moron_not_found' });
        const body = await readBody(request);
        return send(response, 200, { moron: catalog.updateMoron(id, body) });
      }
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
        return review ? send(response, 200, { review: { ...review, application: applications.get(review.id) } }) : send(response, 404, { error: 'review_not_found' });
      }
      const reviewApply = /^\/v1\/reviews\/([a-f0-9]{16})\/apply$/.exec(path);
      if (reviewApply && request.method === 'POST') {
        const body = await readBody(request);
        const review = catalog.getReview(reviewApply[1]);
        if (!review) return send(response, 404, { error: 'review_not_found' });
        permissionSession(catalog.getSession(review.sessionId));
        return send(response, 202, { application: await applications.request(review.id,
          { proposalRevision: body?.proposalRevision, diffHash: body?.diffHash }) });
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
        if (body?.role === 'coordinator') return send(response, 400, { error: 'invalid_moron' });
        if (catalog.getMoron(body?.id)) return send(response, 409, { error: "moron_exists" });
        return send(response, 201, { moron: catalog.createMoron(body) });
      }
      const moronMemory = /^\/v1\/morons\/([^/]+)\/memory$/.exec(path);
      if (moronMemory && request.method === "POST") {
        const moronId = decodeURIComponent(moronMemory[1]);
        const moron = catalog.getMoron(moronId);
        if (!moron || moron.role === 'implementation') return send(response, 404, { error: "moron_not_found" });
        const body = await readBody(request);
        if (!validId(body?.id) || typeof body?.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 8192)
          return send(response, 400, { error: "invalid_memory" });
        const sourceId = `decision:${moronId}:${body.id}`;
        optchat.memory.append({ sourceId, projectId: accountId, repository: moronId, threadId: null,
          kind: "decision", date: catalog.memoryDate(sourceId), text: body.text });
        return send(response, 201, { id: body.id, moronId });
      }
      const moronSessions = /^\/v1\/morons\/([^/]+)\/sessions$/.exec(path);
      if (moronSessions) {
        const moronId = decodeURIComponent(moronSessions[1]);
        const moron = catalog.getMoron(moronId);
        if (!moron) return send(response, 404, { error: "moron_not_found" });
        if (request.method === "GET") return send(response, 200, { sessions: catalog.listSessions(moronId)
          .filter((session) => !implementationRuntime.isImplementationSession(session.id)) });
        if (request.method === "POST") {
          if (moron.archived) return send(response, 409, { error: 'moron_archived' });
          const body = await readBody(request);
          if (!validId(body?.id)) return send(response, 400, { error: "invalid_session" });
          if (catalog.getSession(body.id)) return send(response, 409, { error: "session_exists" });
          return send(response, 201, { session: await createNamedSession(moron, body.id,
            { title: body.title ?? 'New thread' }) });
        }
      }
      const sessionPath = /^\/v1\/sessions\/([^/]+)\/(history|chat)$/.exec(path);
      const sessionModelPath = /^\/v1\/sessions\/([^/]+)\/models?$/.exec(path);
      const sessionEffortPath = /^\/v1\/sessions\/([^/]+)\/effort$/.exec(path);
      const sessionFastPath = /^\/v1\/sessions\/([^/]+)\/fast$/.exec(path);
      if (sessionFastPath && request.method === 'POST') {
        const session = catalog.getSession(decodeURIComponent(sessionFastPath[1]));
        if (!session) return send(response, 404, { error: 'session_not_found' });
        const body = await readBody(request);
        if (typeof body?.enabled !== 'boolean') return send(response, 400, { error: 'invalid_fast_mode' });
        if (modelChanges.has(session.id) || sessionTail.has(session.id) ||
            catalog.pendingReplies().some((reply) => reply.session_id === session.id))
          return send(response, 409, { error: 'session_busy' });
        modelChanges.add(session.id);
        try {
          const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
          const inspection = await harness.inspect(BACKGROUND_CONTEXT);
          if (inspection.tasks.some((task) => task.record.conversationId === conversation.id) ||
              inspection.submissions.some((submission) => submission.conversationId === conversation.id &&
                (submission.status === 'queued' || submission.status === 'placed')))
            return send(response, 409, { error: 'session_busy' });
          const view = await modelCatalog(conversation);
          if (!view.selected || !view.models.some((model) => model.provider === view.selected.provider &&
              model.id === view.selected.id && model.available))
            return send(response, 403, { error: 'model_unavailable' });
          if (body.enabled && !view.fastAvailable)
            return send(response, 403, { error: 'fast_mode_unavailable' });
          await conversation.configure({ model: { provider: view.selected.provider,
            modelId: body.enabled ? fastModelId(view.selected.id) : view.selected.id } }, BACKGROUND_CONTEXT);
          return send(response, 200, await modelCatalog(conversation));
        } finally { modelChanges.delete(session.id); }
      }
      if (sessionEffortPath && request.method === 'POST') {
        const session = catalog.getSession(decodeURIComponent(sessionEffortPath[1]));
        if (!session) return send(response, 404, { error: 'session_not_found' });
        const body = await readBody(request);
        if (typeof body?.effort !== 'string') return send(response, 400, { error: 'invalid_effort' });
        if (modelChanges.has(session.id) || sessionTail.has(session.id) ||
            catalog.pendingReplies().some((reply) => reply.session_id === session.id))
          return send(response, 409, { error: 'session_busy' });
        modelChanges.add(session.id);
        try {
          const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
          const inspection = await harness.inspect(BACKGROUND_CONTEXT);
          if (inspection.tasks.some((task) => task.record.conversationId === conversation.id) ||
              inspection.submissions.some((submission) => submission.conversationId === conversation.id &&
                (submission.status === 'queued' || submission.status === 'placed')))
            return send(response, 409, { error: 'session_busy' });
          const view = await modelCatalog(conversation);
          const selected = view.models.find((model) => model.provider === view.selected?.provider &&
            model.id === view.selected?.id);
          if (!selected?.available || !selected.efforts.includes(body.effort))
            return send(response, 403, { error: 'effort_unavailable' });
          await conversation.configure({ thinkingLevel: body.effort }, BACKGROUND_CONTEXT);
          return send(response, 200, await modelCatalog(conversation));
        } finally { modelChanges.delete(session.id); }
      }
      if (sessionModelPath) {
        const session = catalog.getSession(decodeURIComponent(sessionModelPath[1]));
        if (!session) return send(response, 404, { error: 'session_not_found' });
        const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
        if (!conversation) return send(response, 500, { error: 'conversation_missing' });
        if (request.method === 'GET') return send(response, 200, await modelCatalog(conversation));
        if (request.method === 'POST' && path.endsWith('/model')) {
          const body = await readBody(request);
          if (typeof body?.provider !== 'string' || typeof body?.id !== 'string' ||
              body.provider.length > 80 || body.id.length > 128 || !body.provider || !body.id)
            return send(response, 400, { error: 'invalid_model' });
          if (modelChanges.has(session.id) || sessionTail.has(session.id) ||
              catalog.pendingReplies().some((reply) => reply.session_id === session.id))
            return send(response, 409, { error: 'session_busy' });
          modelChanges.add(session.id);
          try {
            const inspection = await harness.inspect(BACKGROUND_CONTEXT);
            const busy = inspection.tasks.some((task) => task.record.conversationId === conversation.id) ||
              inspection.submissions.some((submission) => submission.conversationId === conversation.id &&
                (submission.status === 'queued' || submission.status === 'placed'));
            if (busy || sessionTail.has(session.id)) return send(response, 409, { error: 'session_busy' });
            const catalogView = await modelCatalog(conversation);
            if (!catalogView.models.some((model) => model.provider === body.provider &&
                model.id === body.id && model.available))
              return send(response, 403, { error: 'model_unavailable' });
            const currentEffort = (await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
            const fastTarget = catalogView.fastMode && body.provider === 'openai' &&
              (await models.getAvailable()).some((model) => model.provider === body.provider &&
                model.id === fastModelId(body.id));
            await conversation.configure({ model: { provider: body.provider,
              modelId: fastTarget ? fastModelId(body.id) : body.id },
              thinkingLevel: catalogView.models.find((model) => model.provider === body.provider && model.id === body.id)
                ?.efforts.includes(currentEffort) ? currentEffort : 'off',
              extensions: extensionsFor(session, { provider: body.provider, modelId: body.id }) }, BACKGROUND_CONTEXT);
            handoffConfigured.add(session.id);
            return send(response, 200, await modelCatalog(conversation));
          } finally { modelChanges.delete(session.id); }
        }
      }
      if (sessionPath) {
        const session = catalog.getSession(decodeURIComponent(sessionPath[1]));
        if (!session) return send(response, 404, { error: "session_not_found" });
        const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
        if (!conversation) return send(response, 500, { error: "conversation_missing" });
        if (request.method === "GET" && sessionPath[2] === "history")
          return send(response, 200, await history(conversation, session.id, session.moronId));
        if (request.method === "POST" && sessionPath[2] === "chat") {
          if (modelChanges.has(session.id)) return send(response, 409, { error: 'session_busy' });
          const body = await readBody(request);
          if (modelChanges.has(session.id)) return send(response, 409, { error: 'session_busy' });
          const result = typeof body?.text === "string" && body.text.startsWith("@")
            ? await delegatedChat(session, body)
            : await chat(conversation, session, body, body?.text, false);
          return send(response, result.status, result.body);
        }
      }
      if (fixtureEnabled && request.method === "GET" && path === "/v1/fixture/history") {
        const items = (await root.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
        return send(response, 200, {
          messages: items.reverse().filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
            .map((entry) => ({ id: entry.id, role: entry.kind === "pi.user" ? "user" : "assistant", text: entryText(entry) })),
        });
      }
      if (fixtureEnabled && request.method === "POST" && path === "/v1/fixture/chat") {
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
      if (error?.message === 'invalid_repository' || error?.code === 'SQLITE_CONSTRAINT_UNIQUE')
        return send(response, 409, { error: 'repository_limit_or_conflict' });
      if (error?.message === "memory_source_conflict") return send(response, 409, { error: "memory_conflict" });
      if (error?.message?.startsWith('permission_') || error?.message === 'invalid_permission_mode' ||
          error?.message === 'invalid_permission_decision' || ['session_stopped', 'operation_cancelled',
            'account_session_revoked', 'server_shutdown', 'chat_admission_cancelled'].includes(error?.message))
        return send(response, 409, { error: error.message });
      if (error?.message?.startsWith('image_')) return send(response, 403, { error: error.message });
      if (error?.message?.startsWith('application_') || error?.message === 'reviewed_proposal_required')
        return send(response, 409, { error: error.message });
      return send(response, 500, { error: "internal" });
    }
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  } catch (error) {
    await applications.close().catch(() => {});
    await images.close().catch(() => {});
    await harness.close(BACKGROUND_CONTEXT);
    for (const plan of runnerPlans.values()) await stopContainerWorkspace(plan).catch(() => {});
    catalog.close();
    optchat.database.close();
    handoffStore.close();
    permissions.close();
    await ownerLock.close();
    throw error;
  }
  for (const intent of catalog.pendingReviews()) {
    const recovery = (async () => {
      let grant;
      try {
        const session = catalog.getSession(intent.session_id);
        const plan = session && await repositoryPlanForSession(session, intent.base_revision);
        if (!plan) return;
        grant = await permissionGrant(session, 'command', { operation: 'recover-review',
          patch: intent.patch, patchHash: createHash('sha256').update(intent.patch).digest('hex'),
          branch: intent.branch }, { proposalId: intent.id, baseRevision: intent.base_revision });
        grant.reassert();
        const result = await runReviewOperation(plan, { operation: 'review', branch: intent.branch,
          patch: intent.patch, baseRevision: intent.base_revision ?? null }, { signal: grant.signal });
        grant.reassert();
        catalog.saveReview({ id: intent.id, sessionId: session.id, branch: intent.branch,
          baseRevision: result.baseRevision, diff: result.diff, checks: result.checks });
      } catch {} finally { grant?.finish(); }
    })();
    reviewRecoveries.add(recovery);
    recovery.finally(() => reviewRecoveries.delete(recovery));
  }
  return {
    url: `http://${host}:${server.address().port}`,
    async revokeOperations() {
      for (const sessionId of permissionSessionIds) {
        const session = catalog.getSession(sessionId);
        if (session) await stopSession(session, 'account_session_revoked').catch(() => {});
      }
    },
    async close() {
      shuttingDown = true;
      const failures = [];
      for (const sessionId of permissionSessionIds) permissions.revokeSession(sessionId, 'server_shutdown');
      for (const cleanup of [
        () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        () => applications.close(), () => images.close(),
        () => Promise.allSettled([...reviewRecoveries]),
        () => harness.close(BACKGROUND_CONTEXT),
        ...[...runnerPlans.values()].map((plan) => () => stopContainerWorkspace(plan)),
        () => catalog.close(), () => optchat.database.close(),
        () => handoffStore.close(), () => permissions.close(), () => ownerLock.close(),
      ]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'fixture_server_cleanup_failed');
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MORONS_FIXTURE_DB: databasePath, MORONS_OWNER_TOKEN: ownerToken } = process.env;
  openFixtureServer({ databasePath, ownerToken, port: Number(process.env.PORT ?? 8787) })
    .then(({ url }) => process.stdout.write(`Fixture server listening at ${url}\n`))
    .catch(() => { process.stderr.write("Fixture server startup failed. Check DB path and owner token.\n"); process.exitCode = 1; });
}

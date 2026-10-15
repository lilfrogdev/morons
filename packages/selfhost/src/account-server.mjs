import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openAccounts } from './accounts.mjs';
import { openFixtureServer } from './server.mjs';
import { acquireOwnerLock } from './owner-lock.mjs';
import { createProviderFlow } from './provider-flow.mjs';
import { openProviderRuntime } from './provider-runtime.mjs';
import { assertRunnerPathSeparation, verifyContainerRunner } from './container-review.mjs';
import { trustedCheckPlan } from '../../review-runner/src/check-policy.mjs';

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function sameSecret(supplied, expected) {
  if (typeof supplied !== 'string') return false;
  const left = createHash('sha256').update(supplied ?? '').digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
async function bytes(request, limit = 300_000) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request_too_large');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
function json(body) { try { return JSON.parse(body.toString('utf8')); } catch { throw new Error('invalid_json'); } }
function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null;
}
async function privateFile(path) {
  if (!isAbsolute(path ?? '')) throw new Error('private_file_path_required');
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error('private_file_required');
  return readFile(path);
}


export async function openAccountServer({ dataDir, bootstrapToken, repositoryPlan = null, providerFactory = null, providerKey = null, providerModelId = null, host = '127.0.0.1', port = 0 }) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('tls_ingress_required');
  if (typeof bootstrapToken !== 'string' || bootstrapToken.length < 32 || bootstrapToken.length > 256)
    throw new Error('bootstrap_token_required');
  if (providerKey !== null && (!Buffer.isBuffer(providerKey) || providerKey.length !== 32))
    throw new Error('provider_unlock_key_required');
  const activeProviderFactory = providerFactory ?? (providerKey ? (account, directory) =>
    openProviderRuntime({ directory, accountId: account.id, masterKey: providerKey }) : null);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dataDir)).isDirectory() || (await lstat(dataDir)).isSymbolicLink())
    throw new Error('private_data_directory_required');
  await chmod(dataDir, 0o700);
  if (repositoryPlan?.runnerImage) {
    trustedCheckPlan(repositoryPlan.checkProfile, repositoryPlan.allowedPaths);
    await assertRunnerPathSeparation(repositoryPlan.repository, dataDir);
    await verifyContainerRunner(repositoryPlan.runnerImage);
  }
  const lockPath = join(dataDir, '.owner.lock');
  const lock = await acquireOwnerLock(lockPath, 'account_server_already_owned_or_stale_lock');
  let accounts;
  try { accounts = await openAccounts(join(dataDir, 'accounts.sqlite')); }
  catch (error) { await lock.close(); throw error; }
  const runtimes = new Map();
  let closing = false;
  let bootstrapInProgress = false;
  const loginAttempts = new Map();
  async function runtime(account) {
    if (runtimes.has(account.id)) return runtimes.get(account.id);
    const pending = (async () => {
      const directory = join(dataDir, 'accounts', account.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const reviewRoot = join(directory, 'reviews');
      if (account.administrator && repositoryPlan) await mkdir(reviewRoot, { recursive: true, mode: 0o700 });
      const internalToken = randomBytes(32).toString('hex');
      const accountPlan = account.administrator && repositoryPlan ?
        { ...repositoryPlan, reviewRoot } : null;
      const providerRuntime = activeProviderFactory ? await activeProviderFactory(account, directory) : null;
      let server;
      try {
        server = await openFixtureServer({ databasePath: join(directory, 'pi.sqlite'),
          ownerToken: internalToken, repositoryPlan: accountPlan, accountId: account.id,
          providerModels: providerRuntime?.models ?? null, providerModelId });
        return { server, internalToken, provider: createProviderFlow(providerRuntime?.auth ?? providerRuntime),
          providerRuntime };
      } catch (error) { await server?.close(); await providerRuntime?.close?.(); throw error; }
    })();
    runtimes.set(account.id, pending);
    try { return await pending; }
    catch (error) { runtimes.delete(account.id); throw error; }
  }
  const server = createServer(async (request, response) => {
    if (closing) return send(response, 503, { error: 'closing' });
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    try {
      if (path === '/v1/accounts/bootstrap' && request.method === 'POST') {
        if (bootstrapInProgress || accounts.count() !== 0 || !sameSecret(request.headers['x-morons-bootstrap'], bootstrapToken))
          return send(response, 403, { error: 'bootstrap_unavailable' });
        bootstrapInProgress = true;
        try {
          const body = json(await bytes(request, 2048));
          const account = await accounts.create(body.name, body.password, true);
          return send(response, 201, { account });
        } finally { bootstrapInProgress = false; }
      }
      if (path === '/v1/session/login' && request.method === 'POST') {
        const address = request.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const attempt = loginAttempts.get(address) ?? { count: 0, until: now + 60_000 };
        if (attempt.until <= now) { attempt.count = 0; attempt.until = now + 60_000; }
        if (++attempt.count > 20) return send(response, 429, { error: 'login_rate_limited' });
        loginAttempts.set(address, attempt);
        const body = json(await bytes(request, 2048));
        const session = await accounts.login(body?.name, body?.password);
        return session ? send(response, 200, session) : send(response, 401, { error: 'invalid_login' });
      }
      const token = bearer(request);
      const account = token && accounts.session(token);
      if (!account) return send(response, 401, { error: 'unauthorized' });
      if (path === '/v1/session/me' && request.method === 'GET')
        return send(response, 200, { account: { id: account.id, name: account.name, administrator: account.administrator }, expiresAt: account.expiresAt });
      if (path === '/v1/session/logout' && request.method === 'POST') {
        accounts.revoke(token); return send(response, 200, { signedOut: true });
      }
      if (path === '/v1/accounts' && request.method === 'POST') {
        if (!account.administrator) return send(response, 403, { error: 'forbidden' });
        const body = json(await bytes(request, 2048));
        return send(response, 201, { account: await accounts.create(body.name, body.password) });
      }
      if (path.startsWith('/v1/provider/openai/')) {
        const target = await runtime(account);
        if (path === '/v1/provider/openai/status' && request.method === 'GET')
          return send(response, 200, { provider: await target.provider.status(), available: Boolean(activeProviderFactory) });
        if (!activeProviderFactory) return send(response, 503, { error: 'provider_store_unavailable' });
        if (path === '/v1/provider/openai/start' && request.method === 'POST')
          return send(response, 202, { provider: target.provider.start() });
        if (path === '/v1/provider/openai/callback' && request.method === 'POST') {
          const body = json(await bytes(request, 8192));
          return send(response, 200, { provider: target.provider.submitCallback(body?.url) });
        }
        if (path === '/v1/provider/openai/cancel' && request.method === 'POST')
          return send(response, 200, { provider: target.provider.cancel() });
        if (path === '/v1/provider/openai/logout' && request.method === 'POST')
          return send(response, 200, { provider: await target.provider.logout() });
        return send(response, 404, { error: 'not_found' });
      }
      if (!path.startsWith('/v1/')) return send(response, 404, { error: 'not_found' });
      const target = await runtime(account);
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await bytes(request) : undefined;
      const upstream = await fetch(`${target.server.url}${request.url}`, { method: request.method,
        headers: { Authorization: `Bearer ${target.internalToken}`, 'Content-Type': 'application/json' },
        body, redirect: 'manual' });
      const output = Buffer.from(await upstream.arrayBuffer());
      if (accounts.session(token)?.id !== account.id) return send(response, 401, { error: 'unauthorized' });
      if (output.length > 512 * 1024) return send(response, 502, { error: 'upstream_too_large' });
      response.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(output);
    } catch (error) {
      const status = error?.message === 'invalid_json' || error?.message === 'invalid_account' || error?.message === 'invalid_callback' ? 400 :
        error?.message === 'request_too_large' ? 413 : error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500;
      send(response, status, { error: status === 500 ? 'internal' : error.message });
    }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { accounts.close(); await lock.close(); throw error; }
  return {
    url: `http://${host}:${server.address().port}`,
    async close() {
      closing = true;
      await new Promise((resolve) => server.close(resolve));
      for (const pending of runtimes.values()) {
        const target = await pending;
        await target.provider.close();
        await target.server.close();
        await target.providerRuntime?.close?.();
      }
      accounts.close();
      await lock.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MORONS_DATA_DIR: dataDir, MORONS_BOOTSTRAP_TOKEN_FILE: bootstrapFile,
    MORONS_PROVIDER_KEY_FILE: providerFile, MORONS_REPOSITORY: repository,
    MORONS_SOURCE_PATHS: sourcePaths, MORONS_PROVIDER_MODEL_ID: providerModelId,
    MORONS_RUNNER_IMAGE: runnerImage, MORONS_REVIEW_CHECK_PROFILE: checkProfile } = process.env;
  const repositoryPlan = repository && sourcePaths ?
    { repository, allowedPaths: sourcePaths.split(',').filter(Boolean),
      ...(runnerImage ? { runnerImage, checkProfile } : {}) } : null;
  Promise.all([privateFile(bootstrapFile), providerFile ? privateFile(providerFile) : Promise.resolve(null)])
    .then(async ([bootstrap, providerKey]) => {
      if (repositoryPlan?.runnerImage) {
        await assertRunnerPathSeparation(repositoryPlan.repository, bootstrapFile);
        if (providerFile) await assertRunnerPathSeparation(repositoryPlan.repository, providerFile);
      }
      return openAccountServer({ dataDir,
      bootstrapToken: bootstrap.toString('utf8').trim(), providerKey, providerModelId, repositoryPlan,
      port: Number(process.env.PORT ?? 8787) });
    })
    .then(({ url }) => process.stdout.write(`Morons local account server listening at ${url}\n`))
    .catch((error) => {
      const runnerErrors = new Set(['runner_image_digest_required', 'container_engine_not_running',
        'runner_image_not_present', 'runner_image_missing_node_or_git', 'container_runner_unavailable',
        'container_boundary_probe_failed', 'container_runner_timeout', 'runner_private_path_overlaps_source',
        'runner_source_must_have_embedded_git', 'review_check_profile_does_not_cover_approved_paths']);
      process.stderr.write(runnerErrors.has(error?.message) ?
        `Morons review runner unavailable: ${error.message}.\n` :
        'Morons account server startup failed. Check private file ownership, data directory, and lock state.\n');
      process.exitCode = 1;
    });
}

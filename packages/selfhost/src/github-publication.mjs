import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const LIMIT = Object.freeze({ patch: 2 * 1024 * 1024, blob: 8 * 1024 * 1024,
  objects: 32 * 1024 * 1024, disk: 192 * 1024 * 1024, output: 48 * 1024 * 1024,
  files: 256, manifest: 1024 * 1024, commandMs: 30000, fetchMs: 60000 });
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const objectSha = (type, value) => createHash('sha1').update(`${type} ${value.length}\0`).update(value).digest('hex');
const fail = (code) => Object.assign(new Error(code), { code });
const ensure = (condition, code) => { if (!condition) throw fail(code); };
const owner = (info) => !process.getuid || info.uid === process.getuid();
const text = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  ensure(value && Object.getPrototypeOf(value) === Object.prototype, 'github_invalid_data');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function repositoryName(value) {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value), 'github_invalid_repository');
  ensure(!value.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.git')), 'github_invalid_repository');
  return value;
}
function branchName(value) {
  ensure(text(value, 240) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') &&
    !value.endsWith('.') && !value.includes('..') && !value.includes('@{') && !/[ ~^:?*\[\\]/.test(value) &&
    !value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')), 'github_invalid_branch');
  return value;
}
function fileName(value) {
  ensure(text(value, 1024) && !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'), 'github_invalid_path');
  return value;
}
function githubUrl(value, expectedPath = null) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password &&
      (!expectedPath || url.pathname === expectedPath) ? url.href : null;
  } catch { return null; }
}
function errorCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code :
    error?.name === 'AbortError' ? 'github_operation_aborted' : 'github_operation_failed';
}
async function privateDirectory(path, create = false) {
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const info = await lstat(path);
  ensure(info.isDirectory() && !info.isSymbolicLink() && owner(info) && !(info.mode & 0o077), 'github_private_directory_required');
  ensure(await realpath(path) === path, 'github_symlink_directory_forbidden');
}
async function privateFile(path, max) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    ensure(info.isFile() && owner(info) && info.nlink === 1 && !(info.mode & 0o077) && info.size <= max, 'github_private_artifact_required');
    const value = await handle.readFile();
    ensure(value.length <= max, 'github_artifact_too_large');
    return value;
  } finally { await handle.close(); }
}
async function saveFile(path, value, immutable = false) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value); await handle.sync(); if (immutable) await handle.chmod(0o400); }
  finally { await handle.close(); }
}
async function saveJSON(path, value, immutable = false) {
  const data = `${canonical(value)}\n`;
  ensure(Buffer.byteLength(data) <= LIMIT.manifest, 'github_artifact_too_large');
  if (immutable) return saveFile(path, data, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await saveFile(temporary, data); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function trustedExecutable(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
    try {
      const path = await realpath(candidate);
      ensure(/^\/[A-Za-z0-9_.+\/-]+$/.test(path), 'github_untrusted_executable');
      const info = await stat(path);
      ensure(info.isFile() && (info.uid === 0 || owner(info)) && !(info.mode & 0o022) && (info.mode & 0o111), 'github_untrusted_executable');
      const homebrewAdmin = process.platform === 'darwin' && /^\/opt\/homebrew\/Cellar\/gh\/[A-Za-z0-9_.+-]+\/bin\/gh$/.test(path);
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        const entry = await lstat(parent);
        ensure(entry.isDirectory() && !entry.isSymbolicLink() && (entry.uid === 0 || owner(entry)) &&
          !(entry.mode & 0o002) && (!(entry.mode & 0o020) || (homebrewAdmin && entry.gid === 80 && parent.startsWith('/opt/homebrew'))), 'github_untrusted_executable');
        if (parent === '/') break;
      }
      return path;
    } catch (error) { if (candidates.length === 1) throw fail('github_trusted_executable_required'); }
  }
  throw fail('github_trusted_executable_required');
}
function terminate(child) {
  try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
}
async function processExec(file, args, { input = null, env, signal, timeoutMs = LIMIT.commandMs,
  maxOutputBytes = LIMIT.output, monitor = null } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: '/', env, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = [], stderr = [], bytes = 0, errorBytes = 0, failure = null, monitoring = false;
    const stop = (error) => { failure ||= error; terminate(child); };
    const abort = () => stop(fail('github_operation_aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => stop(fail('github_command_timeout')), timeoutMs);
    const interval = monitor ? setInterval(async () => {
      if (monitoring) return;
      monitoring = true;
      try { await monitor(); } catch (error) { stop(error); } finally { monitoring = false; }
    }, 200) : null;
    child.stdout.on('data', (part) => { bytes += part.length; if (bytes > maxOutputBytes) stop(fail('github_output_limit')); else stdout.push(part); });
    child.stderr.on('data', (part) => { errorBytes += part.length; if (errorBytes <= 16384) stderr.push(part); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { failure ||= fail(error.code === 'ENOENT' ? 'github_executable_missing' : 'github_command_failed'); });
    child.on('close', (code) => {
      clearTimeout(timeout); if (interval) clearInterval(interval); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input);
  });
}
async function ghEnvironment(home) {
  const configured = process.env.GH_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'gh') : join(homedir(), '.config', 'gh'));
  ensure(isAbsolute(configured), 'github_invalid_host_configuration');
  const config = await realpath(configured).catch((error) => { if (error.code === 'ENOENT') return resolve(configured); throw error; });
  try {
    const info = await lstat(config);
    ensure(info.isDirectory() && !info.isSymbolicLink() && owner(info) && !(info.mode & 0o022), 'github_untrusted_host_configuration');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: home, GH_CONFIG_DIR: config,
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat', NO_COLOR: '1' };
}
const encode = (value) => encodeURIComponent(value);

export function createGitHubAdapter({ exec = processExec, ghPath } = {}) {
  let gh;
  const executable = async () => {
    try { return gh ||= await trustedExecutable(ghPath ? [ghPath] : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']); }
    catch { throw fail('github_cli_unavailable'); }
  };
  async function request(method, path, body, signal, token = null) {
    ensure(method !== 'POST' || token, 'github_bound_identity_required');
    ensure(/^\/repos\/[A-Za-z0-9_.%/-]+(?:\?[^\s#]*)?$/.test(path) || path === '/user', 'github_invalid_api_path');
    const env = await ghEnvironment('/var/empty');
    if (token) env.GH_TOKEN = token;
    const args = ['api', '--hostname', 'github.com', '--include', '--method', method,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', path];
    if (body !== undefined) args.push('--input', '-');
    const result = await exec(await executable(), args, { env, signal,
      input: body === undefined ? null : JSON.stringify(body), maxOutputBytes: LIMIT.output, timeoutMs: LIMIT.commandMs });
    const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '');
    ensure(Buffer.byteLength(output) <= LIMIT.output, 'github_output_limit');
    const header = output.match(/^HTTP\/[^\s]+\s+(\d{3})[^\r\n]*\r?\n/);
    const status = header ? Number(header[1]) : Number(String(result.stderr ?? '').match(/HTTP (\d{3})/)?.[1] || 0);
    const separator = output.search(/\r?\n\r?\n/);
    const payload = header && separator >= 0 ? output.slice(separator + (output.slice(separator).startsWith('\r\n') ? 4 : 2)) : output;
    if ((result.code ?? result.exitCode ?? 0) !== 0 || status >= 400) {
      const error = fail(status === 404 ? 'github_not_found' : status === 401 ? 'github_authentication_required' :
        status === 403 ? 'github_permission_denied' : status === 422 ? 'github_remote_rejected' : 'github_remote_request_failed');
      error.status = status;
      throw error;
    }
    try { return JSON.parse(payload); } catch { throw fail('github_invalid_api_response'); }
  }
  const endpoint = (repository) => `/repos/${repositoryName(repository)}`;
  const optional = async (operation) => { try { return await operation(); } catch (error) { if (error.status === 404 || error.code === 'github_not_found') return null; throw error; } };
  async function forConnection(connection, signal) {
    ensure(positiveId(connection?.userId) && text(connection.login, 39) && /^[A-Za-z0-9-]+$/.test(connection.login), 'github_invalid_identity');
    const result = await exec(await executable(), ['auth', 'token', '--hostname', 'github.com', '--user', connection.login], {
      env: await ghEnvironment('/var/empty'), signal, timeoutMs: LIMIT.commandMs, maxOutputBytes: 8192 });
    ensure((result.code ?? result.exitCode ?? 0) === 0, 'github_authentication_required');
    const captured = (Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '')).trim();
    ensure(captured.length >= 16 && captured.length <= 4096 && /^[A-Za-z0-9_=-]+$/.test(captured), 'github_authentication_required');
    const bound = makeAdapter(captured);
    const actual = identity(await bound.identity(signal));
    ensure(actual.userId === connection.userId && actual.login === connection.login, 'github_identity_changed');
    return bound;
  }
  function makeAdapter(token = null) {
    const api = (method, path, body, signal) => request(method, path, body, signal, token);
    return {
      forConnection,
      async identity(signal) { return api('GET', '/user', undefined, signal); },
      async repository(repository, signal) { return api('GET', endpoint(repository), undefined, signal); },
      async base(repository, baseRef, signal) {
        const ref = await api('GET', `${endpoint(repository)}/git/ref/heads/${encode(branchName(baseRef))}`, undefined, signal);
        ensure(ref.ref === `refs/heads/${baseRef}` && ref.object?.type === 'commit' && SHA.test(ref.object.sha), 'github_invalid_base');
        const commit = await api('GET', `${endpoint(repository)}/git/commits/${ref.object.sha}`, undefined, signal);
        return { sha: ref.object.sha, tree: commit.tree?.sha };
      },
      async fetchBase({ repository, baseRef, git }, signal) {
        ensure(token, 'github_bound_identity_required');
        const ghFile = await executable();
        const env = await ghEnvironment('/var/empty');
        if (token) env.GH_TOKEN = token;
        return git(['-c', 'credential.helper=', '-c', `credential.helper=!'${ghFile}' auth git-credential`,
          '-c', 'credential.https://github.com.useHttpPath=true', 'fetch', '--no-tags', '--no-recurse-submodules',
          '--depth=1', '--no-write-fetch-head', `https://github.com/${repositoryName(repository)}.git`,
          `refs/heads/${branchName(baseRef)}:refs/morons/base`], null, signal, { env, fetch: true });
      },
      async writeObject(repository, type, body, signal) {
        ensure(['blobs', 'trees', 'commits'].includes(type), 'github_invalid_object');
        return api('POST', `${endpoint(repository)}/git/${type}`, body, signal);
      },
      async readObject(repository, type, sha, signal) {
        ensure(['blobs', 'trees', 'commits'].includes(type) && SHA.test(sha), 'github_invalid_object');
        return optional(() => api('GET', `${endpoint(repository)}/git/${type}/${sha}`, undefined, signal));
      },
      async commit(repository, sha, signal) { return this.readObject(repository, 'commits', sha, signal); },
      async createRef(repository, ref, sha, signal) {
        ensure(ref.startsWith('refs/heads/morons/') && ID.test(ref.slice('refs/heads/morons/'.length)) && SHA.test(sha), 'github_invalid_publication_ref');
        return api('POST', `${endpoint(repository)}/git/refs`, { ref, sha }, signal);
      },
      async findRef(repository, branch, signal) {
        return optional(() => api('GET', `${endpoint(repository)}/git/ref/heads/${encode(branchName(branch))}`, undefined, signal));
      },
      async findPull(repository, { head, base }, signal) {
        const pulls = await api('GET', `${endpoint(repository)}/pulls?state=all&head=${encode(`${repository.split('/')[0]}:${head}`)}&base=${encode(base)}&per_page=100`, undefined, signal);
        ensure(Array.isArray(pulls) && pulls.length < 100, 'github_ambiguous_pull_request');
        const matching = pulls.filter((pull) => pull.head?.ref === head && pull.base?.ref === base);
        ensure(matching.length <= 1, 'github_ambiguous_pull_request');
        return matching[0] || null;
      },
      async createPull(repository, body, signal) { return api('POST', `${endpoint(repository)}/pulls`, body, signal); },
      async checks(repository, sha, signal) {
        ensure(SHA.test(sha), 'github_invalid_commit');
        const checkRuns = await api('GET', `${endpoint(repository)}/commits/${sha}/check-runs?per_page=100`, undefined, signal);
        const statuses = await api('GET', `${endpoint(repository)}/commits/${sha}/status?per_page=100`, undefined, signal);
        ensure(statuses.sha === sha, 'github_check_head_mismatch');
        return { sha, checkRuns: checkRuns.check_runs, statuses: statuses.statuses, state: statuses.state,
          truncated: checkRuns.total_count > 100 || statuses.total_count > 100 };
      },
    };
  }
  return makeAdapter();
}

function identity(value) {
  ensure(positiveId(value?.id) && text(value.login, 39) && /^[A-Za-z0-9-]+$/.test(value.login), 'github_invalid_identity');
  return { userId: value.id, login: value.login };
}
function repository(value, requested) {
  ensure(positiveId(value?.id) && value.permissions?.push === true && !value.archived && !value.disabled &&
    repositoryName(value.full_name).toLowerCase() === requested.toLowerCase() && value.owner?.login === value.full_name.split('/')[0] &&
    value.name === value.full_name.split('/')[1], 'github_repository_unavailable');
  branchName(value.default_branch);
  return { repositoryId: value.id, repository: value.full_name, defaultBranch: value.default_branch };
}
function connectionData(value) {
  ensure(value && ID.test(value.id) && text(value.accountId) && value.host === 'github.com' &&
    positiveId(value.userId) && text(value.login, 39) && positiveId(value.repositoryId), 'github_invalid_connection');
  repositoryName(value.repository); branchName(value.baseRef); branchName(value.defaultBranch);
  return value;
}
function reviewed(value, allowedPaths) {
  ensure(value && text(value.id) && text(value.sessionId) && value.decision === 'approve' &&
    SHA.test(value.baseRevision) && SHA.test(value.proposalRevision) && typeof value.diff === 'string' &&
    Buffer.byteLength(value.diff) > 0 && Buffer.byteLength(value.diff) <= LIMIT.patch && HASH.test(value.diffHash) &&
    digest(value.diff) === value.diffHash && typeof value.mainReview === 'string' && value.mainReview.trim() &&
    Buffer.byteLength(value.mainReview) <= LIMIT.patch && Array.isArray(value.checks) && value.checks.length > 0 &&
    value.checks.length <= 256 && value.checks.every((check) => check && check.ok === true), 'github_approved_review_required');
  ensure(Array.isArray(allowedPaths) && allowedPaths.length > 0 && allowedPaths.length <= 100000, 'github_allowlist_required');
  ensure(Buffer.byteLength(canonical(value.checks)) <= LIMIT.patch, 'github_checks_limit');
  ensure(allowedPaths.reduce((size, path) => size + fileName(path).length, 0) <= 8 * 1024 * 1024, 'github_allowlist_limit');
  return new Set(allowedPaths);
}
async function directoryBytes(path, budget = { bytes: 0, entries: 0 }) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    ensure(++budget.entries <= 100000, 'github_repository_limit');
    const child = join(path, item.name);
    let info;
    try { info = await lstat(child); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    ensure(!info.isSymbolicLink(), 'github_repository_symlink');
    if (info.isDirectory()) await directoryBytes(child, budget);
    else { budget.bytes += info.size; ensure(budget.bytes <= LIMIT.disk, 'github_repository_limit'); }
  }
  return budget.bytes;
}
function baseData(value) {
  ensure(value && SHA.test(value.sha) && SHA.test(value.tree), 'github_invalid_base');
  return value;
}
function parseChanges(output, allowed) {
  const data = output.toString('utf8');
  ensure(Buffer.from(data).equals(output), 'github_non_utf8_path');
  const parts = data.split('\0');
  ensure(parts.pop() === '', 'github_invalid_diff');
  ensure(parts.length > 0 && parts.length % 2 === 0 && parts.length <= LIMIT.files * 2, 'github_change_limit');
  const changes = [];
  for (let i = 0; i < parts.length; i += 2) {
    const match = parts[i].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/);
    const path = fileName(parts[i + 1]);
    ensure(match && allowed.has(path), 'github_path_or_mode_forbidden');
    ensure(['000000', '100644', '100755'].includes(match[1]) && ['000000', '100644', '100755'].includes(match[2]), 'github_file_mode_forbidden');
    changes.push({ path, mode: match[2] === '000000' ? match[1] : match[2], type: 'blob',
      sha: match[2] === '000000' ? null : match[4] });
  }
  ensure(new Set(changes.map((change) => change.path)).size === changes.length, 'github_duplicate_path');
  return changes;
}
function sameRef(ref, manifest) {
  ensure(ref && ref.ref === `refs/heads/${manifest.branch}` && ref.object?.type === 'commit' &&
    ref.object.sha === manifest.commit, 'github_ref_conflict');
  return ref;
}
function samePull(pull, manifest, strict = true) {
  ensure(pull && positiveId(pull.number) && pull.head?.ref === manifest.branch && pull.head?.sha === manifest.commit &&
    pull.head?.repo?.id === manifest.repositoryId && pull.base?.ref === manifest.baseRef &&
    pull.base?.repo?.id === manifest.repositoryId && typeof pull.draft === 'boolean' &&
    (!strict || (pull.draft === true && !pull.merged_at && pull.title === manifest.prTitle &&
      pull.body === manifest.prBody && pull.maintainer_can_modify === false)) &&
    githubUrl(pull.html_url, `/${manifest.repository}/pull/${pull.number}`), 'github_pull_request_conflict');
  return pull;
}
function descriptorFor(manifest) {
  return { kind: 'external-request', sessionId: manifest.sessionId, proposalId: manifest.reviewId,
    baseRevision: manifest.baseRevision, action: { operation: 'github-publish', artifactId: manifest.id,
      accountId: manifest.accountId, connectionId: manifest.connectionId, host: 'github.com',
      userId: manifest.userId, login: manifest.login, repository: manifest.repository,
      githubRepositoryId: manifest.repositoryId, baseRef: manifest.baseRef, baseRevision: manifest.baseRevision,
      proposalRevision: manifest.proposalRevision, patchHash: manifest.patchHash,
      mainAgentReviewHash: manifest.mainReviewHash, checksHash: manifest.checksHash,
      allowlistHash: manifest.allowlistHash, manifestHash: manifest.contentHash, branch: manifest.branch,
      tree: manifest.tree, commit: manifest.commit, author: manifest.author, committer: manifest.committer,
      date: manifest.date, message: manifest.message, prTitle: manifest.prTitle, prBody: manifest.prBody,
      draft: true, maintainerCanModify: false } };
}
function contentHash(manifest) {
  const { descriptor, contentHash: ignored, ...content } = manifest;
  return digest(canonical(content));
}
function manifestData(manifest, connection) {
  ensure(manifest && manifest.version === 1 && ID.test(manifest.id) && manifest.accountId === connection.accountId &&
    manifest.connectionId === connection.id && manifest.repositoryId === connection.repositoryId &&
    manifest.repository === connection.repository && manifest.userId === connection.userId && manifest.login === connection.login &&
    manifest.baseRef === connection.baseRef && manifest.branch === `morons/${manifest.id}` &&
    manifest.branch !== connection.defaultBranch && manifest.branch !== connection.baseRef &&
    SHA.test(manifest.commit) && SHA.test(manifest.tree) && SHA.test(manifest.baseRevision) && SHA.test(manifest.baseTree) &&
    manifest.contentHash === contentHash(manifest) && canonical(manifest.descriptor) === canonical(descriptorFor(manifest)), 'github_manifest_conflict');
  return manifest;
}

export function createGitHubPublication({ rootPath, accountId = null, adapter = createGitHubAdapter(), now = Date.now } = {}) {
  ensure(typeof rootPath === 'string' && isAbsolute(rootPath), 'github_private_root_required');
  const root = resolve(rootPath), active = new Set(), busy = new Set();
  ensure(accountId === null || text(accountId), 'github_account_required');
  let closed = false, ready, boundAccountId = accountId;
  function bindAccount(value) {
    ensure(text(value), 'github_account_required');
    boundAccountId ??= value;
    ensure(boundAccountId === value, 'github_account_mismatch');
  }
  async function initialize() {
    await privateDirectory(root, true);
    for (const name of ['artifacts', 'scratch', 'locks']) await privateDirectory(join(root, name), true);
  }
  async function operation(signal, action) {
    ensure(!closed, 'github_runtime_closed');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const completion = (async () => {
      combined.throwIfAborted();
      await (ready ||= initialize());
      return action(combined);
    })();
    const pending = { controller, completion }; active.add(pending);
    try { return await completion; } finally { active.delete(pending); }
  }
  async function verifyConnection(connection, signal, expectedBase = null, remote = adapter) {
    connectionData(connection); bindAccount(connection.accountId);
    const user = identity(await remote.identity(signal));
    ensure(user.userId === connection.userId && user.login === connection.login, 'github_identity_changed');
    const repo = repository(await remote.repository(connection.repository, signal), connection.repository);
    ensure(repo.repositoryId === connection.repositoryId && repo.repository === connection.repository &&
      repo.defaultBranch === connection.defaultBranch, 'github_repository_changed');
    const base = baseData(await remote.base(connection.repository, connection.baseRef, signal));
    if (expectedBase) ensure(base.sha === expectedBase, 'github_base_changed');
    return base;
  }
  async function savedManifest(input, connection) {
    connectionData(connection); bindAccount(connection.accountId);
    ensure(input && ID.test(input.id), 'github_invalid_artifact');
    const directory = join(root, 'artifacts', input.id);
    await privateDirectory(directory);
    const saved = JSON.parse((await privateFile(join(directory, 'manifest.json'), LIMIT.manifest)).toString('utf8'));
    ensure(canonical(input) === canonical(saved), 'github_manifest_conflict');
    manifestData(saved, connection);
    return { manifest: freeze(saved), directory };
  }
  async function receiptFor(directory, manifest) {
    const receipt = JSON.parse((await privateFile(join(directory, 'receipt.json'), LIMIT.manifest)).toString('utf8'));
    ensure(receipt.artifactId === manifest.id && receipt.manifestHash === manifest.contentHash &&
      receipt.accountId === manifest.accountId && receipt.connectionId === manifest.connectionId &&
      receipt.repositoryId === manifest.repositoryId && receipt.headSha === manifest.commit, 'github_receipt_conflict');
    return receipt;
  }
  async function artifactLock(id, action) {
    ensure(!busy.has(id), 'github_publication_busy');
    busy.add(id);
    const path = join(root, 'locks', id);
    let acquired = false;
    try {
      try { await saveFile(path, canonical({ pid: process.pid, id })); acquired = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const prior = JSON.parse((await privateFile(path, 1024)).toString('utf8'));
        ensure(positiveId(prior.pid) && prior.id === id, 'github_publication_busy');
        let alive = true;
        try { process.kill(prior.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
        ensure(!alive, 'github_publication_busy');
        await rm(path);
        await saveFile(path, canonical({ pid: process.pid, id })); acquired = true;
      }
      return await action();
    } finally { if (acquired) await rm(path, { force: true }); busy.delete(id); }
  }
  return {
    connect({ accountId, repository: fullName, baseRef } = {}, signal) {
      return operation(signal, async (scopedSignal) => {
        bindAccount(accountId); repositoryName(fullName);
        const user = identity(await adapter.identity(scopedSignal));
        const remote = adapter.forConnection ? await adapter.forConnection(user, scopedSignal) : adapter;
        const repo = repository(await remote.repository(fullName, scopedSignal), fullName);
        const selectedBase = branchName(baseRef ?? repo.defaultBranch);
        baseData(await remote.base(repo.repository, selectedBase, scopedSignal));
        return freeze({ version: 1, id: randomUUID().replaceAll('-', ''), accountId, host: 'github.com',
          ...user, ...repo, baseRef: selectedBase, createdAt: now() });
      });
    },
    prepare({ connection, review, allowedPaths, title, body } = {}, signal) {
      return operation(signal, async (scopedSignal) => {
        connection = clone(connectionData(connection)); review = clone(review); allowedPaths = clone(allowedPaths);
        const allowed = reviewed(review, allowedPaths);
        const remote = adapter.forConnection ? await adapter.forConnection(connection, scopedSignal) : adapter;
        const base = await verifyConnection(connection, scopedSignal, review.baseRevision, remote);
        const id = randomUUID().replaceAll('-', '');
        const scratch = await mkdtemp(join(root, 'scratch', `${id}-`));
        await chmod(scratch, 0o700);
        let artifact = null;
        try {
          const gitPath = await trustedExecutable(['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']);
          const gitDir = join(scratch, 'repository.git'), home = join(scratch, 'home');
          await mkdir(home, { mode: 0o700 });
          const gitEnv = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
            GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'https',
            GIT_INDEX_FILE: join(scratch, 'index'), GIT_OPTIONAL_LOCKS: '0' };
          const config = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
            '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.sshCommand=/usr/bin/false',
            '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'commit.gpgSign=false',
            '-c', 'tag.gpgSign=false', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
            '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'protocol.allow=never',
            '-c', 'protocol.https.allow=always', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
            '-c', 'diff.external=', '-c', 'core.logAllRefUpdates=false'];
          const git = async (args, input = null, callSignal = scopedSignal, extra = {}) => {
            const result = await processExec(gitPath, ['--git-dir', gitDir, ...config, ...args], { input,
              env: { ...gitEnv, ...(extra.env || {}), ...(extra.commitEnv || {}) }, signal: callSignal,
              timeoutMs: extra.fetch ? LIMIT.fetchMs : LIMIT.commandMs,
              maxOutputBytes: LIMIT.output, monitor: () => directoryBytes(scratch) });
            ensure(result.code === 0, 'github_git_command_failed');
            return result.stdout;
          };
          await git(['init', '--bare', '--object-format=sha1', '--template=', gitDir]);
          await remote.fetchBase({ repository: connection.repository, baseRef: connection.baseRef, gitDir, git }, scopedSignal);
          await directoryBytes(scratch);
          const fetched = (await git(['rev-parse', '--verify', 'refs/morons/base^{commit}'])).toString('utf8').trim();
          ensure(fetched === review.baseRevision, 'github_fetched_base_changed');
          ensure((await git(['rev-parse', `${fetched}^{tree}`])).toString('utf8').trim() === base.tree, 'github_fetched_tree_changed');
          await verifyConnection(connection, scopedSignal, review.baseRevision, remote);
          await git(['read-tree', fetched]);
          await git(['apply', '--cached', '--check', '--whitespace=nowarn', '-'], review.diff);
          await git(['apply', '--cached', '--whitespace=nowarn', '-'], review.diff);
          const changes = parseChanges(await git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', fetched, '--']), allowed);
          const tree = (await git(['write-tree'])).toString('utf8').trim();
          ensure(SHA.test(tree) && tree !== base.tree, 'github_empty_proposal');
          const date = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
          const author = { name: 'Morons', email: 'morons@users.noreply.github.com', date }, committer = { ...author };
          const prTitle = title ?? `Reviewed proposal ${review.id}`;
          ensure(text(prTitle, 200) && prTitle.trim() === prTitle, 'github_invalid_title');
          const branch = `morons/${id}`;
          ensure(branch !== connection.defaultBranch && branch !== connection.baseRef, 'github_protected_target');
          const message = `${prTitle}\n\nMorons review: ${review.id}\nPatch SHA-256: ${review.diffHash}\n`;
          const marker = `Morons publication: ${id}`;
          const requestedBody = body ?? `Reviewed proposal ${review.id}.\n\nPatch SHA-256: ${review.diffHash}`;
          ensure(typeof requestedBody === 'string' && Buffer.byteLength(requestedBody) <= 30000 && !requestedBody.includes('\0'), 'github_invalid_body');
          const prBody = `${requestedBody}\n\n${marker}`;
          const commitEnv = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: date };
          const commit = (await git(['commit-tree', tree, '-p', fetched], message, scopedSignal, { commitEnv })).toString('utf8').trim();
          ensure(SHA.test(commit), 'github_invalid_commit');
          const commitData = await git(['cat-file', 'commit', commit]);
          ensure(objectSha('commit', commitData) === commit, 'github_commit_hash_mismatch');
          artifact = join(root, 'artifacts', id);
          await mkdir(artifact, { mode: 0o700 });
          const blobDirectory = join(artifact, 'blobs'); await mkdir(blobDirectory, { mode: 0o700 });
          const objects = [], seen = new Set(); let total = 0;
          for (const change of changes) {
            if (!change.sha || seen.has(change.sha)) continue;
            seen.add(change.sha);
            const size = Number((await git(['cat-file', '-s', change.sha])).toString('utf8').trim());
            ensure(Number.isSafeInteger(size) && size >= 0 && size <= LIMIT.blob && (total += size) <= LIMIT.objects, 'github_blob_limit');
            const bytes = await git(['cat-file', 'blob', change.sha]);
            ensure(bytes.length === size && objectSha('blob', bytes) === change.sha, 'github_blob_hash_mismatch');
            await saveFile(join(blobDirectory, change.sha), bytes, true);
            objects.push({ sha: change.sha, size, contentHash: digest(bytes) });
          }
          const manifest = { version: 1, id, accountId: connection.accountId, connectionId: connection.id,
            host: 'github.com', userId: connection.userId, login: connection.login, repository: connection.repository,
            repositoryId: connection.repositoryId, defaultBranch: connection.defaultBranch, reviewId: review.id,
            sessionId: review.sessionId, baseRef: connection.baseRef, baseRevision: fetched, baseTree: base.tree,
            proposalRevision: review.proposalRevision, patchHash: review.diffHash, mainReviewHash: digest(review.mainReview),
            checksHash: digest(canonical(review.checks)), allowlistHash: digest(canonical([...allowed].sort())),
            branch, tree, commit, author, committer, date, message, prTitle, prBody, changes, objects, createdAt: now() };
          manifest.contentHash = contentHash(manifest); manifest.descriptor = descriptorFor(manifest);
          manifestData(manifest, connection);
          await saveJSON(join(artifact, 'manifest.json'), manifest, true);
          const receipt = { version: 1, id, artifactId: id, accountId: manifest.accountId, connectionId: manifest.connectionId,
            repository: manifest.repository, repositoryId: manifest.repositoryId, branch, baseRef: manifest.baseRef,
            baseRevision: fetched, headSha: commit, tree, manifestHash: manifest.contentHash, status: 'prepared',
            uploaded: [], pending: null, refCreated: false, pullNumber: null, pullUrl: null, error: null, updatedAt: now() };
          await saveJSON(join(artifact, 'receipt.json'), receipt);
          return freeze(manifest);
        } catch (error) { if (artifact) await rm(artifact, { recursive: true, force: true }); throw error; }
        finally { await rm(scratch, { recursive: true, force: true }); }
      });
    },
    publish({ connection, manifest: requestedManifest, assertApproval } = {}, signal) {
      return operation(signal, async (scopedSignal) => {
        ensure(typeof assertApproval === 'function', 'github_explicit_approval_required');
        connection = clone(connectionData(connection));
        const { manifest, directory } = await savedManifest(requestedManifest, connection);
        const remote = adapter.forConnection ? await adapter.forConnection(connection, scopedSignal) : adapter;
        return artifactLock(manifest.id, async () => {
          const receipt = await receiptFor(directory, manifest);
          const save = async () => { receipt.updatedAt = now(); await saveJSON(join(directory, 'receipt.json'), receipt); };
          const approved = async () => {
            scopedSignal.throwIfAborted();
            ensure(await assertApproval(manifest.descriptor) !== false, 'github_approval_revoked');
            await verifyConnection(connection, scopedSignal, manifest.baseRevision, remote);
            scopedSignal.throwIfAborted();
            ensure(await assertApproval(manifest.descriptor) !== false, 'github_approval_revoked');
          };
          const readObject = async (type, sha) => {
            if (remote.readObject) return remote.readObject(manifest.repository, type, sha, scopedSignal);
            if (type === 'commits' && remote.commit) return remote.commit(manifest.repository, sha, scopedSignal);
            return null;
          };
          const writeObject = async (type, sha, payload) => {
            const key = `${type}:${sha}`;
            if (receipt.uploaded.includes(key)) return;
            if (receipt.pending?.key === key) {
              const existing = await readObject(type, sha);
              if (existing) {
                ensure(existing.sha === sha, 'github_remote_object_mismatch');
                receipt.uploaded.push(key); receipt.pending = null; await save(); return;
              }
            }
            await approved();
            receipt.pending = { kind: 'object', key, type, sha }; await save();
            let result;
            await approved();
            try { result = await remote.writeObject(manifest.repository, type, payload, scopedSignal); }
            catch (error) {
              try { result = await readObject(type, sha); } catch {}
              if (!result) throw error;
            }
            ensure(result.sha === sha, 'github_remote_object_mismatch');
            if (type === 'commits') ensure(result.tree?.sha === manifest.tree && result.parents?.length === 1 &&
              result.parents[0].sha === manifest.baseRevision, 'github_remote_commit_mismatch');
            receipt.uploaded.push(key); receipt.pending = null; await save();
          };
          try {
            await approved();
            receipt.status = 'publishing'; receipt.error = null; await save();
            let ref = await remote.findRef(manifest.repository, manifest.branch, scopedSignal);
            if (ref) { sameRef(ref, manifest); receipt.refCreated = true; await save(); }
            else {
              ensure(!receipt.refCreated, 'github_published_ref_missing');
              await privateDirectory(join(directory, 'blobs'));
              for (const object of manifest.objects) {
                const bytes = await privateFile(join(directory, 'blobs', object.sha), LIMIT.blob);
                ensure(bytes.length === object.size && digest(bytes) === object.contentHash && objectSha('blob', bytes) === object.sha, 'github_blob_hash_mismatch');
                await writeObject('blobs', object.sha, { content: bytes.toString('base64'), encoding: 'base64' });
              }
              await writeObject('trees', manifest.tree, { base_tree: manifest.baseTree, tree: manifest.changes });
              await writeObject('commits', manifest.commit, { message: manifest.message, tree: manifest.tree,
                parents: [manifest.baseRevision], author: manifest.author, committer: manifest.committer });
              const remoteCommit = await readObject('commits', manifest.commit);
              ensure(remoteCommit && remoteCommit.sha === manifest.commit && remoteCommit.tree?.sha === manifest.tree &&
                remoteCommit.parents?.length === 1 && remoteCommit.parents[0].sha === manifest.baseRevision, 'github_remote_commit_mismatch');
              await approved();
              ref = await remote.findRef(manifest.repository, manifest.branch, scopedSignal);
              if (ref) sameRef(ref, manifest);
              else {
                receipt.pending = { kind: 'ref', ref: `refs/heads/${manifest.branch}`, sha: manifest.commit }; await save();
                await approved();
                try { ref = await remote.createRef(manifest.repository, `refs/heads/${manifest.branch}`, manifest.commit, scopedSignal); }
                catch (error) { try { ref = await remote.findRef(manifest.repository, manifest.branch, scopedSignal); } catch {} if (!ref) throw error; }
                sameRef(ref, manifest);
              }
              receipt.refCreated = true; receipt.pending = null; receipt.status = 'ref-created'; await save();
            }
            let pull = await remote.findPull(manifest.repository, { head: manifest.branch, base: manifest.baseRef, headSha: manifest.commit }, scopedSignal);
            if (!pull) {
              ensure(!receipt.pullNumber, 'github_published_pull_missing');
              await approved();
              sameRef(await remote.findRef(manifest.repository, manifest.branch, scopedSignal), manifest);
              receipt.pending = { kind: 'pull', head: manifest.branch, sha: manifest.commit }; await save();
              await approved();
              try { pull = await remote.createPull(manifest.repository, { title: manifest.prTitle, body: manifest.prBody,
                head: manifest.branch, base: manifest.baseRef, draft: true, maintainer_can_modify: false }, scopedSignal); }
              catch (error) { try { pull = await remote.findPull(manifest.repository, { head: manifest.branch, base: manifest.baseRef, headSha: manifest.commit }, scopedSignal); } catch {} if (!pull) throw error; }
            }
            samePull(pull, manifest);
            receipt.pullNumber = pull.number; receipt.pullUrl = githubUrl(pull.html_url, `/${manifest.repository}/pull/${pull.number}`);
            receipt.pending = null; receipt.error = null; receipt.status = pull.state === 'closed' ? 'closed' : 'draft-created';
            await save(); return freeze(clone(receipt));
          } catch (error) {
            receipt.status = receipt.pending ? 'uncertain' : 'failed'; receipt.error = errorCode(error);
            await save();
            const failure = fail(receipt.error); failure.receipt = freeze(clone(receipt)); throw failure;
          }
        });
      });
    },
    status({ connection, receipt: requestedReceipt } = {}, signal) {
      return operation(signal, async (scopedSignal) => {
        connection = clone(connectionData(connection));
        bindAccount(connection.accountId);
        const remote = adapter.forConnection ? await adapter.forConnection(connection, scopedSignal) : adapter;
        const id = requestedReceipt?.artifactId ?? requestedReceipt?.id;
        ensure(ID.test(id), 'github_invalid_receipt');
        const directory = join(root, 'artifacts', id);
        await privateDirectory(directory);
        const manifest = manifestData(JSON.parse((await privateFile(join(directory, 'manifest.json'), LIMIT.manifest)).toString('utf8')), connection);
        return artifactLock(id, async () => {
          const receipt = await receiptFor(directory, manifest);
          if (requestedReceipt?.headSha) ensure(requestedReceipt.headSha === manifest.commit, 'github_receipt_conflict');
          const user = identity(await remote.identity(scopedSignal));
          ensure(user.userId === connection.userId && user.login === connection.login, 'github_identity_changed');
          const repo = repository(await remote.repository(connection.repository, scopedSignal), connection.repository);
          ensure(repo.repositoryId === connection.repositoryId && repo.repository === connection.repository, 'github_repository_changed');
          const ref = await remote.findRef(manifest.repository, manifest.branch, scopedSignal);
          if (!ref) {
            ensure(!receipt.refCreated && !receipt.pullNumber, 'github_published_ref_missing');
            const existingPull = await remote.findPull(manifest.repository, { head: manifest.branch, base: manifest.baseRef, headSha: manifest.commit }, scopedSignal);
            ensure(!existingPull, 'github_published_ref_missing');
            return freeze({ ...receipt, overall: 'unpublished', checkRuns: [], statuses: [],
              remoteObjectsMayExist: receipt.uploaded.length > 0 || receipt.pending?.kind === 'object' });
          }
          sameRef(ref, manifest); receipt.refCreated = true;
          const pull = await remote.findPull(manifest.repository, { head: manifest.branch, base: manifest.baseRef, headSha: manifest.commit }, scopedSignal);
          if (pull) {
            samePull(pull, manifest, false); receipt.pullNumber = pull.number;
            receipt.pullUrl = githubUrl(pull.html_url, `/${manifest.repository}/pull/${pull.number}`);
            receipt.pullState = pull.state; receipt.draft = pull.draft; receipt.mergedAt = pull.merged_at ?? null;
            receipt.status = pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft-created' : 'open'; receipt.pending = null;
          } else { ensure(!receipt.pullNumber, 'github_published_pull_missing'); receipt.status = 'ref-created'; }
          const checks = await remote.checks(manifest.repository, manifest.commit, scopedSignal);
          ensure(checks && checks.sha === manifest.commit && Array.isArray(checks.checkRuns) && Array.isArray(checks.statuses) &&
            checks.checkRuns.length <= 100 && checks.statuses.length <= 100, 'github_invalid_checks');
          const checkRuns = checks.checkRuns.map((check) => {
            ensure(check.head_sha === manifest.commit && positiveId(check.id), 'github_check_head_mismatch');
            return { id: check.id, name: String(check.name ?? '').slice(0, 200), status: check.status,
              conclusion: check.conclusion ?? null, url: githubUrl(check.html_url ?? check.details_url) };
          });
          const statuses = checks.statuses.map((item) => ({ id: item.id, context: String(item.context ?? '').slice(0, 200),
            state: item.state, url: githubUrl(item.target_url) }));
          const failed = checkRuns.some((check) => ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(check.conclusion)) ||
            statuses.some((item) => ['error', 'failure'].includes(item.state));
          const pending = checks.truncated || checkRuns.some((check) => check.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(check.conclusion)) ||
            statuses.some((item) => item.state !== 'success');
          const overall = failed ? 'failure' : pending ? 'pending' : checkRuns.length + statuses.length ? 'success' : 'none';
          receipt.updatedAt = now(); await saveJSON(join(directory, 'receipt.json'), receipt);
          return freeze({ ...receipt, overall, checkRuns, statuses, truncated: Boolean(checks.truncated) });
        });
      });
    },
    async close() { closed = true; for (const task of active) task.controller.abort(); await Promise.allSettled([...active].map((task) => task.completion)); },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_PERMISSION_MODE = 'full-access';
export const PERMISSION_MODES = Object.freeze([
  Object.freeze({ id: 'approval-required', label: 'Supervised', description: 'Ask before commands and file changes.' }),
  Object.freeze({ id: 'auto-accept-edits', label: 'Auto-accept edits', description: 'Auto-approve edits, ask before other actions.' }),
  Object.freeze({ id: 'auto', label: 'Auto', description: 'Supported providers approve routine actions; others still ask.' }),
  Object.freeze({ id: 'full-access', label: 'Full access', description: 'Allow commands and edits without prompts.' }),
]);
export const PERMISSION_REFERENCE = Object.freeze({
  repository: 'https://github.com/pingdotgg/t3code',
  revision: '2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f',
  defaultPath: 'packages/contracts/src/providerPolicy.ts',
  piMappingPath: 'packages/provider-pi/src/server/mcpExtensionSource.ts',
  autoReviewSupported: false,
});

const modes = new Set(PERMISSION_MODES.map(({ id }) => id));
const kinds = new Set(['read', 'edit', 'command', 'source-apply', 'external-request', 'github-publish']);
const liveStates = ['pending', 'ready', 'active'];
const strengths = { 'approval-required': 0, auto: 0, 'auto-accept-edits': 1, 'full-access': 2 };
function failure(code) { return Object.assign(new Error(code), { code }); }
function checkMode(mode) { if (!modes.has(mode)) throw failure('invalid_permission_mode'); return mode; }
function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\x00-\x1f]/.test(value))
    throw failure('invalid_permission_scope');
  return value;
}
function optionalIdentifier(value) { return value === null || value === undefined ? null : identifier(value); }
function canonical(value, depth = 0) {
  if (depth > 32) throw failure('invalid_permission_action');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw failure('invalid_permission_action');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
}
function immutable(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) immutable(item); Object.freeze(value); }
  return value;
}
export function permissionActionDescriptor(input) {
  if (!input || !kinds.has(input.kind) || !input.action || Array.isArray(input.action) || typeof input.action !== 'object')
    throw failure('invalid_permission_action');
  const descriptor = {
    sessionId: identifier(input.sessionId), workspaceId: identifier(input.workspaceId),
    repositoryId: optionalIdentifier(input.repositoryId), kind: input.kind, action: input.action,
    proposalId: optionalIdentifier(input.proposalId), baseRevision: optionalIdentifier(input.baseRevision),
  };
  if (descriptor.kind === 'source-apply' && (!descriptor.repositoryId || !descriptor.proposalId ||
      !/^[0-9a-f]{40}$/.test(descriptor.baseRevision ?? '') ||
      !/^[0-9a-f]{64}$/.test(descriptor.action.patchHash ?? '') ||
      !/^[0-9a-f]{64}$/.test(descriptor.action.mainAgentReviewHash ?? '')))
    throw failure('source_apply_review_required');
  if (descriptor.kind === 'github-publish' && (!descriptor.repositoryId || !descriptor.proposalId ||
      !/^[0-9a-f]{40}$/.test(descriptor.baseRevision ?? '') ||
      !/^[0-9a-f]{40}$/.test(descriptor.action.commit ?? '') ||
      !/^[0-9a-f]{40}$/.test(descriptor.action.tree ?? '') ||
      !/^[0-9a-f]{64}$/.test(descriptor.action.patchHash ?? '') ||
      !/^[0-9a-f]{64}$/.test(descriptor.action.mainReviewHash ?? '') ||
      !descriptor.action.connectionId || !descriptor.action.accountId || descriptor.action.host !== 'github.com' ||
      !Number.isSafeInteger(descriptor.action.githubRepositoryId) || !Number.isSafeInteger(descriptor.action.userId) ||
      !/^morons\/[a-zA-Z0-9-]+$/.test(descriptor.action.branch ?? '') || descriptor.action.draft !== true))
    throw failure('github_publish_review_required');
  const serialized = canonical(descriptor);
  if (Buffer.byteLength(serialized) > 524288) throw failure('permission_action_too_large');
  return immutable(JSON.parse(serialized));
}
export function permissionActionFingerprint(input) {
  return createHash('sha256').update(canonical(permissionActionDescriptor(input))).digest('hex');
}
export function permissionRequiresApproval(mode, kind) {
  checkMode(mode);
  if (!kinds.has(kind)) throw failure('invalid_permission_action');
  if (kind === 'read') return false;
  if (kind === 'source-apply' || kind === 'external-request' || kind === 'github-publish') return true;
  if (mode === 'full-access') return false;
  return !(mode === 'auto-accept-edits' && kind === 'edit');
}

function privateDatabase(path) {
  if (path === ':memory:') return;
  if (typeof path !== 'string' || !path || path.includes('\0')) throw failure('invalid_permission_database');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (process.getuid && parent.uid !== process.getuid()) || (parent.mode & 0o022))
    throw failure('private_permission_directory_required');
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    let info;
    try { info = lstatSync(candidate); }
    catch (error) { if (error.code === 'ENOENT' && candidate !== path) continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        (process.getuid && info.uid !== process.getuid())) throw failure('private_permission_database_required');
    chmodSync(candidate, 0o600);
  }
}

export function openPermissionPolicy(path, { approvalTimeoutMs = 900000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 1 || approvalTimeoutMs > 86400000)
    throw failure('invalid_approval_timeout');
  privateDatabase(path);
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS permission_sessions (
      session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repository_id TEXT,
      mode TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS permission_operations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES permission_sessions(session_id),
      fingerprint TEXT NOT NULL, descriptor TEXT NOT NULL, mode TEXT NOT NULL,
      revision INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS permission_operations_session ON permission_operations(session_id,status);`);
  privateDatabase(path);
  db.prepare("UPDATE permission_operations SET status='revoked', reason='server_restarted' WHERE status IN ('pending','ready','active')").run();
  const controllers = new Map();
  const waiters = new Map();
  const timers = new Map();
  let closed = false;
  function open() { if (closed) throw failure('permission_policy_closed'); }
  function row(id) { open(); return db.prepare('SELECT * FROM permission_operations WHERE id=?').get(identifier(id)); }
  function controller(id) {
    if (!controllers.has(id)) controllers.set(id, new AbortController());
    return controllers.get(id);
  }
  function publicOperation(record) {
    if (!record) return null;
    return immutable({ id: record.id, ...JSON.parse(record.descriptor), fingerprint: record.fingerprint,
      mode: record.mode, revision: record.revision, status: record.status, reason: record.reason,
      createdAt: record.created_at, expiresAt: record.expires_at });
  }
  function settle(id, error = null) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    const pending = waiters.get(id) ?? [];
    waiters.delete(id);
    for (const waiter of pending) error ? waiter.reject(error) : waiter.resolve(publicOperation(row(id)));
  }
  function invalidate(id, reason, status = 'revoked') {
    const record = row(id);
    if (!record || !liveStates.includes(record.status)) return false;
    db.prepare('UPDATE permission_operations SET status=?, reason=? WHERE id=?').run(status, reason, id);
    const error = failure(reason);
    controller(id).abort(error);
    settle(id, error);
    controllers.delete(id);
    return true;
  }
  function checked(lease, descriptor) {
    const record = row(lease?.id);
    if (!record || record.fingerprint !== lease.fingerprint) throw failure('permission_action_mismatch');
    if (descriptor && permissionActionFingerprint(descriptor) !== record.fingerprint)
      throw failure('permission_action_mismatch');
    if (record.expires_at <= now() && record.status !== 'active' && liveStates.includes(record.status)) {
      invalidate(record.id, 'permission_approval_expired');
      throw failure('permission_approval_expired');
    }
    if (!['ready', 'active'].includes(record.status)) throw failure(record.reason ?? 'permission_approval_required');
    return record;
  }
  const policy = {
    ensureSession({ sessionId, workspaceId, repositoryId = null, existing = false, mode }) {
      open(); identifier(sessionId); identifier(workspaceId); optionalIdentifier(repositoryId);
      const current = policy.get(sessionId);
      if (current) {
        if (current.workspaceId !== workspaceId || current.repositoryId !== repositoryId)
          throw failure('permission_scope_mismatch');
        return current;
      }
      const selected = checkMode(mode ?? (existing ? 'approval-required' : DEFAULT_PERMISSION_MODE));
      db.prepare('INSERT INTO permission_sessions VALUES (?,?,?,?,1,?)').run(sessionId, workspaceId, repositoryId, selected, now());
      return policy.get(sessionId);
    },
    get(sessionId) {
      open();
      const state = db.prepare('SELECT * FROM permission_sessions WHERE session_id=?').get(identifier(sessionId));
      return state ? Object.freeze({ sessionId: state.session_id, workspaceId: state.workspace_id,
        repositoryId: state.repository_id, mode: state.mode, revision: state.revision,
        autoReviewSupported: false, effectiveMode: state.mode === 'auto' ? 'approval-required' : state.mode }) : null;
    },
    set(sessionId, mode, { expectedRevision } = {}) {
      checkMode(mode);
      const current = policy.get(sessionId);
      if (!current) throw failure('permission_session_missing');
      if (expectedRevision !== undefined && expectedRevision !== current.revision) throw failure('permission_revision_conflict');
      if (current.mode === mode) return current;
      db.prepare('UPDATE permission_sessions SET mode=?, revision=revision+1, updated_at=? WHERE session_id=?').run(mode, now(), sessionId);
      const stricter = strengths[mode] < strengths[current.mode];
      const records = db.prepare("SELECT * FROM permission_operations WHERE session_id=? AND status IN ('pending','ready','active')").all(sessionId);
      for (const record of records) {
        if (record.status === 'pending' || (stricter && JSON.parse(record.descriptor).kind !== 'read'))
          invalidate(record.id, 'permission_mode_changed');
      }
      return policy.get(sessionId);
    },
    admit(input) {
      const descriptor = permissionActionDescriptor(input);
      const current = policy.get(descriptor.sessionId);
      if (!current || current.workspaceId !== descriptor.workspaceId || current.repositoryId !== descriptor.repositoryId)
        throw failure('permission_scope_mismatch');
      const id = randomUUID();
      const fingerprint = permissionActionFingerprint(descriptor);
      const status = permissionRequiresApproval(current.mode, descriptor.kind) ? 'pending' : 'ready';
      const createdAt = now();
      db.prepare('INSERT INTO permission_operations VALUES (?,?,?,?,?,?,?,NULL,?,?)')
        .run(id, descriptor.sessionId, fingerprint, canonical(descriptor), current.mode, current.revision, status, createdAt, createdAt + approvalTimeoutMs);
      const lease = Object.freeze({ ...publicOperation(row(id)), signal: controller(id).signal });
      if (status === 'pending') {
        const timer = setTimeout(() => { if (!closed) invalidate(id, 'permission_approval_expired'); }, approvalTimeoutMs);
        timer.unref?.(); timers.set(id, timer);
      }
      return lease;
    },
    operation(id) { return publicOperation(row(id)); },
    listPending(sessionId) {
      open(); identifier(sessionId);
      const records = db.prepare("SELECT * FROM permission_operations WHERE session_id=? AND status='pending' ORDER BY created_at,id").all(sessionId);
      const result = [];
      for (const record of records) {
        if (record.expires_at <= now()) invalidate(record.id, 'permission_approval_expired');
        else result.push(publicOperation(record));
      }
      return result;
    },
    wait(lease) {
      const record = row(lease?.id);
      if (!record || record.fingerprint !== lease.fingerprint) return Promise.reject(failure('permission_action_mismatch'));
      if (record.status !== 'pending') {
        try { checked(lease); return Promise.resolve(publicOperation(row(lease.id))); }
        catch (error) { return Promise.reject(error); }
      }
      if (record.expires_at <= now()) {
        invalidate(record.id, 'permission_approval_expired');
        return Promise.reject(failure('permission_approval_expired'));
      }
      return new Promise((resolve, reject) => {
        const pending = waiters.get(lease.id) ?? [];
        pending.push({ resolve, reject }); waiters.set(lease.id, pending);
      });
    },
    decide({ id, sessionId, workspaceId, repositoryId = null, fingerprint, decision }) {
      if (!['approve', 'reject'].includes(decision)) throw failure('invalid_permission_decision');
      const record = row(id);
      const descriptor = record && JSON.parse(record.descriptor);
      if (!record || record.fingerprint !== fingerprint || descriptor.sessionId !== sessionId ||
          descriptor.workspaceId !== workspaceId || descriptor.repositoryId !== repositoryId)
        throw failure('permission_action_mismatch');
      if (record.status !== 'pending') throw failure(record.reason ?? 'permission_decision_stale');
      const current = policy.get(sessionId);
      if (current.revision !== record.revision || current.mode !== record.mode) {
        invalidate(id, 'permission_mode_changed'); throw failure('permission_mode_changed');
      }
      if (record.expires_at <= now()) {
        invalidate(id, 'permission_approval_expired'); throw failure('permission_approval_expired');
      }
      if (decision === 'reject') invalidate(id, 'permission_rejected', 'rejected');
      else { db.prepare("UPDATE permission_operations SET status='ready' WHERE id=?").run(id); settle(id); }
      return publicOperation(row(id));
    },
    start(lease, descriptor) {
      const record = checked(lease, descriptor);
      if (record.status !== 'ready') throw failure('permission_operation_already_started');
      db.prepare("UPDATE permission_operations SET status='active' WHERE id=?").run(record.id);
      return publicOperation(row(record.id));
    },
    assert(lease, descriptor) { return publicOperation(checked(lease, descriptor)); },
    finish(lease) {
      const record = row(lease?.id);
      if (!record || record.fingerprint !== lease.fingerprint) throw failure('permission_action_mismatch');
      if (record.status === 'pending') { invalidate(record.id, 'permission_operation_cancelled'); return; }
      if (['active', 'ready'].includes(record.status))
        db.prepare("UPDATE permission_operations SET status='complete' WHERE id=?").run(record.id);
      settle(record.id); controllers.delete(record.id);
    },
    revokeSession(sessionId, reason = 'permission_session_revoked') {
      open(); identifier(sessionId); identifier(reason);
      const records = db.prepare("SELECT id FROM permission_operations WHERE session_id=? AND status IN ('pending','ready','active')").all(sessionId);
      for (const { id } of records) invalidate(id, reason);
      return records.length;
    },
    async run(descriptor, execute) {
      const lease = policy.admit(descriptor);
      await policy.wait(lease);
      policy.start(lease, descriptor);
      try {
        const result = await execute(lease);
        policy.assert(lease, descriptor);
        return result;
      } finally { policy.finish(lease); }
    },
    close() {
      if (closed) return;
      for (const { session_id } of db.prepare('SELECT session_id FROM permission_sessions').all())
        policy.revokeSession(session_id, 'permission_policy_closed');
      closed = true; db.close();
    },
  };
  return Object.freeze(policy);
}

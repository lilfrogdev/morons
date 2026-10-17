import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

async function git(repository, args, input = null, signal = null) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repository, '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', ...args], { windowsHide: true, signal,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', HOME: '/tmp',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorOutput = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (part) => { output += part; if (Buffer.byteLength(output) > 524288) child.kill('SIGKILL'); });
    child.stderr.on('data', (part) => { errorOutput += part; if (errorOutput.length > 8192) child.kill('SIGKILL'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output, errorOutput }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function reviewed(catalog, id, expected) {
  const review = catalog.getReview(id);
  if (!review || review.decision !== 'approve' || !sha(review.baseRevision) ||
      !sha(review.proposalRevision) || typeof review.mainReview !== 'string' || !review.mainReview.trim() ||
      !review.checks.length || !review.checks.every((check) => check.ok) ||
      review.diffHash !== hash(review.diff) || review.diffHash !== expected.diffHash ||
      review.proposalRevision !== expected.proposalRevision) throw new Error('reviewed_proposal_required');
  return review;
}

export async function openSourceApplications({ filePath, catalog, permissions, planForSession }) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
      throw new Error('private_application_database_required');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(filePath);
  await chmod(filePath, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL);
    UPDATE applications SET status='interrupted', error='Application interrupted; inspect the source before retrying'
      WHERE status IN ('waiting','running');`);
  const active = new Map(), repositoryLocks = new Set();
  let closed = false;
  function get(id) {
    const row = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
    return row ? { reviewId: row.id, status: row.status, error: row.error, updatedAt: row.updated_at } : null;
  }
  async function request(id, expected) {
    if (closed) throw new Error('application_runtime_closed');
    const review = reviewed(catalog, id, expected);
    const session = catalog.getSession(review.sessionId);
    const moron = session && catalog.getMoron(session.moronId);
    const repository = moron && catalog.repositoryForMoron(moron.id);
    if (!session || !moron || moron.archived || !repository || repository.workspaceId !== moron.workspaceId)
      throw new Error('application_scope_forbidden');
    const plan = await planForSession(session, review.baseRevision);
    if (!plan?.runnerImage) throw new Error('application_runner_required');
    const descriptor = { sessionId: session.id, workspaceId: moron.workspaceId, repositoryId: repository.id,
      kind: 'source-apply', proposalId: id, baseRevision: review.baseRevision,
      action: { proposalRevision: review.proposalRevision, patchHash: review.diffHash,
        mainAgentReviewHash: hash(review.mainReview) } };
    const fingerprint = hash(JSON.stringify(descriptor));
    const saved = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
    if (saved && saved.fingerprint !== fingerprint) throw new Error('application_conflict');
    if (active.has(id) || saved?.status === 'completed') return get(id);
    const lease = permissions.admit(descriptor);
    db.prepare(`INSERT INTO applications VALUES (?,?,?,'waiting',NULL,?)
      ON CONFLICT(id) DO UPDATE SET status='waiting',error=NULL,updated_at=excluded.updated_at`)
      .run(id, session.id, fingerprint, Date.now());
    const completion = (async () => {
      try {
        await permissions.wait(lease);
        permissions.start(lease, descriptor);
        if (repositoryLocks.has(plan.repository)) throw new Error('repository_application_busy');
        repositoryLocks.add(plan.repository);
        try {
          db.prepare("UPDATE applications SET status='running',updated_at=? WHERE id=?").run(Date.now(), id);
          reviewed(catalog, id, expected);
          const currentPlan = await planForSession(session, review.baseRevision);
          if (currentPlan?.repository !== plan.repository) throw new Error('repository_path_changed');
          const head = await git(plan.repository, ['rev-parse', 'HEAD'], null, lease.signal);
          if (!head.ok || head.output.trim() !== review.baseRevision) throw new Error('application_base_changed');
          const unstaged = await git(plan.repository, ['diff', '--no-ext-diff', '--binary'], null, lease.signal);
          const staged = await git(plan.repository, ['diff', '--cached', '--no-ext-diff', '--binary'], null, lease.signal);
          const untracked = await git(plan.repository, ['ls-files', '--others', '--exclude-standard', '-z'], null, lease.signal);
          if (!unstaged.ok || !staged.ok || !untracked.ok || unstaged.output || untracked.output)
            throw new Error('application_source_dirty');
          if (staged.output && hash(staged.output) !== review.diffHash) throw new Error('application_source_dirty');
          if (!staged.output) {
            if (/^(?:old mode|new mode|new file mode|deleted file mode) (?!100644|100755)/m.test(review.diff))
              throw new Error('application_file_mode_forbidden');
            const paths = await git(plan.repository, ['apply', '--numstat', '-z'], review.diff, lease.signal);
            const names = paths.output.split('\0').filter(Boolean).map((item) => item.split('\t').slice(2).join('\t'));
            if (!paths.ok || !names.length || names.some((path) => !plan.allowedPaths.includes(path)))
              throw new Error('application_path_forbidden');
            const checked = await git(plan.repository, ['apply', '--index', '--check', '-'], review.diff, lease.signal);
            if (!checked.ok) throw new Error('application_patch_conflict');
            permissions.assert(lease, descriptor);
            reviewed(catalog, id, expected);
            const applied = await git(plan.repository, ['apply', '--index', '-'], review.diff, lease.signal);
            if (!applied.ok) throw new Error('application_failed_inspect_source');
          }
          permissions.assert(lease, descriptor);
          db.prepare("UPDATE applications SET status='completed',error=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
        } finally { repositoryLocks.delete(plan.repository); }
      } catch (error) {
        db.prepare("UPDATE applications SET status='failed',error=?,updated_at=? WHERE id=?")
          .run(error.message === 'application_source_dirty' ? 'Source has local changes; preserve or move them before applying' :
            error.message === 'application_base_changed' ? 'Source HEAD changed; request a new implementation' :
              'Application stopped; inspect the exact source state before retrying', Date.now(), id);
      } finally { permissions.finish(lease); active.delete(id); }
    })();
    active.set(id, { sessionId: session.id, completion });
    return get(id);
  }
  return { request, get,
    async close() {
      closed = true;
      for (const { sessionId } of active.values()) permissions.revokeSession(sessionId, 'shutdown');
      await Promise.allSettled([...active.values()].map((item) => item.completion));
      db.close();
    } };
}

import { createHash } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGitHubPublication } from './github-publication.mjs';

const canonical = value => JSON.stringify(value && typeof value === 'object' ?
  Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) :
    Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const hash = value => createHash('sha256').update(value).digest('hex');
const safeError = error => /^github_[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'github_operation_stopped';
const messages = {
  github_authentication_required: 'Sign in to GitHub with the host GitHub CLI, then connect this repository.',
  github_cli_unavailable: 'Install the GitHub CLI on this computer, sign in, then connect this repository.',
  github_publication_cancelled: 'Publication cancelled. Resume this saved artifact with fresh approval.',
  github_connection_changed: 'GitHub connection changed. Reconnect the displayed identity and request fresh approval.',
  github_identity_changed: 'The GitHub identity changed. Reconnect the displayed account before resuming.',
  github_base_changed: 'The base branch changed. Request a fresh implementation and review.',
  github_approved_artifact_changed: 'The reviewed change changed. Publication stopped before continuing.',
  github_allowlist_changed: 'The approved source paths changed. Request a fresh implementation and review.',
  github_remote_rejected: 'GitHub rejected this operation. Check repository permissions or rules, then resume the saved artifact.',
  github_permission_denied: 'GitHub denied access. Check the displayed account and repository permissions.',
  github_ref_conflict: 'The task branch has different changes. Publication stopped without updating that branch.',
  github_remote_object_mismatch: 'GitHub returned a different object hash. Publication stopped before creating the branch.',
  github_operation_stopped: 'Operation stopped. Remote objects or a task branch may already exist; resume this exact publication to reconcile.',
};

export async function openGitHubRuntime({ filePath, rootPath, accountId, catalog, permissions,
  planForSession, ensureSession, enabled = false, adapter }) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error('github_private_database_required');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(filePath);
  await chmod(filePath, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS github_connections (
      repository_id TEXT PRIMARY KEY, connection TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_connection_history (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, connection TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_publications (
      review_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      status TEXT NOT NULL, manifest TEXT, receipt TEXT, checks TEXT, error TEXT, updated_at INTEGER NOT NULL);
    UPDATE github_publications SET status='interrupted',error='Publication interrupted; resume to reconcile exact remote state'
      WHERE status IN ('preparing','waiting','running');`);
  const publisher = await createGitHubPublication({ rootPath, accountId, ...(adapter ? { adapter } : {}) });
  const operations = new Map(), revisions = new Map();
  let closed = false;
  const open = () => { if (closed) throw new Error('github_runtime_closed'); if (!enabled) throw new Error('github_administrator_required'); };
  function repository(id) {
    const item = catalog.getRepository(id);
    const moron = item && catalog.getMoron(item.moronId);
    if (!item || !moron || moron.archived || moron.workspaceId !== item.workspaceId)
      throw new Error('github_repository_scope_forbidden');
    return item;
  }
  function scope(reviewId) {
    const review = catalog.getReview(reviewId);
    const session = review && catalog.getSession(review.sessionId);
    const moron = session && catalog.getMoron(session.moronId);
    const item = moron && catalog.repositoryForMoron(moron.id);
    if (!review || !session || !item || repository(item.id).workspaceId !== moron.workspaceId)
      throw new Error('github_review_scope_forbidden');
    return { review, session, repository: item };
  }
  function connection(id) {
    const row = db.prepare('SELECT connection FROM github_connections WHERE repository_id=?').get(id);
    const value = row && JSON.parse(row.connection);
    if (value && value.accountId !== accountId) throw new Error('github_connection_account_mismatch');
    return value ?? null;
  }
  const record = id => db.prepare('SELECT * FROM github_publications WHERE review_id=?').get(id);
  function publicPublication(row) {
    if (!row?.manifest) return null;
    const manifest = JSON.parse(row.manifest), receipt = row.receipt && JSON.parse(row.receipt);
    const checks = row.checks && JSON.parse(row.checks);
    return { id: manifest.id, accountId: manifest.accountId, reviewId: row.review_id, status: row.status,
      repository: manifest.repository, login: manifest.login, branch: manifest.branch,
      baseRef: manifest.baseRef, baseRevision: manifest.baseRevision, commit: manifest.commit,
      tree: manifest.tree, patchHash: manifest.patchHash, mainReviewHash: manifest.mainReviewHash,
      prTitle: manifest.prTitle, prBody: manifest.prBody, message: manifest.message,
      authorName: manifest.author.name, authorEmail: manifest.author.email,
      pullUrl: receipt?.pullUrl ?? null, error: row.error,
      checkSummary: checks?.overall ?? null,
      checks: [...(checks?.checkRuns ?? []).map(check => ({ name: check.name,
        status: check.status, conclusion: check.conclusion ?? '', url: check.details_url ?? check.url ?? null })),
        ...(checks?.statuses ?? []).map(check => ({ name: check.context ?? check.name,
          status: check.state ?? check.status, conclusion: check.state ?? '', url: check.target_url ?? check.url ?? null }))].slice(0, 100) };
  }
  function view(repositoryId, reviewId = null) {
    repository(repositoryId);
    const row = reviewId ? record(reviewId) : null;
    if (row && row.repository_id !== repositoryId) throw new Error('github_review_scope_forbidden');
    const current = connection(repositoryId);
    const visible = row;
    return { repositoryId, available: enabled, preparing: visible?.status === 'preparing',
      message: !enabled ? 'GitHub publishing requires the local administrator account.' :
        visible?.status === 'preparing' ? 'Preparing the exact reviewed patch…' :
        visible?.error ? (messages[visible.error] ?? visible.error) :
        current ? 'GitHub connection is bound to this account and repository.' :
        'Connect an existing host GitHub sign-in for this repository.',
      connection: current, publication: publicPublication(visible) };
  }
  function cancelRepository(id) {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
    for (const operation of operations.values()) if (operation.repositoryId === id) operation.controller.abort();
    const item = repository(id);
    for (const session of catalog.listSessions(item.moronId)) permissions.revokeSession(session.id, 'github_connection_changed');
  }
  function current(row, manifest, selected) {
    open();
    const { review, repository: item } = scope(row.review_id);
    if (item.id !== row.repository_id || connection(item.id)?.id !== selected.id ||
        selected.accountId !== accountId || manifest.accountId !== accountId ||
        review.decision !== 'approve' || review.diffHash !== manifest.patchHash ||
        hash(review.diff) !== manifest.patchHash || hash(review.mainReview ?? '') !== manifest.mainReviewHash ||
        !Array.isArray(review.checks) || !review.checks.length || !review.checks.every(check => check.ok === true) ||
        hash(canonical(review.checks)) !== manifest.checksHash ||
        review.proposalRevision !== manifest.proposalRevision || review.baseRevision !== manifest.baseRevision)
      throw new Error('github_approved_artifact_changed');
  }
  function launch(reviewId, repositoryId, action) {
    const controller = new AbortController();
    const completion = Promise.resolve().then(() => action(controller.signal)).catch(error => {
      if (!closed) {
        if (error?.receipt) db.prepare('UPDATE github_publications SET receipt=? WHERE review_id=?')
          .run(JSON.stringify(error.receipt), reviewId);
        db.prepare("UPDATE github_publications SET status='failed',error=?,updated_at=? WHERE review_id=?")
          .run(messages[safeError(error)] ?? messages.github_operation_stopped, Date.now(), reviewId);
      }
    }).finally(() => operations.delete(reviewId));
    operations.set(reviewId, { repositoryId, controller, completion });
  }
  return {
    view,
    async connect(repositoryId, input) {
      open(); repository(repositoryId);
      if (operations.has(`connect-${repositoryId}`)) throw new Error('github_connection_busy');
      cancelRepository(repositoryId);
      const revision = revisions.get(repositoryId), controller = new AbortController();
      const completion = publisher.connect({ accountId, repository: input.repository,
        ...(input.baseRef ? { baseRef: input.baseRef } : {}) }, controller.signal);
      operations.set(`connect-${repositoryId}`, { repositoryId, controller, completion });
      try {
        let selected = await completion;
        open(); controller.signal.throwIfAborted();
        if (revisions.get(repositoryId) !== revision || selected.accountId !== accountId)
          throw new Error('github_connection_changed');
        const prior = db.prepare('SELECT connection FROM github_connection_history WHERE repository_id=?').all(repositoryId)
          .map(row => JSON.parse(row.connection)).find(value => value.accountId === selected.accountId &&
            value.userId === selected.userId && value.login === selected.login && value.host === selected.host &&
            value.repositoryId === selected.repositoryId && value.repository === selected.repository &&
            value.baseRef === selected.baseRef && value.defaultBranch === selected.defaultBranch);
        if (prior) selected = { ...selected, id: prior.id, createdAt: prior.createdAt };
        db.prepare('INSERT OR REPLACE INTO github_connection_history VALUES (?,?,?)')
          .run(selected.id, repositoryId, JSON.stringify(selected));
        db.prepare('INSERT OR REPLACE INTO github_connections VALUES (?,?)').run(repositoryId, JSON.stringify(selected));
        return view(repositoryId);
      } finally { operations.delete(`connect-${repositoryId}`); }
    },
    disconnect(repositoryId) {
      open(); cancelRepository(repositoryId);
      db.prepare('DELETE FROM github_connections WHERE repository_id=?').run(repositoryId);
      return view(repositoryId);
    },
    prepare(reviewId) {
      open();
      const { review, session, repository: item } = scope(reviewId);
      ensureSession(session);
      const selected = connection(item.id);
      if (!selected) throw new Error('github_connection_required');
      const saved = record(reviewId);
      if (operations.has(reviewId) || saved?.manifest) return view(item.id, reviewId);
      db.prepare(`INSERT OR REPLACE INTO github_publications VALUES (?,?,?,'preparing',NULL,NULL,NULL,NULL,?)`)
        .run(reviewId, item.id, selected.id, Date.now());
      launch(reviewId, item.id, async signal => {
        const plan = await planForSession(session, review.baseRevision);
        signal.throwIfAborted();
        if (!plan?.allowedPaths?.length) throw new Error('github_review_plan_required');
        const manifest = await publisher.prepare({ connection: selected, review, allowedPaths: plan.allowedPaths }, signal);
        current(record(reviewId), manifest, selected); signal.throwIfAborted();
        db.prepare("UPDATE github_publications SET manifest=?,status='prepared',error=NULL,updated_at=? WHERE review_id=?")
          .run(JSON.stringify(manifest), Date.now(), reviewId);
      });
      return view(item.id, reviewId);
    },
    publish(reviewId, publicationId) {
      open();
      const row = record(reviewId), manifest = row?.manifest && JSON.parse(row.manifest);
      const { session, repository: item } = scope(reviewId);
      ensureSession(session);
      const selected = connection(item.id);
      if (!manifest || manifest.id !== publicationId || !selected) throw new Error('github_prepared_artifact_required');
      current(row, manifest, selected);
      if (operations.has(reviewId) || row.status === 'completed') return view(item.id, reviewId);
      const descriptor = { sessionId: session.id, workspaceId: item.workspaceId, repositoryId: item.id,
        proposalId: reviewId, baseRevision: manifest.baseRevision, kind: 'github-publish', action: { connectionId: selected.id, accountId, host: selected.host,
          login: selected.login, userId: selected.userId, githubRepositoryId: selected.repositoryId,
          repository: manifest.repository, baseRef: manifest.baseRef, branch: manifest.branch,
          commit: manifest.commit, tree: manifest.tree, patchHash: manifest.patchHash,
          mainReviewHash: manifest.mainReviewHash, proposalRevision: manifest.proposalRevision,
          author: manifest.author, committer: manifest.committer, message: manifest.message,
          prTitle: manifest.prTitle, prBody: manifest.prBody, draft: true, mayTriggerCi: true,
          checksHash: manifest.descriptor?.action?.checksHash, allowlistHash: manifest.descriptor?.action?.allowlistHash,
          manifestHash: manifest.descriptor?.action?.manifestHash }  };
      const lease = permissions.admit(descriptor);
      db.prepare("UPDATE github_publications SET status='waiting',error=NULL,updated_at=? WHERE review_id=?").run(Date.now(), reviewId);
      launch(reviewId, item.id, async signal => {
        const abort = () => permissions.revokeSession(session.id, 'github_publication_cancelled');
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (signal.aborted) abort();
          await permissions.wait(lease); signal.throwIfAborted();
          permissions.start(lease, descriptor);
          current(row, manifest, selected);
          const combined = AbortSignal.any([signal, lease.signal]);
          db.prepare("UPDATE github_publications SET status='running',updated_at=? WHERE review_id=?").run(Date.now(), reviewId);
          const receipt = await publisher.publish({ connection: selected, manifest, assertApproval: async () => {
            combined.throwIfAborted(); current(row, manifest, selected); permissions.assert(lease, descriptor);
            const plan = await planForSession(session, manifest.baseRevision);
            if (!plan || hash(canonical([...new Set(plan.allowedPaths)].sort())) !== manifest.allowlistHash)
              throw new Error('github_allowlist_changed');
            combined.throwIfAborted(); current(row, manifest, selected); permissions.assert(lease, descriptor);
          } }, combined);
          combined.throwIfAborted(); current(row, manifest, selected);
          db.prepare("UPDATE github_publications SET receipt=?,status='completed',error=NULL,updated_at=? WHERE review_id=?")
            .run(JSON.stringify(receipt), Date.now(), reviewId);
        } finally { signal.removeEventListener('abort', abort); permissions.finish(lease); }
      });
      return view(item.id, reviewId);
    },
    async refresh(reviewId, publicationId) {
      open();
      const row = record(reviewId), manifest = row?.manifest && JSON.parse(row.manifest);
      const { repository: item } = scope(reviewId), selected = connection(item.id);
      if (!manifest || manifest.id !== publicationId || !row.receipt || !selected)
        throw new Error('github_publication_receipt_required');
      current(row, manifest, selected);
      let result;
      try { result = await publisher.status({ connection: selected, receipt: JSON.parse(row.receipt) }); }
      catch (error) {
        db.prepare('UPDATE github_publications SET checks=NULL,error=?,updated_at=? WHERE review_id=?')
          .run(messages[safeError(error)] ?? 'GitHub status could not be verified. Refresh again after checking the connection.', Date.now(), reviewId);
        throw error;
      }
      current(row, manifest, selected);
      db.prepare('UPDATE github_publications SET checks=?,receipt=?,error=NULL,updated_at=? WHERE review_id=?')
        .run(JSON.stringify(result), JSON.stringify(result), Date.now(), reviewId);
      return view(item.id, reviewId);
    },
    async cancel() {
      for (const operation of operations.values()) operation.controller.abort();
      await Promise.allSettled([...operations.values()].map(operation => operation.completion));
    },
    async close() {
      if (closed) return;
      for (const operation of operations.values()) operation.controller.abort();
      await Promise.allSettled([...operations.values()].map(operation => operation.completion));
      closed = true;
      await publisher.close(); db.close();
    },
  };
}

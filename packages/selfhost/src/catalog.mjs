import { DatabaseSync } from "node:sqlite";

const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
export function validId(value) { return typeof value === "string" && idPattern.test(value); }

export function openCatalog(path) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS morons (id TEXT PRIMARY KEY, name TEXT NOT NULL, rules TEXT NOT NULL, preferences TEXT NOT NULL, created_at INTEGER NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal');
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, moron_id TEXT NOT NULL REFERENCES morons(id), conversation_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replies (session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, text TEXT NOT NULL, display_text TEXT NOT NULL, answer TEXT, PRIMARY KEY(session_id, request_id));
    CREATE TABLE IF NOT EXISTS memory_entry_dates (entry_id TEXT PRIMARY KEY, date TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS handoffs (source_session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, target_moron_id TEXT NOT NULL REFERENCES morons(id), question TEXT NOT NULL, target_session_id TEXT NOT NULL REFERENCES sessions(id), answer TEXT, PRIMARY KEY(source_session_id, request_id));
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL, base_revision TEXT NOT NULL, diff TEXT NOT NULL, checks TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_intents (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL, patch TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visualizations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), document TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`);
  db.exec('CREATE TABLE IF NOT EXISTS model_favorites (provider TEXT NOT NULL, model_id TEXT NOT NULL, PRIMARY KEY(provider, model_id))');
  db.exec(`CREATE TABLE IF NOT EXISTS external_usage (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL,
    provider TEXT NOT NULL, model_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
    usage_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS external_usage_session_time ON external_usage(session_id, timestamp);`);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_sync_cursors (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    last_entry_id INTEGER NOT NULL CHECK(last_entry_id > 0),
    source_count INTEGER NOT NULL DEFAULT 0 CHECK(source_count >= 0)
  );
  CREATE INDEX IF NOT EXISTS replies_by_submitted_text ON replies(session_id, text);`);
  if (!db.prepare('PRAGMA table_info(memory_sync_cursors)').all().some((column) => column.name === 'source_count'))
    db.exec('ALTER TABLE memory_sync_cursors ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(review_intents)').all().some((column) => column.name === 'base_revision'))
    db.exec('ALTER TABLE review_intents ADD COLUMN base_revision TEXT');
  if (!db.prepare('PRAGMA table_info(replies)').all().some((column) => column.name === 'state'))
    db.exec("ALTER TABLE replies ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted'");
  if (!db.prepare('PRAGMA table_info(morons)').all().some((column) => column.name === 'workspace_id'))
    db.exec("ALTER TABLE morons ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal'");
  if (!db.prepare('PRAGMA table_info(morons)').all().some((column) => column.name === 'pinned'))
    db.exec("ALTER TABLE morons ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!db.prepare('PRAGMA table_info(morons)').all().some((column) => column.name === 'role'))
    db.exec("ALTER TABLE morons ADD COLUMN role TEXT NOT NULL DEFAULT 'named'");
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'title'))
    db.exec("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT 'New thread'");
  db.exec(`CREATE TABLE IF NOT EXISTS repository_sidebar (
    workspace_id TEXT NOT NULL, repository_id TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(workspace_id, repository_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, moron_id TEXT NOT NULL UNIQUE REFERENCES morons(id),
    path TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(workspace_id, path)
  );
  CREATE INDEX IF NOT EXISTS repositories_workspace ON repositories(workspace_id, created_at, id);`);
  db.exec('CREATE INDEX IF NOT EXISTS morons_workspace ON morons(workspace_id, created_at, id)');
  db.exec("UPDATE replies SET state = 'done' WHERE answer IS NOT NULL AND state = 'accepted'");
  const getMoron = db.prepare("SELECT * FROM morons WHERE id = ?");
  const getSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  return {
    listRepositories(workspaceId) {
      return db.prepare('SELECT id, workspace_id AS workspaceId, moron_id AS moronId, path, name FROM repositories WHERE workspace_id = ? ORDER BY created_at, id').all(workspaceId);
    },
    getRepository(id) {
      return db.prepare('SELECT id, workspace_id AS workspaceId, moron_id AS moronId, path, name FROM repositories WHERE id = ?').get(id) ?? null;
    },
    repositoryForMoron(moronId) {
      return db.prepare('SELECT id, workspace_id AS workspaceId, moron_id AS moronId, path, name FROM repositories WHERE moron_id = ?').get(moronId) ?? null;
    },
    ensureLegacyRepository(path, name) {
      db.prepare("INSERT OR IGNORE INTO repositories VALUES ('configured', 'personal', 'repo', ?, ?, ?)").run(path, name, Date.now());
      db.prepare("UPDATE morons SET role = 'coordinator' WHERE id = 'repo' AND EXISTS (SELECT 1 FROM repositories WHERE id = 'configured' AND moron_id = 'repo')").run();
      return this.getRepository('configured');
    },
    registerRepository({ id, workspaceId, moronId, path, name }) {
      if (!validId(id) || !validId(workspaceId) || !validId(moronId) ||
          typeof path !== 'string' || !path || typeof name !== 'string' || !name.trim() || name.length > 80 ||
          this.listRepositories(workspaceId).length >= 32 || this.listMorons(workspaceId).length >= 32)
        throw new Error('invalid_repository');
      db.exec('BEGIN IMMEDIATE');
      try {
        this.createMoron({ id: moronId, name, rules: '', preferences: '', workspaceId, role: 'coordinator' });
        db.prepare('INSERT INTO repositories VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, workspaceId, moronId, path, name, Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return this.getRepository(id);
    },
    listModelFavorites: () => db.prepare('SELECT provider, model_id AS id FROM model_favorites ORDER BY provider, model_id').all(),
    setModelFavorite(provider, id, favorite) {
      if (favorite) db.prepare('INSERT OR IGNORE INTO model_favorites VALUES (?, ?)').run(provider, id);
      else db.prepare('DELETE FROM model_favorites WHERE provider = ? AND model_id = ?').run(provider, id);
    },
    listMorons: (workspaceId = 'personal') => db.prepare("SELECT * FROM morons WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId).map(moron),
    getMoron: (id) => moron(getMoron.get(id)),
    setMoronPinned(id, pinned) {
      if (!validId(id) || typeof pinned !== 'boolean' || !getMoron.get(id)) throw new Error('invalid_moron');
      db.prepare('UPDATE morons SET pinned = ? WHERE id = ?').run(Number(pinned), id);
      return moron(getMoron.get(id));
    },
    updateMoron(id, { name, rules, preferences }) {
      if (!validId(id) || !getMoron.get(id) || typeof name !== 'string' || !name.trim() || name.length > 80 ||
          typeof rules !== 'string' || rules.length > 12000 || typeof preferences !== 'string' || preferences.length > 12000)
        throw new Error('invalid_moron');
      db.prepare('UPDATE morons SET name = ?, rules = ?, preferences = ? WHERE id = ?')
        .run(name.trim(), rules, preferences, id);
      return moron(getMoron.get(id));
    },
    repositorySidebar(workspaceId, repositoryId) {
      const row = db.prepare('SELECT pinned, archived FROM repository_sidebar WHERE workspace_id = ? AND repository_id = ?')
        .get(workspaceId, repositoryId);
      return { pinned: Boolean(row?.pinned), archived: Boolean(row?.archived) };
    },
    setRepositorySidebar(workspaceId, repositoryId, field, value) {
      if (!validId(workspaceId) || !validId(repositoryId) || !['pinned', 'archived'].includes(field) || typeof value !== 'boolean')
        throw new Error('invalid_repository_sidebar');
      db.prepare(`INSERT INTO repository_sidebar (workspace_id, repository_id, ${field}) VALUES (?, ?, ?)
        ON CONFLICT(workspace_id, repository_id) DO UPDATE SET ${field} = excluded.${field}`)
        .run(workspaceId, repositoryId, Number(value));
      return this.repositorySidebar(workspaceId, repositoryId);
    },
    createMoron({ id, name, rules, preferences, workspaceId = 'personal', role = 'named' }) {
      if (!validId(id) || typeof name !== "string" || !name.trim() || name.length > 80 ||
          typeof rules !== "string" || rules.length > 12000 ||
          typeof preferences !== "string" || preferences.length > 12000 || !validId(workspaceId) ||
          !['named', 'implementation', 'coordinator'].includes(role)) throw new Error("invalid_moron");
      db.prepare("INSERT INTO morons (id, name, rules, preferences, created_at, workspace_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, name.trim(), rules, preferences, Date.now(), workspaceId, role);
      return moron(getMoron.get(id));
    },
    listSessions: (moronId) => db.prepare("SELECT id, moron_id, conversation_id, created_at, title FROM sessions WHERE moron_id = ? ORDER BY created_at, id").all(moronId).map(session),
    saveExternalUsage({ id, sessionId, kind, provider, modelId, timestamp, usage }) {
      if (!getSession.get(sessionId) || !['memory'].includes(kind) ||
          typeof id !== 'string' || typeof provider !== 'string' || typeof modelId !== 'string' ||
          !Number.isSafeInteger(timestamp)) throw new Error('invalid_external_usage');
      db.prepare('INSERT OR IGNORE INTO external_usage VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, sessionId, kind, provider, modelId, timestamp, JSON.stringify(usage));
    },
    listExternalUsage(sessionIds) {
      if (!sessionIds.length) return [];
      const statement = db.prepare(`SELECT id, session_id, kind, provider, model_id, timestamp, usage_json
        FROM external_usage WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY timestamp, id`);
      return statement.all(...sessionIds).map((row) => ({ id: row.id, sessionId: row.session_id,
        kind: row.kind, provider: row.provider, modelId: row.model_id,
        timestamp: row.timestamp, usage: JSON.parse(row.usage_json) }));
    },
    getSession: (id) => session(getSession.get(id)),
    getSessionByConversation: (id) => session(db.prepare("SELECT * FROM sessions WHERE conversation_id = ?").get(id)),
    createSession(id, moronId, conversationId, title = 'New thread') {
      if (!validId(id) || !getMoron.get(moronId)) throw new Error("invalid_session");
      if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('invalid_session');
      db.prepare("INSERT INTO sessions (id, moron_id, conversation_id, created_at, title) VALUES (?, ?, ?, ?, ?)")
        .run(id, moronId, conversationId, Date.now(), title.trim());
      return session(getSession.get(id));
    },
    getReply: (sessionId, requestId) => db.prepare("SELECT text, display_text, answer, state FROM replies WHERE session_id = ? AND request_id = ?").get(sessionId, requestId),
    listReplies: (sessionId) => db.prepare("SELECT request_id, text, display_text, answer, state FROM replies WHERE session_id = ? ORDER BY rowid").all(sessionId),
    pendingReplies: () => db.prepare("SELECT session_id, request_id, text, display_text FROM replies WHERE state = 'accepted' ORDER BY rowid").all(),
    displayTextForSubmitted: (sessionId, text) => db.prepare(
      "SELECT display_text FROM replies WHERE session_id = ? AND text = ? LIMIT 1"
    ).get(sessionId, text)?.display_text,
    memoryCursor: (sessionId) => db.prepare(
      "SELECT last_entry_id FROM memory_sync_cursors WHERE session_id = ?"
    ).get(sessionId)?.last_entry_id ?? 0,
    memorySourceCount: (sessionId) => db.prepare(
      "SELECT source_count FROM memory_sync_cursors WHERE session_id = ?"
    ).get(sessionId)?.source_count ?? 0,
    advanceMemoryCursor(sessionId, entryId, sourceCount) {
      if (!Number.isSafeInteger(entryId) || entryId <= 0 ||
          !Number.isSafeInteger(sourceCount) || sourceCount < 0) throw new Error('invalid_memory_cursor');
      db.prepare(`INSERT INTO memory_sync_cursors (session_id, last_entry_id, source_count) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET last_entry_id = excluded.last_entry_id,
          source_count = excluded.source_count
        WHERE excluded.last_entry_id > memory_sync_cursors.last_entry_id
          AND excluded.source_count >= memory_sync_cursors.source_count`)
        .run(sessionId, entryId, sourceCount);
    },
    reserveReply: (sessionId, requestId, text, displayText) => db.prepare("INSERT OR IGNORE INTO replies (session_id, request_id, text, display_text, answer) VALUES (?, ?, ?, ?, NULL)").run(sessionId, requestId, text, displayText),
    saveReply: (sessionId, requestId, answer) => db.prepare("UPDATE replies SET answer = ?, state = 'done' WHERE session_id = ? AND request_id = ?").run(answer, sessionId, requestId),
    failReply: (sessionId, requestId) => db.prepare("UPDATE replies SET state = 'failed' WHERE session_id = ? AND request_id = ? AND answer IS NULL").run(sessionId, requestId),
    memoryDate(entryId) {
      db.prepare("INSERT OR IGNORE INTO memory_entry_dates VALUES (?, ?)").run(entryId, new Date().toISOString());
      return db.prepare("SELECT date FROM memory_entry_dates WHERE entry_id = ?").get(entryId).date;
    },
    getHandoff: (sourceSessionId, requestId) => db.prepare("SELECT * FROM handoffs WHERE source_session_id = ? AND request_id = ?").get(sourceSessionId, requestId),
    listHandoffs: (sourceSessionId) => db.prepare("SELECT * FROM handoffs WHERE source_session_id = ?").all(sourceSessionId),
    isHandoffTarget: (sessionId) => !!db.prepare("SELECT 1 FROM handoffs WHERE target_session_id = ? LIMIT 1").get(sessionId),
    createHandoff: (sourceSessionId, requestId, targetMoronId, question, targetSessionId) => db.prepare("INSERT OR IGNORE INTO handoffs VALUES (?, ?, ?, ?, ?, NULL)").run(sourceSessionId, requestId, targetMoronId, question, targetSessionId),
    saveHandoffAnswer: (sourceSessionId, requestId, answer) => db.prepare("UPDATE handoffs SET answer = ? WHERE source_session_id = ? AND request_id = ?").run(answer, sourceSessionId, requestId),
    saveReview({ id, sessionId, branch, baseRevision, diff, checks }) {
      const intent = db.prepare('SELECT * FROM review_intents WHERE id = ?').get(id);
      if (intent && (intent.session_id !== sessionId || intent.branch !== branch ||
          (intent.base_revision && intent.base_revision !== baseRevision))) throw new Error('review_base_conflict');
      db.prepare("INSERT OR IGNORE INTO reviews VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, sessionId, branch, baseRevision, diff, JSON.stringify(checks), Date.now());
      db.prepare("DELETE FROM review_intents WHERE id = ?").run(id);
      return this.getReview(id);
    },
    getReviewIntent: (id) => db.prepare('SELECT * FROM review_intents WHERE id = ?').get(id),
    reserveReview({ id, sessionId, branch, patch, baseRevision }) {
      const prior = db.prepare('SELECT * FROM review_intents WHERE id = ?').get(id);
      if (prior) {
        if (prior.session_id !== sessionId || prior.branch !== branch || prior.patch !== patch ||
            prior.base_revision !== baseRevision) throw new Error('review_intent_conflict');
        return prior;
      }
      if (typeof baseRevision !== 'string' || !/^[0-9a-f]{40}$/.test(baseRevision)) throw new Error('invalid_review_base');
      db.prepare("INSERT OR IGNORE INTO review_intents (id, session_id, branch, patch, created_at, base_revision) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, sessionId, branch, patch, Date.now(), baseRevision);
      const intent = db.prepare("SELECT * FROM review_intents WHERE id = ?").get(id);
      if (intent?.session_id !== sessionId || intent?.branch !== branch || intent?.patch !== patch ||
          intent?.base_revision !== baseRevision)
        throw new Error('review_intent_conflict');
      return intent;
    },
    pendingReviews: () => db.prepare("SELECT * FROM review_intents ORDER BY created_at, id").all(),
    saveVisualization(sessionId, document) {
      db.prepare("INSERT OR IGNORE INTO visualizations VALUES (?, ?, ?, 0, ?)")
        .run(document.id, sessionId, JSON.stringify(document), Date.now());
    },
    listVisualizations(sessionId) {
      return db.prepare("SELECT document FROM visualizations WHERE session_id = ? AND revoked = 0 ORDER BY created_at DESC, id DESC LIMIT 10")
        .all(sessionId).map((row) => JSON.parse(row.document));
    },
    getReview(id) { return review(db.prepare("SELECT * FROM reviews WHERE id = ?").get(id)); },
    listReviews(sessionId) { return db.prepare("SELECT id, session_id, branch, base_revision, checks, decision, created_at FROM reviews WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 64").all(sessionId).map(reviewSummary); },
    decideReview(id, decision) {
      const current = this.getReview(id);
      if (!current || !['approve', 'reject'].includes(decision)) return null;
      if (current.decision === 'pending') db.prepare("UPDATE reviews SET decision = ? WHERE id = ?").run(decision, id);
      return this.getReview(id);
    },
    close: () => db.close(),
  };
}

function moron(row) { return row && { id: row.id, name: row.name, rules: row.rules, preferences: row.preferences, createdAt: row.created_at, workspaceId: row.workspace_id, role: row.role, pinned: Boolean(row.pinned) }; }
function session(row) { return row && { id: row.id, moronId: row.moron_id,
  conversationId: Number(row.conversation_id), createdAt: row.created_at, title: row.title ?? 'New thread' }; }
function review(row) { return row && { id: row.id, sessionId: row.session_id, branch: row.branch, baseRevision: row.base_revision, diff: row.diff, checks: JSON.parse(row.checks), decision: row.decision, createdAt: row.created_at }; }
function reviewSummary(row) { return row && { id: row.id, sessionId: row.session_id, branch: row.branch, baseRevision: row.base_revision, checks: JSON.parse(row.checks).map(({ ok }) => ({ ok })), decision: row.decision, createdAt: row.created_at }; }

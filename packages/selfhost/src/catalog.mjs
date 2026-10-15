import { DatabaseSync } from "node:sqlite";

const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
export function validId(value) { return typeof value === "string" && idPattern.test(value); }

export function openCatalog(path) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS morons (id TEXT PRIMARY KEY, name TEXT NOT NULL, rules TEXT NOT NULL, preferences TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, moron_id TEXT NOT NULL REFERENCES morons(id), conversation_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replies (session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, text TEXT NOT NULL, display_text TEXT NOT NULL, answer TEXT, PRIMARY KEY(session_id, request_id));
    CREATE TABLE IF NOT EXISTS memory_entry_dates (entry_id TEXT PRIMARY KEY, date TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS handoffs (source_session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, target_moron_id TEXT NOT NULL REFERENCES morons(id), question TEXT NOT NULL, target_session_id TEXT NOT NULL REFERENCES sessions(id), answer TEXT, PRIMARY KEY(source_session_id, request_id));
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL, base_revision TEXT NOT NULL, diff TEXT NOT NULL, checks TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_intents (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL, patch TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visualizations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), document TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(review_intents)').all().some((column) => column.name === 'base_revision'))
    db.exec('ALTER TABLE review_intents ADD COLUMN base_revision TEXT');
  const getMoron = db.prepare("SELECT * FROM morons WHERE id = ?");
  const getSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  return {
    listMorons: () => db.prepare("SELECT * FROM morons ORDER BY created_at, id").all().map(moron),
    getMoron: (id) => moron(getMoron.get(id)),
    createMoron({ id, name, rules, preferences }) {
      if (!validId(id) || typeof name !== "string" || !name.trim() || name.length > 80 ||
          typeof rules !== "string" || rules.length > 12000 ||
          typeof preferences !== "string" || preferences.length > 12000) throw new Error("invalid_moron");
      db.prepare("INSERT INTO morons VALUES (?, ?, ?, ?, ?)").run(id, name.trim(), rules, preferences, Date.now());
      return moron(getMoron.get(id));
    },
    listSessions: (moronId) => db.prepare("SELECT id, moron_id, created_at FROM sessions WHERE moron_id = ? ORDER BY created_at, id").all(moronId).map(session),
    getSession: (id) => session(getSession.get(id)),
    getSessionByConversation: (id) => session(db.prepare("SELECT * FROM sessions WHERE conversation_id = ?").get(id)),
    createSession(id, moronId, conversationId) {
      if (!validId(id) || !getMoron.get(moronId)) throw new Error("invalid_session");
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(id, moronId, conversationId, Date.now());
      return session(getSession.get(id));
    },
    getReply: (sessionId, requestId) => db.prepare("SELECT text, display_text, answer FROM replies WHERE session_id = ? AND request_id = ?").get(sessionId, requestId),
    listReplies: (sessionId) => db.prepare("SELECT text, display_text FROM replies WHERE session_id = ?").all(sessionId),
    reserveReply: (sessionId, requestId, text, displayText) => db.prepare("INSERT OR IGNORE INTO replies VALUES (?, ?, ?, ?, NULL)").run(sessionId, requestId, text, displayText),
    saveReply: (sessionId, requestId, answer) => db.prepare("UPDATE replies SET answer = ? WHERE session_id = ? AND request_id = ?").run(answer, sessionId, requestId),
    memoryDate(entryId) {
      db.prepare("INSERT OR IGNORE INTO memory_entry_dates VALUES (?, ?)").run(entryId, new Date().toISOString());
      return db.prepare("SELECT date FROM memory_entry_dates WHERE entry_id = ?").get(entryId).date;
    },
    getHandoff: (sourceSessionId, requestId) => db.prepare("SELECT * FROM handoffs WHERE source_session_id = ? AND request_id = ?").get(sourceSessionId, requestId),
    listHandoffs: (sourceSessionId) => db.prepare("SELECT * FROM handoffs WHERE source_session_id = ?").all(sourceSessionId),
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

function moron(row) { return row && { id: row.id, name: row.name, rules: row.rules, preferences: row.preferences, createdAt: row.created_at }; }
function session(row) { return row && { id: row.id, moronId: row.moron_id, conversationId: row.conversation_id, createdAt: row.created_at }; }
function review(row) { return row && { id: row.id, sessionId: row.session_id, branch: row.branch, baseRevision: row.base_revision, diff: row.diff, checks: JSON.parse(row.checks), decision: row.decision, createdAt: row.created_at }; }
function reviewSummary(row) { return row && { id: row.id, sessionId: row.session_id, branch: row.branch, baseRevision: row.base_revision, checks: JSON.parse(row.checks).map(({ ok }) => ({ ok })), decision: row.decision, createdAt: row.created_at }; }

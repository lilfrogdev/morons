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
    CREATE TABLE IF NOT EXISTS handoffs (source_session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, target_moron_id TEXT NOT NULL REFERENCES morons(id), question TEXT NOT NULL, target_session_id TEXT NOT NULL REFERENCES sessions(id), answer TEXT, PRIMARY KEY(source_session_id, request_id));`);
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
    close: () => db.close(),
  };
}

function moron(row) { return row && { id: row.id, name: row.name, rules: row.rules, preferences: row.preferences, createdAt: row.created_at }; }
function session(row) { return row && { id: row.id, moronId: row.moron_id, conversationId: row.conversation_id, createdAt: row.created_at }; }

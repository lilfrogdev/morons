import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_QUESTION_BYTES = 2048;
const MAX_ANSWER_BYTES = 4096;

function bytes(value) { return Buffer.byteLength(value, 'utf8'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function requestId(key, purpose) {
  const hex = digest(`${purpose}\0${key}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function userGrantsHandoff(userText, targetMoronId) {
  if (typeof userText !== 'string' || !ID.test(targetMoronId)) return false;
  const grants = /^(?:(?:please|can you|could you|would you)\s+)?(?:reach out to|ask|contact|consult)\s+@([a-z][a-z0-9-]{1,39})\b/i;
  return grants.exec(userText.trim())?.[1].toLowerCase() === targetMoronId;
}

// This is intentionally a separate ledger from the user-initiated @mention
// table. One model tool call is permitted for each source user entry. The
// owner lock held by the server prevents a second process from writing it.
export function openHandoffStore(path) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS model_handoffs (
      source_session_id TEXT NOT NULL,
      source_user_entry_id TEXT NOT NULL,
      source_call_id TEXT NOT NULL,
      source_moron_id TEXT NOT NULL,
      target_moron_id TEXT NOT NULL,
      question TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_request_id TEXT NOT NULL,
      answer TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_session_id, source_user_entry_id),
      UNIQUE (source_session_id, source_call_id)
    )`);
  const findTurn = db.prepare('SELECT * FROM model_handoffs WHERE source_session_id = ? AND source_user_entry_id = ?');
  const findCall = db.prepare('SELECT * FROM model_handoffs WHERE source_session_id = ? AND source_call_id = ?');
  const reserve = db.prepare(`INSERT OR IGNORE INTO model_handoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  const save = db.prepare(`UPDATE model_handoffs SET answer = ? WHERE source_session_id = ? AND source_call_id = ? AND answer IS NULL`);
  return {
    getTurn: (sessionId, entryId) => findTurn.get(sessionId, String(entryId)),
    getCall: (sessionId, callId) => findCall.get(sessionId, callId),
    list: (sessionId) => db.prepare('SELECT * FROM model_handoffs WHERE source_session_id = ? ORDER BY created_at, source_user_entry_id').all(sessionId),
    isTargetSession: (sessionId) => !!db.prepare('SELECT 1 FROM model_handoffs WHERE target_session_id = ? LIMIT 1').get(sessionId),
    reserve({ sourceSessionId, sourceUserEntryId, sourceCallId, sourceMoronId, targetMoronId, question }) {
      const key = `${sourceSessionId}\0${sourceUserEntryId}\0${sourceCallId}`;
      const targetSessionId = `handoff-${digest(`session\0${key}`).slice(0, 24)}`;
      const targetRequestId = requestId(key, 'target');
      reserve.run(sourceSessionId, String(sourceUserEntryId), sourceCallId, sourceMoronId,
        targetMoronId, question, targetSessionId, targetRequestId, Date.now());
      const row = findTurn.get(sourceSessionId, String(sourceUserEntryId));
      if (row.source_call_id !== sourceCallId || row.target_moron_id !== targetMoronId || row.question !== question)
        throw new Error('handoff_turn_limit_or_conflict');
      return row;
    },
    saveAnswer(sourceSessionId, callId, answer) {
      save.run(answer, sourceSessionId, callId);
      const row = findCall.get(sourceSessionId, callId);
      if (row?.answer !== answer) throw new Error('handoff_answer_conflict');
      return row;
    },
    close: () => db.close(),
  };
}

/**
 * Install only on normal named-Moron conversations. ensureTargetSession MUST
 * create/reuse the deterministic id with target rules but without this tool,
 * repository tools, or another Moron's history. askTarget MUST use its supplied
 * deterministic requestId with Pi Durable submission and return only text.
 * getUserGrant MUST return the original user-visible text, not Pi's submitted
 * text with OptChat memory appended. authorizeTarget MUST check account
 * ownership and explicit target policy.
 */
export function createHandoffExtension({ store, catalog, getSourceUserEntryId, getUserGrant, authorizeTarget, ensureTargetSession, askTarget }) {
  if (!store || !catalog || !getSourceUserEntryId || !getUserGrant || !authorizeTarget || !ensureTargetSession || !askTarget)
    throw new Error('handoff_dependencies_required');
  const tool = defineTool({
    name: 'ask_moron', replay: 'safe',
    description: 'Ask one named Moron a narrow question when the user asks you to reach out to them. Use targetMoronId without @. You receive only its scoped answer. At most one handoff is allowed per user turn; answer the user after this result.',
    parameters: Type.Object({
      targetMoronId: Type.String({ minLength: 2, maxLength: 40 }),
      question: Type.String({ minLength: 1, maxLength: 2048 }),
    }, { additionalProperties: false }),
    async execute({ targetMoronId, question }, api) {
      const source = catalog.getSessionByConversation(api.conversationId);
      if (!source) throw new Error('handoff_source_missing');
      if (!ID.test(targetMoronId) || targetMoronId === source.moronId ||
          !question.trim() || bytes(question) > MAX_QUESTION_BYTES)
        throw new Error('invalid_handoff');
      const sourceUserEntryId = String(await getSourceUserEntryId({ source, callId: api.callId }));
      const userText = await getUserGrant({ source, sourceUserEntryId });
      if (!userGrantsHandoff(userText, targetMoronId)) throw new Error('handoff_not_user_granted');
      // A replay of the same call uses the original target and question; a
      // different call in this user turn is rejected before contacting anyone.
      const existing = store.getTurn(source.id, sourceUserEntryId);
      if (existing && (existing.source_call_id !== api.callId ||
          existing.target_moron_id !== targetMoronId || existing.question !== question))
        throw new Error('handoff_turn_limit_or_conflict');
      const target = catalog.getMoron(targetMoronId);
      if (!target || !await authorizeTarget({ source, target, question }))
        throw new Error('handoff_target_forbidden');
      const row = store.reserve({ sourceSessionId: source.id, sourceUserEntryId,
        sourceCallId: api.callId, sourceMoronId: source.moronId, targetMoronId, question });
      if (row.answer !== null) return { output: [{ type: 'text', text: `Scoped answer from @${targetMoronId}: ${row.answer}` }],
        details: { targetMoronId, sourceUserEntryId } };
      await ensureTargetSession({ id: row.target_session_id, target, source,
        sourceUserEntryId, sourceCallId: api.callId });
      const answer = await askTarget({ targetSessionId: row.target_session_id,
        targetMoronId, question, requestId: row.target_request_id });
      if (typeof answer !== 'string' || bytes(answer) > MAX_ANSWER_BYTES)
        throw new Error('handoff_answer_too_large');
      store.saveAnswer(source.id, api.callId, answer);
      return { output: [{ type: 'text', text: `Scoped answer from @${targetMoronId}: ${answer}` }],
        details: { targetMoronId, sourceUserEntryId } };
    },
  });
  return defineExtension({ name: 'named-moron-handoff', tools: [tool] });
}

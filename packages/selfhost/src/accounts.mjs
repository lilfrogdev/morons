import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';

const scrypt = promisify(scryptCallback);
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const validName = (name) => typeof name === 'string' && /^[a-z][a-z0-9-]{2,39}$/.test(name);
const validPassword = (password) => typeof password === 'string' && Buffer.byteLength(password) >= 12 && Buffer.byteLength(password) <= 256;
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export async function openAccounts(path) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  await chmod(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt BLOB NOT NULL, password_hash BLOB NOT NULL, administrator INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS device_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS device_sessions_account ON device_sessions(account_id);`);
  const findName = db.prepare('SELECT * FROM accounts WHERE name = ?');
  const findToken = db.prepare('SELECT a.id, a.name, a.administrator, s.expires_at FROM device_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?');
  return {
    count: () => db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count,
    async create(name, password, administrator = false) {
      if (!validName(name) || !validPassword(password)) throw new Error('invalid_account');
      const salt = randomBytes(16);
      const hash = await scrypt(password, salt, 64);
      const id = randomUUID();
      db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)').run(id, name, salt, hash, administrator ? 1 : 0, Date.now());
      return { id, name, administrator };
    },
    async login(name, password) {
      if (!validName(name) || typeof password !== 'string' || Buffer.byteLength(password) > 256) return null;
      const row = findName.get(name);

      const salt = row?.salt ?? Buffer.alloc(16);
      const expected = row?.password_hash ?? Buffer.alloc(64);
      const actual = await scrypt(password, salt, 64);
      if (!row || !timingSafeEqual(actual, expected)) return null;
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + SESSION_LIFETIME_MS;
      db.prepare('INSERT INTO device_sessions VALUES (?, ?, ?, ?)').run(tokenHash(token), row.id, expiresAt, Date.now());
      return { token, expiresAt, account: { id: row.id, name: row.name, administrator: Boolean(row.administrator) } };
    },
    session(token) {
      if (typeof token !== 'string' || token.length > 256) return null;
      const row = findToken.get(tokenHash(token));
      if (!row || row.expires_at <= Date.now()) return null;
      return { id: row.id, name: row.name, administrator: Boolean(row.administrator), expiresAt: row.expires_at };
    },
    revoke(token) { if (typeof token === 'string') db.prepare('DELETE FROM device_sessions WHERE token_hash = ?').run(tokenHash(token)); },
    close: () => db.close(),
  };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Single SQLite database shared with the session-viewer backend. Auth, user
// records, and per-user settings live here alongside session_board_nodes.
function resolveDataDir() {
  let dir = process.env.SSOT_DATA_DIR || path.join(os.homedir(), '.ssot');
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  return path.resolve(dir);
}

const dataDir = resolveDataDir();
fs.mkdirSync(dataDir, { recursive: true });

export const dbPath = path.join(dataDir, 'ssot.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT,
    expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT,
    PRIMARY KEY (user_id, namespace, key)
  );
`);

const nowIso = () => new Date().toISOString();

// --- users ---------------------------------------------------------------
export function upsertUser({ email, name, picture }) {
  db.prepare(
    `INSERT INTO users (email, name, picture, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       picture = excluded.picture`
  ).run(email, name ?? null, picture ?? null, nowIso());
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// --- sessions ------------------------------------------------------------
export function createSession(tokenHash, userId, ttlDays) {
  const created = new Date();
  const expires = new Date(created.getTime() + ttlDays * 86400_000);
  db.prepare(
    `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(tokenHash, userId, created.toISOString(), expires.toISOString());
}

// Returns the user row for a live session, or null. Purges the row if expired.
export function getSessionUser(tokenHash) {
  const row = db
    .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return getUserById(row.user_id) ?? null;
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(nowIso());
}

// --- settings ------------------------------------------------------------
// Values are stored as JSON strings; callers deal in parsed values.
export function getSettings(userId, namespace) {
  const rows = db
    .prepare(
      'SELECT key, value FROM user_settings WHERE user_id = ? AND namespace = ?'
    )
    .all(userId, namespace);
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

export function setSetting(userId, namespace, key, value) {
  db.prepare(
    `INSERT INTO user_settings (user_id, namespace, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, namespace, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(userId, namespace, key, JSON.stringify(value ?? null), nowIso());
}

export function setSettings(userId, namespace, obj) {
  for (const [key, value] of Object.entries(obj)) {
    setSetting(userId, namespace, key, value);
  }
  return getSettings(userId, namespace);
}

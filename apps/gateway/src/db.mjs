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
try {
  fs.chmodSync(dataDir, 0o700);
} catch {
  // Best effort on filesystems that do not implement POSIX permissions.
}

export const dbPath = path.join(dataDir, 'ssot.db');
export const db = new DatabaseSync(dbPath);
try {
  fs.chmodSync(dbPath, 0o600);
} catch {
  // Best effort on filesystems that do not implement POSIX permissions.
}

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

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

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Replace a target account's settings with an exact, transactional copy of a
// source account. This is an explicit administration operation; normal sign-in
// still creates an empty account and never inherits another user's settings.
export function cloneUserSettings(sourcePrincipal, targetPrincipal, targetName) {
  const source = String(sourcePrincipal || '').trim().toLowerCase();
  const target = String(targetPrincipal || '').trim().toLowerCase();
  if (!source || !target) throw new Error('source and target principals are required');
  if (source === target) throw new Error('source and target principals must differ');

  db.exec('BEGIN IMMEDIATE');
  try {
    const sourceUser = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(source);
    if (!sourceUser) throw new Error(`source account does not exist: ${source}`);

    db.prepare(
      `INSERT INTO users (email, name, picture, created_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name`
    ).run(target, targetName ?? target, nowIso());
    const targetUser = db.prepare('SELECT id FROM users WHERE email = ?').get(target);

    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(targetUser.id);
    const copied = db.prepare(
      `INSERT INTO user_settings (user_id, namespace, key, value, updated_at)
       SELECT ?, namespace, key, value, ?
       FROM user_settings
       WHERE user_id = ?`
    ).run(targetUser.id, nowIso(), sourceUser.id);
    db.exec('COMMIT');
    return { user: getUserById(targetUser.id), settingsCount: Number(copied.changes) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

function setSetting(userId, namespace, key, value) {
  db.prepare(
    `INSERT INTO user_settings (user_id, namespace, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, namespace, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(userId, namespace, key, JSON.stringify(value ?? null), nowIso());
}

export function setSettings(userId, namespace, obj) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(obj)) {
      setSetting(userId, namespace, key, value);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getSettings(userId, namespace);
}

// Read, transform, and replace multiple namespaces in one transaction. The
// Settings page uses this so its single Save action cannot leave only some
// sections persisted when validation or a write fails.
export function transformSettingsBatch(userId, transforms) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const updated = {};
    for (const [namespace, transform] of Object.entries(transforms)) {
      const current = getSettings(userId, namespace);
      const next = transform(current);
      db.prepare('DELETE FROM user_settings WHERE user_id = ? AND namespace = ?').run(
        userId,
        namespace
      );
      for (const [key, value] of Object.entries(next)) {
        setSetting(userId, namespace, key, value);
      }
      updated[namespace] = getSettings(userId, namespace);
    }
    db.exec('COMMIT');
    return updated;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * SQLite database for server-side session persistence.
 *
 * Database file lives at $DATA_DIR/foundry.db (default: ./data/foundry.db).
 * Tables are created automatically on first boot and NEVER dropped on
 * re-deploy — existing data is always preserved.
 *
 * Schema:
 *   sessions  — saved project sessions (history shown in the sidebar)
 *   config_kv — reserved for future server-side config (not used yet)
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const DB_PATH = join(DATA_DIR, "foundry.db");

// Ensure the data directory exists before opening the DB.
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode: much faster concurrent reads, no read-write contention.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Auto-migration ──────────────────────────────────────────────────────────
// Only CREATE TABLE IF NOT EXISTS — never ALTER or DROP. Safe for re-deploys.

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    PRIMARY KEY,
    label       TEXT    NOT NULL DEFAULT '',
    mode        TEXT    NOT NULL DEFAULT 'youtube',
    project_json TEXT   NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

  CREATE TABLE IF NOT EXISTS config_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Session CRUD ─────────────────────────────────────────────────────────────

export type SessionRow = {
  id: string;
  label: string;
  mode: string;
  project_json: string;
  created_at: number;
  updated_at: number;
};

export type SessionSummary = {
  id: string;
  label: string;
  mode: string;
  created_at: number;
  updated_at: number;
};

const stmts = {
  upsert: db.prepare<[string, string, string, string, number, number]>(`
    INSERT INTO sessions (id, label, mode, project_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label        = excluded.label,
      mode         = excluded.mode,
      project_json = excluded.project_json,
      updated_at   = excluded.updated_at
  `),

  list: db.prepare<[], SessionSummary>(`
    SELECT id, label, mode, created_at, updated_at
    FROM sessions
    ORDER BY updated_at DESC
    LIMIT 100
  `),

  get: db.prepare<[string], SessionRow>(`
    SELECT * FROM sessions WHERE id = ?
  `),

  delete: db.prepare<[string]>(`
    DELETE FROM sessions WHERE id = ?
  `),

  deleteAll: db.prepare(`
    DELETE FROM sessions
  `),

  count: db.prepare<[], { count: number }>(`
    SELECT COUNT(*) as count FROM sessions
  `),
};

export function upsertSession(
  id: string,
  label: string,
  mode: string,
  projectJson: string,
): void {
  const now = Date.now();
  // Fetch existing created_at so we don't overwrite it on updates.
  const existing = stmts.get.get(id);
  stmts.upsert.run(id, label, mode, projectJson, existing?.created_at ?? now, now);
}

export function listSessions(): SessionSummary[] {
  return stmts.list.all();
}

export function getSession(id: string): SessionRow | undefined {
  return stmts.get.get(id);
}

export function deleteSession(id: string): void {
  stmts.delete.run(id);
}

export function deleteAllSessions(): void {
  stmts.deleteAll.run();
}

export function sessionCount(): number {
  return stmts.count.get()!.count;
}

export function getConfigKV(key: string): string | undefined {
  const row = db.prepare<{ key: string }, { value: string }>(`SELECT value FROM config_kv WHERE key = ?`).get({ key });
  return row?.value;
}

export function upsertConfigKV(key: string, value: string): void {
  db.prepare<{ key: string; value: string }>(`
    INSERT INTO config_kv (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ key, value });
}

export default db;

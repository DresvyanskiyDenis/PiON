/**
 * EXT-26 — the on-disk shape of `index.db`. `db.ts` execs this on every open, so it must stay
 * idempotent (`IF NOT EXISTS` everywhere) — the indexer runs it on every `session_start`.
 *
 * REQ-CTX-22: per-session cost, token families and `parent_id`.
 * REQ-PRV-74: `cost_known=0` renders "n/a"; `cost_usd` is NULL, never 0.0, when unknown.
 * REQ-PRV-91: the greppable event log — identifiers and counts only, never message content.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  file           TEXT NOT NULL,
  parent_id      TEXT,
  title          TEXT,
  cwd            TEXT,
  branch         TEXT,
  worktree       INTEGER NOT NULL DEFAULT 0,
  provider       TEXT,
  model          TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,
  turns          INTEGER NOT NULL DEFAULT 0,
  tokens_input   INTEGER NOT NULL DEFAULT 0,
  tokens_output  INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning   INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL,
  cost_known     INTEGER NOT NULL DEFAULT 0,
  indexed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS sessions_parent  ON sessions(parent_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT,
  ok         INTEGER,
  ms         INTEGER,
  payload    TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_kind    ON events(kind, ts);
`;

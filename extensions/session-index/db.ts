/**
 * The one place that opens `index.db` and the one place that writes to it.
 *
 * SQLite access goes through `sqlite-runtime.ts`'s `openSqliteDatabase()`, not a direct
 * `node:sqlite` import — see that file's docstring for why (Node ships `node:sqlite`, the
 * Bun-compiled `pi` binary that is actually installed does not; `bun:sqlite` covers it
 * instead). All access here is synchronous by design; nothing in this file starts a timer,
 * socket or watcher, so it is safe to call from `register()` as well as from event handlers —
 * though in practice every caller in this tree is an event handler,
 * never module top level, so the process never pays for a DB open on invocations that never
 * open a session (`pi --list-models`).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../lib/paths.ts";
import { SCHEMA_SQL } from "./schema.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite-runtime.ts";

/** `PI_INDEX_DB` mirrors `bin/pi-log`'s override so both sides ever agree on one file. */
export function defaultIndexDbPath(): string {
  return process.env.PI_INDEX_DB ?? join(configDir(), "index.db");
}

let cached: SqliteDatabase | undefined;
let cachedPath: string | undefined;

/** Opens (and caches) the index db, applying the schema and WAL mode. Idempotent. */
export function openIndexDb(path: string = defaultIndexDbPath()): SqliteDatabase {
  if (cached && cachedPath === path) return cached;
  mkdirSync(dirname(path), { recursive: true });
  const db = openSqliteDatabase(path);
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA journal_mode = WAL"); // concurrent sessions index without blocking each other
  cached = db;
  cachedPath = path;
  return db;
}

/** Test-only: drop the cached handle so the next `openIndexDb()` call reopens from disk. */
export function resetIndexDbCache(): void {
  cached = undefined;
  cachedPath = undefined;
}

export interface SessionRow {
  readonly id: string;
  readonly file: string;
  readonly parentId: string | null;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly worktree: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly turns: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensReasoning: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
  /** NULL, never 0, when `costKnown` is false (REQ-PRV-74). */
  readonly costUsd: number | null;
  readonly costKnown: boolean;
  readonly indexedAt: number;
}

/**
 * Deviation from an earlier draft's sample SQL: that ON CONFLICT clause updated only
 * `ended_at`/`turns`/token/cost/`title` — `provider`, `model`, `started_at`, `cwd`, `branch` and
 * `parent_id` were left out of the UPDATE SET. A brand-new session's first `session_start` fires
 * with an empty entry list (reason "new"), so those columns would be inserted null/empty and then
 * NEVER corrected, because the richer values computed at `session_shutdown` had no column to land
 * in. Fixed here by covering every column, guarding the "should only improve, never regress to
 * null" ones with COALESCE(excluded.x, sessions.x) — except `started_at`, which is the reverse:
 * once a real start time is known it must win over a later null, so it's
 * COALESCE(sessions.started_at, excluded.started_at). `ended_at`, the token/cost families and
 * `worktree` are always freshly computed cumulative snapshots, so they overwrite unconditionally.
 */
const UPSERT_SESSION_SQL = `
  INSERT INTO sessions (id, file, parent_id, title, cwd, branch, worktree, provider, model,
                        started_at, ended_at, turns, tokens_input, tokens_output, tokens_reasoning,
                        tokens_cache_read, tokens_cache_write, cost_usd, cost_known, indexed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    file=excluded.file,
    parent_id=COALESCE(excluded.parent_id, sessions.parent_id),
    title=COALESCE(excluded.title, sessions.title),
    cwd=COALESCE(excluded.cwd, sessions.cwd),
    branch=COALESCE(excluded.branch, sessions.branch),
    worktree=CASE WHEN excluded.worktree=1 THEN 1 ELSE sessions.worktree END,
    provider=COALESCE(excluded.provider, sessions.provider),
    model=COALESCE(excluded.model, sessions.model),
    started_at=COALESCE(sessions.started_at, excluded.started_at),
    ended_at=excluded.ended_at,
    turns=excluded.turns,
    tokens_input=excluded.tokens_input,
    tokens_output=excluded.tokens_output,
    tokens_reasoning=excluded.tokens_reasoning,
    tokens_cache_read=excluded.tokens_cache_read,
    tokens_cache_write=excluded.tokens_cache_write,
    cost_usd=excluded.cost_usd,
    cost_known=excluded.cost_known,
    indexed_at=excluded.indexed_at
`;

/** Read-modify-write over `sessions` only — never touches a PI session file. */
export function upsertSession(db: SqliteDatabase, row: SessionRow): void {
  db.prepare(UPSERT_SESSION_SQL).run(
    row.id,
    row.file,
    row.parentId,
    row.title,
    row.cwd,
    row.branch,
    row.worktree ? 1 : 0,
    row.provider,
    row.model,
    row.startedAt,
    row.endedAt,
    row.turns,
    row.tokensInput,
    row.tokensOutput,
    row.tokensReasoning,
    row.tokensCacheRead,
    row.tokensCacheWrite,
    row.costUsd,
    row.costKnown ? 1 : 0,
    row.indexedAt,
  );
}

/** REQ-PRV-91: one row per interesting thing. `payload` is caller-supplied JSON — identifiers
 * and counts only, by calling convention (see `logEvent` in `index.ts`); this layer does not and
 * cannot enforce that, it only persists what it is given. */
export function insertEvent(
  db: SqliteDatabase,
  sessionId: string,
  kind: string,
  name: string | null,
  ok: boolean | null,
  ms: number | null,
  payload: string | null,
): void {
  db.prepare(
    "INSERT INTO events (session_id, ts, kind, name, ok, ms, payload) VALUES (?,?,?,?,?,?,?)",
  ).run(sessionId, Date.now(), kind, name, ok === null ? null : ok ? 1 : 0, ms, payload);
}

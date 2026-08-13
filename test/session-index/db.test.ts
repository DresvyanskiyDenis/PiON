import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { insertEvent, openIndexDb, resetIndexDbCache, upsertSession, type SessionRow } from "../../extensions/session-index/db.ts";

let sandbox: string;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "session-index-db-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function baseRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s1",
    file: "/sessions/s1.jsonl",
    parentId: null,
    title: null,
    cwd: "/repo",
    branch: null,
    worktree: false,
    provider: "anthropic",
    model: "claude-x",
    startedAt: 1000,
    endedAt: 2000,
    turns: 1,
    tokensInput: 10,
    tokensOutput: 5,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUsd: 0.01,
    costKnown: true,
    indexedAt: 3000,
    ...over,
  };
}

describe("openIndexDb", () => {
  it("creates the schema (both tables + all four indexes) on a fresh file", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "fresh-")), "index.db");
    const db = openIndexDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => String(r.name))
      // sqlite_sequence is SQLite's own bookkeeping table for AUTOINCREMENT, not ours.
      .filter((name) => name !== "sqlite_sequence");
    assert.deepEqual(tables, ["events", "sessions"]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r) => String(r.name))
      // SQLite's own implicit autoindex backing the sessions.id PRIMARY KEY, not ours.
      .filter((name) => !name.startsWith("sqlite_autoindex_"));
    assert.deepEqual(indexes, ["events_kind", "events_session", "sessions_parent", "sessions_started"]);
  });

  it("is idempotent: opening an already-initialized db does not error", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "reopen-")), "index.db");
    openIndexDb(dbPath).close();
    resetIndexDbCache();
    assert.doesNotThrow(() => openIndexDb(dbPath));
  });

  it("caches the handle for repeat calls with the same path", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "cache-")), "index.db");
    const a = openIndexDb(dbPath);
    const b = openIndexDb(dbPath);
    assert.equal(a, b);
    resetIndexDbCache();
  });
});

describe("upsertSession", () => {
  it("inserts a new row with all fields readable back", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "insert-")), "index.db");
    const db = openIndexDb(dbPath);
    upsertSession(db, baseRow());
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1")!;
    assert.equal(row.file, "/sessions/s1.jsonl");
    assert.equal(row.provider, "anthropic");
    assert.equal(row.tokens_input, 10);
    assert.equal(row.cost_known, 1);
    assert.equal(row.cost_usd, 0.01);
  });

  it("REQ-PRV-74: cost_known=0 stores cost_usd as NULL, never 0.0", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "unpriced-")), "index.db");
    const db = openIndexDb(dbPath);
    upsertSession(db, baseRow({ id: "s2", provider: "github-copilot", costKnown: false, costUsd: null }));
    const row = db.prepare("SELECT cost_usd, cost_known FROM sessions WHERE id = ?").get("s2")!;
    assert.equal(row.cost_known, 0);
    assert.equal(row.cost_usd, null);
  });

  it("a second upsert overwrites cumulative fields (ended_at, turns, tokens, cost)", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "cumulative-")), "index.db");
    const db = openIndexDb(dbPath);
    upsertSession(db, baseRow({ id: "s3", turns: 1, tokensInput: 10, endedAt: 2000 }));
    upsertSession(db, baseRow({ id: "s3", turns: 3, tokensInput: 40, endedAt: 5000, costUsd: 0.05 }));
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s3")!;
    assert.equal(row.turns, 3);
    assert.equal(row.tokens_input, 40);
    assert.equal(row.ended_at, 5000);
    assert.equal(row.cost_usd, 0.05);
  });

  it("a sparse first insert (fresh new session, no entries yet) is not permanently blanked by a later richer upsert — and vice versa", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "sparse-")), "index.db");
    const db = openIndexDb(dbPath);
    // session_start on a brand-new session: no assistant turns yet, provider/model/started_at unknown.
    upsertSession(
      db,
      baseRow({ id: "s4", provider: null, model: null, startedAt: null, branch: null, title: null }),
    );
    // session_shutdown later: now everything is known.
    upsertSession(
      db,
      baseRow({ id: "s4", provider: "anthropic", model: "claude-x", startedAt: 1234, branch: "main", title: "my session" }),
    );
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s4")!;
    assert.equal(row.provider, "anthropic", "provider must not stay stuck at the sparse first insert");
    assert.equal(row.model, "claude-x");
    assert.equal(row.started_at, 1234);
    assert.equal(row.branch, "main");
    assert.equal(row.title, "my session");
  });

  it("started_at, once known, is never overwritten by a later null", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "started-at-")), "index.db");
    const db = openIndexDb(dbPath);
    upsertSession(db, baseRow({ id: "s5", startedAt: 1000 }));
    upsertSession(db, baseRow({ id: "s5", startedAt: null, turns: 9 }));
    const row = db.prepare("SELECT started_at, turns FROM sessions WHERE id = ?").get("s5")!;
    assert.equal(row.started_at, 1000);
    assert.equal(row.turns, 9);
  });

  it("worktree flips to 1 and stays 1 once observed true", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "worktree-")), "index.db");
    const db = openIndexDb(dbPath);
    upsertSession(db, baseRow({ id: "s6", worktree: true }));
    upsertSession(db, baseRow({ id: "s6", worktree: false }));
    const row = db.prepare("SELECT worktree FROM sessions WHERE id = ?").get("s6")!;
    assert.equal(row.worktree, 1);
  });
});

describe("insertEvent (REQ-PRV-91)", () => {
  it("stores a greppable row with a JSON payload", async () => {
    resetIndexDbCache();
    const dbPath = join(await mkdtemp(join(sandbox, "events-")), "index.db");
    const db = openIndexDb(dbPath);
    insertEvent(db, "s1", "guard", "DB-RM-ROOT", false, 3, JSON.stringify({ toolName: "bash" }));
    const row = db.prepare("SELECT * FROM events WHERE session_id = ?").get("s1")!;
    assert.equal(row.kind, "guard");
    assert.equal(row.name, "DB-RM-ROOT");
    assert.equal(row.ok, 0);
    assert.deepEqual(JSON.parse(row.payload as string), { toolName: "bash" });
  });
});

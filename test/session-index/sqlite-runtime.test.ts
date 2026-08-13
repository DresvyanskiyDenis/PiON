import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openSqliteDatabase, resolveSqliteBinding } from "../../extensions/session-index/sqlite-runtime.ts";

/**
 * Regression coverage for the bug this file exists to fix: the installed `pi` binary is a
 * Bun-compiled standalone executable, and Bun does not implement `node:sqlite` (confirmed
 * empirically against both the installed binary and a bare system `bun`: `import("node:sqlite")`
 * -> `ResolveMessage: No such built-in module: node:sqlite`). The old `db.ts` used a static
 * `import { DatabaseSync } from "node:sqlite"`, which fails at module-link time under Bun and,
 * because it's a static import, takes down `extensions/index.ts`'s entire import graph with it —
 * every extension, not just session-index. `resolveSqliteBinding` replaces that static import
 * with a synchronous, catchable `require()` so a missing `node:sqlite` degrades to `bun:sqlite`
 * (this runtime) instead of aborting extension load.
 *
 * These tests can't flip the *real* runtime under `node --test` (node:sqlite is genuinely
 * present here), so they exercise the fallback logic itself via an injected `require`, which is
 * exactly the contract `resolveSqliteBinding` was built to expose for this purpose.
 */
describe("resolveSqliteBinding", () => {
  it("prefers node:sqlite when it resolves", () => {
    class FakeDatabaseSync {
      readonly path: string;
      constructor(path: string) {
        this.path = path;
      }
    }
    const binding = resolveSqliteBinding((id) => {
      if (id === "node:sqlite") return { DatabaseSync: FakeDatabaseSync };
      throw new Error(`unexpected require(${id})`);
    });
    assert.equal(binding.moduleName, "node:sqlite");
    const db = binding.open("/tmp/x.db") as unknown as FakeDatabaseSync;
    assert.ok(db instanceof FakeDatabaseSync);
    assert.equal(db.path, "/tmp/x.db");
  });

  it("falls back to bun:sqlite when node:sqlite's require throws — the exact Bun scenario this file fixes", () => {
    class FakeBunDatabase {
      readonly path: string;
      constructor(path: string) {
        this.path = path;
      }
    }
    const binding = resolveSqliteBinding((id) => {
      if (id === "node:sqlite") {
        throw new Error("No such built-in module: node:sqlite");
      }
      if (id === "bun:sqlite") return { Database: FakeBunDatabase };
      throw new Error(`unexpected require(${id})`);
    });
    assert.equal(binding.moduleName, "bun:sqlite");
    const db = binding.open("/tmp/y.db") as unknown as FakeBunDatabase;
    assert.ok(db instanceof FakeBunDatabase);
    assert.equal(db.path, "/tmp/y.db");
  });

  it("fails loud, naming both modules and a remedy, when neither is available", () => {
    assert.throws(
      () =>
        resolveSqliteBinding((id) => {
          throw new Error(`no ${id} here`);
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /node:sqlite/);
        assert.match(err.message, /bun:sqlite/);
        assert.match(err.message, /session-index/i);
        assert.match(err.message, /npm/i);
        return true;
      },
    );
  });

  it("openSqliteDatabase (real, uninjected) opens a usable database on this runtime", () => {
    const db = openSqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
    db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("a", 1);
    const row = db.prepare("SELECT * FROM t WHERE id = ?").get("a");
    assert.equal(row?.n, 1);
    db.close();
  });
});

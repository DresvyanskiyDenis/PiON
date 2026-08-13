/**
 * EXT-26's one runtime-detection seam: a synchronous SQLite binding that works whether `pi`
 * is the compiled Bun binary (`--mode binary`, the default and currently-installed mode) or
 * real Node (`--mode npm`).
 *
 * **Why this file exists.** An earlier draft chose `node:sqlite` on the assumption that
 * Node ships it unflagged from our floor of 22.19 — true for Node, but `pi`'s default install
 * is a **Bun-compiled standalone binary**, not Node (`bin/pi -> .local/pi/<ver>/pi/pi`, a
 * Mach-O executable; `core/config.js`'s `isBunBinary` flag, read by the extension loader, is
 * how PI itself tells them apart). Bun 1.3.x does not implement `node:sqlite` — confirmed
 * empirically 2026-08-07 against both the installed `pi` binary and a bare system `bun`
 * (`bun bare.mjs`, `import("node:sqlite")` -> `ResolveMessage: No such built-in module:
 * node:sqlite`), so this is a genuine runtime gap, not an artifact of `pi`'s jiti-based
 * extension loader. Bun does ship its own `bun:sqlite`, API-compatible for the narrow surface
 * this tree uses (`exec`/`prepare`/`run`/`get`/`all`/`close` — verified empirically the same
 * day: `bun:sqlite`'s `Database` returns `{changes, lastInsertRowid}` from `.run()` and plain
 * row objects from `.get()`/`.all()`, matching `node:sqlite`'s `DatabaseSync` shape closely
 * enough that no normalization layer is needed for what this tree calls).
 *
 * **Why `require()`, not `import`.** A static `import { DatabaseSync } from "node:sqlite"` — the
 * original shape of this file — is resolved and linked before any module code runs. Under Bun
 * that link step throws immediately, which doesn't just break session-index: it throws out of
 * `extensions/index.ts`'s own top-level import of this module, before that file's per-registrar
 * try/catch (see its docstring) ever gets a chance to run, taking down every extension in the
 * tree with it (the bug this file fixes). A `require()` call inside a function body, by
 * contrast, only executes — and can only throw — when that function is actually called, so it
 * is catchable here. `createRequire(import.meta.url)` and synchronous `require()` are both
 * available and synchronous on this runtime under both Bun and Node (verified empirically
 * alongside the above).
 *
 * **Isolation, not just resolution.** Even without this file, `db.ts`'s only callers
 * (`index.ts`) never call `openIndexDb()` from `register()` itself — only from inside
 * `guardedIndex()` (which already catches and logs to stderr, "observability must never break a
 * session") and the `/index` command handler (whose failure is scoped to that one command). So
 * once the load-time throw above is gone, a hypothetical future runtime with *neither* binding
 * fails loud but scoped: `/doctor`, every other extension and both session lifecycle hooks stay
 * unaffected; only `session-index`'s writes (and the `/index` command, if invoked) are disabled,
 * with the error below naming the runtime, both modules tried and the remedy.
 */
import { createRequire } from "node:module";
import { describeError } from "../lib/once.ts";

export interface SqliteStatement {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
  all(...params: readonly unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteBinding {
  readonly moduleName: "node:sqlite" | "bun:sqlite";
  open(path: string): SqliteDatabase;
}

type RequireFn = (id: string) => unknown;

const defaultRequire: RequireFn = createRequire(import.meta.url);

function describeRuntime(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  if (bun) return `Bun ${bun.version ?? "unknown version"}`;
  return `Node ${process.versions.node}`;
}

/**
 * Exported so tests can inject a fake `require` and exercise both the fallback and the
 * both-fail path without needing a second real runtime in CI. Real callers use
 * `openSqliteDatabase()` below, which always passes the real `require`.
 */
export function resolveSqliteBinding(requireFn: RequireFn = defaultRequire): SqliteBinding {
  try {
    const nodeSqlite = requireFn("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    return { moduleName: "node:sqlite", open: (path) => new nodeSqlite.DatabaseSync(path) };
  } catch (nodeErr) {
    try {
      const bunSqlite = requireFn("bun:sqlite") as {
        Database: new (path: string) => SqliteDatabase;
      };
      return { moduleName: "bun:sqlite", open: (path) => new bunSqlite.Database(path) };
    } catch (bunErr) {
      throw new Error(
        "session-index (EXT-26): no SQLite binding available on this runtime — " +
          `tried "node:sqlite" (${describeError(nodeErr)}) and "bun:sqlite" (${describeError(bunErr)}). ` +
          `Detected runtime: ${describeRuntime()}. Remedy: run under Node >=22.19, where node:sqlite ` +
          'is available (see "npm" mode in scripts/install.sh and the npm spec in ' +
          "config/pi-release.lock), or a Bun build that ships bun:sqlite. Session indexing " +
          "(EXT-26) is disabled; every other extension is unaffected.",
      );
    }
  }
}

/** Opens `path` with whichever binding this runtime actually has. */
export function openSqliteDatabase(path: string): SqliteDatabase {
  return resolveSqliteBinding().open(path);
}

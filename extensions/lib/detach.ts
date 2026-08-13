/**
 * Detached, locked, recursion-guarded, version-stamped background spawn
 * (REQ-CTX-24, REQ-EXT-22, REQ-EXT-23).
 *
 * Ported from a real outage: the unguarded predecessor produced 18 concurrent workers, load
 * 233 and swap exhaustion, which drops ssh and every service on the box. The locking and the
 * recursion guard are not optional hardening; they are the reason this module exists.
 *
 * `flock(1)` is util-linux and does not exist on macOS, so the mutex is an atomic `mkdir` —
 * the same mechanism already proven in `config/bin/dbx-token-cached`. `mkdir(2)` is atomic on
 * APFS, needs no dependency, and a crashed holder is reclaimed by pid liveness plus age.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError } from "./once.ts";

/**
 * `"error"` is an addition to the four outcomes an earlier draft defined. `runDetached` must
 * never reject — a background side effect cannot be allowed to fail a turn — but silently
 * reporting an internal failure as `"locked"` would be exactly the silent substitution the
 * project forbids. The failure is reported through `onError` and named in the return value.
 */
export type DetachOutcome = "spawned" | "locked" | "recursion" | "stale-cleared" | "error";

export interface DetachOptions {
  /** Directory used as the mutex. One per logical worker, e.g. <state>/locks/session-digest. */
  readonly lockDir: string;
  /** A lock older than this is assumed crashed and is cleared. Default 15 min. */
  readonly staleMs?: number;
  /** Env var that marks "we are already inside this worker". Default PI_CONFIG_WORKER. */
  readonly recursionEnv?: string;
  /** Bumped whenever the worker's output format changes; written into the lock meta. */
  readonly version: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Where internal failures are reported. Defaults to stderr. Never swallowed. */
  readonly onError?: (line: string) => void;
}

export const DEFAULT_STALE_MS = 15 * 60_000;
export const DEFAULT_RECURSION_ENV = "PI_CONFIG_WORKER";

/**
 * Spawns `argv` fully detached and returns immediately. Never rejects.
 */
export async function runDetached(
  argv: readonly [string, ...string[]],
  opts: DetachOptions,
): Promise<DetachOutcome> {
  const recursionEnv = opts.recursionEnv ?? DEFAULT_RECURSION_ENV;
  const fail = opts.onError ?? defaultOnError;

  try {
    if (process.env[recursionEnv]) return "recursion";

    let outcome: AcquireOutcome;
    try {
      outcome = await acquire(opts.lockDir, opts.staleMs ?? DEFAULT_STALE_MS, opts.version);
    } catch (err) {
      fail(`[pi-config] detach: could not acquire ${opts.lockDir}: ${describeError(err)}`);
      return "error";
    }
    if (outcome === "locked") return "locked";

    try {
      const child = spawn(argv[0], argv.slice(1), {
        detached: true,
        stdio: "ignore",
        cwd: opts.cwd,
        env: {
          ...process.env,
          ...opts.env,
          [recursionEnv]: "1",
          PI_CONFIG_WORKER_VERSION: opts.version,
        },
      });
      // A detached child that cannot start (ENOENT, EACCES) emits "error" asynchronously.
      // With no listener Node throws it as an unhandled event and takes the host process
      // down — the opposite of "a background side effect must not fail a turn".
      child.on("error", (err) => {
        fail(`[pi-config] detach: worker ${argv[0]} failed to start: ${describeError(err)}`);
        void releaseLock(opts.lockDir);
      });
      child.unref();
      // Re-stamp the lock with the WORKER's pid. The spawner is a `pi` process that exits at
      // session shutdown within two seconds (REQ-EXT-22), so a lock stamped with the spawner's
      // pid looks crash-abandoned to the very next session and the mutex evaporates — which is
      // the 18-worker outage all over again. The holder is the worker, so the holder's pid is
      // the worker's pid.
      if (child.pid !== undefined) {
        // Best effort, and deliberately not fatal: the child is already running, and without
        // the stamp the lock still ages out on the directory's own mtime. Racing with the
        // "failed to start" path above must not turn a successful spawn into an "error".
        try {
          await writeMeta(opts.lockDir, opts.version, child.pid);
        } catch (err) {
          fail(
            `[pi-config] detach: could not stamp ${opts.lockDir} with worker pid ${child.pid}: ` +
              describeError(err),
          );
        }
      }
    } catch (err) {
      fail(`[pi-config] detach: spawn of ${argv[0]} threw: ${describeError(err)}`);
      await releaseLock(opts.lockDir);
      return "error";
    }
    return outcome;
  } catch (err) {
    fail(`[pi-config] detach: unexpected internal failure: ${describeError(err)}`);
    return "error";
  }
}

/** The worker itself calls this in a finally block. Safe to call when not held. */
export async function releaseLock(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true }).catch(() => {});
}

export interface LockMeta {
  at: number;
  /** The WORKER's pid once it has been spawned; the spawner's only in the window before that. */
  pid: number;
  version: string;
}

/** Read the current holder's stamp, or null when the lock is free or unreadable. */
export async function readLockMeta(lockDir: string): Promise<LockMeta | null> {
  try {
    return JSON.parse(await readFile(join(lockDir, "meta.json"), "utf8")) as LockMeta;
  } catch {
    return null;
  }
}

type AcquireOutcome = "spawned" | "locked" | "stale-cleared";

/** A reclaim is held for a few milliseconds; anything older is a crashed reclaimer. */
const RECLAIM_STALE_MS = 5_000;
const MAX_ACQUIRE_ATTEMPTS = 6;

async function acquire(
  lockDir: string,
  staleMs: number,
  version: string,
): Promise<AcquireOutcome> {
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  let clearedStale = false;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      // recursive:false is the whole mutex: with recursive:true an existing directory does
      // not throw and the lock silently stops being a lock.
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      await writeMeta(lockDir, version);
      return clearedStale ? "stale-cleared" : "spawned";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const state = await inspectLock(lockDir, staleMs);
    if (state === "fresh") return "locked";
    if (state === "gone") continue;
    if (await reclaimStale(lockDir, staleMs)) clearedStale = true;
    else await delay(15 + attempt * 10);
  }
  // Every attempt was beaten to the lock. Refusing to spawn is the safe direction.
  return "locked";
}

type LockState = "fresh" | "stale" | "gone";

async function inspectLock(lockDir: string, staleMs: number): Promise<LockState> {
  const meta = await readLockMeta(lockDir);
  let at: number;
  if (meta) {
    if (!isAlive(meta.pid)) return "stale";
    at = meta.at;
  } else {
    // meta.json may simply not be written yet: the holder is between mkdir and writeMeta.
    // Treating "no meta" as stale would let a second process clear a lock one millisecond
    // old, which is exactly the 18-worker failure. Fall back to the directory's own age.
    const st = await stat(lockDir).catch(() => null);
    if (!st) return "gone";
    at = st.mtimeMs;
  }
  return Date.now() - at < staleMs ? "fresh" : "stale";
}

/**
 * Clears a stale lock, under a mutex of its own.
 *
 * `rename(2)` alone is not enough, and the five-process race proves it: between one racer
 * inspecting the lock as stale and renaming it away, a second racer can legitimately acquire
 * it — and the rename then deletes a FRESH lock, letting a third racer `mkdir` successfully.
 * Two workers, which is the outage. The fix is to serialise reclaims on their own atomic
 * `mkdir` and re-verify staleness inside that critical section: while the stale directory is
 * still in place nobody else can acquire, so the re-check cannot go out of date before the
 * rename.
 */
async function reclaimStale(lockDir: string, staleMs: number): Promise<boolean> {
  const reclaimDir = `${lockDir}.reclaim`;
  if (!(await enterReclaim(reclaimDir))) return false;
  try {
    if ((await inspectLock(lockDir, staleMs)) !== "stale") return false;
    const graveyard = `${lockDir}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await rename(lockDir, graveyard);
    } catch {
      return false;
    }
    await rm(graveyard, { recursive: true, force: true }).catch(() => {});
    return true;
  } finally {
    await rm(reclaimDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function enterReclaim(reclaimDir: string): Promise<boolean> {
  try {
    await mkdir(reclaimDir, { recursive: false, mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    const st = await stat(reclaimDir).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < RECLAIM_STALE_MS) return false;
    await rm(reclaimDir, { recursive: true, force: true }).catch(() => {});
    try {
      await mkdir(reclaimDir, { recursive: false, mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeMeta(lockDir: string, version: string, pid = process.pid): Promise<void> {
  await writeFile(
    join(lockDir, "meta.json"),
    JSON.stringify({ at: Date.now(), pid, version } satisfies LockMeta),
  );
}

function defaultOnError(line: string): void {
  process.stderr.write(`${line}\n`);
}

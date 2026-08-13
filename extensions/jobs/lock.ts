/**
 * The per-job mutex, built on `EXT-01`'s lock (`lib/detach.ts`).
 *
 * `detach.ts` owns the *mechanism* — an atomic `mkdir(2)` directory holding a `meta.json`
 * stamp of `{at, pid, version}` — because `flock(1)` is util-linux and does not exist on
 * macOS. That mechanism is what a job's read-modify-write window needs, but `detach.ts`
 * exports only `readLockMeta` and `releaseLock`; its `acquire()` is private and its public
 * entry point, `runDetached`, is a *singleton-worker* spawner: one lock per logical worker,
 * `stdio: "ignore"`, and a "locked" outcome for every caller after the first. A job store
 * needs the opposite — N concurrent jobs, each with its own lock and its own log files — so
 * `runDetached` cannot be the spawn path here (see `spawnJob` in `store.ts`).
 *
 * What this module therefore does NOT do is invent a second lock *format*: the directory
 * layout and the `meta.json` shape are `detach.ts`'s, the stale-holder reader is
 * `detach.ts`'s `readLockMeta`, and the release path is `detach.ts`'s `releaseLock`. If
 * `EXT-01` ever exports its `acquire()`, this file should shrink to a call of it.
 *
 * Deliberately absent: `detach.ts`'s `.reclaim` sub-mutex. That dance exists because five
 * *different* singleton spawners race for one shared worker lock. Here every lock is inside
 * a freshly created, uniquely named job directory, so the only contenders are reapers of one
 * already-existing job — a much narrower race, and one where the safe direction is to fail
 * loud rather than to clear another holder's lock.
 */
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readLockMeta, releaseLock } from "../lib/detach.ts";
import { describeError } from "../lib/once.ts";

/** Bumped with the on-disk job schema so an old holder is never mistaken for a current one. */
export const JOB_LOCK_VERSION = "jobs-2";

/** A holder whose pid is gone, or which is older than this, is treated as crashed. */
export const JOB_LOCK_STALE_MS = 60_000;

const MAX_ATTEMPTS = 60;
const RETRY_MS = 25;

export interface JobLockOptions {
  readonly staleMs?: number;
  readonly maxAttempts?: number;
}

/** `process.kill(pid, 0)`, with EPERM read as "alive but not ours". Mirrors `detach.ts`. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs `fn` while holding `lockDir`. Releases in a `finally`, so a throwing `fn` never
 * strands the lock.
 *
 * Throws — loudly, naming the lock and the holder — when the lock cannot be taken. A job
 * state write that silently skipped its mutex would be exactly the lost update the mutex
 * exists to prevent.
 */
export async function withJobLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts: JobLockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? JOB_LOCK_STALE_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  await acquire(lockDir, staleMs, maxAttempts);
  try {
    return await fn();
  } finally {
    await releaseLock(lockDir);
  }
}

async function acquire(lockDir: string, staleMs: number, maxAttempts: number): Promise<void> {
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // recursive:false is the whole mutex — with recursive:true an existing directory
      // does not throw and the lock silently stops being a lock (`detach.ts`, same note).
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      await writeFile(
        join(lockDir, "meta.json"),
        JSON.stringify({ at: Date.now(), pid: process.pid, version: JOB_LOCK_VERSION }),
      );
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`job lock ${lockDir} could not be created: ${describeError(err)}`, {
          cause: err,
        });
      }
    }

    if (await isStale(lockDir, staleMs)) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    await delay(RETRY_MS);
  }

  const meta = await readLockMeta(lockDir);
  throw new Error(
    `job lock ${lockDir} is held by pid ${meta?.pid ?? "unknown"} ` +
      `(version ${meta?.version ?? "unknown"}, age ${meta ? Date.now() - meta.at : "unknown"}ms) ` +
      `and did not become free after ${maxAttempts} attempts`,
  );
}

async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  const meta = await readLockMeta(lockDir);
  if (meta) {
    if (!isProcessAlive(meta.pid)) return true;
    return Date.now() - meta.at >= staleMs;
  }
  // The holder may simply be between `mkdir` and the `meta.json` write. Treating that as
  // stale would let a racer clear a millisecond-old lock, so fall back to the directory's
  // own age — the same reasoning as `detach.ts`'s `inspectLock`.
  const st = await stat(lockDir).catch(() => null);
  if (!st) return false;
  return Date.now() - st.mtimeMs >= staleMs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

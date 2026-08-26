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
 * Waiting is bounded by wall-clock time, not by a retry count. A count was the first shape here
 * — 60 attempts, 25ms apart — and it was wrong twice over. It could never be the defence it
 * looked like: a wedged holder is cleared by the `JOB_LOCK_STALE_MS` reclaim below, and 60
 * attempts give up 58.5 seconds before that fires, so the only outcome the budget could reach
 * was to turn ordinary contention into a wedge-shaped error. And a fixed 25ms sleep wakes every
 * contender on the same grid, so they collide, re-collide, and drain the lock at a rate set by
 * the sleep rather than by the work — measured at ~40 acquisitions/second regardless of how
 * short the critical section is. Full jitter is what decorrelates them; the deadline is what
 * makes the promise ("waits up to N milliseconds") one the code can actually keep.
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

/**
 * How long a caller waits for a contended lock before giving up.
 *
 * An order of magnitude above the worst wait measured under load, and an order of magnitude
 * below `JOB_LOCK_STALE_MS`, so the two mechanisms stop disagreeing about what "stuck" means:
 * this one bounds *waiting*, the stale reclaim handles a holder that is genuinely gone.
 */
export const JOB_LOCK_TIMEOUT_MS = 10_000;

const MIN_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 200;

export interface JobLockOptions {
  readonly staleMs?: number;
  readonly timeoutMs?: number;
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
 * Waits up to `timeoutMs` (default `JOB_LOCK_TIMEOUT_MS`) and then throws — loudly, naming the
 * lock and saying what was actually there when the wait ended. A job state write that silently
 * skipped its mutex would be exactly the lost update the mutex exists to prevent.
 */
export async function withJobLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts: JobLockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? JOB_LOCK_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? JOB_LOCK_TIMEOUT_MS;
  await acquire(lockDir, staleMs, timeoutMs);
  try {
    return await fn();
  } finally {
    await releaseLock(lockDir);
  }
}

async function acquire(lockDir: string, staleMs: number, timeoutMs: number): Promise<void> {
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  let backoff = MIN_BACKOFF_MS;

  for (;;) {
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

    const reclaimed = await isStale(lockDir, staleMs);
    if (reclaimed) await rm(lockDir, { recursive: true, force: true }).catch(() => {});

    // Checked before sleeping, and the sleep is clamped to what is left, so the wait never
    // runs past the number the error is about to quote.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // A reclaim already changed the world; retry at once rather than sleeping on a lock that
    // is not there any more.
    if (!reclaimed) {
      // Full jitter — uniform in [0, backoff), not a narrow band around it. Every waiter woke
      // on the same 25ms grid under the old scheme and collided again; a jittered wait is the
      // part that actually breaks the lockstep, and halving the mean is a side effect.
      await delay(Math.min(Math.random() * backoff, remaining));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  throw new Error(
    `job lock ${lockDir} was not acquired within ${timeoutMs}ms; it is ${await describeHolder(lockDir)}`,
  );
}

/**
 * Says what the lock looked like at the moment the wait ran out.
 *
 * The old message asserted "is held by pid <unknown>" unconditionally, which under load was
 * routinely a lie: the holder had already released and the waiter had simply lost every race.
 * An error that invents a wedged holder is exactly the failure fail-loud exists to prevent, so
 * the three cases are now told apart.
 */
async function describeHolder(lockDir: string): Promise<string> {
  const meta = await readLockMeta(lockDir);
  if (meta) {
    return `still held by pid ${meta.pid} (version ${meta.version}, age ${Date.now() - meta.at}ms)`;
  }
  const st = await stat(lockDir).catch(() => null);
  if (st) {
    return (
      `held by a process that had not stamped it yet — no readable meta.json, directory age ` +
      `${Math.round(Date.now() - st.mtimeMs)}ms`
    );
  }
  return `free again — this wait was lost to contention, not to a wedged holder`;
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

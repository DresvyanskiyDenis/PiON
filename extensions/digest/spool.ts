/**
 * The enqueue half of the digest pipeline: publish one job file into `digest-queue/` with an
 * atomic `write`+`rename` (build step 2's check — "kill -9 the session mid-write ⇒
 * `digest-queue/` contains no partial `.json`, only a stale `.tmp`" — holds because a `rename(2)`
 * on the same filesystem is atomic and the drainer only ever looks at `*.json`).
 *
 * No PI dependency: this module only touches `node:fs`/`node:path` so it is importable from
 * both the extension (`extensions/digest/index.ts`) and the standalone worker's tests.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIGEST_VERSION } from "./config.ts";
import { queueDir } from "./paths.ts";

export interface DigestJob {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  /** e.g. "shutdown:quit", "shutdown:reload", "compact:threshold". */
  readonly reason: string;
  readonly queuedAt: string;
  readonly digestVersion: number;
}

export interface EnqueueInput {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly reason: string;
}

/**
 * Writes `<queueDir>/.<sessionId>-<rand>.tmp` then renames it to
 * `<queueDir>/<sessionId>-<timestamp>-<rand>.json`. Returns the final path.
 *
 * The random suffix (not just `Date.now()`) exists because two events for the same session
 * (`session_before_compact` followed later by `session_shutdown`) can enqueue within the same
 * millisecond; a collision would silently overwrite one job with the other instead of queuing
 * both.
 */
export async function enqueueDigestJob(input: EnqueueInput, dir: string = queueDir()): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const job: DigestJob = {
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    cwd: input.cwd,
    reason: input.reason,
    queuedAt: new Date().toISOString(),
    digestVersion: DIGEST_VERSION,
  };
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tmp = join(dir, `.${input.sessionId}-${suffix}.tmp`);
  const dest = join(dir, `${input.sessionId}-${suffix}.json`);
  await writeFile(tmp, JSON.stringify(job), "utf8");
  await rename(tmp, dest);
  return dest;
}

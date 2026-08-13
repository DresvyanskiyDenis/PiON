/**
 * `EXT-06` — session digest pipeline. Binds `session_shutdown` (event #11) and
 * `session_before_compact` (event #7); on either, spools one job file and asks
 * `extensions/lib/detach.ts`'s `runDetached()` to spawn (at most one) `bin/pi-digest-drain`.
 *
 * Follows the non-index module contract (`export const id` +
 * `export function register(pi)`), not `export default` —
 * `extensions/index.ts` is the *only* default-exporting module in the
 * tree, and this module is composed into it by `integration`, not loaded directly by PI.
 *
 * Three independent, overlapping recursion guards, because the summariser (`pi -p
 * --no-session ...`) is itself a `pi` invocation that loads this same extension:
 *   1. `PI_DIGEST_WORKER=1` — set on the worker's env by `runDetached`, checked here at
 *      `register()` time, before any handler is even wired up.
 *   2. `PI_SUBAGENT_NAME` — set for `EXT-05` dispatch children; a subagent turn is not a
 *      session a human digests.
 *   3. `!ctx.sessionManager.getSessionFile()` — the summariser runs `--no-session`,
 *      so even without guards 1–2 it has nothing to spool.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { runDetached } from "../lib/detach.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { DIGEST_VERSION, RECURSION_ENV, type DigestConfig, loadDigestConfig } from "./config.ts";
import { digestLockDir } from "./paths.ts";
import { enqueueDigestJob } from "./spool.ts";

export const id = "digest";

export function register(pi: ExtensionAPI): void | Promise<void> {
  // Guards 1–2. Deliberately before any `await`: register() must stay fast, and a worker or
  // subagent child must never even construct the handlers, let alone spool a job.
  if (process.env[RECURSION_ENV] === "1" || process.env.PI_SUBAGENT_NAME) return;
  return registerHandlers(pi);
}

async function registerHandlers(pi: ExtensionAPI): Promise<void> {
  // Config I/O happens once, here, at register() time — a single local file read, not a
  // timer/socket/watcher, so it stays inside the "fast-async" allowance for register().
  // A malformed (not merely absent) config/digest.json throws; index.ts's per-module try/catch
  // reports that loudly through manifest.ts without taking any other
  // module down — silently downgrading a broken config to "digests off" would hide the bug.
  const cfg = await loadDigestConfig();
  if (!cfg.enabled) return;

  pi.on("session_shutdown", async (event, ctx) => {
    await enqueueAndSpawn(ctx, `shutdown:${event.reason}`, cfg);
    // No return value: session_shutdown carries no result contract, so there is nothing to
    // accidentally override — see the mirror comment on session_before_compact below.
  });

  pi.on("session_before_compact", async (event, ctx) => {
    await enqueueAndSpawn(ctx, `compact:${event.reason}`, cfg);
    // MUST stay undefined. session_before_compact accepts { cancel: true } or a full
    // { compaction: {...} }; the digest is purely observational
    // and returning anything here would cancel or replace the user's compaction.
    return undefined;
  });
}

async function enqueueAndSpawn(ctx: ExtensionContext, reason: string, cfg: DigestConfig): Promise<void> {
  try {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return; // --no-session runs (guard 3) have nothing to digest

    const turnCount = ctx.sessionManager.getEntries().filter((e) => e.type === "message").length;
    if (turnCount < cfg.minTurns) return;

    const sessionId = ctx.sessionManager.getSessionId();
    await enqueueDigestJob({ sessionId, sessionFile, cwd: ctx.cwd, reason });

    const outcome = await runDetached([process.execPath, drainScriptPath()], {
      lockDir: digestLockDir(),
      version: String(DIGEST_VERSION),
      recursionEnv: RECURSION_ENV,
      onError: (line) => report(ctx, line),
    });
    if (outcome === "error") {
      report(ctx, `[pi-config] digest: could not spawn the drain worker for session ${sessionId}`);
    }
    // "spawned" / "stale-cleared": a fresh worker now holds the lock and will drain this job.
    // "locked": an existing worker holds the lock; per bin/pi-digest-drain's re-scan-before-
    // release loop it will pick this job up before exiting (self-heal — see that file's header).
    // "recursion": unreachable here (guard 1 already returned), kept exhaustive for the type.
  } catch (err) {
    // The digest pipeline must never be the reason a session fails to shut down or compact.
    surfaceOnce(ctx, `digest:enqueue:${reason}:${errorSignature(err)}`, () => {
      emitNotice(ctx, `[pi-config] digest: failed to enqueue (${reason}): ${describeError(err)}`, "error");
    });
  }
}

function report(ctx: ExtensionContext, line: string): void {
  // One channel, whichever this run mode has — see `lib/announce.ts`.
  surfaceOnce(ctx, `digest:detach:${line.slice(0, 120)}`, () => emitNotice(ctx, line, "error"));
}

/**
 * Resolved relative to THIS module's own on-disk location, not `lib/paths.ts`'s `repoRoot()`.
 * `repoRoot()` defaults to `~/pi-config`, which disagrees with wherever this repo was actually
 * cloned whenever `PI_CONFIG_REPO` is unset — the drain worker then fails to spawn (ENOENT) silently,
 * because `runDetached`'s spawn error only reaches `onError`, and a `pi -p` batch never has a
 * human in front of it to see it. `import.meta.url` needs no env var and cannot disagree with
 * where this file actually lives; PI's jiti loader and Node's own loader both preserve the real
 * file:// URL for a module loaded by path (verified empirically).
 */
function drainScriptPath(): string {
  return fileURLToPath(new URL("../../bin/pi-digest-drain", import.meta.url));
}

function errorSignature(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return msg.slice(0, 120);
}

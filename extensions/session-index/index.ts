/**
 * EXT-26 — session index and local observability.
 *
 * Standalone extension (default export), not a wave-1 module: it is loaded directly via
 * `settings.json`'s `extensions` array, so — unlike the wave-1 tree under `extensions/index.ts` — it does not go
 * through `extensions/lib/manifest.ts`'s `DECLARED_MODULES` registry; that registry is scoped to
 * wave-1's seven modules and is out of scope for this task.
 *
 * Read-only by construction: every write in this file goes to `index.db` (`db.ts`); every read
 * of a *session* file goes through `session-file.ts`'s `readFileSync`-only contract. No code path
 * here can open a session file for writing.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describeError } from "../lib/once.ts";
import { backfill } from "./backfill.ts";
import { insertEvent, openIndexDb, upsertSession } from "./db.ts";
import { probeGitInfo } from "./git-probe.ts";
import { readSessionFile } from "./session-file.ts";
import { accumulateSessionStats, isUnpricedProvider } from "./usage.ts";

export const id = "session-index";

/**
 * REQ-PRV-91. Payload must be identifiers, counts and durations only, never message content —
 * that is a calling convention this function cannot enforce (see `db.ts`'s `insertEvent`), only
 * document. Never throws: "observability must never break a session" holds for this call site
 * exactly as it does for the indexer itself.
 */
export function logEvent(
  sessionId: string,
  kind: string,
  name: string,
  ok: boolean,
  ms?: number,
  payload?: unknown,
): void {
  try {
    insertEvent(
      openIndexDb(),
      sessionId,
      kind,
      name,
      ok,
      ms ?? null,
      payload === undefined ? null : JSON.stringify(payload),
    );
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}

/**
 * `PI_PARENT_SESSION` (set by EXT-05 when dispatching a sub-agent) takes priority: it is the
 * only signal for a dispatched child, which has no natural file-chain link back to its parent.
 * Falls back to the session's own header, whose `parentSession` field is a *file path* (see
 * `backfill.ts`'s doc comment) — resolved to an id by reading that file's header once.
 */
function resolveParentId(ctx: ExtensionContext): string | null {
  const dispatched = process.env.PI_PARENT_SESSION;
  if (dispatched) return dispatched;

  const parentPath = ctx.sessionManager.getHeader()?.parentSession;
  if (!parentPath) return null;
  try {
    return readSessionFile(parentPath).header?.id ?? null;
  } catch {
    return null;
  }
}

async function indexSession(ctx: ExtensionContext): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return; // in-memory / non-persisted session — nothing on disk to index

  const stats = accumulateSessionStats(ctx.sessionManager.getEntries());
  const provider = ctx.model?.provider ?? stats.provider;
  const model = ctx.model?.id ?? stats.model;
  const costKnown = !isUnpricedProvider(provider);
  const git = probeGitInfo(ctx.cwd);

  upsertSession(openIndexDb(), {
    id: sessionId,
    file: sessionFile,
    parentId: resolveParentId(ctx),
    title: ctx.sessionManager.getSessionName() ?? null,
    cwd: ctx.cwd || null,
    branch: git.branch,
    worktree: git.worktree,
    provider,
    model,
    startedAt: stats.startedAt,
    endedAt: Date.now(),
    turns: stats.turns,
    tokensInput: stats.tokensInput,
    tokensOutput: stats.tokensOutput,
    tokensReasoning: stats.tokensReasoning,
    tokensCacheRead: stats.tokensCacheRead,
    tokensCacheWrite: stats.tokensCacheWrite,
    costUsd: costKnown ? stats.costUsd : null,
    costKnown,
    indexedAt: Date.now(),
  });
}

/** Never lets an indexing failure propagate into the session lifecycle it's observing. */
function guardedIndex(reason: string): (event: unknown, ctx: ExtensionContext) => Promise<void> {
  return async (_event, ctx) => {
    try {
      await indexSession(ctx);
    } catch (err) {
      process.stderr.write(
        `[pi-config] session-index: ${reason} indexing failed: ${describeError(err)}\n`,
      );
    }
  };
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", guardedIndex("session_start"));
  pi.on("session_shutdown", guardedIndex("session_shutdown"));

  pi.registerCommand("index", {
    description: "Re-index all sessions into the local SQLite index (read-only over the session store)",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      ctx.ui.notify("indexing sessions…", "info");
      const all = await SessionManager.listAll();
      const result = backfill(openIndexDb(), all);
      const suffix = result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : "";
      ctx.ui.notify(`indexed ${result.indexed} sessions${suffix}`, "info");
    },
  });
}

/**
 * EXT-22 — task-list glue (`REQ-CTX-70`, `REQ-CTX-71`).
 *
 * `@juicesharp/rpiv-todo` 2.4.0 owns the `todo` tool, the `/todos` command and the live overlay —
 * that is the entire "the list itself, and its survival across `/reload` and compaction" half of
 * `REQ-CTX-70`. **VP-07 (was V-10)**: the package replays its state from the session transcript; it
 * writes nothing to disk, so a task list does NOT survive into a brand-new session
 * (`docs/PACKAGES.md`). This module does not try to close that
 * gap.
 *
 * This module is the remainder the package leaves: "binding it to our
 * conventions, and the stale-`in_progress` nudge every N turns on a cached prefix." It registers no
 * `todo` tool and no `/todos` command of its own — that pair belongs to the package — and reads the
 * package's task list only through the persisted `todo` toolResult envelope (`./replay.ts`), never
 * through the package's internal `state/` module.
 *
 * **The package itself is a separate load path.** Reviewing and pinning a package — already done
 * here, in `package.json`, `config/packages.lock.json` and `docs/PACKAGES.md` — produces nothing
 * else: no extension code is written and nothing is enabled. `@juicesharp/rpiv-todo`'s own `package.json` has no `main`/`exports`, only
 * `"pi": { "extensions": ["./index.ts"] }` — a PI package manifest, meant to be read by PI's own
 * package loader via `settings.json`'s `"packages"` array (a shared file this module does not
 * own), not by a bare `import` from this file. A hand-rolled
 * `import ... from "@juicesharp/rpiv-todo"` would additionally break `node --test` on this tree:
 * Node refuses type-stripping for `.ts` files under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, hit and documented the same way by EXT-12a's
 * `test/ext-12a-statusline.test.ts`). Until the integration phase applies that `settingsPatch`, the
 * `todo` tool does not exist and this module's nudge logic runs against a permanently empty list —
 * inert, not broken (see `nudge.ts`: zero tasks is a documented no-op).
 *
 * Auto-discovered as a standalone extension via the `extensions/<dir>/index.ts` subdirectory
 * pattern (same as `extensions/big-results/index.ts`, EXT-29) — it does not go through wave-1's
 * single composed `extensions/index.ts`, so `settings.json`'s `"extensions"` array needs no entry.
 * (That array is unrelated to the `"packages"` array the paragraph above depends on.)
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../lib/paths.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { lastTodoTasks, replayTasksFromBranch, type Task } from "./replay.ts";
import { createNudgeState, evaluateNudge, type NudgeState } from "./nudge.ts";

export const id = "tasks";

interface TasksConfig {
  readonly nudgeEveryTurns: number;
  readonly staleAfterTurns: number;
}

const DEFAULT_CONFIG: TasksConfig = { nudgeEveryTurns: 6, staleAfterTurns: 12 };

/** Candidate locations for `config/tasks.json`, first existing wins. Mirrors `guard/policy.ts`. */
function configPaths(): string[] {
  const candidates: string[] = [];
  // `extensions/` is symlinked into `~/.pi/agent/extensions`, so `import.meta.url` points at the
  // symlink. realpath() is what gets us back to the repo the file actually lives in.
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    candidates.push(resolve(dirname(here), "..", "..", "config", "tasks.json"));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  candidates.push(resolve(repoRoot(), "config", "tasks.json"));
  return candidates;
}

/** Synchronous by contract: `register()` must not start async work. */
function loadConfig(): TasksConfig {
  const found = configPaths().find((p) => existsSync(p));
  if (found === undefined) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(found, "utf8")) as { tasks?: Partial<TasksConfig> };
    const t = parsed.tasks ?? {};
    return {
      nudgeEveryTurns: typeof t.nudgeEveryTurns === "number" ? t.nudgeEveryTurns : DEFAULT_CONFIG.nudgeEveryTurns,
      staleAfterTurns: typeof t.staleAfterTurns === "number" ? t.staleAfterTurns : DEFAULT_CONFIG.staleAfterTurns,
    };
  } catch (err) {
    process.stderr.write(
      `[pi-config] tasks: ${found} is not valid JSON (${describeError(err)}); using built-in defaults\n`,
    );
    return DEFAULT_CONFIG;
  }
}

const cfg = loadConfig();

/**
 * Per-session live state. A session's cache and nudge tracking are isolated from any other's —
 * mirrors the installed package's own "parallel sessions stay separate" design (its `state/store.ts`
 * keys everything by session id too), so a detached or child session never inherits or corrupts the
 * foreground session's nudge cadence.
 */
const taskCache = new Map<string, Task[]>();
const nudgeStateBySession = new Map<string, NudgeState>();

function sid(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

function nudgeStateFor(session: string): NudgeState {
  let state = nudgeStateBySession.get(session);
  if (!state) {
    state = createNudgeState();
    nudgeStateBySession.set(session, state);
  }
  return state;
}

function prime(ctx: ExtensionContext): void {
  taskCache.set(sid(ctx), replayTasksFromBranch(ctx.sessionManager));
}

/**
 * Fail open (REQ-EXT-16's spirit, applied to a non-gate module): a bug in this nudge must never
 * crash a turn or corrupt the model's view of its own tool results. The error is still surfaced,
 * once, to both the log and the TUI — matches `extensions/big-results/index.ts`'s convention.
 */
function reportInternalError(ctx: ExtensionContext | undefined, where: string, err: unknown): void {
  surfaceOnce(ctx, `tasks:${where}:${describeError(err).slice(0, 120)}`, () => {
    emitNotice(
      ctx,
      `[pi-config] tasks: ${where} failed internally and was skipped: ${describeError(err)}`,
      "error",
    );
  });
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      prime(ctx);
    } catch (err) {
      reportInternalError(ctx, "session_start", err);
    }
  });

  // The branch identity can change under compaction and tree navigation — re-prime rather than
  // trust the cache, the same three events the installed package's own index.ts re-derives its
  // state from.
  pi.on("session_compact", (_event, ctx) => {
    try {
      prime(ctx);
    } catch (err) {
      reportInternalError(ctx, "session_compact", err);
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    try {
      prime(ctx);
    } catch (err) {
      reportInternalError(ctx, "session_tree", err);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const session = sid(ctx);
    taskCache.delete(session);
    nudgeStateBySession.delete(session);
  });

  // #17 — the stale-`in_progress` nudge (REQ-CTX-71). Sent via `sendMessage` rather than a
  // system-prompt edit, so it never invalidates the provider prompt cache; `display:false` keeps
  // it invisible in the transcript view, and `deliverAs:"nextTurn"` + `triggerTurn:false` guarantee
  // it never interrupts a turn already streaming.
  pi.on("turn_end", (event, ctx) => {
    try {
      const session = sid(ctx);
      // Fast path: this turn's own toolResults already carry the full post-mutation snapshot if
      // `todo` was called. Falls back to the primed cache, and — only if that is somehow still
      // unset — one full branch replay, so a missed/failed `session_start` cannot leave the nudge
      // permanently blind.
      const fromThisTurn = lastTodoTasks(event.toolResults);
      const tasks = fromThisTurn ?? taskCache.get(session) ?? replayTasksFromBranch(ctx.sessionManager);
      taskCache.set(session, tasks);

      const result = evaluateNudge(nudgeStateFor(session), tasks, event.turnIndex, cfg);
      if (!result) return;

      pi.sendMessage(
        { customType: "task_reminder", content: result.text, display: false },
        { deliverAs: "nextTurn", triggerTurn: false },
      );
    } catch (err) {
      reportInternalError(ctx, "turn_end", err);
    }
  });
}

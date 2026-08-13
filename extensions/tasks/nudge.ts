/**
 * EXT-22 — task-list glue: the stale-`in_progress` nudge (`REQ-CTX-71`).
 *
 * Pure decision logic — no PI imports, no I/O. `extensions/tasks/index.ts` is the only module that
 * touches `pi.sendMessage`; everything here is plain data in, plain data out, so it is unit-tested
 * without any PI runtime or mock `ExtensionContext`.
 *
 * Shape follows the original design (nudge every N turns, or sooner if
 * something has sat `in_progress` past the stale threshold) with two corrections against the real,
 * installed `@juicesharp/rpiv-todo` 2.4.0: the task field is `subject`, not `title`, and the
 * completed status is `"completed"`, not `"done"` (`node_modules/@juicesharp/rpiv-todo/tool/types.ts`).
 * The file-backed assumption (`listPath`, a `.pi/TODO.md` mention in the nudge text) is removed
 * entirely — `docs/PACKAGES.md`'s VP-07 finding is that the package writes no file at all.
 */
import type { Task } from "./replay.ts";

export interface NudgeConfig {
  readonly nudgeEveryTurns: number;
  readonly staleAfterTurns: number;
}

/** Per-session tracking state, mutated in place by `evaluateNudge`. */
export interface NudgeState {
  lastNudgeTurn: number;
  readonly inProgressSince: Map<number, number>;
}

export function createNudgeState(): NudgeState {
  return { lastNudgeTurn: -Infinity, inProgressSince: new Map() };
}

export interface NudgeResult {
  readonly text: string;
  readonly stale: boolean;
}

/**
 * Decides whether a nudge is due this turn, and mutates `state` to reflect the current
 * `in_progress` set. Returns `undefined` when nothing should be sent this turn.
 */
export function evaluateNudge(
  state: NudgeState,
  tasks: readonly Task[],
  turnIndex: number,
  cfg: NudgeConfig,
): NudgeResult | undefined {
  if (tasks.length === 0) {
    // Nothing to track. Clear stale bookkeeping so a task re-created later starts fresh.
    state.inProgressSince.clear();
    return undefined;
  }

  const liveInProgress = new Set<number>();
  for (const t of tasks) {
    if (t.status !== "in_progress") continue;
    liveInProgress.add(t.id);
    if (!state.inProgressSince.has(t.id)) state.inProgressSince.set(t.id, turnIndex);
  }
  // A task that left in_progress (closed, or reverted to pending) stops being tracked as stale.
  for (const id of [...state.inProgressSince.keys()]) {
    if (!liveInProgress.has(id)) state.inProgressSince.delete(id);
  }

  const stale = tasks.filter((t) => {
    if (t.status !== "in_progress") return false;
    const since = state.inProgressSince.get(t.id) ?? turnIndex;
    return turnIndex - since >= cfg.staleAfterTurns;
  });

  const due = turnIndex - state.lastNudgeTurn >= cfg.nudgeEveryTurns;
  if (!due && stale.length === 0) return undefined;
  state.lastNudgeTurn = turnIndex;

  const text = stale.length
    ? `Task list: "${stale[0].subject}" has been in_progress for ${cfg.staleAfterTurns}+ turns. Close it or re-plan.`
    : "Task list check: mark finished items completed and add anything new via the todo tool.";

  return { text, stale: stale.length > 0 };
}

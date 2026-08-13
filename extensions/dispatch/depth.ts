/**
 * **VP-01** — the depth limit, and the verification the plan asked for.
 *
 * The plan asked: *"The source references depth; whether it aborts at
 * dispatch with a named error is unverified, and this is the exact defect behind 50 recorded
 * OpenCode failures. If it does not, we assert depth in the ceiling hook before the child is
 * created."*
 *
 * **It does.** `pi-subagents` 0.41.0, `src/shared/types.ts:1936` `checkSubagentDepth()` reads
 * `PI_SUBAGENT_DEPTH`, compares it against `PI_SUBAGENT_MAX_DEPTH` (env first, then the package's
 * own config, then its built-in default), and `src/runs/foreground/subagent-executor.ts:4748`
 * turns a `blocked` verdict into a tool result carrying `isError: true` and the text
 * `"Nested subagent call blocked (depth=N, max=M)"` — at dispatch, before any child is created,
 * naming both numbers. That is loud, and it is the behaviour VP-01 asked about.
 *
 * Two things are still ours:
 *
 *  1. **Our number, not the package's.** `resolveCurrentMaxSubagentDepth()` prefers
 *     `PI_SUBAGENT_MAX_DEPTH` over everything else, so `session_start` stamps our configured
 *     `maxDepth` into the environment. Without that the effective ceiling is whatever
 *     `~/.pi/agent/extensions/subagent/config.json` says — a file outside this repo.
 *  2. **An independent assertion.** The package's check is the package's; if the env is lost, if a
 *     future version changes the variable, or if the package fails to load at all while its tool
 *     name is still being called, nothing else stops depth 3. Our own `tool_call` rule re-asserts
 *     it. Two mechanisms agreeing costs one integer comparison.
 */

/** The package's variable names. Read, and in the max case written, deliberately. */
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEPTH_ENV];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  // A malformed depth must not read as 0 — that would hand an unbounded budget to a child whose
  // environment was mangled. Treat it as "already deep".
  if (!Number.isFinite(parsed) || parsed < 0) return Number.POSITIVE_INFINITY;
  return Math.floor(parsed);
}

export interface DepthVerdict {
  readonly blocked: boolean;
  readonly depth: number;
  readonly maxDepth: number;
  readonly reason?: string;
}

export function evaluateDepth(depth: number, maxDepth: number): DepthVerdict {
  if (depth < maxDepth) return { blocked: false, depth, maxDepth };
  const shown = Number.isFinite(depth) ? String(depth) : "unreadable (PI_SUBAGENT_DEPTH was malformed)";
  return {
    blocked: true,
    depth,
    maxDepth,
    reason:
      `sub-agent dispatch refused at depth ${shown} (max ${maxDepth}). ` +
      `You are already running as a sub-agent at the configured nesting limit — ` +
      `complete this task directly instead of delegating it further.`,
  };
}

/**
 * Stamps our `maxDepth` into the environment so the package's own check uses our number, and
 * returns what was overwritten so `/doctor` can show it. Idempotent.
 */
export function applyMaxDepthEnv(maxDepth: number, env: NodeJS.ProcessEnv = process.env): { previous?: string } {
  const previous = env[MAX_DEPTH_ENV];
  env[MAX_DEPTH_ENV] = String(maxDepth);
  return previous === undefined ? {} : { previous };
}

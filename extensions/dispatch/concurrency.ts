/**
 * **VP-02**, applied — where the per-provider cap actually bites, and where it verifiably cannot.
 *
 * ## The constraint, verified in PI 0.84.0
 *
 * The obvious design — acquire a permit in the `tool_call` hook, release it in `tool_result` —
 * **deadlocks**. In
 * `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`,
 * `executeToolCallsParallel()` runs
 *
 *     for (const toolCall of toolCalls) { await emit(tool_execution_start); await prepareToolCall(...) }
 *     await Promise.all(finalizedCalls.map(entry => entry()))
 *
 * `prepareToolCall` is what invokes `config.beforeToolCall`, i.e. our `tool_call` handler. Every
 * hook in the batch is therefore awaited **before any tool in the batch begins executing**. A hook
 * that blocks waiting for a permit held by an earlier call in the same batch waits for a task that
 * has not started and cannot start until the hook returns. On a lane capped at 1, with two
 * `subagent` calls in one assistant message, that is a permanent hang — strictly worse than over-subscription.
 * `tool_execution_start` is emitted inside the same loop and is no better.
 *
 * There is no extension-visible hook that runs inside the `Promise.all` phase: `pi.registerTool`
 * adds a tool, `pi.getAllTools()` returns `ToolInfo` records and not the live executables, so the
 * package's `subagent` tool cannot be wrapped from outside.
 *
 * ## What this module does instead
 *
 * It **lowers the fanout width in place**, which is deadlock-free because it is pure argument
 * rewriting. `pi-subagents`' `subagent` tool takes a `concurrency` argument for its parallel,
 * chain and dynamic-fanout modes and *queues* the remaining tasks — so clamping that number to the
 * provider's cap gives exactly "queue, never error" on the path that produces the bursts: one tool
 * call fanning out N children. Clamping only ever lowers; it never raises a cap the caller asked
 * for, and it never raises the package's own default.
 *
 * The residual — several separate `subagent` tool calls emitted in one assistant message — is
 * **not** bounded by this module, and this note says so rather than pretending otherwise. `ProviderSemaphore` is exported and tested for the callers that *can* use it (any
 * in-process spawner: `EXT-23`'s worktree runner, `EXT-25`'s teammate runtime, and a future
 * first-party dispatch tool built on `pi-subagents`' structured delegation API, whose `execute()`
 * runs inside the `Promise.all` phase where blocking is safe).
 */
import type { DispatchConfig, RoutingConfig } from "./config.ts";

/** Argument names that carry a fanout width on a dispatch tool call. */
export const CONCURRENCY_KEYS = ["concurrency"] as const;

/** Argument names whose presence means the call fans out rather than running one child. */
export const FANOUT_KEYS = ["tasks", "parallel", "chain", "expand"] as const;

export function capFor(routing: RoutingConfig | undefined, provider: string, cfg: DispatchConfig): number {
  const configured = routing?.concurrency[provider];
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 1
    ? configured
    : cfg.concurrencyDefault;
}

export function isFanoutCall(input: Readonly<Record<string, unknown>>): boolean {
  return FANOUT_KEYS.some((key) => input[key] !== undefined);
}

export interface ClampOutcome {
  readonly changed: boolean;
  /** What the call asked for, or the package default when it asked for nothing. */
  readonly requested: number;
  readonly cap: number;
  readonly applied: number;
  readonly reason: string;
}

/**
 * Clamps `input.concurrency` in place. Returns `undefined` when the call is not a fanout, in which
 * case there is nothing to bound: one child is always within any cap of 1 or more.
 *
 * In-place mutation of `input` is the documented mechanism ("input mutation
 * is in-place and is **not** re-validated"), which is why this writes a plain number and nothing
 * that would need re-validating.
 */
export function clampConcurrency(
  input: Record<string, unknown>,
  cap: number,
  cfg: DispatchConfig,
): ClampOutcome | undefined {
  if (!isFanoutCall(input)) return undefined;

  const raw = input.concurrency;
  const asked =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : undefined;
  const requested = asked ?? cfg.packageDefaultConcurrency;
  const applied = Math.min(requested, cap);

  if (applied >= requested && asked !== undefined) {
    return { changed: false, requested, cap, applied: requested, reason: "already within the provider cap" };
  }
  if (asked === undefined && cap >= cfg.packageDefaultConcurrency) {
    return {
      changed: false,
      requested,
      cap,
      applied: requested,
      reason: `no explicit concurrency and the cap (${cap}) is at or above the package default (${cfg.packageDefaultConcurrency})`,
    };
  }

  input.concurrency = applied;
  return {
    changed: true,
    requested,
    cap,
    applied,
    reason:
      asked === undefined
        ? `no explicit concurrency; the package would default to ${cfg.packageDefaultConcurrency}, lowered to the provider cap ${cap}`
        : `requested ${requested}, lowered to the provider cap ${cap}`,
  };
}

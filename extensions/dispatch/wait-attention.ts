/**
 * `subagent_wait`'s `stopOnAttention` default, set where this repo can actually set it: on the
 * call, not in the package.
 *
 * ## What the package does
 *
 * `pi-subagents` 0.57.0 resolves the flag as
 * `params.stopOnAttention ?? deps.stopOnAttention !== false`
 * (`src/runs/background/subagent-wait.ts:562`), so an omitted parameter means **true** and a
 * blocking wait ends on ANY `needs_attention` run. Two of the three producers of that state are
 * heuristics rather than questions:
 *
 *   - idle beyond 60 s, scaled ×2/×5/×10 for medium/high/xhigh thinking
 *     (`runs/shared/subagent-control.ts:19`, `scaledNeedsAttentionAfterMs` `:82-95`,
 *     `deriveActivityState` `:97-110`)
 *   - one tool call open for 240 s or more (`subagent-control.ts:21`,
 *     `shouldEmitOpenToolAttention` `:112-121`)
 *
 * A child that is thinking hard, or is four minutes into one `bash`, is not asking the lead
 * anything. The signal that IS an ask, a pending `contact_supervisor`/intercom request, is
 * `hasSupervisorTool(run)` (`subagent-wait.ts:248`), and it is checked independently of this flag,
 * which is why lowering the default loses nothing: `isDone()` reads
 * `stopOnAttention || hasSupervisorTool(run)` (`:566`). Terminal states are a different branch of
 * the same predicate and are not affected at all.
 *
 * Each spurious wake costs the lead a full re-read of its context: a cache miss bought with no new
 * information.
 *
 * ## Why the default is written onto the call
 *
 * There is no configuration surface for it, in either file the package reads.
 * `resolveWaitToolConfig` returns `{ enabled }` and nothing else
 * (`runs/background/wait-config.ts`), so `config.waitTool` in `config/subagent.json` cannot express
 * it; `subagents.watchdog` in `config/settings.json` is a different parser (`watchdog/settings.ts`)
 * that rejects unknown fields outright. The only injector of `deps.stopOnAttention` in the whole
 * package is its own internal auto-drain (`runs/background/auto-drain.ts:59`), which passes
 * `false`: upstream already agrees with the value, it just does not expose it.
 * `test/dispatch/watchdog-settings.test.ts` pins all three facts, so the day a real key appears
 * this module becomes deletable and that test says so.
 *
 * Patching `node_modules` is not the alternative: `bin/rules/pc-21-vendored-tree-unmodified.mjs`
 * keeps the vendored tree unmodified, and the installed tree is what runs.
 *
 * So the value is written where every other dispatch-shaped default in this extension is written:
 * into the tool call's arguments, in place, from a `tool_call` rule, where input mutation is
 * in-place and is not re-validated. Same mechanism as `clampConcurrency`, and for the same reason.
 * No wrapper tool exists to register, because `pi.getAllTools()` hands back `ToolInfo` records
 * rather than the live executables, and re-registering the package's own `subagent_wait` would
 * fork a tool this repo does not own.
 *
 * ## What it deliberately does not do
 *
 *   - **An explicit parameter always wins.** A lead that writes `stopOnAttention: true` gets the
 *     package default back for that call; this only fills a value the caller omitted.
 *   - **Non-blocking waits are left alone.** `{ id, nonBlocking: true }` returns from the
 *     subscription branch before the flag is read, so writing it there would be an argument that
 *     means nothing.
 *   - **Nothing is suppressed.** A supervisor request, a completion, a failure, a pause and the
 *     wait's own timeout all still end the wait. The only thing that stops ending it is a
 *     heartbeat.
 */
import type { DispatchConfig } from "./config.ts";

export interface WaitDefaultOutcome {
  /** True when this module wrote `stopOnAttention` onto the call. */
  readonly changed: boolean;
  /** What the call will now do, in the lead's terms. */
  readonly reason: string;
}

/**
 * Fills in `input.stopOnAttention` for a blocking wait that did not name it, in place.
 *
 * Returns `undefined` when there is nothing to decide: the harness default is the package's own,
 * or the call is a non-blocking subscription whose result the flag cannot reach.
 */
export function applyWaitStopOnAttention(
  input: Record<string, unknown>,
  cfg: DispatchConfig,
): WaitDefaultOutcome | undefined {
  // `true` is what the package already does with no argument. Writing it would add a parameter
  // that changes nothing and make the disclosure below lie about a rewrite.
  if (cfg.waitStopOnAttention) return undefined;
  if (input.nonBlocking === true) return undefined;
  if (input.stopOnAttention !== undefined) {
    return {
      changed: false,
      reason: `the call named stopOnAttention: ${String(input.stopOnAttention)}; left as written`,
    };
  }
  input.stopOnAttention = false;
  return {
    changed: true,
    reason:
      "no stopOnAttention on the call; defaulted to false so idle and long-tool heartbeats do not end the wait",
  };
}

/**
 * The one-line disclosure. Deliberately constant: `report()` deduplicates on the message text, so a
 * fixed string is announced once per session instead of on every wait.
 */
export const WAIT_DEFAULT_NOTICE =
  "subagent_wait: this harness defaults stopOnAttention to false, so a blocking wait keeps waiting " +
  "through idle and long-tool heartbeats. It still returns on completion, failure, pause, timeout " +
  "and on a child's supervisor/contact request. Pass stopOnAttention: true to wake on heartbeats.";

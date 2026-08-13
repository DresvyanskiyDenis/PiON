/**
 * The fail-closed-on-match / fail-open-on-our-own-bug wrapper (REQ-EXT-16).
 *
 * PI's native semantics are the inverse: a `tool_call` handler that throws BLOCKS the tool.
 * That turns one bug in one rule into a blanket block on every tool
 * call that reaches it. No module in this tree registers a raw `tool_call` handler; they all
 * go through `guardedHandler`.
 */
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "./announce.ts";
import { describeError, surfaceAlways, surfaceOnce } from "./once.ts";

export type GuardVerdict = { block: true; reason: string } | { block: false } | undefined;

export interface GuardRule {
  /** Stable id, e.g. "DB-RM-ROOT". Appears in the reason string and in the audit entry. */
  readonly id: string;
  readonly evaluate: (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ) => GuardVerdict | Promise<GuardVerdict>;
  /**
   * Per-rule override of what happens when THIS rule throws (F2). Falls back to the handler's
   * shared `onInternalError` when unset, so a rule set that never opts in behaves exactly as
   * before. Only set "closed" for a rule whose absence is itself unsafe.
   */
  readonly onInternalError?: "open" | "closed";
}

export interface GuardedHandlerOptions {
  /** Owning module id, e.g. "guard". Used for dedup keys and the audit entry type. */
  readonly owner: string;
  readonly rules: readonly GuardRule[];
  /**
   * What to do when a rule THROWS. REQ-EXT-16 mandates "open": our own bug must never
   * become a blanket tool block. Only set "closed" for a rule whose absence is itself unsafe.
   */
  readonly onInternalError?: "open" | "closed";
  /**
   * F2: `surfaceOnce` keys its dedup on `owner:ruleId:error-signature`, so a rule that keeps
   * throwing the same error reports once and then goes silent — indistinguishable from a healthy
   * gate. Set true to bypass that dedup for every internal error this handler surfaces, so a
   * repeating failure never stops being visible. `guard.ts` sets this; nothing else needs to.
   */
  readonly alwaysSurfaceInternalErrors?: boolean;
  /** Optional audit sink; `guard.ts` passes `pi.appendEntry`. */
  readonly audit?: (customType: string, data: unknown) => void;
  /**
   * The "and in the log" half of REQ-EXT-16's acceptance. Defaults to stderr.
   * `ctx.ui.notify` covers the TUI half, but it is a no-op in `-p` and `--mode json`,
   * so a log sink is the only channel that always exists.
   */
  readonly log?: (line: string) => void;
}

export type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;

/**
 * Wraps an ordered rule set into a single `tool_call` handler:
 *   - the first rule returning `{block:true}` wins and short-circuits (fail CLOSED on a match)
 *   - a rule that THROWS is surfaced exactly once and skipped (fail OPEN on our bug)
 *   - the returned handler never throws, so PI's "throwing handler blocks" path is unreachable
 */
export function guardedHandler(opts: GuardedHandlerOptions): ToolCallHandler {
  const onError = opts.onInternalError ?? "open";

  return async (event, ctx) => {
    try {
      for (const rule of opts.rules) {
        let verdict: GuardVerdict;
        try {
          verdict = await rule.evaluate(event, ctx);
        } catch (err) {
          surfaceInternalError(opts, ctx, rule.id, err);
          // F2: a rule's own `onInternalError` wins over the handler's shared default, so a rule
          // whose absence is itself unsafe (e.g. the credential gate) can fail CLOSED even inside
          // a handler that otherwise fails open on our own bugs.
          if ((rule.onInternalError ?? onError) === "closed") {
            return {
              block: true,
              reason: `${rule.id}: guard unavailable (internal error) — refusing`,
            };
          }
          continue;
        }
        if (verdict?.block) {
          writeAudit(opts, ctx, rule, event, verdict.reason);
          return { block: true, reason: verdict.reason };
        }
      }
      return undefined;
    } catch (err) {
      // Unreachable by design — every await above is already guarded. Kept because
      // "fail open on an internal error of the guard itself" has to hold for bugs we
      // have not thought of, not only for the ones we have.
      surfaceInternalError(opts, ctx, "<handler>", err);
      return onError === "closed"
        ? { block: true, reason: `${opts.owner}: guard unavailable (internal error) — refusing` }
        : undefined;
    }
  };
}

function writeAudit(
  opts: GuardedHandlerOptions,
  ctx: ExtensionContext | undefined,
  rule: GuardRule,
  event: ToolCallEvent,
  reason: string,
): void {
  if (!opts.audit) return;
  try {
    opts.audit(`${opts.owner}.block`, {
      ruleId: rule.id,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      reason,
      at: Date.now(),
    });
  } catch (err) {
    // An audit sink that throws must not un-block a matched rule.
    surfaceInternalError(opts, ctx, `${rule.id}#audit`, err);
  }
}

function surfaceInternalError(
  opts: GuardedHandlerOptions,
  ctx: ExtensionContext | undefined,
  ruleId: string,
  err: unknown,
): void {
  const emit = (): void => {
    const line =
      `[pi-config] ${opts.owner}: rule ${ruleId} failed internally and was skipped: ` +
      describeError(err);
    // One channel, whichever this run mode has: `opts.log` when there is no UI, `ctx.ui.notify`
    // when there is. Writing both printed every internal-error report twice in the TUI — see
    // `lib/announce.ts`.
    emitNotice(ctx, line, "error", opts.log ?? defaultLog);
  };
  if (opts.alwaysSurfaceInternalErrors) {
    surfaceAlways(ctx, emit);
    return;
  }
  const key = `${opts.owner}:${ruleId}:${signature(err)}`;
  surfaceOnce(ctx, key, emit);
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

function signature(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return msg.slice(0, 120);
}

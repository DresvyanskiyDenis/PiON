/**
 * EXT-11 — the compaction loop guard (`REQ-CTX-35`, the MUST this whole item exists for).
 *
 * Pure decision logic: no PI import, no I/O, no clock. Everything the guard needs is measured
 * from the `session_before_compact` event and handed in as a `PassObservation`, so the rule set
 * is unit-testable without a PI runtime.
 *
 * **What "fails to reduce token count" means here.** PI gives an extension no post-compaction
 * token count it can trust: `ctx.getContextUsage()` returns `tokens: null` until the next
 * assistant response (`dist/core/extensions/types.d.ts`, `ContextUsage.tokens`), and
 * `CompactionEntry` carries only `tokensBefore`. So the reduction is measured **forward**, from
 * the preparation PI hands us, on two independent signals:
 *
 *   1. `droppedTokens / tokensBefore < minReductionRatio` — the pass is about to summarise a
 *      slice too small to buy room. Whatever it drops is replaced by a summary of comparable
 *      size, so the next turn lands back over the threshold.
 *   2. fewer than `minEntriesBetweenPasses` entries were appended since the previous compaction —
 *      the compaction is chasing its own tail rather than following real work. This is the signal
 *      that catches the overflow-recovery ping-pong, where the slice can look large but the same
 *      turn is being re-summarised.
 *
 * Either signal makes a pass **non-reducing**. `maxNonReducingPasses` consecutive non-reducing
 * passes trip the guard. One reducing pass resets the counter — the guard is about a loop, not
 * about a single bad pass.
 *
 * `reason: "manual"` passes are observed but never counted and never reset: a human typing
 * `/compact` twice is not the failure mode `REQ-CTX-35` describes, and letting it trip the guard
 * would take the session down for a deliberate act.
 */

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface LoopGuardConfig {
  /** Consecutive non-reducing automatic passes before the guard trips. */
  readonly maxNonReducingPasses: number;
  /** A pass dropping less than this fraction of the pre-compaction context is non-reducing. */
  readonly minReductionRatio: number;
  /** Fewer session entries than this since the previous compaction is non-reducing. */
  readonly minEntriesBetweenPasses: number;
}

export const DEFAULT_LOOP_GUARD: LoopGuardConfig = {
  maxNonReducingPasses: 3,
  minReductionRatio: 0.15,
  minEntriesBetweenPasses: 2,
};

export interface PassObservation {
  readonly reason: CompactionReason;
  /** `preparation.tokensBefore` — the context size PI measured before this pass. */
  readonly tokensBefore: number;
  /** Σ `estimateTokens` over `messagesToSummarize` + `turnPrefixMessages`. */
  readonly droppedTokens: number;
  /** Entries appended since the previous compaction entry on this branch, or -1 if there is none. */
  readonly entriesSinceLastCompaction: number;
}

export interface LoopGuardState {
  /** Automatic passes seen this session. Manual passes are excluded. */
  automaticPasses: number;
  consecutiveNonReducing: number;
  /** Set once the guard has tripped, so the abort is reported exactly once per session. */
  tripped: boolean;
}

export interface PassVerdict {
  readonly counted: boolean;
  readonly reducing: boolean;
  /** Human-readable reason, always populated — it goes verbatim into the typed error. */
  readonly why: string;
  readonly reductionRatio: number;
  readonly consecutiveNonReducing: number;
  /** True on the pass that crosses `maxNonReducingPasses`, and on every pass after it. */
  readonly trip: boolean;
}

export function createLoopGuardState(): LoopGuardState {
  return { automaticPasses: 0, consecutiveNonReducing: 0, tripped: false };
}

export function reductionRatio(obs: PassObservation): number {
  const before = Math.max(obs.tokensBefore, 1);
  return obs.droppedTokens / before;
}

/**
 * Folds one compaction pass into the guard state and returns the verdict.
 *
 * Mutates `state` — the caller owns one state object per session and hands the same one back on
 * every pass.
 */
export function observePass(
  state: LoopGuardState,
  obs: PassObservation,
  cfg: LoopGuardConfig = DEFAULT_LOOP_GUARD,
): PassVerdict {
  const ratio = reductionRatio(obs);

  if (obs.reason === "manual") {
    return {
      counted: false,
      reducing: true,
      why: "manual /compact — observed but not counted toward the loop guard",
      reductionRatio: ratio,
      consecutiveNonReducing: state.consecutiveNonReducing,
      trip: state.tripped,
    };
  }

  state.automaticPasses += 1;

  const tooSmallASlice = ratio < cfg.minReductionRatio;
  // -1 means "no previous compaction on this branch", which cannot be evidence of a loop.
  const tooSoon =
    obs.entriesSinceLastCompaction >= 0 &&
    obs.entriesSinceLastCompaction < cfg.minEntriesBetweenPasses;

  const reasons: string[] = [];
  if (tooSmallASlice) {
    reasons.push(
      `pass would drop ~${obs.droppedTokens} of ${obs.tokensBefore} context tokens ` +
        `(${(ratio * 100).toFixed(1)} % < the ${(cfg.minReductionRatio * 100).toFixed(1)} % floor)`,
    );
  }
  if (tooSoon) {
    reasons.push(
      `only ${obs.entriesSinceLastCompaction} session ${
        obs.entriesSinceLastCompaction === 1 ? "entry was" : "entries were"
      } appended since the previous compaction ` +
        `(floor is ${cfg.minEntriesBetweenPasses}) — the compaction is following itself, not work`,
    );
  }

  const reducing = reasons.length === 0;
  if (reducing) {
    state.consecutiveNonReducing = 0;
  } else {
    state.consecutiveNonReducing += 1;
  }

  const trip = state.consecutiveNonReducing >= cfg.maxNonReducingPasses;
  if (trip) state.tripped = true;

  return {
    counted: true,
    reducing,
    why: reducing
      ? `pass drops ~${obs.droppedTokens} of ${obs.tokensBefore} context tokens (${(ratio * 100).toFixed(1)} %)`
      : reasons.join("; "),
    reductionRatio: ratio,
    consecutiveNonReducing: state.consecutiveNonReducing,
    trip,
  };
}

export interface CompactionLoopDetails {
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly reason: CompactionReason;
  readonly automaticPasses: number;
  readonly consecutiveNonReducing: number;
  readonly maxNonReducingPasses: number;
  readonly tokensBefore: number;
  readonly droppedTokens: number;
  readonly reductionRatio: number;
  readonly entriesSinceLastCompaction: number;
  readonly why: string;
}

/**
 * The typed error `REQ-CTX-35` asks for. It is a real `Error` subclass so a `cause` chain
 * survives, and it carries `code` so a log line can be grepped without parsing prose.
 */
export class CompactionLoopError extends Error {
  override readonly name = "CompactionLoopError";
  readonly code = "compaction_loop";
  readonly details: CompactionLoopDetails;

  constructor(details: CompactionLoopDetails, options?: { cause?: unknown }) {
    super(
      `compaction loop guard tripped after ${details.consecutiveNonReducing} consecutive ` +
        `non-reducing pass(es) (limit ${details.maxNonReducingPasses}): ${details.why}`,
      options,
    );
    this.details = details;
  }
}

/**
 * The multi-line block written to stderr — the only channel that exists in `-p` and
 * `--mode json`. `context_overflow` appears literally when the trip happened on an
 * overflow-recovery pass, because that is the string `REQ-CTX-35`'s acceptance greps for.
 */
export function formatLoopFailure(err: CompactionLoopError): string {
  const d = err.details;
  const lines = [
    `[pi-config] compaction: ${err.code} — aborting the session, context is not shrinking`,
    `  error    : ${err.name}`,
    `  code     : ${err.code}${d.reason === "overflow" ? " (context_overflow recovery)" : ""}`,
    `  session  : ${d.sessionId}`,
    `  provider : ${d.provider}`,
    `  model    : ${d.model}`,
    `  trigger  : ${d.reason}`,
    `  passes   : ${d.automaticPasses} automatic, ${d.consecutiveNonReducing} consecutive non-reducing (limit ${d.maxNonReducingPasses})`,
    `  tokens   : ${d.tokensBefore} before this pass, ~${d.droppedTokens} would be summarised (${(d.reductionRatio * 100).toFixed(1)} %)`,
    `  entries  : ${
      d.entriesSinceLastCompaction < 0 ? "n/a (first compaction)" : d.entriesSinceLastCompaction
    } since the previous compaction`,
    `  why      : ${d.why}`,
    `  message  : ${err.message}`,
  ];
  return lines.join("\n");
}

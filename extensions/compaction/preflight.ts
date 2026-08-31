/**
 * Context-window preflight — refuse a request the harness already knows is over the window.
 *
 * ## The observation this exists for (2026-08-30)
 *
 * A call billed 273 110 tokens (`input 2, output 2537, cacheWrite 270571`) against a model whose
 * window this harness itself declares as 200 000 — ~35% over. The provider did not error. It
 * answered `200 OK` with an empty body, which is the `empty-response` class, which then killed the
 * turn. The number that would have prevented the whole chain was already in `config/models.json`
 * before the request was assembled.
 *
 * ## Order of operations, and why this cannot fire first
 *
 * PI compacts on its own rule — `shouldCompact(contextTokens, contextWindow, settings)` is
 * `contextTokens > contextWindow - reserveTokens` (`core/compaction/compaction.js:160-164`) — and
 * it evaluates it AFTER a run, in `_handlePostAgentRun` (`agent-session.js:776`). Its trigger is
 * therefore always strictly BELOW the window, by `reserveTokens` (20 000 here).
 *
 * This module only ever acts strictly ABOVE the window, with a further tolerance on top. That
 * ordering is the whole design and it is not a coincidence to be preserved by hand: at any size
 * where compaction has something to say, this module is silent, so it can never trigger a
 * compaction that autocompact was not already going to do, and it can never spend a summarisation
 * call that the reserve would have spent anyway. What it catches is the case autocompact
 * structurally cannot — growth *inside* a single run, where several provider requests are issued
 * between two post-run checks and the last of them is already doomed.
 *
 * ## Recovery, and why the refusal alone is not one
 *
 * This module used to claim that recovery was PI's: the refused turn returns to
 * `_handlePostAgentRun`, which runs `_checkCompaction` against a context that is demonstrably over
 * the window, compacts, and continues the loop. The first half is true and the second half is not,
 * and the shipped code says which: `_checkCompaction(assistantMessage, skipAbortedCheck = true)`
 * opens with `if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false`
 * (`core/agent-session.js:1510-1516`), and `_handlePostAgentRun` calls it with the default. A
 * refusal aborts, so the message PI evaluates is `aborted`, so **no compaction runs and the `while`
 * loop ends**. The session goes idle holding the same over-window context.
 *
 * Nothing restarts it. Compaction only reaches that context through the *other* call site —
 * `prompt()`'s pre-run check, `_checkCompaction(lastAssistant, false)` (`:860-866`), the one that
 * passes `skipAbortedCheck: false` on purpose "to catch aborted responses". That call site is
 * reached by a new turn, and the only thing that started one was a person typing. Every refusal
 * therefore cost the run an open-ended stretch of dead wall-clock, ended by a keystroke — on an
 * unattended run, by nothing at all.
 *
 * So the recovery is a **self-resume**: refuse, abort, and then, once the run has settled, have the
 * harness itself send the user message a person would have. `index.ts` does that from
 * `agent_settled` — see its `registerPreflight` header for why that event and not this handler.
 * The turn it starts runs `prompt()`, hence the pre-run compaction check, hence exactly the
 * recovery this module always described, minus the wait.
 *
 * Calling `ctx.compact()` from the handler instead would put a second compaction against the same
 * context — the shape `loop-guard.ts` exists to shoot down — and would still leave the session
 * idle afterwards, because `AgentSession.compact()` aborts and summarises but starts no turn.
 * The self-resume needs no second compaction: the turn it starts performs the first one.
 *
 * ## The estimate, and the honest bound on it
 *
 * No tokenizer. The estimate is the total length of the string leaves of the assembled request
 * body, divided by {@link CHARS_PER_TOKEN}. Both halves of that are approximations and both are
 * stated rather than hidden:
 *
 *   - **String leaves, not `JSON.stringify` length.** Serialising the whole body counts keys,
 *     braces, quotes and escapes, which no tokenizer ever sees; on a body with thousands of small
 *     message objects that overhead is tens of thousands of phantom tokens.
 *   - **3.5 chars per token.** English prose runs ~4, code and JSON payloads run ~3, and this
 *     harness's contexts are mostly the latter. 3.5 splits them. The residual error is roughly
 *     ±15%, in both directions, and that is why the refusal needs the tolerance below rather than
 *     firing at exactly `contextWindow`.
 *
 * {@link OVER_WINDOW_TOLERANCE} is the margin that converts "probably over" into "over by more
 * than this estimator can be wrong about". At 1.05 on a 200 000 window the bar is 210 000
 * estimated tokens; the observed incident estimated ~270 000 and is caught with room to spare,
 * while a prompt sitting at 98% of the window — where the estimator's error genuinely could
 * decide the verdict — is left alone for autocompact, which by then has long since fired.
 */

/** Characters per token. See the module header for why 3.5 and not 4. */
export const CHARS_PER_TOKEN = 3.5;

/**
 * How far past the declared window an ESTIMATE has to be before it is treated as a fact.
 *
 * 5%. Not tuned — chosen so the bar sits outside the estimator's own error band on the side that
 * matters: a false refusal costs a turn the model could have completed, and this module must never
 * be the reason a request that would have worked did not happen.
 */
export const OVER_WINDOW_TOLERANCE = 1.05;

/**
 * Consecutive refusals allowed before this module stands down for the streak.
 *
 * Two: one for the request that was over before compaction, one for a request that is STILL over
 * after it. Past that, compaction has demonstrably not brought the context under the window and
 * refusing again would be an invisible loop — a session that never sends anything and never says
 * why. So the third one is let through, loudly, and the failure that follows is the provider's own
 * and lands in the normal classified-failure channel where it can be read.
 *
 * Until the self-resume this number was unreachable: the streak can only advance if a *second*
 * request is attempted without human input, and a refusal ended the session's turn. It is now live
 * machinery, and it is also what bounds the self-resume — at most {@link MAX_CONSECUTIVE_REFUSALS}
 * of them per streak, because the verdict at the cap is `over-but-passed`, which sends rather than
 * refuses and therefore resumes nothing.
 */
export const MAX_CONSECUTIVE_REFUSALS = 2;

export type PreflightVerdict =
  /** Under the bar, or the harness has no window to compare against. Send it. */
  | "send"
  /** Over the bar. Do not send; the turn returns to PI, which compacts and continues. */
  | "refuse"
  /**
   * Over the bar, and refusing has already failed to help twice. Send it and say so — a doomed
   * request whose failure is visible beats a silent loop.
   */
  | "over-but-passed";

export interface PreflightInput {
  readonly estimatedTokens: number;
  /** `ctx.model.contextWindow`, as declared by `config/models.json` + PI's own catalogue. */
  readonly contextWindow: number | undefined;
  /** Refusals already issued in this streak; cleared by the first request that fits. */
  readonly refusalsSoFar: number;
}

/**
 * Estimated tokens for the assembled request body.
 *
 * Structural and defensive: `BeforeProviderRequestEvent.payload` is `unknown`, its shape differs
 * per API (`anthropic-messages` vs `openai-completions`), and a preflight that threw on an
 * unfamiliar body would break every request instead of the over-window ones. Anything that is not
 * a string, array or object contributes nothing, and a cycle cannot hang it.
 */
export function estimatePromptTokens(payload: unknown): number {
  let chars = 0;
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      chars += node.length;
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };
  walk(payload);
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** The bar this request has to clear, or `undefined` when there is no declared window. */
export function overWindowBar(contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.round(contextWindow * OVER_WINDOW_TOLERANCE);
}

/**
 * Send it, refuse it, or send it under protest.
 *
 * A missing or nonsensical `contextWindow` is always `send`. Refusing on a number the harness does
 * not have would be the same silent substitution this repo refuses everywhere else, only with the
 * harness playing the provider's part.
 */
export function preflightVerdict(input: PreflightInput): PreflightVerdict {
  const bar = overWindowBar(input.contextWindow);
  if (bar === undefined) return "send";
  if (input.estimatedTokens <= bar) return "send";
  return input.refusalsSoFar >= MAX_CONSECUTIVE_REFUSALS ? "over-but-passed" : "refuse";
}

export interface PreflightFacts {
  readonly estimatedTokens: number;
  readonly contextWindow: number;
  readonly model: string;
}

/**
 * What the operator is told, and it says four things on purpose: that the harness refused (not the
 * provider), by how much, on which model's declared number, and what happens next. The word
 * "estimate" is in it because it is one.
 */
export function refusalLine(facts: PreflightFacts): string {
  const over = Math.round((facts.estimatedTokens / facts.contextWindow - 1) * 100);
  return (
    `refused a request this harness estimates at ~${facts.estimatedTokens} tokens against ` +
    `${facts.model}'s declared ${facts.contextWindow}-token window (~${over}% over, estimate is ` +
    `chars/${CHARS_PER_TOKEN} on the assembled body). Nothing was sent: an over-window request to ` +
    `this fleet comes back as a 200 with an empty body, not as an error. This harness resumes the ` +
    `session itself once the run settles; compaction runs on that turn's entry. No keystroke needed.`
  );
}

/**
 * The message the harness sends itself to restart the session after a refusal.
 *
 * It is a real user message, because only the `prompt()` path carries the pre-run compaction check
 * that makes the resumed turn fit — see the module header. Two things it therefore has to do that a
 * human's "continue" did by accident: say who sent it, so the model does not read it as the
 * operator changing course mid-task, and say what happened, so the model knows the missing
 * assistant turn is a harness abort and not its own output being lost.
 */
export function selfResumeLine(facts: PreflightFacts): string {
  return (
    `[pi-config] Automatic resume, not a human message. The previous request was refused by this ` +
    `harness's context-window preflight (~${facts.estimatedTokens} estimated tokens against ` +
    `${facts.model}'s declared ${facts.contextWindow}-token window) and never reached the ` +
    `provider, so the turn it belonged to has no assistant reply. The context has been handed to ` +
    `compaction on the way into this turn. Continue the work exactly where it stopped; do not ` +
    `restart it and do not ask what to do next.`
  );
}

/** The stand-down line: said once, when refusing twice has not helped. */
export function passedAnywayLine(facts: PreflightFacts): string {
  return (
    `still ~${facts.estimatedTokens} tokens against ${facts.model}'s declared ` +
    `${facts.contextWindow}-token window after ${MAX_CONSECUTIVE_REFUSALS} refusals and a ` +
    `compaction. Letting this request go so its failure is the provider's own and visible, rather ` +
    `than refusing on a loop. The context needs a smaller model-independent fix: /compact with ` +
    `instructions, a new session, or a model whose declared window matches what it serves.`
  );
}

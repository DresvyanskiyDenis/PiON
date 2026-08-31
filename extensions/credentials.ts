/**
 * `EXT-13` — credentials, providers, and provider error surfacing.
 *
 * Two things live here, and they are here together because they are the same subject: what it
 * takes to talk to a model, and what happens when that fails.
 *
 * **(a) Databricks credentials.** No code here — `config/bin/dbx-token-cached` is the whole
 * implementation, referenced from `models.json` as `"apiKey": "!$HOME/bin/dbx-token-cached"`.
 * It exists because PI re-executes an `!command` credential on **every request** with no TTL of
 * its own, so an unwrapped `databricks auth token` costs one OAuth round trip per LLM call.
 *
 * **(b) Provider error surfacing** (`implementation_plan.md` §3.4a) — what replaced the cancelled
 * `EXT-08` failover item. A failed provider call names the provider, model, error class and
 * message, keeps the cause chain, and the turn aborts. No substitution, no retry into a different
 * provider, no silent degradation. Classification and rendering are in `lib/provider-error.ts`.
 *
 * Since 2026-08-30 two of the six classes get ONE more attempt before that abort — `network` and
 * `empty-response`, at the same provider and the same model, per `routing.json` ->
 * `onProviderError.retry` (`lib/provider-retry.ts` carries the argument). That is not failover
 * arriving by the back door: nothing here has ever re-issued a request anywhere else, and nothing
 * here does now. It is the difference between "this endpoint refused you" and "this endpoint
 * answered 200 with an empty body", which the old block treated as the same event.
 *
 * That re-issue may now also be allowed to DIFFER from the attempt it replaces, on one axis and one
 * only: reasoning effort, via `onProviderError.retry.onEmpty`. PI exposes no per-message model or
 * thinking override — `pi.sendMessage`'s options are `triggerTurn` and `deliverAs`, nothing else —
 * so the only lever is the session-level `pi.setThinkingLevel`, which means the level has to be
 * BORROWED and given back. `restoreThinkingLevel` below is that second half, and it is the
 * load-bearing one: a harness that lowered the effort for a retry and never put it back would keep
 * reasoning less than the operator asked for, forever, silently, which is the exact failure this
 * repo's no-silent-degradation rule is about.
 *
 * This file used to carry a third subject, the `local` lane: a hand-registered `local` provider
 * pointing at llama-swap on loopback, with its own discovery budget, a `/v1/models` warm-up ping,
 * a footer status marker and a one-line "the local tier is unavailable" warning. It is gone.
 * Owner decision, 2026-08-15: the live provider set is exactly `github-copilot`, `litellm` and
 * `databricks`, and the live tier set is exactly `strong`, `light` and `confidential` — so there
 * is no `local` provider to register and no `local` tier for a warning to be about. Nothing
 * replaced the warning, deliberately: a provider that does not exist cannot be unreachable.
 * No built-in provider is re-registered here either, and none ever was — re-registering
 * `github-copilot` would destroy its OAuth block (`coverage_matrix.md`, `REQ-PRV-22`: "impossible
 * for built-in providers"), and that lane is resolved by configuration instead (a raw `gho_`
 * token as an apiKey credential plus a `baseUrl` override in `models.json`).
 *
 * `register()` starts no timers, sockets or watchers, and now performs no I/O at all: the factory
 * also runs in invocations that never open a session (`pi --list-models`).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildEmptyCompletionFailure,
  buildProviderFailure,
  isEmptyCompletion,
  type ProviderFailure,
  surfaceProviderFailure,
} from "./lib/provider-error.ts";
import {
  loadProviderRetryPolicy,
  planRetryVariation,
  type ProviderRetryPolicy,
  retryBudget,
  shouldRetry,
} from "./lib/provider-retry.ts";

export const id = "credentials";

export function register(pi: ExtensionAPI): void {
  registerProviderErrorSurfacing(pi);
}

/* ------------------------------------------------------------------------------------------- *
 * (b) provider error surfacing
 * ------------------------------------------------------------------------------------------- */

interface ObservedResponse {
  readonly status: number;
  /**
   * `AfterProviderResponseEvent.headers`, kept on the SAME reset cycle as the status.
   *
   * They were being discarded here, one line from where they were needed. An empty 200 has no body
   * to quote, so the gateway's own correlation headers — `x-litellm-call-id` above all — are the
   * only thing in the report a proxy admin can act on. `pickGatewayHeaders` decides which four
   * survive; this just stops throwing them away.
   *
   * Deliberately stored on the existing `observed` record rather than in a second variable with its
   * own subscriber: two subscribers to the same event would have two reset cycles, and one turn's
   * headers would eventually be printed against the next turn's status. That is the exact bug
   * `before_provider_request`'s reset exists to prevent for the status itself.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Wire the two events that, together, cover all three failure shapes:
 *
 *   - **non-2xx.** `after_provider_response` fires with the status; the status is remembered, and
 *     the assistant message that follows carries the upstream text.
 *   - **200 that dies mid-stream.** `after_provider_response` fires with `status: 200` — it runs
 *     on the response headers, before the body is consumed — so the status alone says nothing is
 *     wrong. The stream's terminal `error` event is what sets the assistant message's
 *     `stopReason` to `"error"`, and `message_end` is where that becomes visible. The failure is
 *     then classified from the message text and rendered as "headers ok; the stream failed after
 *     them" rather than as a misleading `http 200`.
 *   - **200 that carries no completion at all.** Nothing fails: the headers are 200, the stream
 *     is well formed, it simply contains no delta, and PI hands up a normal assistant message with
 *     `content: []`, `stopReason: "stop"` and zero usage. There is no error anywhere for the two
 *     branches above to catch, and PI's own retry predicate (`isRetryableAssistantError`) requires
 *     `stopReason === "error"`, so this shape passes every guard in the stack and is read
 *     downstream as "the model had nothing to say". `isEmptyCompletion` is the only thing between
 *     that and a silent no-op turn.
 *
 * All three therefore converge on `message_end`, which is the only point where the turn's outcome
 * is final. `stopReason: "aborted"` is deliberately not reported: that is the user pressing Esc,
 * not a provider failing.
 */
function registerProviderErrorSurfacing(pi: ExtensionAPI): void {
  let observed: ObservedResponse | undefined;
  // The persistence half of `surfaceProviderFailure`'s sinks: without it, `causeChain` for the
  // top-level session's own failures lives only on `stderr`, invisible inside an interactive TUI.
  const sinks = { appendEntry: (customType: string, data: unknown) => pi.appendEntry(customType, data) };
  // Read once per process. `routing.json` is not watched anywhere else in this tree either, and a
  // policy that changed under a running session would make two attempts at the same turn obey two
  // different rules.
  let policy: ProviderRetryPolicy | undefined;
  const retryPolicy = (): ProviderRetryPolicy => (policy ??= loadProviderRetryPolicy());
  /**
   * Retries already spent on the CURRENT failure streak — not on the session.
   *
   * Cleared by any assistant message that is neither an error nor an empty completion, i.e. by a
   * turn that worked. A transient failure an hour after a recovered one is a new coin flip, and
   * carrying the old budget into it would spend a retry that was never used on anything.
   */
  let retriesSpent = 0;
  /**
   * The session the streak belongs to, so a switched or forked session starts with a full budget.
   *
   * Read off `ctx` in `message_end` rather than from a `session_start` subscription, on purpose:
   * this module deliberately arms no session-lifecycle handlers (the only one it ever had was the
   * deleted local lane's warm-up ping, and `test/ext-13-credentials.test.ts` holds that line), and
   * a switch mid-process is a case `session_start` would not cover anyway.
   */
  let streakSession: string | undefined;
  /**
   * The reasoning effort the session was on before a varied retry borrowed it.
   *
   * Set at most once per streak — the level to give back is the one that was live when the streak
   * STARTED, not the borrowed one a second varied attempt would otherwise record over it.
   *
   * Typed off the API rather than off an imported union: PI's session vocabulary is the runtime's
   * to define, and a level this cannot hold is a level it cannot give back.
   */
  let borrowedThinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;

  /**
   * Give the borrowed effort back. Called from every path that ends a streak, without exception:
   * the abort, the turn that worked, and the session switch.
   *
   * The session switch is included on purpose even though the borrowed level belongs to a session
   * that is no longer current. `setThinkingLevel` is process-wide, so the alternative — dropping
   * the record — leaves the NEW session running at the lowered effort with nothing that says why.
   * Restoring can at worst overwrite a level the new session had just picked; not restoring
   * silently degrades every turn that follows, which is strictly worse and invisible.
   */
  const restoreThinkingLevel = (): void => {
    if (borrowedThinkingLevel === undefined) return;
    const level = borrowedThinkingLevel;
    borrowedThinkingLevel = undefined;
    pi.setThinkingLevel(level);
  };

  pi.on("before_provider_request", () => {
    observed = undefined;
  });

  pi.on("after_provider_response", (event) => {
    observed = { status: event.status, ...(event.headers !== undefined ? { headers: event.headers } : {}) };
  });

  /**
   * Report the failure, and — for a transient class with budget left — ask for the same request
   * again.
   *
   * The re-issue is `pi.sendMessage(..., { triggerTurn: true })`, which is the only lever an
   * extension has: by `message_end` the provider call is over, `MessageEndEventResult` can replace
   * the message but not re-run it, and PI's own auto-retry
   * (`agent-session.js:764`, `_isRetryableError`) requires `stopReason === "error"` and so cannot
   * see an `empty-response` at all — that shape arrives as a perfectly normal `stop`. The message
   * is queued rather than sent: `_handlePostAgentRun` continues the agent loop while anything is
   * queued (`:781`), so mid-run this becomes another turn of the same run, and idle it starts one.
   * The same code path runs inside a dispatched child, because a child is a `pi` process loading
   * this same extension — which is the case the 2026-08-30 evidence cared about, since an aborted
   * subagent loses work an operator cannot simply retype.
   *
   * `display: true` on purpose: a turn that silently ran twice is indistinguishable from a model
   * that repeated itself, and the transcript is where that question gets asked.
   */
  const report = (ctx: ExtensionContext, failure: ProviderFailure): void => {
    const policy = retryPolicy();
    const willRetry = shouldRetry(policy, failure.klass, retriesSpent);
    const attempt = retriesSpent + 1;
    // The retry disposition is attached only when this class is one the policy would retry. A
    // class that was never in play must keep the block's original `abort` line to the byte: an
    // `auth` failure rendered as "the transient retry budget is spent" would tell the operator
    // this harness tried a rejected credential twice, which it did not and must not.
    const budget = retryBudget(policy, failure.klass);
    const inPlay = policy.classes.has(failure.klass) && (budget > 0 || retriesSpent > 0);
    const decided: ProviderFailure = {
      ...failure,
      retry: inPlay ? { attempt, maxAttempts: budget, willRetry } : undefined,
    };
    surfaceProviderFailure(ctx, decided, sinks);
    if (!willRetry) {
      restoreThinkingLevel();
      retriesSpent = 0;
      return;
    }
    retriesSpent = attempt;
    // The live level, not the tier's declared one: PI clamps to what the model supports, and a
    // re-issue that announced a move away from a level the model never ran at would be fiction.
    const currentLevel = pi.getThinkingLevel();
    const variation = planRetryVariation(policy, failure.klass, currentLevel);
    if (variation.thinkingLevel !== undefined) {
      borrowedThinkingLevel ??= currentLevel;
      pi.setThinkingLevel(variation.thinkingLevel);
    }
    // `identical` keeps the original wording to the byte. `vary` has to withdraw the "carry on with
    // exactly what you were doing" half of it: on `temperature: 0` that sentence is itself a pull
    // back toward the answer that did not arrive, which is what the measurement found.
    const closing =
      variation.strategy === "vary"
        ? "Redo the work rather than reproducing the previous attempt."
        : "Carry on with exactly what you were doing.";
    pi.sendMessage(
      {
        customType: "provider-retry",
        content: [
          {
            type: "text",
            text:
              `The previous request failed with a transient provider error ` +
              `(${failure.provider}/${failure.model} — ${failure.klass}) and produced no answer. ` +
              `This is attempt ${attempt + 1}; ${variation.summary}. ${closing}`,
          },
        ],
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const response = observed;
    observed = undefined;

    const session = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
    if (session !== streakSession) {
      streakSession = session;
      restoreThinkingLevel();
      retriesSpent = 0;
    }

    const message = event.message;
    if (message.role !== "assistant") return;

    const status = response?.status;

    if (message.stopReason !== "error") {
      // Observed 2026-08-14 on `litellm/gpt-5.6-luna`: nine subagent runs whose last turn is
      // `content: []` / `stopReason: "stop"` / usage all zeros. Reported by `pi-subagents` as
      // "Subagent produced no output (possible model cold-start or empty response)" — a guessed
      // cause that named the model instead of the gateway. Say what was observed instead.
      if (isEmptyCompletion(message)) {
        report(
          ctx,
          buildEmptyCompletionFailure({
            provider: message.provider ?? "(unknown provider)",
            model: message.model ?? "(unknown model)",
            ...(status !== undefined ? { status } : {}),
            stopReason: message.stopReason,
            ...(message.rawStopReason !== undefined ? { rawStopReason: message.rawStopReason } : {}),
            ...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
            ...(ctx.thinkingLevel !== undefined ? { thinkingLevel: ctx.thinkingLevel } : {}),
            ...(response?.headers !== undefined ? { headers: response.headers } : {}),
            usage: message.usage,
          }),
        );
        return;
      }
      // A turn that worked. The retry budget belongs to a streak of consecutive failures, so it
      // is spent only while one is running, and this is where a streak ends — which is also where
      // a borrowed reasoning effort goes back, whether or not the recovery is what earned it.
      restoreThinkingLevel();
      retriesSpent = 0;
      return;
    }

    const midStream = status !== undefined && status >= 200 && status < 300;

    report(
      ctx,
      buildProviderFailure({
        provider: message.provider ?? "(unknown provider)",
        model: message.model ?? "(unknown model)",
        status,
        midStream,
        message: message.errorMessage,
        rawStopReason: message.rawStopReason,
        // PI has already flattened the throw into `errorMessage` by the time it reaches here;
        // `diagnostics[].error` is the only surviving carrier of name, code and stack, so it is
        // passed through untouched rather than wrapped in a synthetic Error that would look
        // like a preserved chain while adding nothing.
        diagnostics: message.diagnostics,
      }),
    );
  });
}

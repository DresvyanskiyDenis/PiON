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
 * **(b) Prompt-cache retention.** `config/models.json` decides the retention tier per route; the
 * ambient `PI_CACHE_RETENTION` may not. The argument, the paid products a stray `long` opens, and
 * the exact rule are in `lib/cache-retention.ts`; `pinCacheRetention` below is the wiring. It is
 * here rather than in a module of its own because it is the same subject as the rest of this file
 * — what it takes to talk to a provider, decided from config rather than from the environment —
 * and because the pin has to land before the first provider request, which is what `register()` is.
 *
 * **(c) Provider error surfacing** (`implementation_plan.md` §3.4a) — what replaced the cancelled
 * `EXT-08` failover item. A failed provider call names the provider, model, error class and
 * message, keeps the cause chain, and the turn aborts. No substitution, no retry into a different
 * provider, no silent degradation. Classification and rendering are in `lib/provider-error.ts`.
 *
 * Since 2026-08-30 two of the seven classes get ONE more attempt before that abort — `network` and
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
 * `register()` starts no timers, sockets or watchers, and its only I/O is one synchronous read of
 * `config/models.json` for the retention pin. It is unconditional: the factory also runs in
 * invocations that never open a session (`pi --list-models`), where that read is one wasted
 * `readFileSync` of a file PI itself has already read — cheaper than any scheme for skipping it,
 * and it cannot be deferred to `session_start`, because a pin that lands after the first request
 * pins nothing. Nothing here opens a socket or awaits anything.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "./lib/announce.ts";
import {
  decideEnvCacheRetention,
  pinCacheRetentionEnv,
  readModelsFile,
} from "./lib/cache-retention.ts";
import {
  buildEmptyCompletionFailure,
  buildProviderFailure,
  isEmptyCompletion,
  type ProviderErrorClass,
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
  pinCacheRetention();
  registerProviderErrorSurfacing(pi);
}

/* ------------------------------------------------------------------------------------------- *
 * (b) prompt-cache retention: the config decides, the environment does not
 * ------------------------------------------------------------------------------------------- */

/**
 * Rule on the ambient `PI_CACHE_RETENTION` from `config/models.json` and announce an override.
 *
 * The notice goes through `emitNotice` with no `ctx`, i.e. to the log sink: `register()` has no
 * `ExtensionContext` and no UI exists yet at extension-load time. It fires only when this actually
 * took a decision away from the environment — see `pinCacheRetentionEnv`.
 *
 * Deliberately not wrapped in a try/catch: `readModelsFile` returns its failures as a `problem`
 * rather than throwing, and that path already pins `short` and says why. A throw from here would
 * be a bug in this module, and `index.ts`'s per-module catch is where bugs in a `register()`
 * belong — swallowing it locally would leave the retention tier decided by the environment with
 * nothing on any channel saying so, which is the exact failure this file exists to end.
 */
function pinCacheRetention(): void {
  const notice = pinCacheRetentionEnv(process.env, decideEnvCacheRetention(readModelsFile()));
  if (notice) emitNotice(undefined, notice, "warning");
}

/* ------------------------------------------------------------------------------------------- *
 * (c) provider error surfacing
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
   * The class `retriesSpent` is counted against. `undefined` exactly when `retriesSpent` is `0`.
   *
   * `retriesSpent` is one counter shared by every transient class — see `shouldRetry` in
   * `lib/provider-retry.ts` — so this is what lets a failure recognise whether it is the SAME
   * streak that pinned the counter or a different one arriving while an old pin is still in effect.
   */
  let retriesSpentClass: ProviderErrorClass | undefined;
  /**
   * How many times THIS session has restarted a streak pinned by a different class — see
   * `maxStreakRestarts` on `ProviderRetryPolicy`. Bounded, so two classes trading failures cannot
   * retry forever just by alternating.
   */
  let streakRestarts = 0;
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
    const budget = retryBudget(policy, failure.klass);
    // A pin left by a DIFFERENT class's exhausted streak does not belong to this one. `shouldRetry`
    // grants it a fresh look only through the bounded restart below — never an unbounded one.
    const crossedClass =
      retriesSpentClass !== undefined && retriesSpentClass !== failure.klass && retriesSpent > 0;
    const willRetry = shouldRetry(policy, failure.klass, retriesSpent, streakRestarts, retriesSpentClass);
    if (willRetry && crossedClass) {
      // `shouldRetry` said yes only via the cross-class restart branch: this class starts its own
      // count from zero, and the restart spends one of the session's bounded `maxStreakRestarts`.
      streakRestarts += 1;
      retriesSpent = 0;
    }
    const attempt = retriesSpent + 1;
    // The retry disposition is attached only when this class is one the policy would retry. A
    // class that was never in play must keep the block's original `abort` line to the byte: an
    // `auth` failure rendered as "the transient retry budget is spent" would tell the operator
    // this harness tried a rejected credential twice, which it did not and must not.
    const inPlay = policy.classes.has(failure.klass) && (budget > 0 || retriesSpent > 0);
    const decided: ProviderFailure = {
      ...failure,
      retry: inPlay
        ? { attempt, maxAttempts: budget, willRetry, streakRestarts, maxStreakRestarts: policy.maxStreakRestarts }
        : undefined,
    };
    surfaceProviderFailure(ctx, decided, sinks);
    if (!willRetry) {
      restoreThinkingLevel();
      // `retriesSpent` and `retriesSpentClass` are deliberately left as they are — the streak is
      // TERMINAL at an abort, not resolved by it. Resetting here used to be the bug: the very next
      // failure of the same class looked like a brand-new streak with a full budget, and the
      // harness would retry, abort, reset, retry again, without ever actually stopping. A session
      // switch, a response that genuinely worked, or the bounded cross-class restart above are the
      // only ways back to a fresh budget now.
      return;
    }
    retriesSpent = attempt;
    retriesSpentClass = failure.klass;
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
      retriesSpentClass = undefined;
      streakRestarts = 0;
    }

    const message = event.message;
    if (message.role !== "assistant") return;

    const status = response?.status;

    if (message.stopReason !== "error") {
      // Observed 2026-08-14 on one OpenAI-compatible gateway (a private model alias,
      // named nowhere here): nine subagent runs whose last turn is
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
      // a borrowed reasoning effort goes back, whether or not the recovery is what earned it. Unlike
      // an abort, a genuine recovery really does clear the slate: the next failure, of any class, is
      // a new coin flip and gets a full budget without spending any of the bounded restarts above.
      restoreThinkingLevel();
      retriesSpent = 0;
      retriesSpentClass = undefined;
      streakRestarts = 0;
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

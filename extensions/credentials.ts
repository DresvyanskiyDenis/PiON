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
 * **(b) Provider error surfacing** — what replaced the cancelled
 * `EXT-08` failover item. A failed provider call names the provider, model, error class and
 * message, keeps the cause chain, and the turn aborts. No substitution, no retry into a different
 * provider, no silent degradation. Classification and rendering are in `lib/provider-error.ts`.
 *
 * This file used to carry a third subject, the `local` lane: a hand-registered `local` provider
 * pointing at an OpenAI-compatible model server on loopback, with its own discovery budget, a
 * `/v1/models` warm-up ping, a footer status marker and a one-line "the local tier is
 * unavailable" warning. It is gone. Owner decision, 2026-08-15: the provider set is exactly
 * `github-copilot`, an OpenAI-compatible gateway and `databricks`, and the tier set is exactly
 * `strong`, `light` and `confidential` — so there is no `local` provider to register and no
 * `local` tier for a warning to be about. Nothing replaced the warning, deliberately: a provider
 * that does not exist cannot be unreachable. A model server on loopback is still perfectly
 * reachable through the gateway lane — `config/providers/openai-compatible.json` with a
 * `http://127.0.0.1:<port>/v1` base URL — which needs no code here at all.
 *
 * No built-in provider is re-registered here either, and none ever was: re-registering
 * `github-copilot` would destroy its OAuth block, and that lane is resolved by configuration
 * instead (a raw `gho_` token as an apiKey credential plus a `baseUrl` override in `models.json`,
 * with `/login github-copilot` never run because its OAuth resolver returns its own `baseUrl` and
 * clobbers the override at request time).
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
  surfaceProviderFailure,
} from "./lib/provider-error.ts";

export const id = "credentials";

export function register(pi: ExtensionAPI): void {
  registerProviderErrorSurfacing(pi);
}

/* ------------------------------------------------------------------------------------------- *
 * (b) provider error surfacing
 * ------------------------------------------------------------------------------------------- */

interface ObservedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
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

  pi.on("before_provider_request", () => {
    observed = undefined;
  });

  pi.on("after_provider_response", (event) => {
    observed = { status: event.status, headers: event.headers };
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const response = observed;
    observed = undefined;

    const message = event.message;
    if (message.role !== "assistant") return;

    const status = response?.status;

    if (message.stopReason !== "error") {
      // Observed 2026-08-14 against an OpenAI-compatible LiteLLM gateway serving `gpt-5.6-luna`:
      // nine subagent runs whose last turn is `content: []` / `stopReason: "stop"` / usage all
      // zeros. Reported by `pi-subagents` as "Subagent produced no output (possible model
      // cold-start or empty response)" — a guessed cause that named the model instead of the
      // gateway. Say what was observed instead.
      if (isEmptyCompletion(message)) {
        surfaceProviderFailure(
          ctx,
          buildEmptyCompletionFailure({
            provider: message.provider ?? "(unknown provider)",
            model: message.model ?? "(unknown model)",
            ...(status !== undefined ? { status } : {}),
            stopReason: message.stopReason,
            ...(message.rawStopReason !== undefined ? { rawStopReason: message.rawStopReason } : {}),
            ...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
            ...(ctx.thinkingLevel !== undefined ? { thinkingLevel: ctx.thinkingLevel } : {}),
            usage: message.usage,
            ...(response?.headers !== undefined ? { headers: response.headers } : {}),
          }),
        );
      }
      return;
    }

    const midStream = status !== undefined && status >= 200 && status < 300;

    surfaceProviderFailure(
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

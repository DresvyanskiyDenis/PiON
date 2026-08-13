/**
 * `EXT-13` — credentials, providers, and provider error surfacing.
 *
 * Three things live here, and they are here together because they are the same subject: what it
 * takes to talk to a model, and what happens when that fails.
 *
 * **(a) The local lane.** `local` = whatever OpenAI-compatible model server is running on loopback
 * (llama.cpp, llama-swap, Ollama, LM Studio, vLLM), registered with its own 3 s discovery budget
 * and a `/v1/models` warm-up ping. Explicitly environment-specific: someone without a local server
 * must still be able to start the agent, so its absence is one warning line, never a fatal. The
 * mechanics are in `lib/local-catalogue.ts`; this file is the wiring.
 *
 * **(b) Databricks credentials.** No code here — `config/bin/dbx-token-cached` is the whole
 * implementation, referenced from `models.json` as `"apiKey": "!$HOME/bin/dbx-token-cached"`.
 * It exists because PI re-executes an `!command` credential on **every request** with no TTL of
 * its own, so an unwrapped `databricks auth token` costs one OAuth round trip per LLM call.
 *
 * **(c) Provider error surfacing** — what replaced the cancelled
 * `EXT-08` failover item. A failed provider call names the provider, model, error class and
 * message, keeps the cause chain, and the turn aborts. No substitution, no retry into a different
 * provider, no silent degradation. Classification and rendering are in `lib/provider-error.ts`.
 *
 * `register()` starts no timers, sockets or watchers: the factory also runs in invocations that
 * never open a session (`pi --list-models`). All I/O is in `session_start` and the provider's own
 * `refreshModels`, and is torn down in `session_shutdown`.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { configDir } from "./lib/paths.ts";
import {
  fetchLiveModelIds,
  localBaseUrl,
  mergeLocalCatalogue,
  pingLocal,
  readConfiguredLocalProvider,
} from "./lib/local-catalogue.ts";
import { buildProviderFailure, surfaceProviderFailure } from "./lib/provider-error.ts";
import { surfaceOnce } from "./lib/once.ts";

export const id = "credentials";

/** Test seam. In production this is `~/.pi/agent/models.json` via PI's own `getAgentDir()`. */
export function modelsJsonPath(): string {
  return process.env.PI_CONFIG_MODELS_JSON ?? join(configDir(), "models.json");
}

export function register(pi: ExtensionAPI): void {
  registerLocalProvider(pi);
  registerProviderErrorSurfacing(pi);
}

/* ------------------------------------------------------------------------------------------- *
 * (a) the local lane
 * ------------------------------------------------------------------------------------------- */

/**
 * Only `local` is re-registered. Re-registering a built-in provider (`github-copilot`, `openai`,
 * `anthropic`) would destroy its OAuth block, and per-provider timeouts stay unavailable for those
 * regardless. The Copilot lane in particular is already resolved a different way: a raw `gho_`
 * token as an apiKey credential plus a `baseUrl` override in `models.json`, with
 * `/login github-copilot` never run because its OAuth resolver returns its own `baseUrl` and
 * clobbers the override at request time. Nothing in this file touches any of them.
 */
function registerLocalProvider(pi: ExtensionAPI): void {
  const config: ProviderConfig = {
    name: "Local (OpenAI-compatible server)",
    baseUrl: localBaseUrl(),
    /**
     * No `apiKey` here on purpose — `models.json` owns it (see `config/providers/local.json`).
     *
     * This lane still needs the field to be *present*, and the reason that took three attempts to
     * pin down is the finding worth keeping: **auth belongs to whatever the router routes to, not
     * to the router.** A router's own `GET /v1/models` is typically open and enforces nothing —
     * which is why `pingLocal` succeeds regardless, and structurally cannot see a bad key — and a
     * model served by a bare llama.cpp behind it answers a completion with any header or none.
     * Probe either and the port reads as keyless. A different model on the *same* port may sit
     * behind a backend that does check a bearer token, and it 401s on the first real completion.
     * Measured against one such pair: no `Authorization` header → 401 `Not authenticated`;
     * `Bearer <wrong>` → 401 `Invalid token payload`; the real key → 200. End to end, `pi -p` on
     * that model aborted with exactly that `Invalid token payload` while `models.json` carried a
     * literal, and answered `OK` once the variable was in place. Which model you sample decides
     * the answer, so one model proves nothing about the port.
     *
     * Reference the credential by `$VAR` from an environment your shell already exports, rather
     * than duplicating the secret into `~/.pi/secrets.env`: one place to rotate it.
     *
     * Declaring it *here* would be worse than redundant — it would win. `provider-composer.js`'s
     * `configuredApiKey()` is `extension?.apiKey ?? config?.apiKey`, so whatever this object
     * declares overrides `models.json` outright and two files end up obliged to agree about a
     * value only one of them owns. Nor may `models.json` drop the field: with no key in either
     * layer `composeApiKeyAuth`'s `resolve` returns `undefined`, PI reads the provider as
     * unconfigured and its models never reach `/model` or `--list-models`.
     */
    api: "openai-completions",
    /**
     * `refreshLocalModels` can answer "no opinion" by returning `undefined`, which PI supports —
     * `dist/core/provider-composer.js` guards the publish with `if (refreshed)` — but which the
     * declared type does not express. This is the one cast, and it is narrow on purpose: every
     * other field above stays type-checked.
     */
    refreshModels: refreshLocalModels as (
      context: RefreshModelsContext,
    ) => Promise<ProviderModelConfig[]>,
  };
  pi.registerProvider("local", config);

  let warmed = false;
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (warmed) return;
    warmed = true;
    // Fire-and-forget: the session must not wait on it, and a failure must not be fatal.
    void warmUp(ctx);
  });
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    warmed = false;
    try {
      ctx.ui.setStatus("local", undefined);
    } catch {
      // The TUI is already gone. Clearing a status we can no longer see is not worth a throw.
    }
  });
}

/**
 * Live catalogue, nothing persisted.
 *
 * Returns `undefined` — "leave the configured catalogue exactly as it is" — in every case where
 * we cannot do better than `models.json`:
 *   - offline initialisation (`allowNetwork: false`), where a fetch is not permitted;
 *   - `models.json` unreadable, so the tuning we would have to preserve is unknown;
 *   - the local server unreachable, slow, or answering with something that is not a model list.
 *
 * The last case is the one an earlier draft got wrong: it returns `[]`, and PI's composer
 * treats `[]` as a real (empty) catalogue, so a dead local server would *delete* every curated
 * `local` model out of the user's own `models.json` until the next successful refresh.
 */
async function refreshLocalModels(
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[] | undefined> {
  if (!context.allowNetwork) return undefined;

  const configured = await readConfiguredLocalProvider(modelsJsonPath());
  if (!configured) return undefined;

  const liveIds = await fetchLiveModelIds(localBaseUrl(), context.signal);
  if (!liveIds) return undefined;

  const { models, synthesised, dropped } = mergeLocalCatalogue(configured, liveIds);

  if (dropped.length > 0) {
    // Dropping a model the routing tier may point at is exactly the kind of thing that must not
    // happen quietly. Once per process, per set of ids.
    surfaceOnce(undefined, `local:dropped:${dropped.join(",")}`, () => {
      process.stderr.write(
        `[pi-config] local: ${dropped.length} model(s) in models.json are not served by ` +
          `the local server at ${localBaseUrl()} and were dropped from this session's catalogue: ` +
          `${dropped.join(", ")}\n`,
      );
    });
  }
  if (synthesised.length > 0) {
    surfaceOnce(undefined, `local:synthesised:${synthesised.join(",")}`, () => {
      process.stderr.write(
        `[pi-config] local: ${synthesised.length} model(s) served by the local server have no ` +
          `models.json entry and are using conservative defaults (text-only, no reasoning, ` +
          `128k context): ${synthesised.join(", ")}\n`,
      );
    });
  }

  return models;
}

/**
 * The `session_start` ping. Success sets a footer marker; failure sets the failed marker and says
 * exactly one line. The `local` tier is `"optional": true` in `routing.json`, so this is
 * information, not an error the colleague has to act on.
 */
export async function warmUp(ctx: ExtensionContext): Promise<void> {
  const baseUrl = localBaseUrl();
  const result = await pingLocal(baseUrl);
  try {
    ctx.ui.setStatus("local", result.ok ? "local ✓" : "local ✗");
  } catch {
    // No UI (`-p`, `--mode json`). setStatus is a no-op there anyway.
  }
  if (result.ok) return;
  try {
    ctx.ui.notify(
      `local provider unreachable at ${baseUrl} (${result.detail}). ` +
        `The "local" tier is unavailable this session; every other provider is unaffected.`,
      "warning",
    );
  } catch {
    // fall through to stderr
  }
  if (!ctx.hasUI) {
    process.stderr.write(
      `[pi-config] local provider unreachable at ${baseUrl} (${result.detail}); ` +
        `the "local" tier is unavailable this session, every other provider is unaffected\n`,
    );
  }
}

/* ------------------------------------------------------------------------------------------- *
 * (c) provider error surfacing
 * ------------------------------------------------------------------------------------------- */

interface ObservedResponse {
  readonly status: number;
}

/**
 * Wire the two events that, together, cover both failure shapes:
 *
 *   - **non-2xx.** `after_provider_response` fires with the status; the status is remembered, and
 *     the assistant message that follows carries the upstream text.
 *   - **200 that dies mid-stream.** `after_provider_response` fires with `status: 200` — it runs
 *     on the response headers, before the body is consumed — so the status alone says nothing is
 *     wrong. The stream's terminal `error` event is what sets the assistant message's
 *     `stopReason` to `"error"`, and `message_end` is where that becomes visible. The failure is
 *     then classified from the message text and rendered as "headers ok; the stream failed after
 *     them" rather than as a misleading `http 200`.
 *
 * Both therefore converge on `message_end`, which is the only point where the turn's outcome is
 * final. `stopReason: "aborted"` is deliberately not reported: that is the user pressing Esc, not
 * a provider failing.
 */
function registerProviderErrorSurfacing(pi: ExtensionAPI): void {
  let observed: ObservedResponse | undefined;

  pi.on("before_provider_request", () => {
    observed = undefined;
  });

  pi.on("after_provider_response", (event) => {
    observed = { status: event.status };
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const response = observed;
    observed = undefined;

    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;

    const status = response?.status;
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

/**
 * `EXT-09` — the Copilot quota meter with a **pre-flight**, not just a number.
 *
 * Follows the non-index module contract (`export const id` +
 * `export function register(pi)`), not `export default` —
 * `extensions/index.ts` is the only default-exporting module in the tree,
 * and this module is composed into it by `integration`.
 *
 * **The pre-flight no longer fails over** (owner decision, `EXT-08` cancelled): it warns before
 * the turn and does nothing else. When the budget is actually gone, the provider's own `quota`
 * error surfaces through `EXT-13` unmodified — this module never intercepts a provider call.
 *
 * Three failure classes, three different postures, matching the "guarded-handler"
 * split between a lifecycle hook (must never crash the session) and a user-initiated command
 * (may surface a real error loudly):
 *   - `session_start` / `turn_end` / `input` (the pre-flight) — refresh runs inside a guard.
 *     ANY exception, expected or not, is logged to stderr and swallowed: a bug in an optional
 *     quota display must never block a turn, let alone the session.
 *   - `/quota` — an explicit user request. `refresh()`'s own expected failures (no token,
 *     unusable token, endpoint unavailable) render a specific, useful message; a genuinely
 *     unexpected error is allowed to propagate to the command caller (fail loud, `REQ-PRV-32`).
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { describeSnapshot, fetchQuota, QuotaUnavailable, render, type QuotaSnapshot } from "./copilot.ts";
import { loadQuotaConfig, type QuotaConfig } from "./config.ts";
import { QuotaTokenError, readToken } from "./store.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";

export const id = "quota";

const STATUS_KEY = "quota";

export function register(pi: ExtensionAPI): void {
  let cfg: QuotaConfig | undefined;
  let snap: QuotaSnapshot | undefined;
  let lastFetch = 0;
  /** Set by `refresh()`'s expected-failure branches, cleared on success or "no token at all".
   *  `/quota` reads it to say *why* there is nothing to show instead of a generic message. */
  let lastDegradeReason: string | undefined;

  const ensureConfig = async (): Promise<QuotaConfig> => {
    if (!cfg) cfg = await loadQuotaConfig();
    return cfg;
  };

  /**
   * Refreshes `snap` from the token file + endpoint, respecting the TTL unless `force`. Expected
   * failures (no token, an unusable token file, the endpoint not answering usefully) degrade
   * `snap` to `undefined` and set the footer to an honest state — they never throw out of this
   * function. Anything else (a genuine bug) throws, by design: callers decide their own posture.
   */
  const refresh = async (ctx: ExtensionContext, force = false): Promise<QuotaSnapshot | undefined> => {
    const c = await ensureConfig();
    if (!c.enabled) return undefined;
    if (!force && Date.now() - lastFetch < c.ttlMs) return snap;

    let tok;
    try {
      tok = await readToken(c.tokenFile);
    } catch (err) {
      if (!(err instanceof QuotaTokenError)) throw err;
      snap = undefined;
      lastDegradeReason = `token unusable: ${describeError(err)}`;
      surfaceOnce(ctx, "quota:token-error", () =>
        ctx.ui.notify(`Copilot quota token unusable — ${describeError(err)}`, "warning"),
      );
      ctx.ui.setStatus(STATUS_KEY, "quota —");
      return undefined;
    }

    if (!tok) {
      snap = undefined;
      lastDegradeReason = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined); // not configured at all — nothing to warn about
      return undefined;
    }

    try {
      // PI_QUOTA_USAGE_URL is a test-only escape hatch: unset in production, it leaves
      // fetchQuota's own default (the real endpoint) untouched. No test may hit the network,
      // and index.ts's wiring has no other injection point for
      // the URL — copilot.ts's fetchQuota already takes it as a parameter for exactly this.
      snap = await fetchQuota(tok.token, AbortSignal.timeout(c.timeoutMs), process.env.PI_QUOTA_USAGE_URL);
      lastFetch = Date.now();
      lastDegradeReason = undefined;
      ctx.ui.setStatus(STATUS_KEY, render(snap));
    } catch (err) {
      if (!(err instanceof QuotaUnavailable)) throw err;
      snap = undefined;
      lastDegradeReason = err.message;
      ctx.ui.setStatus(STATUS_KEY, "quota —"); // V-13 bad answer: degrade, never crash
    }
    return snap;
  };

  pi.on("session_start", guardedLifecycle("session_start", (ctx) => refresh(ctx, true)));
  pi.on("turn_end", guardedLifecycle("turn_end", (ctx) => refresh(ctx)));

  // REQ-EXT-45 (visibility half): a threshold warning before the turn's first provider request.
  // Event #33 `input` — before agent processing, not on the response path.
  pi.on("input", async (_event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
    try {
      const c = await ensureConfig();
      if (c.enabled && c.preflight.enabled && ctx.model?.provider === "github-copilot") {
        const s = await refresh(ctx);
        if (s?.kind === "metered" && s.remainingPct !== undefined && s.remainingPct <= c.preflight.thresholdPct) {
          ctx.ui.notify(`Copilot ${s.id} at ${s.remainingPct}% remaining`, "warning");
        }
      }
    } catch (err) {
      process.stderr.write(`[pi-config] quota: input pre-flight failed: ${describeError(err)}\n`);
    }
    return { action: "continue" };
  });

  pi.registerCommand("quota", {
    description:
      "Show the GitHub Copilot quota (premium requests / AI credits) — see " +
      "https://dresvyanskiydenis.github.io/PiON/extensions/quota/",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      const s = await refresh(ctx, true);
      if (s) {
        ctx.ui.notify(describeSnapshot(s), "info");
        return;
      }
      if (lastDegradeReason) {
        ctx.ui.notify(`quota unavailable — ${lastDegradeReason}`, "warning");
        return;
      }
      ctx.ui.notify(
        "no quota token configured (see https://dresvyanskiydenis.github.io/PiON/extensions/quota/)",
        "info",
      );
    },
  });
}

/** Never lets a quota-meter bug propagate into the session lifecycle it observes — mirrors
 *  `extensions/session-index/index.ts`'s `guardedIndex`. */
function guardedLifecycle(
  reason: string,
  run: (ctx: ExtensionContext) => Promise<unknown>,
): (event: SessionStartEvent | TurnEndEvent, ctx: ExtensionContext) => Promise<void> {
  return async (_event, ctx) => {
    try {
      await run(ctx);
    } catch (err) {
      process.stderr.write(`[pi-config] quota: ${reason} refresh failed: ${describeError(err)}\n`);
    }
  };
}

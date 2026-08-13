/**
 * EXT-11 — `REQ-CTX-31` threshold reporting: the arithmetic, the verdict, and the sentence.
 *
 * Pure except for `readReserveTokens()`, which reads the two settings files PI itself reads.
 * No PI runtime import, so the whole decision is unit-testable.
 *
 * ---------------------------------------------------------------------------------------------
 * **What PI 0.84.0 actually offers, read off the shipped code, not the docs.**
 *
 * The trigger is one line — `dist/core/compaction/compaction.js:160-164`:
 *
 *     shouldCompact(contextTokens, contextWindow, settings) {
 *       if (!settings.enabled) return false;
 *       return contextTokens > contextWindow - settings.reserveTokens;
 *     }
 *
 * `settings` comes from `SettingsManager.getCompactionSettings()`
 * (`dist/core/settings-manager.js:518-528`) and has exactly three keys — `enabled`,
 * `reserveTokens`, `keepRecentTokens` (`dist/core/settings-manager.d.ts:4-8`). There is no
 * absolute-count key, no ratio key, and no per-model compaction key. `contextWindow` is
 * `this.model.contextWindow` (`dist/core/agent-session.js:1517`).
 *
 * So there are exactly two ways to move the trigger, and they are not equivalent:
 *
 * 1. **`compaction.reserveTokens`** — a single global scalar (or per-project, via
 *    `<cwd>/.pi/settings.json`; `dist/core/settings-manager.js:47,141`). It is **not per model**.
 *    Raising it to `window - absolute` for a 1M model makes `contextWindow - reserveTokens`
 *    *negative* for every model with a smaller window, and `shouldCompact` then returns true for
 *    any context size at all. `prepareCompaction()` only refuses when the newest entry is already
 *    a compaction (`compaction.js:492-495`), so the session compacts after every assistant
 *    message, each pass drops far less than `minReductionRatio`, and this extension's own loop
 *    guard trips and takes the run down. That is why this module never recommends it.
 *
 *    (What it does *not* do is starve the summariser. `generateSummaryWithUsage` sets
 *    `maxTokens = min(0.8 * reserveTokens, model.maxTokens)` — `compaction.js:461` — and the turn
 *    prefix uses `0.5 *` at `compaction.js:625`. A larger reserve therefore *raises* the summary
 *    ceiling until `model.maxTokens` caps it. `branchSummary.reserveTokens` is a separate key
 *    (`settings-manager.js:532`) and is untouched either way.)
 *
 * 2. **`models.json` → `providers.<p>.modelOverrides.<id>.contextWindow`** — per model, exact,
 *    documented in PI's own `models.md`, and applied at `dist/core/provider-composer.js:40`. PI
 *    ships this pattern itself: OpenAI's Sol/Terra/Luna default to a *reduced* 272 000 window and
 *    the docs tell you to raise it to 1 050 000 to opt into the large-context tier
 *    (same doc). This is the only mechanism that survives a model switch, because
 *    the number is declared next to the model rather than globally.
 *
 *    It has one cost this module must not hide: `clampMaxTokensToContext`
 *    (`@earendil-works/pi-ai/dist/api/simple-options.js:4-9`) caps every request's `maxTokens` at
 *    `contextWindow - contextTokens - 4096`, so a declared window also becomes an output ceiling
 *    as the session fills. And it collides head-on with **`REQ-PRV-04`** (MUST — *"an honest
 *    `contextWindow` … matching what the endpoint actually serves"*), which names this exact
 *    workaround as the banned one. Declaring it is therefore an
 *    operator decision, not something this extension may take on its own.
 *
 * Hence the shape below: compute the truth, classify it, and say it **once, ever** per distinct
 * (model, window, reserve, absolute) tuple — not once per session. A condition that is true on
 * every start and that the operator cannot act on from inside the session is noise, and noise is
 * how a real warning gets skimmed past.
 * ------------------------------------------------------------------------------------------- */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** PI's own default when neither settings file declares one (`settings-manager.js:518`). */
export const PI_DEFAULT_RESERVE_TOKENS = 16384;

/** PI's own default for `keepRecentTokens` (`SettingsManager.getCompactionKeepRecentTokens`). */
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000;

export type ThresholdVerdict =
  /** `absoluteTokens: 0` — the operator opted out of the check. */
  | "disabled"
  /** The effective trigger is within tolerance of the configured absolute. Nothing to say. */
  | "aligned"
  /**
   * The window is physically too small to host the absolute threshold
   * (`contextWindow - reserveTokens < absoluteTokens`). Structural, not a misconfiguration:
   * no setting anywhere makes a 150 000-token model compact at 180 000. Reported on demand
   * through `/compaction-status`, never at session start.
   */
  | "window-too-small"
  /**
   * The window is large enough but no per-model window is declared, so PI compacts far later
   * than the configured absolute. This is the only actionable case.
   */
  | "trigger-too-high";

export interface ThresholdReport {
  readonly contextWindow: number;
  readonly reserveTokens: number;
  /** The token count at which PI's `shouldCompact()` fires for this model. */
  readonly effectiveTrigger: number;
  readonly configuredAbsolute: number;
  readonly divergenceRatio: number;
  readonly diverged: boolean;
  readonly verdict: ThresholdVerdict;
  /** The `modelOverrides.<id>.contextWindow` that would make the trigger exact, or 0 when none can. */
  readonly suggestedContextWindow: number;
}

export function thresholdReport(
  contextWindow: number,
  reserveTokens: number,
  configuredAbsolute: number,
  toleranceRatio: number,
): ThresholdReport {
  const effectiveTrigger = contextWindow - reserveTokens;
  const divergenceRatio =
    configuredAbsolute > 0 ? Math.abs(effectiveTrigger - configuredAbsolute) / configuredAbsolute : 0;
  const diverged = configuredAbsolute > 0 && divergenceRatio > toleranceRatio;

  let verdict: ThresholdVerdict;
  if (configuredAbsolute <= 0) verdict = "disabled";
  else if (!diverged) verdict = "aligned";
  else if (effectiveTrigger < configuredAbsolute) verdict = "window-too-small";
  else verdict = "trigger-too-high";

  // Only meaningful when the native window can actually hold absolute + reserve. A declared
  // window above the native one would be a lie in the direction REQ-PRV-04 exists to forbid.
  const wanted = configuredAbsolute + reserveTokens;
  const suggestedContextWindow =
    verdict === "trigger-too-high" && wanted > 0 && wanted <= contextWindow ? wanted : 0;

  return {
    contextWindow,
    reserveTokens,
    effectiveTrigger,
    configuredAbsolute,
    divergenceRatio,
    diverged,
    verdict,
    suggestedContextWindow,
  };
}

/* ---------------------------------------------------------------------------------------------
 * The live reserve — PI does not expose it to extensions, so read the files PI reads
 * ------------------------------------------------------------------------------------------- */

export interface ReserveTokens {
  readonly value: number;
  /** Where the number came from, so a report can never present a default as a measurement. */
  readonly source: "compaction-event" | "project-settings" | "global-settings" | "pi-default";
}

function readCompactionNumber(path: string, key: "reserveTokens" | "keepRecentTokens"): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      compaction?: Record<string, unknown>;
    };
    const value = raw?.compaction?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    // A settings file PI itself would reject is not this module's error to raise; PI surfaces
    // its own parse failure at startup. Fall through to the next layer.
    return undefined;
  }
}

/**
 * The reserve PI will actually use, resolved the way `SettingsManager` resolves it: project
 * settings (`<cwd>/.pi/settings.json`) over global (`<agentDir>/settings.json`) over PI's
 * documented default (`settings-manager.js:47,141,518`).
 *
 * `observed` short-circuits everything: once a `session_before_compact` has been seen,
 * `preparation.settings.reserveTokens` is the number PI used, and no file needs trusting.
 */
export function readReserveTokens(opts: {
  readonly observed?: number | undefined;
  readonly agentDir: string;
  readonly cwd: string;
  readonly configDirName: string;
}): ReserveTokens {
  if (typeof opts.observed === "number" && Number.isFinite(opts.observed)) {
    return { value: opts.observed, source: "compaction-event" };
  }
  const project = readCompactionNumber(join(opts.cwd, opts.configDirName, "settings.json"), "reserveTokens");
  if (project !== undefined) return { value: project, source: "project-settings" };
  const global = readCompactionNumber(join(opts.agentDir, "settings.json"), "reserveTokens");
  if (global !== undefined) return { value: global, source: "global-settings" };
  return { value: PI_DEFAULT_RESERVE_TOKENS, source: "pi-default" };
}

/**
 * `keepRecentTokens`, resolved through the same layers as the reserve.
 *
 * It governs a different decision and is read by a different consumer: `prepareCompaction()`
 * walks session entries backwards accumulating `estimateTokens` until it reaches this number, and
 * when the walk ends first the cut point never moves off the first boundary, `messagesToSummarize`
 * comes out empty, and `/compact` raises `Nothing to compact (session too small)`. So this is the
 * number that decides whether a manual compaction is possible at all — the context window plays no
 * part in it. `extensions/context-report/` reports it for exactly that reason.
 *
 * PI's default is 20 000 (`SettingsManager.getCompactionKeepRecentTokens`, `?? 20000`).
 */
export function readKeepRecentTokens(opts: {
  readonly observed?: number | undefined;
  readonly agentDir: string;
  readonly cwd: string;
  readonly configDirName: string;
}): ReserveTokens {
  if (typeof opts.observed === "number" && Number.isFinite(opts.observed)) {
    return { value: opts.observed, source: "compaction-event" };
  }
  const project = readCompactionNumber(join(opts.cwd, opts.configDirName, "settings.json"), "keepRecentTokens");
  if (project !== undefined) return { value: project, source: "project-settings" };
  const global = readCompactionNumber(join(opts.agentDir, "settings.json"), "keepRecentTokens");
  if (global !== undefined) return { value: global, source: "global-settings" };
  return { value: PI_DEFAULT_KEEP_RECENT_TOKENS, source: "pi-default" };
}

/* ---------------------------------------------------------------------------------------------
 * The sentence
 * ------------------------------------------------------------------------------------------- */

/** Stable identity of a divergence, so "say it once" survives across sessions and restarts. */
export function thresholdKey(provider: string, model: string, report: ThresholdReport): string {
  return [
    provider,
    model,
    report.contextWindow,
    report.reserveTokens,
    report.configuredAbsolute,
    report.verdict,
  ]
    .join("_")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The one-off report for an actionable divergence, or `null` when there is nothing an operator
 * can do — `aligned` and `disabled` are silent by definition, and `window-too-small` is a
 * property of the model, not a setting anybody typed wrong.
 *
 * Deliberately does **not** mention `compaction.reserveTokens`: see the module header. A global
 * reserve of `window - absolute` breaks every smaller model in `models.json` and trips this
 * extension's own loop guard. Recommending it was the previous behaviour and it was wrong.
 */
export function formatThresholdNotice(
  provider: string,
  model: string,
  report: ThresholdReport,
  reserveSource: ReserveTokens["source"],
): string | null {
  if (report.verdict !== "trigger-too-high") return null;
  const reserveNote = reserveSource === "pi-default" ? " (PI default, not declared)" : "";
  const fix =
    report.suggestedContextWindow > 0
      ? `To meet it on this model, declare a per-model window in models.json — ` +
        `providers.${provider}.modelOverrides["${model}"].contextWindow = ${report.suggestedContextWindow} ` +
        `(= ${report.configuredAbsolute} + ${report.reserveTokens}). ` +
        `That is the only per-model lever PI 0.84.0 has; compaction.reserveTokens is a single global ` +
        `scalar and raising it to ${report.contextWindow - report.configuredAbsolute} would make the trigger ` +
        `negative for every smaller model and compact on every turn. ` +
        `Note the trade-off before applying it: a declared window is also an output ceiling ` +
        `(pi-ai clamps maxTokens to window - context - 4096), and it collides with REQ-PRV-04, ` +
        `which requires contextWindow to match what the endpoint actually serves.`
      : `No setting closes this gap on this model.`;
  return (
    `REQ-CTX-31 is not in force on ${provider}/${model}: the configured absolute threshold is ` +
    `${report.configuredAbsolute} tokens, but PI compacts above ${report.effectiveTrigger} ` +
    `(contextWindow ${report.contextWindow} - reserveTokens ${report.reserveTokens}${reserveNote}). ` +
    `${fix} ` +
    `Said once for this model; /compaction-status shows it any time.`
  );
}

/** The always-available on-demand line for `/compaction-status`. Never deduped. */
export function formatThresholdLine(
  report: ThresholdReport,
  reserveSource: ReserveTokens["source"],
): string {
  const base =
    `threshold  : fires above ${report.effectiveTrigger} tokens ` +
    `(window ${report.contextWindow} - reserve ${report.reserveTokens} [${reserveSource}]); ` +
    `configured absolute ${report.configuredAbsolute || "(off)"}`;
  switch (report.verdict) {
    case "disabled":
      return `${base} — check off`;
    case "aligned":
      return `${base} — REQ-CTX-31 in force`;
    case "window-too-small":
      return (
        `${base} — window too small to host it; no PI 0.84.0 setting closes this gap ` +
        `(${(report.divergenceRatio * 100).toFixed(0)} % below)`
      );
    case "trigger-too-high":
      return (
        `${base} — DIVERGED by ${(report.divergenceRatio * 100).toFixed(0)} %; declare ` +
        `modelOverrides.contextWindow = ${report.suggestedContextWindow} in models.json to close it`
      );
  }
}

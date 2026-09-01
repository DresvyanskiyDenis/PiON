/**
 * A 12-cell threshold gauge for `ctx`, and the preflight estimate beside it when one is parked.
 *
 * Pure formatting only, no I/O and no event wiring — `index.ts` publishes the result of
 * {@link formatCtxGaugeStatus} through `ctx.ui.setStatus`, the same `extensionStatusIcons` side
 * channel `compaction`'s own route status and `quota`'s meter already use. No upstream package
 * touched.
 *
 * ## Why not the `context` powerline segment itself
 *
 * `@narumitw/pi-statusline` 0.49.5's `context` segment (`render.ts:154-165` in that package) is
 * plain text — `${percent}%/${window}` — with its own fixed threshold colouring (`contextColor()`
 * in the same file: dim/success/warning/error at 70/90, not this module's 80/92) and no bar
 * primitive; that package's `SegmentPaletteColor` (`types.ts`) is a static per-segment colour, not
 * one conditional on the rendered value. `pi-tui` — the primitive layer both the agent and that
 * package sit on — ships `box`, `loader`, `cancellable-loader`, `text`, `truncated-text`,
 * `markdown`, `spacer`, `select-list`, `settings-list`, `image`, `editor`, `input`; no
 * gauge/progress-bar/table/sparkline. Making the `context` segment itself render a bar, or changing
 * its thresholds, means patching a third-party `node_modules` package, which this module avoids.
 * It renders the gauge itself, as plain text, and publishes it through the extension-status side
 * channel instead: no upstream dependency, and the package's own vocabulary (`ctx.ui.setStatus` /
 * `extensionStatusIcons`) is all it uses.
 */

/** Cells in the bar — twelve characters wide, e.g. `████████░░░░ 72%`. */
export const GAUGE_CELLS = 12;
const FULL_CELL = "█";
const EMPTY_CELL = "░";

/**
 * `default` under 80%, `amber` 80–92% inclusive, `red` above 92%, distinct from
 * `@narumitw/pi-statusline`'s built-in `contextColor()` (70/90).
 */
export const GAUGE_AMBER_THRESHOLD = 80;
export const GAUGE_RED_THRESHOLD = 92;

export type GaugeLevel = "default" | "amber" | "red";

/** Which of the three bands `percent` (0-100) falls in. */
export function gaugeLevel(percent: number): GaugeLevel {
  if (percent > GAUGE_RED_THRESHOLD) return "red";
  if (percent >= GAUGE_AMBER_THRESHOLD) return "amber";
  return "default";
}

/**
 * `GAUGE_CELLS` filled/empty block characters for `percent` (0-100; out-of-range values clamp).
 *
 * Filled cells are `round(percent / 100 * GAUGE_CELLS)` — rounding rather than flooring so the bar
 * never shows empty at a nonzero percentage or full below 100%.
 */
export function renderGaugeBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * GAUGE_CELLS);
  return FULL_CELL.repeat(filled) + EMPTY_CELL.repeat(GAUGE_CELLS - filled);
}

/**
 * `781501` -> `"781k"` — truncated, not rounded: rounding `781501` would read `782k`, which
 * overstates a preflight estimate that already refused a request. This module's own short-count
 * formatter: `@narumitw/pi-statusline`'s equivalent (`formatCount`) lives in that package's `.ts`
 * sources under `node_modules`, which extension code cannot import — Node refuses type-stripping
 * there (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), the same constraint
 * `test/ext-12a-statusline.test.ts` already documents for `SEGMENT_NAMES`.
 */
export function formatShortCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${Math.trunc(n / 1_000_000)}m`;
  if (abs >= 1_000) return `${Math.trunc(n / 1000)}k`;
  return `${Math.trunc(n)}`;
}

export interface GaugeUsage {
  /** Mirrors `ExtensionContext.getContextUsage()`'s `ContextUsage.percent` — `null` right after
   *  compaction, before the next response. */
  readonly percent: number | null;
}

export interface GaugePreflightEstimate {
  readonly estimatedTokens: number;
}

/**
 * `ctx ████████░░░░ 72%`, and `  (preflight est. 781k ⚠)` appended when `preflight` is given.
 * `usage.percent === null` renders an empty bar and `?%`, matching the native `context` segment's
 * own `"?"` for the same unknown state.
 */
export function formatCtxGaugeStatus(usage: GaugeUsage, preflight?: GaugePreflightEstimate): string {
  const percent = usage.percent ?? 0;
  const bar = renderGaugeBar(percent);
  const label = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
  const base = `ctx ${bar} ${label}`;
  if (preflight === undefined) return base;
  // The ⚠ is unconditional here: this function only ever receives a preflight estimate for a
  // request that already tripped `preflightVerdict` into refusal (see index.ts's call site) — an
  // estimate that has not bitten is not passed in at all, so there is no "quiet" preflight state to
  // distinguish it from.
  return `${base}  (preflight est. ${formatShortCount(preflight.estimatedTokens)} ⚠)`;
}

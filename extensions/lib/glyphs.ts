/**
 * One glyph, one meaning, everywhere this repo's own code draws state.
 *
 * **The problem.** `●` used to mean three different things depending on where it showed up: a
 * workflow node, a live async lane, and a section header's own running-count marker. A glyph that
 * means three things at a glance means nothing at a glance — the operator has to read the
 * surrounding text to know which one they are looking at.
 *
 * **The law.** Exactly one glyph per meaning, fixed:
 *   - `▸` / `▾` — a collapsible container: collapsed / expanded.
 *   - `●` — running, and ONLY running. Never a node label, never a section header, never
 *     anything that is not "this is active right now".
 *   - `✓` — done. `○` — pending. `✗` — failed. `⏸` — blocked.
 * Nothing in this repo's own rendering may use one of these six characters for a meaning other
 * than the one listed here. A site that needs a different marker (a list-selection cursor, an
 * "unknown" data marker) must reach for a character outside this set, not overload one of these.
 *
 * **What this module is not.** Some renderers this repo depends on are owned upstream — a
 * third-party package's own inline widget or overlay — and this module cannot reach into them to
 * change which glyph they draw. The law only binds this repo's own code; an upstream renderer that
 * still overloads one of these characters is a report to file against that package, not something
 * this module can fix from here.
 *
 * **What this module is.** The vocabulary every *repo-owned* renderer must draw from —
 * `extensions/dispatch/fleet-widget.ts` and `async-fleet.ts` (async run state),
 * `extensions/subagent-cost/summary.ts` (dead-child marker) — so that everywhere this repo
 * chooses a glyph, it chooses the same one for the same fact.
 */

export const GLYPH = {
  /** A collapsible container, currently collapsed — its contents are hidden behind a count. */
  expand: "▸",
  /** A collapsible container, currently expanded — its contents are shown in full. */
  collapse: "▾",
  /** Active right now. The ONLY meaning `●` carries in this repo's own rendering. */
  running: "●",
  /** Reached a successful terminal state. */
  done: "✓",
  /** Not yet started. */
  pending: "○",
  /** Reached a terminal state that is a failure. */
  failed: "✗",
  /** Started, then explicitly paused/blocked short of a terminal state. */
  blocked: "⏸",
} as const;

export type GlyphName = keyof typeof GLYPH;
export type Glyph = (typeof GLYPH)[GlyphName];

/**
 * The working indicator carries the thinking level.
 *
 * **What this is not.** It is not "making an unused theme token do work". PI already renders the
 * thinking level: `interactive-mode.js:3239-3240` reads `session.thinkingLevel || "off"` and hands
 * it to `theme.getThinkingBorderColor(level)`, which paints the editor's border. That signal is one
 * cell wide, sits at the edge of the frame, and is the only place the level appears while the model
 * is streaming — the moment the level actually matters. This module reinforces that same signal
 * where the eye already is (the spinner row) and adds a second, non-colour channel to it: the frame
 * glyph's *height*. Colour alone is one channel and not everyone reads it.
 *
 * **Why frames and not a message.** `ui.setWorkingMessage` would say the level in words and cost a
 * line of prose on every turn. `ui.setWorkingIndicator` replaces the spinner glyphs, which costs
 * nothing extra on screen. The ramp `▁▂▃▄▅▆▇█` maps level index → glyph height, so `off` pulses at
 * the floor and `max` at the ceiling, and two adjacent glyphs make the pulse.
 *
 * **Who owns the animation.** PI does, entirely. `WorkingStatusIndicator` extends `pi-tui`'s
 * `Loader`, which owns the `setInterval` (`components/loader.js:53`), restarts it on
 * `setIndicator`, and clears it in `stop()`, which `StatusIndicator.dispose()` calls. Interactive
 * mode constructs a fresh indicator per stream (`interactive-mode.js:1600`, `:2471`) from whatever
 * options were last set. So this module owns exactly one thing — the options object — and creates
 * no timer, no component and no subscription of its own. That is what makes the interruptibility
 * and non-blocking properties true rather than asserted: there is nothing here to interrupt.
 *
 * **Colour.** `Loader.setIndicator` sets `renderIndicatorVerbatim = indicator !== undefined`
 * (`loader.js:43`), so supplying frames *disables* the loader's own `spinnerColorFn`; a custom
 * indicator must carry its own ANSI or render unstyled. The live `Theme` is not reachable by
 * import — the package's exports map lists only `.`, `./rpc-entry` and `./client`, and the index
 * re-exports the `Theme` class but not the `theme` singleton. Upstream puts that singleton on
 * `globalThis` under a `Symbol.for` key deliberately, so that every module loader (tsx, jiti) sees
 * one theme (`theme/theme.js:618-629`); reading it there is using the sharing mechanism it exists
 * for, and it is read at paint time, so `/theme` changes are picked up with no listener.
 *
 * **Why the missing-theme path is not fail-loud.** The repo's rule aims at silent substitution of
 * *intent* — a provider swapped, a model downgraded, a result invented. Nothing here is a result.
 * If the theme global is absent (a non-TUI loader, an upstream refactor of the symbol) the frames
 * render unstyled and the level still reads, because the height channel does not depend on colour.
 * Aborting a session over the colour of a spinner would be the disproportionate answer.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { describeError, surfaceOnce } from "./lib/once.ts";

export const id = "thinking-indicator";

/**
 * The levels, low to high. `"off"` is deliberately included: `@earendil-works/pi-ai`'s published
 * `ThinkingLevel` union omits it, but the runtime substitutes it (`interactive-mode.js:3239`
 * `session.thinkingLevel || "off"`) and `theme.getThinkingBorderColor` has a case for it, so it is
 * a real level with a real colour and the ramp starts there.
 */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type IndicatorLevel = (typeof LEVELS)[number];

/** One glyph per level, plus one more so the top level still has a second frame to pulse to. */
export const RAMP = [..."▁▂▃▄▅▆▇█"];

/**
 * Frame interval. PI's own spinner runs at 80 ms (`loader.js` `DEFAULT_INTERVAL_MS`) because it is
 * a rotation and reads as motion; this is a two-frame pulse, where 80 ms would read as a flicker.
 * 280 ms sits inside the 150–300 ms band the UI notes give state changes, at the slow end.
 */
export const INTERVAL_MS = 280;

/** Upstream's cross-loader handle for the live `Theme` (`theme/theme.js:618`). */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

type BorderPainter = { getThinkingBorderColor(level: string): (str: string) => string };

/** The live theme's painter for `level`, or identity when no theme is installed. */
export function painterFor(level: IndicatorLevel): (str: string) => string {
  const live = (globalThis as unknown as Record<symbol, unknown>)[THEME_KEY] as
    | Partial<BorderPainter>
    | undefined;
  if (typeof live?.getThinkingBorderColor !== "function") return (str) => str;
  return live.getThinkingBorderColor(level);
}

/** Normalises whatever the runtime hands us onto the ramp. Anything unknown reads as `"off"`. */
export function normaliseLevel(level: unknown): IndicatorLevel {
  return (LEVELS as readonly string[]).includes(level as string) ? (level as IndicatorLevel) : "off";
}

/** The two frames for `level`, painted. Index into the ramp *is* the level's rank. */
export function framesForLevel(level: IndicatorLevel, paint: (str: string) => string): string[] {
  const rank = LEVELS.indexOf(level);
  return [paint(RAMP[rank]!), paint(RAMP[rank + 1]!)];
}

/** The whole options object PI needs, for `level`. Exported so a test can read it without a TUI. */
export function indicatorFor(level: IndicatorLevel): { frames: string[]; intervalMs: number } {
  return { frames: framesForLevel(level, painterFor(level)), intervalMs: INTERVAL_MS };
}

export function register(pi: ExtensionAPI): void {
  let level: IndicatorLevel = "off";

  /**
   * `hasUI` is true in RPC mode too (`types.d.ts:215`), where there is no loader to configure;
   * `mode === "tui"` is the guard the same file names for terminal-only UI.
   */
  const apply = (ctx: ExtensionContext, what: string): void => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setWorkingIndicator(indicatorFor(level));
    } catch (err) {
      surfaceOnce(ctx, "thinking-indicator:apply-error", () => {
        process.stderr.write(
          `[pi-config] thinking-indicator: ${what} failed, spinner left at the default — ${describeError(err)}\n`,
        );
      });
    }
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // `resetExtensionUi` calls `setWorkingIndicator()` with no argument on every session
    // replacement (`interactive-mode.js:1695`), so the indicator has to be re-applied here, not
    // once at registration.
    level = normaliseLevel(ctx.thinkingLevel);
    apply(ctx, "session_start");
  });

  pi.on("thinking_level_select", (event, ctx: ExtensionContext) => {
    level = normaliseLevel(event.level);
    apply(ctx, "thinking_level_select");
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    // Hand the spinner back. Nothing else here needs tearing down — see the module docstring on
    // who owns the timer — but leaving custom frames behind would outlive the module that set them.
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setWorkingIndicator();
    } catch {
      // A shutdown path that throws on the way out has nowhere useful to report to.
    }
  });
}

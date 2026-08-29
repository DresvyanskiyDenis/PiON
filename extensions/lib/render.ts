/**
 * Two failure modes a custom entry renderer can fall into that PI's own API does nothing to
 * prevent, and the guard/denial-card that is this module's first caller would have hit both.
 *
 * **A renderer that throws.** `registerEntryRenderer` documents an `undefined` return as "show
 * the generic fallback instead" — a graceful degradation PI handles for you. It says nothing
 * about a renderer that *throws*, because from PI's side there is nothing to say: the call sits
 * inside the transcript paint, so an exception there propagates into the paint loop itself. A
 * session with one bad session-entry in its history would then fail to redraw on every repaint
 * until the operator ends it, which is a worse outcome than the plain audit line the fallback
 * view would have shown. `safeEntryRenderer` is the same posture `lib/guarded-handler.ts` takes
 * for a gate that throws mid-evaluation (REQ-EXT-16, `guard.ts`'s header): a bug in one
 * extension's presentation code degrades that extension's presentation, not the session.
 *
 * **A keybinding hint outside the TUI.** PI's `keyHint()` reads the process-wide interactive
 * theme to resolve a binding's current keys, and throws `Theme not initialized` when no theme
 * has been loaded — true for a renderer invoked in a unit test, in `-p`, or in `--mode json`,
 * none of which stand up a TUI theme. A card that only renders when a theme happens to exist is
 * not fit to ship. `keyHintOr` treats the hint as decoration and the rest of the card as the
 * content: losing the live key combo costs nothing a plain-English fallback cannot say instead.
 */
import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { describeError } from "./once.ts";

/**
 * Wraps an `EntryRenderer` so a thrown error degrades to PI's own generic-entry fallback
 * instead of taking the whole transcript repaint down with it. The failure is not swallowed
 * silently: it is written once to stderr, tagged with `owner` so the offending extension is
 * obvious from the log line alone.
 */
export function safeEntryRenderer<T>(owner: string, render: EntryRenderer<T>): EntryRenderer<T> {
  return (entry, options, theme) => {
    try {
      return render(entry, options, theme);
    } catch (err) {
      process.stderr.write(`[pi-config] ${owner}: entry renderer failed: ${describeError(err)}\n`);
      return undefined;
    }
  };
}

/**
 * `keyHint()`'s live binding text when a theme is loaded, `fallback` when it is not (rendered
 * dimmed, matching how a hint reads inside the TUI). Never throws, so a card built in a test
 * harness or a headless run still renders in full, just without the resolved key combo.
 */
export function keyHintOr(
  keybinding: Parameters<typeof keyHint>[0],
  description: string,
  theme: Theme,
  fallback: string,
): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    return theme.fg("dim", fallback);
  }
}

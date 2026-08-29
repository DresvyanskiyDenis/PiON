/**
 * Two small guards for custom entry renderers. Neither is a safety net against a crash — PI
 * already has one — and it is worth being exact about what they do instead.
 *
 * WHY A WRAPPER AROUND A RENDERER AT ALL. PI does catch: `custom-entry.js` invokes a registered
 * renderer inside a try/catch and, on a throw, paints a themed error box reading
 * `[<customType>] renderer failed: <message>`. So a throwing renderer never takes the session
 * down. What it does do is leave that error box in the transcript, repainted on every redraw of
 * a scrollback the operator cannot scroll past without ending the session, with the message
 * visible only there. PI's behaviour for a renderer that returns `undefined` is nicer: it falls
 * back to a generic view of the entry. This wrapper converts "renderer throws" into "renderer
 * returned nothing" — the generic fallback in the transcript, and the error written once to
 * stderr where it can be read after the fact.
 *
 * WHY `keyHintOr`. PI's `keyHint()` reads the process-wide interactive theme and throws
 * `Theme not initialized` when no theme has been set up — which is the normal state outside an
 * interactive TUI session: `-p` mode, `--mode json`, a unit test, or a renderer invoked before
 * the terminal UI has finished starting. A key hint is a nicety on top of a card, not the reason
 * the card exists, so it should degrade to plain text instead of taking the card down with it.
 */
import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { describeError } from "./once.ts";

/**
 * Wraps an entry renderer so that an exception inside `render` degrades to PI's own fallback
 * rendering (a return of `undefined`) instead of propagating out of the transcript paint.
 *
 * @param owner Name of the extension the renderer belongs to, used to prefix the stderr line so
 *   a failure is traceable back to its module without guessing from a bare stack trace.
 * @param render The renderer to protect.
 * @returns A renderer with the same signature that never throws.
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
 * Returns `keyHint()`'s formatted hint when a theme is available, and `fallback` when it is not,
 * so a card built outside an interactive session (a test, `-p` mode) still renders instead of
 * throwing on a decoration nobody outside a TUI could see anyway.
 *
 * @param keybinding The keybinding to look up, forwarded to `keyHint()` unchanged.
 * @param description Human-readable description of what the key does, forwarded to `keyHint()`.
 * @param theme Active theme, used only to style `fallback` if `keyHint()` is unavailable.
 * @param fallback Plain-text hint to show when no interactive theme is initialized.
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

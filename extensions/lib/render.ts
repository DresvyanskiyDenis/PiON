/**
 * Two small guards that every custom entry renderer in this repository ends up needing, because
 * PI's host API gives an extension the hook (`registerEntryRenderer`) but not the safety net
 * around it.
 *
 * WHY A WRAPPER AROUND A RENDERER AT ALL. A registered renderer runs inside PI's transcript
 * paint, once per repaint of every entry currently on screen. If it throws, the throw happens on
 * that repaint — not once, but on every subsequent redraw of a scrollback the operator cannot
 * scroll away from without ending the session. PI's own behaviour for a renderer that returns
 * `undefined` is graceful (it falls back to a generic view of the entry), so the fix is to make
 * "renderer throws" behave like "renderer returned nothing": log once to stderr and let the
 * fallback take over, rather than let one extension's bug take the whole transcript down.
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

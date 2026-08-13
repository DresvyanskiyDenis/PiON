/**
 * One notice, one channel — the single emitter every module in this tree announces through.
 *
 * ## The bug this replaces
 *
 * Every module used to carry its own copy of a "both channels, always" helper: write the line to
 * `process.stderr` AND hand the same line to `ctx.ui.notify`. The comment justifying it was half
 * right — `ctx.ui.notify` really is a no-op in `-p` / `--mode json`, so a
 * UI-only announcement is a silent one there — but the conclusion did not follow. In the TUI both
 * channels are live at once and they are not the same surface:
 *
 *   - `ctx.ui.notify` goes to `InteractiveMode.showExtensionNotify`
 *     (`dist/modes/interactive/interactive-mode.js:2068`), which appends a `Text` node to the chat
 *     container via `showStatus` / `showWarning` / `showError` (`:2744`, `:3338`, `:3333`).
 *   - `process.stderr.write` goes straight to the terminal. PI's `takeOverStdout`
 *     (`dist/core/output-guard.js:38`) redirects *stdout* onto the raw stderr write; it never
 *     captures stderr itself. So our raw line lands in the middle of the TUI's own frame.
 *
 * Result: every startup announcement was printed twice — once as a bare line interleaved with the
 * TUI's repaint, once as the rendered chat entry — with the `warning` level adding a `Warning: `
 * prefix to only one of the two, which is what made it look like two different messages.
 *
 * ## The rule
 *
 * `hasUI` is the discriminator, and it is PI's own: `ExtensionRunner.hasUI()`
 * (`dist/core/extensions/runner.js:274`) is true exactly when a real UI context is installed —
 * TUI and RPC — and false for `print` / `json`, where the context is `noOpUIContext`. PI uses this
 * discriminator for precisely this purpose in `getShortcuts`: `if (!this.hasUI()) console.warn(...)`
 * (`:325`). `extensions/credentials.ts`'s `warmUp` already had it right; this module makes it the
 * one implementation instead of the one exception.
 *
 * So: UI present -> `ctx.ui.notify` only. No UI -> the log sink only. Never both, never neither.
 */
import { describeError } from "./once.ts";

export type NoticeLevel = "info" | "warning" | "error";

/** Where a notice goes when there is no UI. Defaults to stderr; injected by tests. */
export type LogSink = (line: string) => void;

/**
 * Structural, not `ExtensionContext`, on purpose: `ExtensionCommandContext` and
 * `ProjectTrustContext` carry the same two members and are legitimate callers.
 */
export interface NoticeTarget {
  readonly hasUI: boolean;
  readonly ui: { notify(message: string, type?: NoticeLevel): void };
}

const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * Emits `line` exactly once, on whichever channel this run mode actually has.
 *
 * Never throws: a `ctx.ui.notify` that fails (closed TUI, broken dialog subsystem) falls back to
 * the log sink rather than turning an announcement into a crash — that fallback is the ONLY case
 * in which a single call can touch both channels, and it is a rescue, not a duplicate.
 */
export function emitNotice(
  ctx: NoticeTarget | undefined,
  line: string,
  level: NoticeLevel = "warning",
  log: LogSink = stderrSink,
): void {
  if (ctx?.hasUI !== true) {
    try {
      log(line);
    } catch {
      // stderr is gone. There is no third channel; losing the notice beats crashing the host.
    }
    return;
  }
  try {
    ctx.ui.notify(line, level);
  } catch (err) {
    try {
      log(`${line} (ui.notify failed: ${describeError(err)})`);
    } catch {
      // As above.
    }
  }
}

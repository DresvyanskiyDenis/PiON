/**
 * The top-level loader says how long and what it is doing, not just "Working...".
 *
 * **The complaint.** A bare `Working...` for the whole time a turn runs is indistinguishable, after
 * a while, from a wedged process: nothing on screen answers "is this still moving" or "what is it
 * doing right now".
 *
 * **The mechanism.** `ctx.ui.setWorkingMessage(text)` fully replaces the loader's text — a
 * first-class `ExtensionUIContext` method, not a patch to the TUI package itself. `turn_start`
 * carries the wall-clock the elapsed figure is measured from, and `tool_execution_start`/`_end`
 * carry which tool is running, so `Working… 2m14s · streaming` becomes `Working… 18s · tool: read`
 * the instant a tool call opens.
 *
 * **Why this is not `thinking-indicator.ts`.** That module's own docstring is explicit about why it
 * avoids `setWorkingMessage`: it would say the level in words and cost a line of prose on every
 * turn — a deliberate choice for *that* module's concern (the thinking level, shown as spinner-glyph
 * height). This module's concern is a different axis (elapsed time + activity phase) and needs the
 * text channel that module deliberately does not use. `setWorkingIndicator` (frames) and
 * `setWorkingMessage` (text) are independent fields on the same loader — nothing here touches the
 * frames thinking-indicator sets, and nothing there touches the text this module sets. Folding both
 * concerns into one file would make an unrelated future change to either one a diff that touches
 * both.
 *
 * **The ticker, and why it is bounded.** A static `setWorkingMessage` call does not animate on its
 * own, so the elapsed figure needs something to repaint it once a second while a turn is open. That
 * timer is `unref()`d so it can never hold the process open, it is started only while a turn is open
 * and stopped the instant one ends (`turn_end`), and `session_shutdown` clears it unconditionally as
 * the safety net.
 *
 * **Why not `message_update`.** `tool_execution_start`/`tool_execution_end` already say everything
 * this module needs about phase — the default phase *is* "streaming", reasserted on every
 * `tool_execution_end` — so there is no reason to subscribe to a token-by-token event, which would
 * fire a `setWorkingMessage` far more often than once a second for no visible gain.
 *
 * **`formatElapsed` is local, not shared.** The natural home for an elapsed-time formatter would be
 * `dispatch/fleet-widget.ts`, since a fleet panel needs the same "Nm SSs" shape — but PiON's current
 * fleet widget renders a flat, glyph-based line per run and does not track or display per-run
 * elapsed time yet, so there is nothing there to import. This module carries its own copy rather
 * than adding an elapsed-time concept to the fleet widget as a side effect of an unrelated loader
 * change; if the fleet widget grows the same figure later, this is the one place that would then
 * import instead of define it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { describeError, surfaceOnce } from "./lib/once.ts";

export const id = "loader-clock";

/** Repaint cadence: elapsed is shown at second resolution. */
export const TICK_MS = 1_000;

/** `123456` → `"2m03s"`, `"41s"` — minutes only once there are any. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/** The loader text for a turn that started `startedAt` ago and is currently in `phase`. */
export function workingMessage(startedAt: number, phase: string, now: number = Date.now()): string {
  return `Working… ${formatElapsed(Math.max(0, now - startedAt))} · ${phase}`;
}

/** The phase a running tool call is shown as. Verbatim: `tool_execution_start.toolName` is already
 *  the short, lower-case name the transcript itself uses (`read`, `edit`, `bash`, …). */
export function toolPhase(toolName: string): string {
  return `tool: ${toolName}`;
}

export const STREAMING_PHASE = "streaming";

export function register(pi: ExtensionAPI): void {
  let turnStartedAt: number | undefined;
  let phase: string = STREAMING_PHASE;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const paint = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || turnStartedAt === undefined) return;
    try {
      ctx.ui.setWorkingMessage(workingMessage(turnStartedAt, phase));
    } catch (err) {
      surfaceOnce(ctx, "loader-clock:paint-error", () => {
        process.stderr.write(
          `[pi-config] loader-clock: repaint failed, loader left at its last text — ${describeError(err)}\n`,
        );
      });
    }
  };

  const restoreDefault = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setWorkingMessage();
    } catch {
      // A teardown path that throws has nowhere useful to report to.
    }
  };

  const reset = (): void => {
    stop();
    turnStartedAt = undefined;
    phase = STREAMING_PHASE;
  };

  pi.on("turn_start", (event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    turnStartedAt = event.timestamp;
    phase = STREAMING_PHASE;
    paint(ctx);
    if (timer !== undefined) return;
    timer = setInterval(() => paint(ctx), TICK_MS);
    timer.unref?.();
  });

  pi.on("tool_execution_start", (event, ctx: ExtensionContext) => {
    if (turnStartedAt === undefined) return;
    phase = toolPhase(event.toolName);
    paint(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx: ExtensionContext) => {
    if (turnStartedAt === undefined) return;
    phase = STREAMING_PHASE;
    paint(ctx);
  });

  pi.on("turn_end", (_event, ctx: ExtensionContext) => {
    stop();
    turnStartedAt = undefined;
    phase = STREAMING_PHASE;
    restoreDefault(ctx);
  });

  // Defensive, like `thinking-indicator.ts`'s own `session_start` re-apply: a stale ticker must
  // never carry over into a replaced session (`/reload`, a resume) even if some future event
  // ordering leaves one running.
  pi.on("session_start", () => {
    reset();
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    stop();
    restoreDefault(ctx);
  });
}

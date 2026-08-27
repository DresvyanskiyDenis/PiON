/**
 * The async fleet as a live panel above the editor, instead of a snapshot you have to ask for.
 *
 * **What was wrong.** A dispatched async run is the one piece of session state the screen said
 * nothing about. `renderAsyncFleet` has always been able to tell you exactly what every run is
 * doing — it re-reads each run's own `status.json` rather than remembering a state — but it was
 * reachable only by typing `/agents`, so the answer to "did that finish?" cost a command, and the
 * question that prompts it ("is anything still running?") had no answer at all short of asking.
 * The `turn_end` announcement is not that surface: it is written for the model, it fires once per
 * run, and it fires only after the run is over.
 *
 * **What this is not.** It does not replace `/agents`. That command carries the dispatch registry
 * as well — what *can* be dispatched, on what model — which is a catalogue, not live state, and
 * would be wrong as a permanent panel. It is also the only fleet surface that exists outside the
 * TUI, where `setWidget` does not. `/agents` keeps its async section verbatim; this makes the
 * common case free rather than taking a diagnostic away.
 *
 * **Why it polls, and what that costs.** The state being displayed lives on disk and changes
 * without any event reaching this process: a run completes while the model is mid-stream, or while
 * the user is typing. Repainting only at `turn_end` would produce a panel that is confidently
 * wrong for exactly as long as the user is looking at it. Repainting on a chatty event such as
 * `message_update` would re-read every status file per token. So the poll is deliberate — one
 * `setInterval`, one `readFileSync` per tracked run per tick, and it exists *only* while at least
 * one run is tracked: the tick that finds nothing to show clears the panel and stops itself.
 *
 * **The timer is the whole risk, so it is bounded three ways.** It is `unref()`d, so it can never
 * hold the process open; it stops itself when the fleet empties; and `dispose()` is idempotent and
 * called from `session_shutdown`. `test/dispatch/fleet-widget.test.ts` counts live timers across a
 * full session and requires zero at the end, rather than asserting it in this comment.
 *
 * **No new colour.** The three states are distinguished by the same three glyphs the announcement
 * already uses (`✓` done, `✗` failed, `?` never started, `▸` live), which is a channel that
 * survives a screenshot, a colour-blind reader and a 256-colour terminal. Introducing a colour here
 * would mean a second site reaching for the live theme, for decoration, and the panel does not need
 * one to be readable.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type AsyncFleet, reconcile, shortId } from "./async-fleet.ts";

/** The `setWidget` key. One key, so a repaint replaces rather than stacks. */
export const WIDGET_KEY = "dispatch-async-fleet";

/** How often the tracked runs' status files are re-read while any run is tracked. */
export const POLL_MS = 1_000;

/** The panel's lines, or `undefined` when there is nothing to show and the panel should go away. */
export function renderFleetPanel(fleet: AsyncFleet): string[] | undefined {
  if (fleet.tracked.size === 0) return undefined;
  const reports = reconcile(fleet);
  let live = 0;
  let done = 0;
  let bad = 0;
  const rows = reports.map((report) => {
    const { run, verdict } = report;
    if (verdict.kind === "live") {
      live += 1;
      return `  ▸ ${run.agent ?? "subagent"} [${shortId(run.runId)}] ${verdict.state}`;
    }
    if (verdict.kind === "no-status") {
      bad += 1;
      return `  ? ${run.agent ?? "subagent"} [${shortId(run.runId)}] NEVER STARTED`;
    }
    if (verdict.failed) bad += 1;
    else done += 1;
    const label = verdict.agent ?? run.agent ?? "subagent";
    return `  ${verdict.failed ? "✗" : "✓"} ${label} [${shortId(run.runId)}] ${verdict.state}`;
  });
  const counts = [
    live > 0 ? `${live} running` : undefined,
    done > 0 ? `${done} done` : undefined,
    bad > 0 ? `${bad} needs attention` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [`async subagents — ${counts.join(" · ")}`, ...rows];
}

export interface FleetWidget {
  /** Re-read the fleet, repaint, and start or stop the poll to match. Safe to call at any time. */
  refresh(ctx: ExtensionContext): void;
  /** Clear the panel and stop the poll. Idempotent. */
  dispose(ctx?: ExtensionContext): void;
}

/**
 * `mode === "tui"` rather than `hasUI`: `hasUI` is true in RPC mode as well
 * (`core/extensions/types.d.ts:215`), where there is no editor for a widget to sit above, and the
 * same file names `mode === "tui"` as the guard for terminal-only UI. Outside the TUI this
 * controller creates no widget and starts no timer — `/agents` is the fleet surface there.
 */
export function createFleetWidget(fleet: AsyncFleet, pollMs: number = POLL_MS): FleetWidget {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pinned: ExtensionContext | undefined;

  const stopPoll = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const paint = (ctx: ExtensionContext): boolean => {
    const lines = renderFleetPanel(fleet);
    if (lines === undefined) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return false;
    }
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    return true;
  };

  return {
    refresh(ctx: ExtensionContext): void {
      if (ctx.mode !== "tui") return;
      pinned = ctx;
      const showing = paint(ctx);
      if (!showing) {
        stopPoll();
        return;
      }
      if (timer !== undefined) return;
      timer = setInterval(() => {
        // The tick repaints from the pinned context, which is the one that was live when the
        // panel appeared. If it finds nothing left to show it clears the panel and stops itself,
        // so an idle session carries no timer.
        if (pinned === undefined || !paint(pinned)) stopPoll();
      }, pollMs);
      timer.unref?.();
    },

    dispose(ctx?: ExtensionContext): void {
      stopPoll();
      const target = ctx ?? pinned;
      pinned = undefined;
      if (target === undefined || target.mode !== "tui") return;
      target.ui.setWidget(WIDGET_KEY, undefined);
    },
  };
}

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

/**
 * The `setWidget` key. One key, so a repaint replaces rather than stacks.
 *
 * **If you are adding a second `aboveEditor` widget, read this first.** Their vertical order is not
 * stable and is not configurable. The host keeps them in a `Map`
 * (`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:285`) and renders
 * `widgets.values()` in insertion order (`:1723-1725`) — but `setExtensionWidget` deletes the key
 * and re-inserts it on *every* update (`:1629-1633` then `:1657`), even when only the content
 * changed. Re-insertion moves a key to the tail, so the rendered order is **least-recently-painted
 * first**: whichever widget painted most recently sinks to the bottom.
 *
 * With two painters on unsynchronised timers that is not a tie-break, it is a flip — the blocks
 * trade places every time the upper one repaints, which at a sub-second repaint rate is a far more
 * violent event on screen than either block changing size. It is why `config/subagent.default.json`
 * sets `asyncWidget: false` and this panel replaces the `pi-subagents` block rather than sitting
 * beside it. Nothing in `docs/extensions.md` or `docs/tui.md` documents ordering among
 * same-placement widgets; only `placement` itself is specified, so this is an emergent property of
 * the implementation and not a contract to rely on.
 */
export const WIDGET_KEY = "dispatch-async-fleet";

/** How often the tracked runs' status files are re-read while any run is tracked. */
export const POLL_MS = 1_000;

/**
 * The most lines this panel may emit, because it is the most the host will draw.
 *
 * `InteractiveMode.MAX_WIDGET_LINES` is 10
 * (`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1702`), and a string
 * array longer than that is silently cut to 10 **plus** an appended `... (widget truncated)` line
 * (`:1644-1649`). A panel that ignored this would not merely lose its tail: at the boundary the
 * host adds a line of its own, so the block would be one row taller than this module believed it
 * was emitting. The ceiling is honoured here, where the layout can degrade deliberately and say
 * what it is not showing, rather than upstream where it degrades by truncation.
 */
export const MAX_PANEL_LINES = 10;

/** Columns assumed when stdout reports none — piped output, a test, CI. */
const FALLBACK_COLUMNS = 80;

/**
 * The width a panel line may occupy. Two columns short of the terminal, because a line that
 * overruns wraps — and a wrapped line costs a second terminal row exactly as an extra line would,
 * which is the height the panel is trying to keep constant.
 */
export function panelWidth(columns: number | undefined = process.stdout.columns): number {
  return Math.max(20, (columns && columns > 0 ? columns : FALLBACK_COLUMNS) - 2);
}

/**
 * Terminal columns one grapheme occupies.
 *
 * `String.length` counts UTF-16 code units and is the wrong ruler twice over: a CJK ideograph or an
 * emoji is one unit and **two columns**, and a combining mark is one unit and **zero**. Both arrive
 * here through values this module does not control — an agent name, a file path, a child's error
 * text — so measuring with `length` would leave the width bound true for ASCII and quietly false
 * for everything else, which is the kind of guarantee that is worse than a documented limit.
 *
 * The wide ranges are East Asian Wide and Fullwidth plus the emoji blocks; anything whose code
 * points are all zero-width (combining marks, joiners, variation selectors) is zero. A grapheme
 * cluster is measured as a whole, so an emoji built from a ZWJ sequence counts two columns once
 * rather than two per component.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function codePointWidth(codePoint: number): number {
  if (ZERO_WIDTH.test(String.fromCodePoint(codePoint))) return 0;
  return WIDE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi) ? 2 : 1;
}

/** Terminal columns a string occupies, as opposed to the number of UTF-16 units it is stored in. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    let cluster = 0;
    for (const char of segment) cluster = Math.max(cluster, codePointWidth(char.codePointAt(0)!));
    width += cluster;
  }
  return width;
}

/** One line, truncated by display width so it can never wrap into a second row. */
export function fitLine(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let kept = "";
  let used = 0;
  // One column is reserved for the ellipsis, which is itself one column wide.
  for (const { segment } of GRAPHEMES.segment(text)) {
    const next = displayWidth(segment);
    if (used + next > width - 1) break;
    kept += segment;
    used += next;
  }
  return `${kept}…`;
}

/** The panel's lines, or `undefined` when there is nothing to show and the panel should go away. */
export function renderFleetPanel(fleet: AsyncFleet, width: number = panelWidth()): string[] | undefined {
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
  // Past the host's ceiling the panel says how many runs it is not showing. Silently dropping them
  // is the one thing it must not do: a fleet panel that omits a running child is worse than one
  // that admits it is out of room.
  const budget = MAX_PANEL_LINES - 1;
  const body = rows.length <= budget
    ? rows
    : [...rows.slice(0, budget - 1), `  … and ${rows.length - (budget - 1)} more`];
  return [`async subagents — ${counts.join(" · ")}`, ...body].map((line) => fitLine(line, width));
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

  /**
   * What the panel currently shows, so an unchanged tick costs nothing. `undefined` means the panel
   * is deliberately cleared; `null` means nothing has been painted yet and the next paint must run.
   *
   * This is not only a saved write. Every `setWidget` call re-inserts the key and so re-orders this
   * widget against any other at the same placement (see `WIDGET_KEY`), which makes a no-op repaint
   * a visible event rather than a free one.
   */
  let painted: string[] | undefined | null = null;

  const unchanged = (lines: string[] | undefined): boolean => {
    if (painted === null) return false;
    if (lines === undefined || painted === undefined) return lines === painted;
    return lines.length === painted.length && lines.every((line, index) => line === painted![index]);
  };

  const paint = (ctx: ExtensionContext): boolean => {
    const lines = renderFleetPanel(fleet);
    if (unchanged(lines)) return lines !== undefined;
    painted = lines;
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
      // Not gated on `painted`: dispose is the safety net, and a net that trusts its own bookkeeping
      // is not one. It clears unconditionally.
      painted = null;
      if (target === undefined || target.mode !== "tui") return;
      target.ui.setWidget(WIDGET_KEY, undefined);
    },
  };
}

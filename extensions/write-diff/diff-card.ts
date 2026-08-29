/**
 * An overwrite shown as a diff, rather than as a wall of new content.
 *
 * WHY THIS TARGETS `write` AND NOT `edit`. The obvious place to want a unified diff is the `edit`
 * tool, and PI already puts one there: `core/tools/edit.js:116` passes `result.details.diff`
 * through `renderDiff` for the result, and `:139` does the same for the live preview.
 * `renderDiff` itself (`modes/interactive/components/diff.js:70`) groups runs of `-` and `+`
 * lines, colours them through `toolDiffRemoved`/`toolDiffAdded`/`toolDiffContext`, and highlights
 * changes within a line. Nothing an extension could add there would be an improvement, and
 * replacing it would be a downgrade.
 *
 * `write` is the tool that dumps. `formatWriteResult` (`core/tools/write.js:118`) returns the
 * error string and nothing else, and the call component prints the first ten lines of the NEW
 * content (`core/tools/write.js:101-114`). That is the right display for a file being created —
 * all of it is new, so a preview of the top is exactly what a reader wants. It is the wrong
 * display for a `write` that landed on a file which already existed, because there "what changed"
 * is the only interesting question, and PI answers it with a syntax-highlighted copy of the
 * result.
 *
 * So this module renders a diff for the tool that lacks one: a pre-image captured while the old
 * bytes still exist, diffed against the content the call carries, appended as a single entry once
 * the write has actually landed.
 *
 * A newly created file gets no card at all. There is nothing to compare it against, and PI's own
 * ten-line preview is already the right thing to show.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHintOr, safeEntryRenderer } from "../lib/render.ts";

export const DIFF_ENTRY = "write-diff.overwrite";

/** Diff rows kept in the entry. Nobody reads a rewrite of a 4000-line file row by row. */
export const MAX_DIFF_LINES = 200;
/** Rows shown before the entry is expanded. Matches the ten lines PI's own write preview shows. */
export const COLLAPSED_DIFF_LINES = 10;

export interface WriteDiffEntry {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** `generateDiffString` output, already capped to `MAX_DIFF_LINES` rows. */
  readonly diff: string;
  /** How many rows that cap dropped. */
  readonly droppedLines: number;
}

/**
 * Builds the entry for an overwrite, or `undefined` when there is nothing worth showing.
 *
 * Kept pure and separate from the event handlers, because every interesting decision lives here:
 * what counts as a change at all, and how much of a diff is worth carrying in an entry.
 */
export function buildWriteDiff(path: string, before: string, after: string): WriteDiffEntry | undefined {
  if (before === after) return undefined; // a write that changed nothing has nothing to say
  const { diff } = generateDiffString(before, after);
  const rows = diff.split("\n");
  const added = rows.filter((r) => r.startsWith("+")).length;
  const removed = rows.filter((r) => r.startsWith("-")).length;
  if (added === 0 && removed === 0) return undefined; // line-ending or whitespace churn only
  return {
    path,
    added,
    removed,
    diff: rows.slice(0, MAX_DIFF_LINES).join("\n"),
    droppedLines: Math.max(0, rows.length - MAX_DIFF_LINES),
  };
}

/**
 * Colours one row of `generateDiffString` output. Deliberately the same three theme slots PI's
 * own `renderDiff` uses, so that an overwrite and an edit read as the same kind of thing rather
 * than as two unrelated widgets that happen to both contain diffs.
 */
function colourRow(row: string, theme: Theme): string {
  if (row.startsWith("+")) return theme.fg("toolDiffAdded", row);
  if (row.startsWith("-")) return theme.fg("toolDiffRemoved", row);
  return theme.fg("toolDiffContext", row);
}

/** The card, as one already-themed string. */
export function formatWriteDiff(data: WriteDiffEntry, theme: Theme, expanded: boolean): string {
  const head =
    theme.fg("toolTitle", theme.bold("overwrote ")) +
    theme.fg("accent", data.path) +
    theme.fg("toolDiffAdded", ` +${data.added}`) +
    theme.fg("toolDiffRemoved", ` -${data.removed}`);

  const rows = data.diff.split("\n");
  const shown = expanded ? rows : rows.slice(0, COLLAPSED_DIFF_LINES);
  const body = shown.map((row) => colourRow(row, theme));

  const hidden = rows.length - shown.length + data.droppedLines;
  if (expanded) {
    if (data.droppedLines > 0) {
      body.push(theme.fg("muted", `  ... ${data.droppedLines} more diff lines, not kept`));
    }
  } else if (hidden > 0) {
    body.push(
      theme.fg("muted", `  ... ${hidden} more `) +
        keyHintOr("app.tools.expand", "to see the rest", theme, "expand to see the rest"),
    );
  }
  return [head, ...body].join("\n");
}

/** Registers the renderer. Kept out of `index.ts` so the card format stays testable on its own. */
export function registerWriteDiffRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<WriteDiffEntry>(
    DIFF_ENTRY,
    safeEntryRenderer("write-diff", (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data || typeof data.diff !== "string") return undefined;
      const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(formatWriteDiff(data, theme, expanded), 0, 0));
      return box;
    }),
  );
}

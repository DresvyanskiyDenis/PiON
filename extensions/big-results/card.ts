/**
 * EXT-29 (REQ-CTX-38) — the externalisation card: the same event `index.ts` reports to the
 * model, said again for the human watching the transcript.
 *
 * `index.ts` patches the tool result the model sees, replacing an oversized wall of text with a
 * head/tail summary plus a re-expand handle. That patch is the only channel a `tool_result`
 * handler has, and it is aimed at the model. A person reading the same transcript in the TUI got
 * the identical wall of text and had to locate the handle inside it by eye. This module adds a
 * second, display-only channel for the same event: one `pi.appendEntry()` call per
 * externalisation, drawn by a `pi.registerEntryRenderer()` as a small card — which tool ran,
 * how big the result was, the handle, the first few lines, and a hint that expands into the full
 * path plus the exact `expand_result(...)` call that reads the rest back.
 *
 * WHY AN ENTRY, NOT A SECOND MESSAGE. `pi.sendMessage()` paired with a message renderer would
 * inject a second copy of the handle into the model's own context — the same handle the patched
 * tool result already delivered there. Custom entries, by contrast, do not participate in the
 * context sent to the model (see the extension docs' "pi.appendEntry" section); that is exactly
 * the property a card for a human needs, since it lets the display and the model-facing patch
 * each carry their own copy of the same fact without either paying for the other's.
 *
 * WHY NOT A TOOL RENDERER. `renderResult` is a property of one tool definition, and this module
 * runs over the result of any tool at all: `bash`, `grep`, an MCP tool, a sub-agent return.
 * Reaching all of those through per-tool renderers would mean overriding every built-in tool's
 * `renderResult`, discarding PI's own presentation for the large majority of results that are
 * never oversized. A card that sits beside the result row costs none of that.
 *
 * The formatter below is a pure function of its input and is exported on its own so
 * `test/big-results/card.test.ts` can assert on the exact rendered string without a terminal, a
 * loaded theme, or a running agent.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import { formatSize, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { keyHintOr, safeEntryRenderer } from "../lib/render.ts";

/** Custom entry type, namespaced on the module id the same way `tool-masks.state` is. */
export const CARD_ENTRY = "big-results.externalised";

/** Number of leading lines the card previews. Fixed, not user-configurable. */
export const PREVIEW_LINES = 3;

export interface ExternalisedCard {
  readonly handle: string;
  readonly toolName: string;
  readonly path: string;
  readonly lines: number;
  readonly totalBytes: number;
  /** The first `PREVIEW_LINES` lines of the externalised text, already sliced by the caller. */
  readonly preview: readonly string[];
}

/**
 * Trims one preview line so a single card row can hold it.
 *
 * Control characters are stripped rather than passed through: the previewed text is the first
 * lines of arbitrary tool output, and a raw escape sequence sitting in it would repaint the
 * terminal from inside the very card that exists to make that output safe to glance at.
 */
function previewLine(line: string): string {
  const flat = line.replace(/\t/g, "  ").replace(/[\x00-\x1f]/g, " ");
  return flat.length > 96 ? `${flat.slice(0, 95)}…` : flat;
}

/**
 * Renders one card as an already-themed string.
 *
 * Collapsed, the card gives what was externalised, how big it was, the handle, and its first
 * lines — enough to recognise the result without reading it. Expanded, it adds the full path and
 * the exact `expand_result(...)` call, which is the one piece a person actually retypes by hand.
 */
export function formatExternalisedCard(data: ExternalisedCard, theme: Theme, expanded: boolean): string {
  const size = `${formatSize(data.totalBytes)}, ${data.lines} lines`;
  const head =
    theme.fg("accent", theme.bold("▤ externalised ")) +
    theme.fg("toolTitle", data.toolName) +
    theme.fg("muted", ` · ${size} · `) +
    theme.fg("accent", `handle "${data.handle}"`);

  const body = data.preview.map((l) => theme.fg("dim", `  ${previewLine(l)}`));

  const foot = expanded
    ? [
        theme.fg("muted", `  full output: ${data.path}`),
        theme.fg("muted", `  read it back with expand_result(handle="${data.handle}", grep="…")`),
      ]
    : [`  ${keyHintOr("app.tools.expand", "for the path and the read-back call", theme, "expand for the path and the read-back call")}`];

  return [head, ...body, ...foot].join("\n");
}

/**
 * Registers the card's entry renderer with `pi`. Kept separate from `formatExternalisedCard` so
 * the string formatting stays testable without going through the registration API at all.
 */
export function registerCardRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<ExternalisedCard>(
    CARD_ENTRY,
    safeEntryRenderer("big-results", (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(formatExternalisedCard(data, theme, expanded), 0, 0));
      return box;
    }),
  );
}

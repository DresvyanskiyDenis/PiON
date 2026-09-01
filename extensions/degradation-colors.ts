/**
 * TUI: reserve amber/red exclusively for degradation states.
 *
 * **The problem.** Every block in the TUI is a dark slab in a slightly different tint, and
 * semantic color is spent on syntax highlighting and tool names rather than on state. A
 * degrading session looks exactly like a healthy one — the operator's only clue is the cost
 * figure. A self-resume, an `error`/`aborted` turn, a provider retry, a provider failure — all
 * grey blocks.
 *
 * **The solution.** Reserve `error` (red) and `warning` (amber) exclusively for degradation:
 * provider retry / provider failure, context-preflight refusal, turn ended `error`/`aborted`,
 * cache-miss re-bill, tool/lane past duration threshold. A three-second glance distinguishes
 * "this session is fine" from "this session is on fire".
 *
 * **What this module does.** Registers custom entry renderers for `provider_retry` and
 * `provider_failure` (the two where we have the most session entry data available today) and
 * colors them red/amber. Hook points for future degradation renderers are marked.
 *
 * **Why a whole-block color rather than a one-line summary.** `extensions/lib/provider-error.ts`'s
 * `surfaceProviderFailure` files these entries as `{ classified: string }` — the same multi-line
 * report `formatProviderFailure()` already writes to stderr, not a structured object with
 * `provider`/`model`/`klass` fields of its own (`test/ext-13-provider-error.test.ts` locks that
 * shape down: `data.classified === formatProviderFailure(failure)`). Reformatting that report
 * into a one-line "provider/model: class — message" header here would either duplicate
 * `formatProviderFailure`'s field selection by hand — a second copy that drifts the first time
 * that function grows a field — or parse its own rendered text back apart, which is more fragile
 * than the string it starts from. Coloring the report as a whole keeps this module honest about
 * what it actually has: one already-composed block whose only missing property is a color.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { safeEntryRenderer } from "./lib/render.ts";

export const id = "degradation-colors";

/** The shape `extensions/lib/provider-error.ts`'s `surfaceProviderFailure` actually appends. */
export interface ClassifiedFailureEntry {
  readonly classified: string;
}

/**
 * Colors an already-formatted `formatProviderFailure()` block red (failure) or amber (retry),
 * end to end, and prefixes its first line with a marker glyph. Retry: amber `⚠️`. Failure: red
 * `🔴`.
 */
export function formatProviderState(classified: string, theme: Theme, isRetry: boolean): string {
  const marker = isRetry ? "⚠️" : "🔴";
  const color = isRetry ? "warning" : "error";
  return classified
    .split("\n")
    .map((line, i) => theme.fg(color, i === 0 ? `${marker} ${line}` : line))
    .join("\n");
}

function renderClassified(isRetry: boolean) {
  return safeEntryRenderer<ClassifiedFailureEntry>("degradation-colors", (entry, _options, theme) => {
    const data = entry.data;
    if (!data || typeof data.classified !== "string") return undefined;

    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(formatProviderState(data.classified, theme, isRetry), 0, 0));
    return box;
  });
}

export function register(pi: ExtensionAPI): void {
  // Provider retry (amber/warning).
  pi.registerEntryRenderer<ClassifiedFailureEntry>("provider_retry", renderClassified(true));

  // Provider failure (red/error).
  pi.registerEntryRenderer<ClassifiedFailureEntry>("provider_failure", renderClassified(false));

  // Future hooks for other degradation states:
  // - Turn ended `error` or `aborted` → use theme.fg("error", ...)
  // - Context-preflight refusal → use theme.fg("warning", ...)
  // - Cache-miss re-bill (cacheRead: 0, not first turn) → use theme.fg("warning", ...) on message-cost card
  // - Tool call / lane past duration threshold → use theme.fg("warning", ...) on progress indicator
}

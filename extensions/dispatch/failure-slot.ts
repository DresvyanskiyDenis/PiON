/**
 * `EXT-05` — what the operator reads first when a dispatched run dies.
 *
 * ## The defect this exists for
 *
 * A subagent child announces everything on stderr, because `lib/announce.ts` routes there whenever
 * `ctx.hasUI` is false and a headless child has no UI. `pi-subagents` then takes the child's ENTIRE
 * stderr tail and makes it the run's error text, and that full tail becomes the tool result's
 * `error` field. Every `[pi-config]` startup notice the child emitted therefore sits ABOVE the
 * actual abort, and the first line of a failure is whichever extension announced itself earliest —
 * not the reason the run died.
 *
 * Observed 2026-08-14, a subagent run that died of `empty-response` against an OpenAI-compatible
 * gateway led with a routing extension's own correct, deliberate no-op notice, followed by two more
 * startup lines, before the classified abort ever appeared. The operator read a routing message
 * where the cause belonged, and lost time to it.
 *
 * ## What this module does, and what it deliberately does not
 *
 * It **reorders**. The classified block — the one `lib/provider-error.ts` rendered, recognised by
 * its own exported marker and by nothing else — is promoted to the front; every other line is kept,
 * verbatim and in its original order, underneath. Nothing is dropped, summarised, truncated or made
 * quieter: a dispatched child's full output must remain visible, and this is about saying the
 * load-bearing part first, not about saying less.
 *
 * It **never classifies**. If the tail carries no block from `provider-error.ts`, this module
 * returns `undefined` and the caller leaves the text exactly as it found it. A run that crashed, or
 * exited non-zero with nothing but stderr to go on, has no classified failure and must not be given
 * an invented one — reporting the observation and nothing more is the standing rule here.
 */
import { PROVIDER_FAILURE_MARKER } from "../lib/provider-error.ts";

/** Separates the promoted block from the untouched remainder, so nothing reads as truncated. */
export const FULL_OUTPUT_SEPARATOR =
  "--- the run's full output follows, unchanged and in its original order (startup notices included) ---";

export interface ReorderedFailure {
  /** The classified block(s), in the order they appeared. Never empty. */
  readonly classified: string;
  /** Everything else, verbatim and in original order. Empty when the tail was only the block. */
  readonly rest: string;
}

/**
 * Splits `text` into the classified provider-failure block(s) and everything else.
 *
 * A block is the marker line plus the indented body `formatProviderFailure` writes under it
 * (`  provider :`, `  message  :`, and so on). The body is taken as the run of following lines
 * that begin with whitespace, rather than by looking for a specific closing field: that makes the
 * one-line `summariseProviderFailure` form — which has no body at all — a valid block too, and
 * keeps a future field from silently falling outside it.
 *
 * `undefined` when there is no marker anywhere: no classification exists, so there is nothing to
 * promote and the caller must not touch the text.
 */
export function splitClassifiedFailure(text: string): ReorderedFailure | undefined {
  if (!text.includes(PROVIDER_FAILURE_MARKER)) return undefined;
  const lines = text.split("\n");
  const classified: string[] = [];
  const rest: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith(PROVIDER_FAILURE_MARKER)) {
      rest.push(line);
      index += 1;
      continue;
    }
    classified.push(line);
    index += 1;
    while (index < lines.length && /^\s+\S/.test(lines[index]!)) {
      classified.push(lines[index]!);
      index += 1;
    }
  }
  // The marker was present but never at the start of a line — quoted inside a longer sentence, say.
  // That is not a block we rendered, so it is not one we may promote.
  if (classified.length === 0) return undefined;
  return { classified: classified.join("\n"), rest: rest.join("\n").trim() };
}

/**
 * The reordered text: classified abort first, everything else below the separator.
 *
 * `undefined` means "leave it alone" — either there is no classified block, or the text was nothing
 * but the block and reordering it would only add a separator to a message that is already right.
 */
export function reorderFailureText(text: string): string | undefined {
  const split = splitClassifiedFailure(text);
  if (split === undefined) return undefined;
  if (split.rest.length === 0) return undefined;
  return `${split.classified}\n\n${FULL_OUTPUT_SEPARATOR}\n${split.rest}`;
}

/**
 * The headline alone, for a surface that has room for the cause but not for a whole stderr tail.
 *
 * Returns `undefined` when nothing was classified, so the caller keeps the text it already had.
 */
export function classifiedHeadline(text: string): string | undefined {
  return splitClassifiedFailure(text)?.classified;
}

/**
 * The minimum PI's `TextContent | ImageContent` union has to look like for the reordering below.
 * Structural on purpose: `failure-slot.ts` stays importable by a test that does not load the
 * runtime's type-only declarations, and a text part is the only shape it needs to understand.
 */
export interface ContentPartLike {
  readonly type: string;
  readonly text?: string;
}

/**
 * The `tool_result` rewrite: the same content array, with the first text part that carries a
 * classified block reordered to lead with it.
 *
 * Only the first such part moves. A dispatch result is one text part in practice, and rewriting
 * every part would reorder each independently, which is a different and worse claim about what
 * happened. Non-text parts — an image a tool returned — are passed through by identity.
 *
 * `undefined` means no part needed changing, so the caller returns `undefined` from the handler and
 * PI keeps the original result untouched.
 */
export function reorderResultContent<T extends ContentPartLike>(content: readonly T[]): T[] | undefined {
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i]!;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const reordered = reorderFailureText(part.text);
    if (reordered === undefined) continue;
    const out = [...content];
    out[i] = { ...part, text: reordered };
    return out;
  }
  return undefined;
}

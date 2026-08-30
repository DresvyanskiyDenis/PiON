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
 * its own exported marker and by nothing else — is promoted to the front; every other line goes
 * underneath, verbatim and in its original order.
 *
 * It also **bounds that remainder**, which reverses what this paragraph used to promise. The
 * sentence that stood here said nothing was dropped, summarised, truncated or made quieter, on the
 * reading that a dispatched child's full output must stay visible whatever it costs. That reading
 * is right about the classified block and wrong about the tail. `pi-subagents` makes the child's
 * ENTIRE captured output the run's error text — `closeError` is taken from the captured stdout and
 * then from stderr (`runs/foreground/execution.ts:1372-1379`) — and that text becomes the tool
 * result's `content`, which is the one field of a result the provider serialisers actually put on
 * the wire. A headless child announces on stderr, so a single dead subagent bought the session
 * every startup notice and every debug line the child emitted, and went on charging for all of it
 * on every later turn, because the result stays in the transcript. The old sentence is rewritten
 * here rather than deleted, so the claim and its correction sit in the same place.
 *
 * The bound is asymmetric, and the asymmetry is the design:
 *
 *   - the **classified block is never touched**. It is the part that says what went wrong, it is
 *     already bounded by construction — `formatProviderFailure` writes a fixed field set — and
 *     shortening a diagnosis to save tokens is exactly the silent substitution `REQ-PRV-32`
 *     forbids.
 *   - the **remainder is elided to `FailureOutputLimits`**, and the elision says how many lines it
 *     took and where the whole text can still be read.
 *   - **no pointer, no elision.** When `resolveFullOutputPointer` finds no file named anywhere in
 *     the result, the remainder is kept whole however small the budget is. A cut nobody can undo is
 *     suppression with a budget for an alibi; a cut with a path beside it is a reference.
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
 * How much of the unclassified remainder survives into the parent's context.
 *
 * Two bounds, because neither alone is enforceable. A line count does not bound bytes: a real
 * provider failure's `message` field runs to several hundred characters on one line, and a child
 * that dumps JSON emits one line of any size at all. A character count alone would cut mid-line and
 * hand the model half a sentence that reads like a whole one. Whichever bites first wins, and the
 * cut always lands on a line boundary.
 *
 * `0` on either field switches that bound off, which is how the pre-bound behaviour stays reachable
 * from `config/dispatch.json` and not only from a code change.
 */
export interface FailureOutputLimits {
  readonly maxLines: number;
  readonly maxChars: number;
}

/** The shipped bound, mirroring `failureOutputMaxLines`/`failureOutputMaxChars`. */
export const DEFAULT_FAILURE_OUTPUT_LIMITS: FailureOutputLimits = { maxLines: 20, maxChars: 2000 };

/** Keeps the remainder whole — what this module did unconditionally before the bound existed. */
export const UNBOUNDED_FAILURE_OUTPUT: FailureOutputLimits = { maxLines: 0, maxChars: 0 };

/**
 * Where the elided text still is, and **what that file actually holds**.
 *
 * The label is load-bearing, not decoration. The candidates below are different artifacts and only
 * some of them contain the text being elided; calling a child's transcript "the full output" would
 * send the reader to a file that does not hold the startup notices they went looking for. Naming
 * the artifact costs one word and is the whole difference between a reference and a false one.
 */
export interface FullOutputPointer {
  readonly label: string;
  readonly path: string;
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

/** Marks the one line that was itself longer than the entire character budget. */
export const LINE_CUT_SUFFIX = " …[line cut at the character budget]";

/** The separator used when the remainder was elided instead of kept whole. */
export function elidedSeparator(kept: number, total: number): string {
  return `--- the run's output, first ${kept} of ${total} line(s), startup notices included ---`;
}

/** The closing line of an elided remainder: what went, and where it can still be read. */
export function elidedTrailer(elided: number, pointer: FullOutputPointer): string {
  return `... (${elided} more line(s) elided — ${pointer.label} at ${pointer.path})`;
}

/**
 * The remainder, bounded. `undefined` when it already fits, so the caller keeps it verbatim.
 *
 * The cut lands on a line boundary in every case but one: a single line longer than the whole
 * character budget is kept, cut and marked as cut. Emitting nothing there would be the worst of
 * both — the budget spent on no text at all, and the likeliest place for the real cause gone
 * without a trace of having been there.
 */
export function elideFailureRest(
  rest: string,
  limits: FailureOutputLimits,
  pointer: FullOutputPointer,
): string | undefined {
  const lines = rest.split("\n");
  const lineBound = limits.maxLines > 0 ? limits.maxLines : Number.POSITIVE_INFINITY;
  const charBound = limits.maxChars > 0 ? limits.maxChars : Number.POSITIVE_INFINITY;
  if (lines.length <= lineBound && rest.length <= charBound) return undefined;

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= lineBound) break;
    // `+ 1` for the newline this line is joined with, so the budget counts what is actually emitted.
    if (used + line.length + 1 > charBound) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) {
    kept.push(lines[0]!.slice(0, Math.max(0, charBound - LINE_CUT_SUFFIX.length)) + LINE_CUT_SUFFIX);
  }
  const elided = lines.length - kept.length;
  // Everything fitted after all: the character bound was the binding one, and it bound nothing.
  if (elided <= 0) return undefined;
  return `${elidedSeparator(kept.length, lines.length)}\n${kept.join("\n")}\n${elidedTrailer(elided, pointer)}`;
}

/**
 * The reordered text: classified abort first, the remainder below — whole, or bounded and pointed
 * at the file that still holds all of it.
 *
 * `undefined` means "leave it alone" — either there is no classified block, or the text was nothing
 * but the block and reordering it would only add a separator to a message that is already right.
 *
 * With no `pointer` the remainder is kept whole whatever `limits` say. That is a decision, not a
 * fallback nobody finished; see the module header.
 */
export function reorderFailureText(
  text: string,
  limits: FailureOutputLimits = UNBOUNDED_FAILURE_OUTPUT,
  pointer?: FullOutputPointer,
): string | undefined {
  const split = splitClassifiedFailure(text);
  if (split === undefined) return undefined;
  if (split.rest.length === 0) return undefined;
  const elided = pointer === undefined ? undefined : elideFailureRest(split.rest, limits, pointer);
  if (elided !== undefined) return `${split.classified}\n\n${elided}`;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string, or nothing. A blank path is not a pointer and must never be printed as one. */
function path(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The file that still holds what an elision drops, chosen most-exact first.
 *
 * The order is by **what the file contains**, not by which field is easiest to reach:
 *
 *   1. `results[].artifactPaths.metadataPath` — the run's own metadata artifact, whose `error`
 *      field is this very text, byte for byte. It is the most exact answer there is.
 *   2. `<asyncDir>/output-0.log` — the async runner's captured stdout and stderr for the run's
 *      first step, which is where the startup notices came from. Named only when the result carries
 *      at most one child: with several, the failing step's index is not derivable from `details`,
 *      guessing `0` would name the wrong file with full confidence, and `async-fleet.ts`'s
 *      `outputLogFor` refuses the same guess for the same reason. The run directory is named
 *      instead.
 *   3. `transcriptPath`, then 4. `sessionFile` — the child's own conversation. These do **not**
 *      carry the stderr tail, which is why they are last and why they are labelled for what they
 *      are rather than as "the full output". They are still worth naming: a run that died has one,
 *      and it is where the reader goes next once the classified block has said what happened.
 *
 * `undefined` when the result named no file at all, which switches elision off entirely.
 *
 * Structural, like `ContentPartLike`: `details` is `unknown` at the `tool_result` boundary, and
 * this module does not load the runtime's type-only declarations to read four optional strings.
 */
export function resolveFullOutputPointer(details: unknown): FullOutputPointer | undefined {
  const source = record(details);
  if (source === undefined) return undefined;
  const results = Array.isArray(source.results) ? source.results : [];

  for (const entry of results) {
    const metadataPath = path(record(record(entry)?.artifactPaths)?.metadataPath);
    if (metadataPath !== undefined) return { label: "full failure text", path: metadataPath };
  }

  const asyncDir = path(source.asyncDir);
  if (asyncDir !== undefined) {
    return results.length > 1
      ? { label: "full output", path: asyncDir }
      : { label: "full output", path: `${asyncDir.replace(/\/+$/, "")}/output-0.log` };
  }

  for (const key of ["transcriptPath", "sessionFile"] as const) {
    for (const entry of results) {
      const found = path(record(entry)?.[key]);
      if (found !== undefined) return { label: "child transcript", path: found };
    }
  }
  return undefined;
}

/**
 * The `tool_result` rewrite: the same content array, with the first text part that carries a
 * classified block reordered to lead with it, and its remainder bounded.
 *
 * Only the first such part moves. A dispatch result is one text part in practice, and rewriting
 * every part would reorder each independently, which is a different and worse claim about what
 * happened. Non-text parts — an image a tool returned — are passed through by identity.
 *
 * `undefined` means no part needed changing, so the caller returns `undefined` from the handler and
 * PI keeps the original result untouched.
 */
export function reorderResultContent<T extends ContentPartLike>(
  content: readonly T[],
  limits: FailureOutputLimits = UNBOUNDED_FAILURE_OUTPUT,
  pointer?: FullOutputPointer,
): T[] | undefined {
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i]!;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const reordered = reorderFailureText(part.text, limits, pointer);
    if (reordered === undefined) continue;
    const out = [...content];
    out[i] = { ...part, text: reordered };
    return out;
  }
  return undefined;
}

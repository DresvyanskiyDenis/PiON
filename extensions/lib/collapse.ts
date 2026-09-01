/**
 * Collapse a finished-item majority to a count:
 * ```
 * ▾ Todos  3 done ▸
 *   ○ Derive scoring ranges from authoritative annotations
 * ```
 * This is the pattern for a completed-item list this repo prints for itself —
 * `extensions/dispatch/async-fleet.ts`'s `renderAsyncFleet()` (the `/agents` list) is the one
 * place in this repo that printed every finished item in full with no cap, and now uses this.
 *
 * Pure and generic on purpose — `T` is never inspected beyond `isDone`/`render`, so this is the
 * one function to reuse the next time some other list in this repo grows an unbounded "done" tail.
 */
import { GLYPH } from "./glyphs.ts";

/**
 * `label` names what is being counted ("Todos", "async runs tracked by this session (4)" — callers
 * that already print a count of their own pass it in `label` rather than duplicating it here).
 *
 * Returns one header line plus one line per still-open item, in `items`' own order. All done: the
 * header alone, with no trailing expand marker — there is nothing left to expand into, so `▸`
 * would promise detail this call does not have.
 */
export function collapseCompleted<T>(
  items: readonly T[],
  isDone: (item: T) => boolean,
  render: (item: T) => string,
  label: string,
): readonly string[] {
  const doneCount = items.filter(isDone).length;
  const open = items.filter((item) => !isDone(item));
  const suffix = doneCount > 0 ? `  ${doneCount} done ${GLYPH.expand}` : "";
  const header = `${GLYPH.collapse} ${label}${suffix}`;
  return [header, ...open.map((item) => `  ${render(item)}`)];
}

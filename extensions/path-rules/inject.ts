/**
 * The durable net: marker-delimited injection into `before_agent_start`'s `systemPrompt` string.
 *
 * Copied from `extensions/session-context.ts`'s `injectOnce`/`stripBlock` idiom, not imported —
 * same reasoning as that module's own module-level-state caveat: `once.ts`'s note that PI loads
 * every discovered extension through its own jiti instance applies here too, and the strip/inject
 * pair is small enough that copying it is more honest than adding a cross-module dependency for
 * four lines. Unlike `session-context`'s block, this one carries no byte-budget cap: the content
 * is operator-authored and bounded by the operator, not runtime-collected free text, so there is
 * no unbounded-growth risk to budget against.
 *
 * Recomputed live every turn from `durable` (the current module-level rule-activation state), not
 * cached across sessions — this is what makes it survive compaction, `/reload`, and fork: whatever
 * ran `session_start` last populated `durable`, and this function only ever reads it fresh.
 */
export const MARK_OPEN = "<!-- pi-config:path-rules v1 -->";
export const MARK_CLOSE = "<!-- /pi-config:path-rules v1 -->";

/** Removes any previously injected block, then appends exactly one. Idempotent by construction. */
export function injectOnce(systemPrompt: string, block: string): string {
  const stripped = stripBlock(systemPrompt);
  return `${stripped.trimEnd()}\n\n${MARK_OPEN}\n${block}\n${MARK_CLOSE}\n`;
}

/** Removes every previously injected block, not just the first — a stacked prompt still heals. */
export function stripBlock(s: string): string {
  let out = s;
  for (;;) {
    const start = out.indexOf(MARK_OPEN);
    if (start === -1) return out;
    const end = out.indexOf(MARK_CLOSE, start);
    out = end === -1 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + MARK_CLOSE.length);
  }
}

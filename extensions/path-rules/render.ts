/**
 * Renders the injectable text for a set of activated rule ids.
 *
 * Pure concatenation, in `rules` (filename) order — no precedence engine, per the format's own
 * spec: a rule that matched is included in full, and nothing here decides one rule "wins" over
 * another the way a cascading config format might.
 */
import type { PathRule } from "./config.ts";

export function renderBlock(rules: readonly PathRule[], ids: ReadonlySet<string>): string {
  return rules
    .filter((r) => ids.has(r.id))
    .map((r) => `## Path rule: ${r.id}\n\n${r.body}`)
    .join("\n\n");
}

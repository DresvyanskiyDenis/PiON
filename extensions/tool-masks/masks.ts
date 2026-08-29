/**
 * The mask table: which tool names each run-time mask leaves active.
 *
 * ALLOW-LIST, NOT DENY-LIST. `/review` is specified as "drop `write`, `edit`, and mutating
 * `bash`", but a deny-list is only as complete as the tool registry it was written against, and
 * that registry is open: `pi.registerTool` in this tree, an MCP server's proxy tool
 * (`extensions/lib/mcp-approvals.ts` gates the approval, not the name), a package adopted next
 * month. A name nobody classified would stay active under a deny-list, which is the one failure
 * mode a mask exists to prevent. Every mask below therefore names what survives, and anything
 * unrecognised is masked out.
 *
 * WHY `bash` IS NOT ON EITHER LIST. `setActiveTools` works at the granularity of a whole tool;
 * there is no seam to keep the read half of `bash` and drop the write half, and no read-only
 * `bash` variant exists in this tree to substitute (`extensions/bash.ts` sets timeouts, it does
 * not split the tool). "Mutating bash" is therefore expressed the only way the primitive allows:
 * under a mask, `bash` is gone. That is stricter than the wording and matches its stated intent,
 * that the model physically cannot change the tree. `guard`'s `FS-*`/`SEC-*` gates remain the
 * audit layer for the unmasked session.
 *
 * A mask is applied by intersecting this list with the tools that were ALREADY active, never by
 * activating from it: a mask may only ever narrow. A tool nobody had is not granted by asking for
 * a mask that mentions it.
 */

/** Every mask name, in increasing permissiveness. `strictness()` below depends on this order. */
export const MASK_NAMES = ["review", "explore"] as const;

export type MaskName = (typeof MASK_NAMES)[number];

/**
 * Tools that can neither change the tree nor reach the network.
 *
 * `read`, `grep`, `find` and `ls` are PI's own read side. `expand_result` (`big-results`) re-reads
 * a result this session already produced, and `ask_user` (`ask-user`) writes to the operator, not
 * to the disk. Both stay: a reviewer that cannot re-open a truncated result or ask a question is
 * not more contained, only less useful.
 */
export const READING_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "expand_result",
  "ask_user",
];

/** `web`'s three tools (`extensions/web.ts`): the adopted package's pair plus this tree's own. */
export const WEB_TOOLS: readonly string[] = ["web_search", "web_fetch", "web_answer"];

export interface MaskDefinition {
  /** Tool names that survive this mask. Intersected with the active set, never added to it. */
  readonly allow: readonly string[];
  /** One line, used as the command description and in the notice on applying the mask. */
  readonly summary: string;
}

export const MASKS: Readonly<Record<MaskName, MaskDefinition>> = {
  review: { allow: READING_TOOLS, summary: "read, grep and reason only" },
  explore: { allow: [...READING_TOOLS, ...WEB_TOOLS], summary: "read-only plus web" },
};

export function isMaskName(value: unknown): value is MaskName {
  return typeof value === "string" && (MASK_NAMES as readonly string[]).includes(value);
}

/**
 * Lower is stricter. Used to decide whether an automatic (path-rule) mask may replace one already
 * in force: it may tighten, never loosen.
 */
export function strictness(mask: MaskName): number {
  return MASK_NAMES.indexOf(mask);
}

/**
 * The tools left active by `mask`, preserving `baseline`'s order.
 *
 * `baseline` is what was active before any mask was applied, so re-masking is computed from the
 * unmasked set every time: switching `/review` to `/explore` widens back to exactly what
 * `/explore` allows rather than to the intersection of the two.
 */
export function maskTools(baseline: readonly string[], mask: MaskName): string[] {
  const allowed = new Set(MASKS[mask].allow);
  return baseline.filter((name) => allowed.has(name));
}

/**
 * EXT-11 — the keep/drop contract (`REQ-CTX-32`).
 *
 * The harness's compaction rule: **keep** files + *intent*, TODO state, open errors/traces,
 * decisions + *why*, open swarm/sub-agent state; **drop** tool traces, intermediate searches,
 * re-readable file contents, dead ends.
 *
 * **Augment, never replace.** PI's summariser appends this text to its own structured template:
 * `generateSummaryWithUsage` does `basePrompt = \`${basePrompt}\n\nAdditional focus: ${custom}\``
 * (`dist/core/compaction/compaction.js`). There is no code path in PI 0.84.0 that lets a
 * `customInstructions` string replace `SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT` —
 * `replaceInstructions` exists only on the *branch-summary* surface (`SessionBeforeTreeResult`,
 * `navigateTree`), never on compaction. So the "do not replace the structured template" rule holds
 * by construction here, not by convention.
 *
 * The text is written to read as a continuation of "Additional focus:".
 */

/** Kept short on purpose: it is prepended to every summarisation call and it costs tokens. */
export const KEEP_DROP_INSTRUCTIONS = [
  "apply this keep/drop contract on top of the sections above.",
  "",
  "KEEP, in full and by name:",
  "- every file that was read or modified, together with *why* it was touched — the intent, not just the path",
  "- the task/TODO state: what is done, what is in progress, what is blocked, and by what",
  "- every open error, failing test or stack trace that has not been resolved yet — name the test, the",
  "  command and the error text, so it can be re-run without re-deriving it",
  "- decisions and their rationale, including options that were rejected and the reason they were rejected",
  "- open sub-agent / delegated work: what was dispatched, to whom, and what is still outstanding",
  "- anything the user stated as a constraint, preference or correction",
  "",
  "DROP:",
  "- raw tool traces and command stdout, except the few lines that carry an unresolved error",
  "- intermediate searches, greps and directory listings whose result is already reflected above",
  "- file contents that can simply be read again — cite the path instead of quoting the body",
  "- dead ends that were abandoned, beyond one line recording that they were tried and why they failed",
].join("\n");

/**
 * Merges the user's own `/compact <instructions>` with the harness contract.
 *
 * The user's text comes first and is never dropped: `/compact focus on the parser` must still
 * focus on the parser. Ours is additive, and is skipped when it is already present so a
 * re-entrant call cannot stack it.
 */
export function mergeInstructions(
  userInstructions: string | undefined,
  contract: string = KEEP_DROP_INSTRUCTIONS,
): string {
  const user = userInstructions?.trim() ?? "";
  if (user.length === 0) return contract;
  if (user.includes(contract)) return user;
  return `${user}\n\n${contract}`;
}

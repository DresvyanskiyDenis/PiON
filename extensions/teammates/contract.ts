/**
 * The delivery obligation, as text — owned by the runtime, never by an agent file.
 *
 * This is recorded evidence, not a hypothesis: on the previous harness,
 * session `488f77ad` (2026-08-05), **five of five teammates wrote complete reports and none of them
 * delivered one**. The lead received 22 empty idle notifications and every report stayed in a
 * transcript nobody read. The cause is structural: a sub-agent's final message *is* its return
 * value, a teammate's final message goes into its own transcript and nowhere else, and the teammate
 * cannot tell which of the two modes it is running in.
 *
 * Therefore: **the obligation is appended by the runtime on every spawn**. Not by
 * the agent definition — those in `agents/` are written for the sub-agent contract ("return a
 * report") and are loaded verbatim for both modes. Not by the caller — a caller that forgets is
 * exactly the failure being prevented. `runtime.ts` is the only place a teammate session is
 * created, and it appends {@link DELIVERY_CONTRACT} unconditionally.
 *
 * The text is duplicated on purpose across two channels:
 *   - the child's **system prompt** (via `appendSystemPrompt`), which survives compaction; and
 *   - **every message** the lead sends (via {@link withObligation}), because recency wins in a long
 *     session and because the reminder path needs the same words the first instruction used.
 */

/** The only channel through which a teammate's work reaches the lead. */
export const REPLY_TOOL = "reply_to_lead";

/** Rule 2 of §4.5a: bounded, then release. Never a stop-hook loop. */
export const MAX_REMINDERS = 2;

/** A live teammate is a whole extra session. Four is already an expensive room. */
export const MAX_TEAMMATES = 4;

/**
 * Appended to the child's system prompt verbatim, on every spawn.
 *
 * Written in the second person and in terms of a concrete tool call, because "deliver your report"
 * is advice and `reply_to_lead(report=…)` is an instruction.
 */
export const DELIVERY_CONTRACT = [
  "## Delivery contract (binding, appended by the runtime)",
  "",
  "You are running as a **named teammate**, not as a sub-agent. This changes where your output goes:",
  "",
  `- Your final assistant message is delivered **nowhere**. It stays in your own transcript and no one reads it.`,
  `- The **only** way your work reaches the lead is \`${REPLY_TOOL}(report="…")\`. Call it before you stop.`,
  `- If you are blocked, call \`${REPLY_TOOL}(report="<what blocked you>", status="blocked")\`. Being blocked is a`,
  "  result; stopping silently is not.",
  `- Put the **whole** report in the \`report\` argument. Do not summarise it there and leave the detail in your`,
  "  messages — the messages are discarded.",
  "",
  `If you go idle without calling \`${REPLY_TOOL}\` you will be reminded at most ${MAX_REMINDERS} times and then released,`,
  "and your work will be recorded as undelivered.",
].join("\n");

/** One-line restatement carried on every lead -> teammate message. */
export const OBLIGATION_LINE =
  `[delivery contract] finish by calling ${REPLY_TOOL}(report="…") — your final message is discarded. ` +
  `If blocked, call it with status="blocked" and the reason.`;

/** Wraps a lead message so the obligation travels with the work, not only with the spawn. */
export function withObligation(message: string): string {
  return `${message}\n\n---\n${OBLIGATION_LINE}`;
}

/**
 * The reminder text. Names the failure explicitly — a teammate that stopped believes it is finished,
 * so the reminder has to contradict that belief rather than repeat the original request.
 */
export function reminderText(attempt: number, max: number = MAX_REMINDERS): string {
  return [
    `You went idle without calling ${REPLY_TOOL}, so nothing you produced has reached the lead.`,
    `This is reminder ${attempt} of ${max}. After the last one you are released and your work is recorded as undelivered.`,
    `Call ${REPLY_TOOL} now with your full report, or with status="blocked" and the reason you cannot finish.`,
  ].join("\n");
}

/**
 * The persona block. The agent file's body is *appended*, not substituted for PI's base system
 * prompt: the body describes a role, PI's base prompt describes the tools and the environment, and
 * a teammate that loses the second one is a teammate that cannot use `read` correctly.
 */
export function personaBlock(agentName: string, body: string): string {
  const trimmed = body.trim();
  const head = `## Agent role: ${agentName}`;
  return trimmed ? `${head}\n\n${trimmed}` : head;
}

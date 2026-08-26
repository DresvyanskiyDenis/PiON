/**
 * The fast path: same-turn injection via the `context` event.
 *
 * `context` fires before each LLM call within a turn — including mid-turn, after a tool result
 * lands (confirmed against `dist/core/sdk.js` `emitContext`/`transformContext`) — which is what
 * closes the "read a file, then edit it, same turn" gap `before_agent_start` cannot: that event
 * fires once, before the turn loop starts, so a rule matched by a file the model touches partway
 * through the turn is invisible to it until the NEXT turn's `before_agent_start`. `context` sees
 * it before the very next LLM call instead.
 *
 * `ContextEvent.messages` is `AgentMessage[]` — the actual wire message list for that one provider
 * call, not the persisted session transcript (`emitContext` works on a `structuredClone` and the
 * result is only ever handed to `transformContext`'s caller; `agent.state.messages`, the real
 * history, is never touched). So injection here is APPEND AT THE TAIL ONLY, never a mid-array
 * insert: prompt caching is prefix-based, and a tail append after the real conversation costs
 * nothing against that cache while a mid-array insert would invalidate every cached prefix behind
 * it. Do not "clean this up" into inserting the note nearer whatever it is about — the tail
 * placement is load-bearing, not an oversight.
 *
 * The messages array PI hands to each `context` firing is not itself accumulated with a previous
 * firing's injection (see above — nothing here is persisted), so this is naturally idempotent
 * across firings within one turn. `injectContext` also strips any message already carrying the
 * marker before appending, as a second, cheap line of defence against a harness version that
 * changes that assumption.
 *
 * There is no `AgentMessage` type exported from this package's public surface (only the event
 * types that reference it are) — `ContextEvent["messages"][number]` reaches the same type by
 * indexed access instead of importing an unexported name.
 */
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];

export const MARK_OPEN = "<!-- pi-config:path-rules:context v1 -->";
export const MARK_CLOSE = "<!-- /pi-config:path-rules:context v1 -->";

/**
 * Strips any message this module previously injected, then appends exactly one fresh one carrying
 * `block`. Pure — takes and returns a new array, never mutates `messages` in place, matching
 * `emitContext`'s own "clone, then transform" contract.
 */
export function injectContext(messages: readonly Message[], block: string): Message[] {
  const stripped = messages.filter((m) => !isInjectedNote(m));
  const note = {
    role: "user",
    content: `${MARK_OPEN}\n${block}\n${MARK_CLOSE}`,
    timestamp: Date.now(),
  } as Message;
  return [...stripped, note];
}

function isInjectedNote(m: Message): boolean {
  if (m.role !== "user") return false;
  return messageText(m.content).includes(MARK_OPEN);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("\n");
}

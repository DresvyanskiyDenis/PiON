/**
 * Assembling a spawn request — the single place the delivery obligation is welded onto a child.
 *
 * The rule is that the obligation is *appended by the runtime*. This
 * function is that runtime step, kept separate from `index.ts` so it can be asserted directly: the
 * claim "an agent file cannot produce a teammate that is unable to deliver" is only worth anything
 * if there is a test that fails when it stops being true.
 *
 * Two things happen here that nothing else in the tree does:
 *
 *   - `DELIVERY_CONTRACT` goes **last** in the system-prompt append list, after the agent's own
 *     persona. Agent files in `agents/` are written for the sub-agent contract ("return a report")
 *     and many of them say so explicitly; when the two disagree the contract must be the more recent
 *     instruction.
 *   - `reply_to_lead` is added to the agent's tool allowlist. An agent file that writes
 *     `tools: [read, grep]` is describing a sub-agent, and honouring it verbatim would produce a
 *     teammate that is *structurally incapable* of delivering — the 488f77ad failure reintroduced
 *     through a field nobody would think to check.
 */
import { DELIVERY_CONTRACT, REPLY_TOOL, personaBlock } from "./contract.ts";
import type { SpawnRequest } from "./runtime.ts";

export interface AgentShape {
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools?: readonly string[];
  readonly target?: { readonly model: string; readonly provider: string };
}

export function buildSpawnRequest(
  name: string,
  def: AgentShape,
  cwd: string,
): Omit<SpawnRequest, "customTools"> {
  const tools = widenTools(def.tools);
  return {
    name,
    agent: def.name,
    cwd,
    systemPromptAppend: [personaBlock(def.name, def.systemPrompt), DELIVERY_CONTRACT],
    ...(def.target !== undefined ? { model: splitModel(def.target.model, def.target.provider) } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

/** `undefined` means "PI's default set", which already includes custom tools. */
export function widenTools(tools: readonly string[] | undefined): string[] | undefined {
  if (tools === undefined) return undefined;
  return tools.includes(REPLY_TOOL) ? [...tools] : [...tools, REPLY_TOOL];
}

/** `ModelTarget.model` is always `provider/id`; the SDK wants the two halves. */
export function splitModel(model: string, provider: string): { provider: string; id: string } {
  const prefix = `${provider}/`;
  return { provider, id: model.startsWith(prefix) ? model.slice(prefix.length) : model };
}

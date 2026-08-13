/**
 * `REQ-CTX-47` — the sub-agent routing veto, SHOULD-level and overridable.
 *
 * The dispatch runtime does not exist in wave 1. This item splits the work:
 * `EXT-01` owns the interface (`lib/dispatch-veto.ts`), **`EXT-03` ships the call site — this
 * file** — and `EXT-05` fills the implementation by registering vetoes against `pi-subagents`'
 * `registerSubagentCapabilityCeiling()`. Until then the gate registers, finds no registered
 * veto, matches nothing, and is exercised only by its unit test.
 *
 * The counters are why this is a gate and not a sentence in `AGENTS.md`: 177 `general-purpose`
 * dispatches against 136 across all fourteen specialists combined, with the instruction already
 * written down. An instruction 100k tokens from the decision point loses to
 * a tool description that sounds right. A gate does not lose.
 */
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../../lib/escape-hatch.ts";
import {
  evaluateDispatch,
  type DispatchRequest,
  type EgressClass,
} from "../../lib/dispatch-veto.ts";
import { tryOverride } from "../override.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

/** Argument names a dispatch tool might use for the agent definition. */
const AGENT_KEYS = ["agentType", "subagent_type", "subagentType", "agent", "type", "name"];
/** Argument names a dispatch tool might use for the child's prompt. */
const PROMPT_KEYS = ["prompt", "task", "instructions", "description", "input", "message"];

export function agentRoutingGate(policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "RTE",
    async evaluate(event) {
      if (!policy.dispatchTools.includes(event.toolName)) return { block: false };

      const request = buildRequest(event);
      if (request === null) return { block: false };

      const verdict = await evaluateDispatch(request, services.log);
      if (!verdict.veto) return { block: false };

      const denial = verdict.denial;
      if (
        denial.overridable &&
        tryOverride({
          event,
          gateId: denial.gateId,
          keys: PROMPT_KEYS,
          services,
          detail: { agentType: request.agentType },
        })
      ) {
        return { block: false };
      }
      return denyWithEscapeHatch(denial);
    },
  };
}

function buildRequest(event: ToolCallEvent): DispatchRequest | null {
  const input = event.input as Record<string, unknown>;
  const agentType = firstString(input, AGENT_KEYS);
  const prompt = firstString(input, PROMPT_KEYS);
  if (agentType === undefined) return null;

  return {
    agentType,
    prompt: prompt ?? "",
    parentTier: optionalString(process.env.PI_ROUTING_TIER),
    parentEgress: asEgress(process.env.PI_ROUTING_EGRESS),
    childTier: firstString(input, ["tier", "childTier"]),
    childProvider: firstString(input, ["provider", "childProvider"]),
    childEgress: asEgress(firstString(input, ["egress", "childEgress"])),
    toolCallId: event.toolCallId,
  };
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function optionalString(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function asEgress(value: string | undefined): EgressClass | undefined {
  return value === "public" || value === "internal" || value === "confidential" ? value : undefined;
}

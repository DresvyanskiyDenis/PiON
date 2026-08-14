/**
 * `RTE-*` — the sub-agent routing veto's call site. **Audit only since 2026-08-14.**
 *
 * This was never a safety rule: it moves the default from `general-purpose` to a matching
 * specialist. Removed outright by owner decision, 2026-08-14 — the allow-list model is gone,
 * only catastrophic commands are blocked — takes a routing preference off the block list by
 * definition. A mis-routed dispatch costs some tokens; it destroys nothing.
 *
 * The gate is kept as an observer rather than deleted, and the reason is measurement, not
 * caution. The whole case for routing to a specialist is a count — 177 `general-purpose`
 * dispatches against 136 across all specialists combined, on one measured project — and
 * `guard.observed` is now the only place that count keeps being taken. Deleting the call site
 * would leave the next argument about routing with no data at all.
 *
 * **Consequence, stated rather than discovered:** this was the only consumer that turned a
 * registered dispatch veto into a block. A veto registered against `lib/dispatch-veto.ts` still
 * evaluates here — but its verdict is now recorded and permitted. Any dispatch veto registered
 * from anywhere is advisory until something else chooses to enforce it.
 */
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GuardRule } from "../../lib/guarded-handler.ts";
import {
  evaluateDispatch,
  type DispatchRequest,
  type EgressClass,
} from "../../lib/dispatch-veto.ts";
import { observe } from "../observe.ts";
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

      return observe({
        event,
        gateId: verdict.denial.gateId,
        what: verdict.denial.what,
        services,
        detail: { agentType: request.agentType },
      });
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

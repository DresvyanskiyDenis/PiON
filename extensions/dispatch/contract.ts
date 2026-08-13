/**
 * The return contract — the distinction this harness paid for once already and will not pay for
 * twice.
 *
 * In the previous (Claude Code) harness, spawning an agent **with a name** silently changed the
 * return contract. A plain sub-agent's final message *is* its return value: it lands in the
 * caller's tool result and the process exits. A named teammate is a separate full session; its
 * final message **is delivered nowhere**, the lead gets an empty idle notification, and the work
 * stays in a transcript nobody reads. Observed at full scale: five teammates finished complete
 * reports, none delivered, the lead received 22 empty notifications.
 *
 * The runtime for teammates belongs to `EXT-25`. What belongs *here* is that the distinction is
 * **declared and validated**, not inferred from whether some optional argument happened to be
 * passed. An agent file states its contract; a file whose contract is incoherent is a load-time
 * problem, not a surprise at minute 40.
 *
 * The rules, all of them load-time assertions:
 *   - `mode: subagent` (the default) — the child's final message is the return value. A `delivery:`
 *     key is a contradiction and is rejected.
 *   - `mode: teammate` — nothing is returned. `delivery:` is **mandatory** and names the channel
 *     the agent must use before it goes idle. `returns: object` is rejected, because a structured
 *     return value that nobody receives is a lie in the schema.
 */
export type ReturnContractMode = "subagent" | "teammate";
export type ReturnShape = "text" | "object";

export interface ReturnContract {
  readonly mode: ReturnContractMode;
  /** Meaningful only for `mode: "subagent"`; always `"text"` for a teammate. */
  readonly returns: ReturnShape;
  /** Present iff `mode === "teammate"`. The channel the agent must deliver through. */
  readonly delivery?: string;
}

export const DEFAULT_RETURN_CONTRACT: ReturnContract = { mode: "subagent", returns: "text" };

export interface ContractInput {
  readonly mode?: unknown;
  readonly returns?: unknown;
  readonly delivery?: unknown;
}

export interface ContractResult {
  readonly contract: ReturnContract;
  readonly problems: readonly string[];
}

export function parseReturnContract(input: ContractInput, agentName: string): ContractResult {
  const problems: string[] = [];

  let mode: ReturnContractMode = "subagent";
  if (input.mode !== undefined) {
    if (input.mode === "subagent" || input.mode === "teammate") {
      mode = input.mode;
    } else {
      problems.push(`agent "${agentName}": mode "${String(input.mode)}" is not one of subagent|teammate`);
    }
  }

  let returns: ReturnShape = "text";
  if (input.returns !== undefined) {
    if (input.returns === "text" || input.returns === "object") {
      returns = input.returns;
    } else {
      problems.push(`agent "${agentName}": returns "${String(input.returns)}" is not one of text|object`);
    }
  }

  const delivery = typeof input.delivery === "string" && input.delivery.trim() ? input.delivery.trim() : undefined;
  if (input.delivery !== undefined && delivery === undefined) {
    problems.push(`agent "${agentName}": delivery must be a non-empty string naming a channel`);
  }

  if (mode === "teammate") {
    if (delivery === undefined) {
      problems.push(
        `agent "${agentName}": mode: teammate requires delivery: <channel>. ` +
          `A teammate's final message is delivered NOWHERE; without an explicit channel its work is lost.`,
      );
    }
    if (returns === "object") {
      problems.push(
        `agent "${agentName}": mode: teammate cannot declare returns: object. ` +
          `Nothing is returned to the caller, so a structured return schema cannot be satisfied.`,
      );
    }
    return {
      contract: { mode, returns: "text", ...(delivery !== undefined ? { delivery } : {}) },
      problems,
    };
  }

  if (delivery !== undefined) {
    problems.push(
      `agent "${agentName}": delivery: is only meaningful with mode: teammate. ` +
        `A subagent's final message IS its return value; declaring a delivery channel as well is a contradiction.`,
    );
  }
  return { contract: { mode, returns }, problems };
}

/** One line for `/agents` and for the load-problem report. */
export function describeReturnContract(c: ReturnContract): string {
  return c.mode === "teammate"
    ? `teammate (returns nothing; delivers via ${c.delivery ?? "<undeclared>"})`
    : `subagent (final message is the return value, as ${c.returns})`;
}

/**
 * The dispatch-time half. A teammate must never be dispatched through a call shape that promises
 * the caller a result — the caller would wait for something that structurally cannot arrive.
 */
export function assertDispatchShape(
  c: ReturnContract,
  call: { readonly structuredOutput: boolean; readonly awaitsResult: boolean },
  agentName: string,
): string | undefined {
  if (c.mode !== "teammate") return undefined;
  if (call.structuredOutput) {
    return (
      `agent "${agentName}" is a teammate (mode: teammate): its final message is delivered nowhere, ` +
      `so it cannot satisfy a structured output schema. Dispatch it without outputSchema, or use a subagent.`
    );
  }
  if (call.awaitsResult) {
    return (
      `agent "${agentName}" is a teammate (mode: teammate): its result is delivered through ` +
      `"${c.delivery ?? "<undeclared>"}", not returned to this tool call. Dispatch it asynchronously ` +
      `and collect the result from that channel.`
    );
  }
  return undefined;
}

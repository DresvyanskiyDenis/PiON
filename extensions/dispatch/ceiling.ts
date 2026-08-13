/**
 * The routing veto, wired the supported way.
 *
 * `EXT-01` defines the predicate (`lib/dispatch-veto.ts`), `EXT-03` ships the call site
 * (`guard/gates/agent-routing.ts`), and this module fills the implementation. There is no fork:
 * conflict X1 is void.
 *
 * ## What `registerSubagentCapabilityCeiling()` can and cannot express
 *
 * Read at `pi-subagents/src/runs/shared/capability-ceiling.ts`, the ceiling is a **static
 * allowlist** — `{ allowedTools?, allowedAgents?, denyExtensions? }` — registered per session id,
 * intersected across registrants, inherited by children through
 * `PI_SUBAGENT_CAPABILITY_CEILING_V1`, and evaluated in preflight
 * (`resolveSubagentLaunchContract` → `restricted_agent`). It cannot see a prompt. So the veto
 * splits along exactly that line, and both halves ship:
 *
 *   - **Static, and therefore in the ceiling**: which agents this session may dispatch at all
 *     (egress containment plus load-time validity), and whether children may dispatch at all
 *     (the depth ceiling, expressed as tools removed rather than as a counter).
 *   - **Per-request, and therefore in `EXT-01`'s veto registry**: `REQ-CTX-47`'s specialist match,
 *     which is a judgement about *this prompt*, and the call-time egress check for a `model`
 *     argument the agent file never declared.
 *
 * The ceiling is also inherited, which is why the depth half is computed from *our* depth: at
 * depth `d` we register a ceiling for our children, and a child at `d+1` registers its own. One
 * registration cannot say "depth 1 may, depth 2 may not"; two registrations, one per level, can.
 *
 * ## Why `REQ-CTX-47` is a gate and not a sentence in `AGENTS.md`
 *
 * 177 `general-purpose` dispatches against 136 across all fourteen specialists combined. The escape hatch is `REQ-CTX-06`'s
 * written justification, which `EXT-03` already implements around this predicate.
 */
import type {
  SubagentCapabilityCeiling,
  SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import {
  registerDispatchVeto,
  type DispatchRequest,
  type DispatchVerdict,
  type EgressClass,
} from "../lib/dispatch-veto.ts";
import type { DispatchConfig, RoutingConfig } from "./config.ts";
import { DispatchError, assertEgressContainment, resolveModelSpec } from "./tiers.ts";
import { dispatchableNames, type AgentRegistry } from "./registry.ts";

export const CEILING_SOURCE = "pi-config/EXT-05";
export const VETO_SPECIALIST = "DV-SPECIALIST";
export const VETO_EGRESS = "DV-EGRESS";

export interface CeilingInput {
  readonly sessionId: string;
  readonly registry: AgentRegistry;
  readonly config: DispatchConfig;
  /** Our own depth. Children run at `depth + 1`. */
  readonly depth: number;
  /** Every tool name PI currently knows, from `pi.getAllTools()`. */
  readonly allToolNames: readonly string[];
}

export interface CeilingPlan {
  readonly ceiling: SubagentCapabilityCeiling;
  /** Human-readable, for `/agents` and the audit entry. */
  readonly notes: readonly string[];
}

/**
 * Builds the ceiling. Separated from registration so it can be asserted without a live session.
 *
 * `denyExtensions` is deliberately never set: it would strip *our* extensions from children, and
 * a child without this module is a child with no depth assertion and no egress containment.
 */
export function planCeiling(input: CeilingInput): CeilingPlan {
  const notes: string[] = [];
  const allowedAgents = dispatchableNames(input.registry);
  notes.push(
    `allowedAgents: ${allowedAgents.length} of ${input.registry.agents.length} ` +
      `(${input.registry.agents.filter((a) => a.status === "restricted").length} restricted by egress, ` +
      `${input.registry.agents.filter((a) => a.status === "invalid").length} invalid)`,
  );

  const childDepth = input.depth + 1;
  let allowedTools: string[] | undefined;
  if (childDepth >= input.config.maxDepth) {
    const denied = new Set(input.config.dispatchTools);
    allowedTools = input.allToolNames.filter((name) => !denied.has(name));
    notes.push(
      `children would run at depth ${childDepth} (max ${input.config.maxDepth}), so the dispatch ` +
        `tools ${[...denied].join(", ")} are removed from their ceiling — depth ${childDepth + 1} is ` +
        `structurally impossible, not merely counted`,
    );
    if (allowedTools.length === 0) {
      // An empty allowlist is indistinguishable from "no tools at all", which would silently
      // cripple every child. Say so and fall back to the counter alone.
      notes.push(
        `pi.getAllTools() returned nothing usable, so no allowedTools ceiling is registered; ` +
          `depth is enforced by the counter only`,
      );
      allowedTools = undefined;
    }
  } else {
    notes.push(`children run at depth ${childDepth} (max ${input.config.maxDepth}); dispatch stays available to them`);
  }

  const ceiling = {
    allowedAgents,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  } as SubagentCapabilityCeiling;
  return { ceiling, notes };
}

export interface CeilingInstallation {
  readonly handle?: SubagentCapabilityCeilingHandle;
  readonly notes: readonly string[];
  /** Set when the ceiling could NOT be registered. Never swallowed. */
  readonly failure?: string;
}

/**
 * Registers the ceiling.
 *
 * The import is dynamic on purpose. `pi-subagents` ships TypeScript sources and PI loads them
 * through jiti; a static import would work at runtime but breaks `node --test`, which refuses to
 * type-strip files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — the same
 * wall `EXT-12a` and `EXT-22` hit). Deferring it keeps `planCeiling()` — the half worth asserting
 * — testable without a transpiler, and turns an unavailable package into one announced
 * degradation instead of a module that will not load at all.
 */
export async function installCeiling(input: CeilingInput): Promise<CeilingInstallation> {
  const plan = planCeiling(input);
  let register: typeof import("pi-subagents/capability-ceiling").registerSubagentCapabilityCeiling;
  try {
    ({ registerSubagentCapabilityCeiling: register } = await import("pi-subagents/capability-ceiling"));
  } catch (err) {
    return {
      notes: plan.notes,
      failure:
        `pi-subagents/capability-ceiling could not be loaded (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}). ` +
        `The subagent capability ceiling is NOT in force: children are not restricted to the ` +
        `${plan.ceiling.allowedAgents?.length ?? 0} egress-permitted agents. Depth and egress are still ` +
        `enforced by this extension's own tool_call rules and by the dispatch vetoes.`,
    };
  }
  try {
    const handle = register({ sessionId: input.sessionId, source: CEILING_SOURCE, ceiling: plan.ceiling });
    return { handle, notes: plan.notes };
  } catch (err) {
    return {
      notes: plan.notes,
      failure:
        `registerSubagentCapabilityCeiling rejected our ceiling ` +
        `(${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}). ` +
        `The ceiling is NOT in force; depth and egress remain enforced by this extension's own rules.`,
    };
  }
}

// --------------------------------------------------------------------------------------------
// The per-request half: two vetoes registered into EXT-01's registry, evaluated by EXT-03's gate.
// --------------------------------------------------------------------------------------------

export interface VetoContext {
  readonly registry: () => AgentRegistry | undefined;
  readonly routing: () => RoutingConfig | undefined;
  readonly config: DispatchConfig;
  readonly sessionEgress: () => EgressClass;
}

/**
 * `DV-EGRESS` — a confidential session may not dispatch a child onto a public provider.
 *
 * Not overridable. A written justification is the right hatch for "this looks dangerous but I mean
 * it"; it is the wrong hatch for "send tenant data to a public endpoint", which is a policy fact
 * about the data and not a judgement about the task.
 */
export function egressVeto(ctx: VetoContext) {
  return {
    id: VETO_EGRESS,
    evaluate(req: DispatchRequest): DispatchVerdict {
      const registry = ctx.registry();
      const routing = ctx.routing();
      if (!registry || !routing) return { veto: false };

      const def = registry.byName.get(req.agentType);
      const sessionEgress = req.parentEgress ?? ctx.sessionEgress();

      // An agent the registry classed `restricted` was classed that way by exactly this rule at
      // load time; repeat the verdict here so the model sees it at the point of decision.
      if (def?.status === "restricted") {
        return {
          veto: true,
          denial: {
            gateId: VETO_EGRESS,
            what: `dispatching "${req.agentType}" is not permitted from a ${sessionEgress} session — ${def.problem ?? "egress containment"}`,
            overridable: false,
          },
        };
      }

      const spec = req.childTier ?? def?.spec;
      if (!spec) return { veto: false };
      try {
        const target = resolveModelSpec(routing, spec, ctx.config.defaultTier);
        assertEgressContainment(target, sessionEgress, `agent "${req.agentType}"`);
      } catch (err) {
        if (err instanceof DispatchError && err.kind === "egress") {
          return {
            veto: true,
            denial: { gateId: VETO_EGRESS, what: err.message, overridable: false },
          };
        }
        // A config or unknown-tier error is not this veto's business; the registry already
        // recorded it and the dispatch rule refuses by name. Do not double-report.
        return { veto: false };
      }
      return { veto: false };
    },
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "from", "into", "onto", "that", "this",
  "these", "those", "then", "than", "you", "your", "our", "its", "it", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "at", "by", "as", "if", "so", "do", "does", "did",
  "not", "no", "all", "any", "can", "will", "would", "should", "must", "may", "use", "using",
  "used", "make", "makes", "made", "new", "one", "two", "when", "what", "which", "who", "how",
  "please", "task", "tasks", "agent", "agents", "run", "runs", "get", "gets", "set", "sets",
  "add", "adds", "also", "only", "just", "very", "more", "most", "some", "each", "every", "here",
  "there", "about", "over", "under", "after", "before", "again", "work", "working",
]);

export function distinctiveWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9+#.-]+/)) {
    const cleaned = word.replace(/^[.-]+|[.-]+$/g, "");
    if (cleaned.length < 4 || STOPWORDS.has(cleaned)) continue;
    out.add(cleaned);
  }
  return out;
}

export interface SpecialistMatch {
  readonly name: string;
  readonly score: number;
  readonly shared: readonly string[];
}

/**
 * Scores every dispatchable specialist against the prompt by shared distinctive words in its
 * `description`. Deliberately dumb: the description *is* the routing contract, so a specialist
 * that does not describe its domain in words a prompt would use is a specialist nobody will find,
 * and that is worth surfacing rather than compensating for with cleverness.
 */
export function bestSpecialist(
  registry: AgentRegistry,
  prompt: string,
  generic: ReadonlySet<string>,
  minScore: number,
): SpecialistMatch | undefined {
  const promptWords = distinctiveWords(prompt);
  if (promptWords.size === 0) return undefined;
  let best: SpecialistMatch | undefined;
  for (const agent of registry.agents) {
    if (agent.status !== "ok" || generic.has(agent.name)) continue;
    const shared = [...distinctiveWords(agent.description)].filter((w) => promptWords.has(w)).sort();
    if (shared.length < minScore) continue;
    if (best === undefined || shared.length > best.score) {
      best = { name: agent.name, score: shared.length, shared };
    }
  }
  return best;
}

/** `DV-SPECIALIST` — `REQ-CTX-47`. Overridable, per `REQ-CTX-06`. */
export function specialistVeto(ctx: VetoContext) {
  const generic = new Set(ctx.config.genericAgents);
  return {
    id: VETO_SPECIALIST,
    evaluate(req: DispatchRequest): DispatchVerdict {
      if (!generic.has(req.agentType)) return { veto: false };
      const registry = ctx.registry();
      if (!registry) return { veto: false };
      const match = bestSpecialist(registry, req.prompt, generic, ctx.config.specialistMatchMinScore);
      if (!match) return { veto: false };
      return {
        veto: true,
        denial: {
          gateId: VETO_SPECIALIST,
          what:
            `dispatching the generic agent "${req.agentType}" when the specialist "${match.name}" ` +
            `matches this task (shared terms: ${match.shared.join(", ")})`,
          legitimateUse: `Re-dispatch with agent: "${match.name}", or say why the specialist is wrong for this task.`,
          overridable: true,
        },
      };
    },
  };
}

/** Registers both vetoes into `EXT-01`'s registry, in evaluation order: containment before taste. */
export function installVetoes(ctx: VetoContext): readonly string[] {
  registerDispatchVeto(egressVeto(ctx));
  registerDispatchVeto(specialistVeto(ctx));
  return [VETO_EGRESS, VETO_SPECIALIST];
}

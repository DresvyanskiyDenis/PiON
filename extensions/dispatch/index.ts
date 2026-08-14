/**
 * `EXT-05` — the sub-agent runtime, as redefined.
 *
 * **There is no dispatcher in this file.** `pi-subagents` 0.41.0 is the dispatcher: agent
 * discovery, the markdown+frontmatter format, per-agent models and tool sets, structured
 * delegation, per-agent permissions, worktrees, the async fleet. Revision 3 voids conflict X1 and
 * the fork with it. What ships here is the remainder this item names, and nothing else:
 *
 *   1. `depth.ts`      — a depth limit that fails loudly at dispatch, on **our** number (VP-01).
 *   2. `semaphore.ts` + `concurrency.ts` — per-provider concurrency from `routing.json`, queueing
 *      rather than erroring (VP-02), plus an honest account of where it cannot reach.
 *   3. `isolation.ts`  — `isolation: worktree`, honoured; the worktree comes from `EXT-23`.
 *   4. `tiers.ts`      — tier name → `provider/id`, from `routing.json`, the single source of truth.
 *   5. `catalogue.ts`  — the model registry as a dispatch surface: a call-time `provider/id` is
 *      checked for existence, a bad one is refused with the closest real ids, and the selectable
 *      set is put in the system prompt so the orchestrating model can pick a cheap model on
 *      purpose instead of guessing an id (`REQ-PRV-09`, dispatch-time override wins).
 *
 * plus the acceptance criterion this item calls non-negotiable — a typo in an agent file is a
 * `session_start` error (`registry.ts`) — and the routing veto, wired into
 * `registerSubagentCapabilityCeiling()` and `EXT-01`'s veto registry rather than into a fork.
 *
 * This item's *second* criterion, "a confidential session cannot dispatch onto a public provider",
 * was WITHDRAWN on 2026-08-13: a constraint nobody asked for, which prevented switching provider
 * inside a session. The session's egress class is still resolved, printed on the startup line,
 * shown by `/agents` and written to the audit entry — it just refuses nothing.
 *
 * ## Load order
 *
 * `guard` (EXT-03) **must** load before this module. `runner.emitToolCall` iterates extensions in
 * load order and returns on the first `{block:true}`; a blocked dispatch must never have had its
 * arguments rewritten first. This is the same rule that holds for `guard` before
 * `bash`.
 *
 * ## Why a `tool_call` handler and not a tool
 *
 * The dispatch tool belongs to the package. Everything this module needs to do to a dispatch —
 * resolve a tier to a model, lower a fanout width, point a child at a worktree, refuse a call that
 * is too deep — is expressible as reading and rewriting that tool's arguments, which is exactly
 * what `tool_call` is for (mutation is in place and is not re-validated).
 * It goes through `guardedHandler`, so a bug in one rule blocks one call instead of bricking the
 * agent.
 */
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { SubagentCapabilityCeilingHandle } from "pi-subagents/capability-ceiling";
import { guardedHandler, type GuardRule, type GuardVerdict } from "../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../lib/escape-hatch.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import type { EgressClass } from "../lib/dispatch-veto.ts";
import {
  describeRegistryDirs,
  loadDispatchSettings,
  registryDirs,
  type DispatchSettings,
} from "./config.ts";
import { applyMaxDepthEnv, currentDepth, evaluateDepth } from "./depth.ts";
import { capFor, clampConcurrency, isFanoutCall } from "./concurrency.ts";
import { ProviderSemaphoreSet } from "./semaphore.ts";
import { applyIsolation } from "./isolation.ts";
import { loadAgentRegistry, renderRegistry, type AgentDef, type AgentRegistry } from "./registry.ts";
import { installCeiling, installVetoes } from "./ceiling.ts";
import { assertDispatchShape } from "./contract.ts";
import { DispatchError, resolveModelSpec, resolveSessionEgress } from "./tiers.ts";
import {
  injectMenuOnce,
  makeCatalogue,
  renderModelMenu,
  type ModelCatalogue,
} from "./catalogue.ts";

export const id = "dispatch";

/** Argument names the package and its neighbours use for the agent definition. */
const AGENT_KEYS = ["agent", "agentType", "subagent_type", "subagentType", "name"] as const;
/** Argument names carrying the child's task text. */
const PROMPT_KEYS = ["task", "prompt", "instructions", "description", "message"] as const;

/** Exported for `test/dispatch/rules.test.ts`, which drives `rules()` without a live PI session. */
export interface State {
  settings: DispatchSettings;
  registry?: AgentRegistry;
  sessionEgress: EgressClass;
  egressSource: string;
  depth: number;
  semaphores: ProviderSemaphoreSet;
  /**
   * `ctx.modelRegistry.getAvailable()`, snapshotted at `session_start`. `undefined` means the
   * registry could not be read — existence is then NOT asserted, and the reduced check is in
   * `problems`. It is never an empty catalogue: "no models exist" and "we cannot see the models"
   * must not produce the same refusal.
   */
  catalogue?: ModelCatalogue;
  /** Memoised system-prompt block; rebuilt only when `session_start` re-runs. */
  menu?: string;
  ceiling?: SubagentCapabilityCeilingHandle;
  ceilingNotes: readonly string[];
  vetoIds: readonly string[];
  /** Problems from config + registry, reported once at session_start and again by `/agents`. */
  problems: string[];
}

export function register(pi: ExtensionAPI): void {
  const settings = loadDispatchSettings();
  const state: State = {
    settings,
    sessionEgress: settings.dispatch.defaultEgress,
    egressSource: "default",
    depth: currentDepth(),
    semaphores: new ProviderSemaphoreSet(settings.routing?.concurrency ?? {}, settings.dispatch.concurrencyDefault),
    ceilingNotes: [],
    vetoIds: [],
    problems: [...settings.problems],
  };

  // The vetoes read live state through closures, so they can be registered before session_start
  // has built the registry — EXT-03's gate finds them either way and simply matches nothing until
  // the registry exists.
  state.vetoIds = installVetoes({
    registry: () => state.registry,
    config: state.settings.dispatch,
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await onSessionStart(pi, ctx, state);
    } catch (err) {
      // session_start must not take the session down; the failure is announced and dispatch is
      // refused by the DSP-READY rule below, which reads the same problem list.
      const line = `[pi-config] dispatch: session_start failed: ${describeError(err)}`;
      state.problems.push(line);
      report(ctx, line, "error");
    }
  });

  pi.on("session_shutdown", () => {
    try {
      state.ceiling?.dispose();
    } catch {
      // A dispose that throws on the way out is not worth failing shutdown over; the registry is
      // process-scoped and dies with us.
    }
    state.ceiling = undefined;
  });

  // Discoverability. A gate that refuses an id the model had no way to know about is a gate that
  // costs a turn; the menu is what makes the refusal rare. Injection only — every byte of it was
  // computed in `session_start`, because this fires on every prompt.
  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined => {
      const menu = state.menu;
      if (menu === undefined) return undefined;
      try {
        return { systemPrompt: injectMenuOnce(event.systemPrompt, menu) };
      } catch (err) {
        // Fail open, loudly, once: a bug here must cost the session its model menu, not every
        // prompt typed into it. The gates below do not depend on the menu having been injected.
        surfaceOnce(ctx, "dispatch:menu-injection", () => {
          report(ctx, `[pi-config] dispatch: model menu injection failed: ${describeError(err)}`, "error");
        });
        return undefined;
      }
    },
  );

  pi.on(
    "tool_call",
    guardedHandler({
      owner: id,
      onInternalError: "open",
      audit: (customType, data) => pi.appendEntry(customType, data),
      rules: rules(state),
    }),
  );

  pi.registerCommand("agents", {
    description: "Sub-agent registry: what can be dispatched, on what model, and what cannot",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(renderStatus(state, ctx.cwd), "info");
    },
  });
}

// --------------------------------------------------------------------------------------------

async function onSessionStart(pi: ExtensionAPI, ctx: ExtensionContext, state: State): Promise<void> {
  const cfg = state.settings.dispatch;
  state.depth = currentDepth();

  const previous = applyMaxDepthEnv(cfg.maxDepth);
  if (previous.previous !== undefined && previous.previous !== String(cfg.maxDepth)) {
    state.problems.push(
      `PI_SUBAGENT_MAX_DEPTH was "${previous.previous}" and is now "${cfg.maxDepth}" (config/dispatch.json)`,
    );
  }

  if (state.settings.routing === undefined) {
    report(
      ctx,
      `[pi-config] dispatch: ${state.problems.join(" | ")}`,
      "error",
    );
    pi.appendEntry("dispatch_problem", { phase: "config", problems: state.problems });
    return;
  }

  const egress = resolveSessionEgress(state.settings.routing, {
    ...(process.env.PI_ROUTING_EGRESS !== undefined ? { declared: process.env.PI_ROUTING_EGRESS } : {}),
    ...(ctx.model?.provider !== undefined ? { activeProvider: ctx.model.provider } : {}),
    defaultEgress: cfg.defaultEgress,
  });
  state.sessionEgress = egress.egress;
  state.egressSource = egress.source;
  if (egress.note) state.problems.push(egress.note);

  let available: Set<string> | undefined;
  try {
    const ids = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
    state.catalogue = makeCatalogue(ids);
    available = new Set(ids);
  } catch (err) {
    // Without the registry we cannot say "this model does not exist"; we can still resolve tiers.
    // Announce the reduced check rather than silently skipping it.
    state.catalogue = undefined;
    state.problems.push(
      `model registry unavailable (${describeError(err)}); agent models are resolved but not checked for existence`,
    );
  }

  // Built once here, not per turn: the selectable set is fixed for the session, and a system-prompt
  // block that changes between turns is a broken prompt-cache prefix for no benefit.
  state.menu = renderModelMenu({
    routing: state.settings.routing,
    catalogue: state.catalogue,
    sessionEgress: state.sessionEgress,
    defaultTier: cfg.defaultTier,
  });

  const registry = loadAgentRegistry({
    dirs: registryDirs(cfg, ctx.cwd),
    routing: state.settings.routing,
    config: cfg,
    ...(available !== undefined ? { availableModels: available } : {}),
  });
  state.registry = registry;
  state.problems.push(...registry.problems);

  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId) {
    const installed = await installCeiling({
      sessionId,
      registry,
      config: cfg,
      depth: state.depth,
      allToolNames: safeToolNames(pi),
    });
    state.ceilingNotes = installed.notes;
    if (installed.handle) state.ceiling = installed.handle;
    if (installed.failure) state.problems.push(installed.failure);
  } else {
    state.problems.push(
      `no session id available, so no capability ceiling was registered; children are not restricted ` +
        `to the dispatchable agent set (depth is still enforced per call)`,
    );
  }

  const broken = registry.agents.filter((a) => a.status === "invalid");
  const restricted = registry.agents.filter((a) => a.status === "restricted");
  pi.appendEntry("dispatch_registry", {
    depth: state.depth,
    maxDepth: cfg.maxDepth,
    egress: state.sessionEgress,
    egressSource: state.egressSource,
    agents: registry.agents.map((a) => ({
      name: a.name,
      spec: a.spec,
      model: a.target?.model,
      status: a.status,
      contract: a.contract.mode,
      isolation: a.isolation,
      ...(a.problem !== undefined ? { problem: a.problem } : {}),
    })),
    problems: state.problems,
  });

  // "A typo in one of 14 agent files is a session_start error, not a surprise at minute 40."
  if (broken.length > 0) {
    report(
      ctx,
      `[pi-config] dispatch: ${broken.length} agent file(s) will NOT dispatch — ` +
        broken.map((a) => `${a.name} (${a.file}): ${a.problem ?? "invalid"}`).join(" | "),
      "error",
    );
  }
  if (restricted.length > 0) {
    report(
      ctx,
      `[pi-config] dispatch: ${restricted.length} agent(s) unavailable right now because their model ` +
        `is not being served — ` + restricted.map((a) => a.name).join(", "),
      "warning",
    );
  }
  const other = state.problems.filter(
    (p) => !broken.some((a) => p.includes(a.file)) && !restricted.some((a) => p.includes(a.file)),
  );
  if (other.length > 0) {
    report(ctx, `[pi-config] dispatch: ${other.join(" | ")}`, "warning");
  }
}

function safeToolNames(pi: ExtensionAPI): string[] {
  try {
    return pi.getAllTools().map((t) => t.name);
  } catch {
    return [];
  }
}

function report(ctx: ExtensionContext | undefined, line: string, level: "info" | "warning" | "error"): void {
  surfaceOnce(ctx, `dispatch:${level}:${line.slice(0, 160)}`, () => {
    // One channel, whichever this run mode has: ctx.ui.* is a no-op in -p and --mode json,
    // and in the TUI a stderr copy prints straight over PI's own frame.
    // `lib/announce.ts` picks by ctx.hasUI and still swallows a UI that throws.
    emitNotice(ctx, line, level);
  });
}

// --------------------------------------------------------------------------------------------
// The rules. Order matters: refuse before rewriting.
// --------------------------------------------------------------------------------------------

export function rules(state: State): GuardRule[] {
  const isDispatch = (event: ToolCallEvent): boolean =>
    state.settings.dispatch.dispatchTools.includes(event.toolName);

  return [
    {
      // Config is unusable => there is no defensible mapping from a tier to a model. Refuse rather
      // than let the package pick something.
      id: "DSP-READY",
      evaluate(event) {
        if (!isDispatch(event)) return { block: false };
        if (state.settings.routing !== undefined) return { block: false };
        return {
          block: true,
          reason:
            `Sub-agent dispatch is unavailable: ${state.settings.sources.routing} could not be used ` +
            `(${state.settings.problems.join("; ") || "no usable tiers"}). ` +
            `Do the work in this session instead of delegating it.`,
        };
      },
    },
    {
      // VP-01. Not overridable: a written justification cannot make a fourth level of nesting safe.
      id: "DSP-DEPTH",
      evaluate(event) {
        if (!isDispatch(event)) return { block: false };
        const verdict = evaluateDepth(state.depth, state.settings.dispatch.maxDepth);
        if (!verdict.blocked) return { block: false };
        return { block: true, reason: verdict.reason ?? "sub-agent dispatch refused: nesting limit reached" };
      },
    },
    // `DSP-EGRESS` sat here, between DSP-DEPTH and DSP-CONTRACT, until 2026-08-13. It refused a
    // call-time `model` override whose provider was classed looser than the session, and it was the
    // only reason `assertEgressContainment` needed a rule of its own on this path. It went with the
    // rest of egress containment (`lib/dispatch-veto.ts`). A call-time override is now resolved and
    // checked for EXISTENCE by DSP-RESOLVE below, and for nothing else.
    {
      // The return contract, enforced at the point of dispatch (see contract.ts for why).
      id: "DSP-CONTRACT",
      evaluate(event) {
        if (!isDispatch(event)) return { block: false };
        const def = agentOf(state, event);
        if (!def) return { block: false };
        const input = event.input as Record<string, unknown>;
        const message = assertDispatchShape(
          def.contract,
          {
            structuredOutput: input.outputSchema !== undefined,
            // `async` defaults to false on the package's own tool
            // (src/extension/schemas.ts:324), so anything that is not explicitly async awaits a
            // result — which a teammate structurally cannot produce.
            awaitsResult: input.async !== true,
          },
          def.name,
        );
        if (message === undefined) return { block: false };
        return { block: true, reason: message };
      },
    },
    {
      // An agent that will not resolve must fail here, by name, and not at minute 40 inside the
      // package with "Unknown agent".
      id: "DSP-AGENT",
      evaluate(event) {
        if (!isDispatch(event)) return { block: false };
        const registry = state.registry;
        if (!registry) return { block: false };
        const requested = firstString(event.input as Record<string, unknown>, AGENT_KEYS);
        if (requested === undefined) return { block: false };
        const def = registry.byName.get(requested);
        if (def === undefined) {
          // Unknown here does not mean unknown to the package: it also discovers its own builtin
          // agents and package agents, which are not in our tracked directories. Do not block on
          // a name we simply do not own.
          return { block: false };
        }
        if (def.status === "ok") return { block: false };
        return {
          block: true,
          reason:
            `agent "${def.name}" cannot be dispatched: ${def.problem ?? def.status}. ` +
            (def.status === "invalid"
              ? `Fix ${def.file}, or dispatch a different agent.`
              : // `restricted` now means one thing only: the agent's model is not being served
                // right now (an `optional` tier whose backend is down). Said explicitly because the
                // obvious next move — "then I will name another model on the call" — does not work.
                // The capability ceiling that carries this verdict into `pi-subagents` is registered
                // once per session (ceiling.ts): its allowedAgents list is static, so no per-call
                // argument can widen it.
                `A per-call \`model\` cannot lift this — the agent is outside this session's ` +
                `capability ceiling, which is fixed for the whole session. Start the backend that ` +
                `serves its model, or dispatch an agent whose model is available.`),
        };
      },
    },
    {
      // The rewrites. This rule never blocks except when isolation cannot be honoured, which is a
      // refusal to run somewhere unsafe rather than a policy verdict.
      id: "DSP-RESOLVE",
      async evaluate(event, ctx): Promise<GuardVerdict> {
        if (!isDispatch(event)) return { block: false };
        const routing = state.settings.routing;
        const registry = state.registry;
        if (!routing || !registry) return { block: false };
        const input = event.input as Record<string, unknown>;
        const def = agentOf(state, event);

        const applied: Record<string, unknown> = {};

        // 4. tier -> provider/id. The package would otherwise try to resolve the literal string
        //    "strong" against its own heuristics, which is routing by accident.
        //
        //    Precedence, REQ-PRV-09: an explicit `model` on THIS call wins over the agent file's
        //    `model:`, which is a default and not a binding. That is the whole point of the
        //    call-time override — the orchestrating model, not the agent author, is the one who
        //    knows whether this particular job is worth an expensive model.
        //
        //    The catalogue is passed here and nowhere else in this rule set. This is the one place
        //    that decides what actually goes on the wire, so it is the one place that must be sure
        //    the model exists: `pi-subagents`' resolveModelCandidate() returns an unmatched string
        //    UNCHANGED, so without this check a typo is spawned as `--model <garbage>` and fails
        //    inside a child process minutes later.
        //
        //    A call that names neither a model nor an agent we own resolves nothing at all — and
        //    that is a hole on exactly one shape. A `workflowScript` launches children of its own,
        //    and a child that names no model falls through to PI's substring matcher, which is
        //    routing by accident onto a provider `config/models.json` never declared. Since
        //    2026-08-14 `defaultTierScope` pins `dispatch.json`'s `defaultTier` onto that shape as
        //    a FLOOR — read its docstring for the package evidence and the upgrade risk.
        const callModel = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
        const fromCall = callModel !== undefined;
        const agentSpec = def?.spec;
        const tierScope = callModel === undefined && agentSpec === undefined ? defaultTierScope(input) : undefined;
        const spec =
          callModel ?? agentSpec ?? (tierScope !== undefined ? `tier:${state.settings.dispatch.defaultTier}` : undefined);
        let provider: string | undefined;
        if (spec) {
          try {
            const target = resolveModelSpec(routing, spec, state.settings.dispatch.defaultTier, state.catalogue);
            provider = target.provider;
            if (input.model !== target.model) {
              input.model = target.model;
              applied.model = {
                from: spec,
                to: target.model,
                tier: target.tier,
                // Which kind of write this was. A reader of the bookkeeping cannot tell "we
                // resolved what the call asked for" from "we set a floor the children may still
                // override" without it, and only one of the two is overridable downstream.
                ...(tierScope !== undefined ? { defaultedScope: tierScope } : {}),
              };
            }
            if (tierScope === "workflow-floor") {
              report(
                ctx,
                `[pi-config] dispatch: this workflowScript named no model, so config/dispatch.json's ` +
                  `defaultTier "${state.settings.dispatch.defaultTier}" was pinned as the FLOOR for its ` +
                  `children: ${target.model}. pi-subagents spreads a workflow-level model underneath each ` +
                  `child's own params (subagent-executor.ts:4106 and :4142), so this routes only the ` +
                  `children that name no model — a child that names one still wins. Nothing was inferred ` +
                  `— set \`model\` on the call, or per child, to choose another.`,
                "info",
              );
            }
            // Reasoning effort is NOT written onto the call as a separate field, and that is still
            // right: `pi-subagents`' top-level `thinking` argument documents itself as belonging to
            // `action='watchdog.configure'` (src/extension/schemas.ts:287), and tool inputs are not
            // re-validated after mutation, so a wrong reading of that field would reach the package
            // unchecked.
            //
            // What this comment used to conclude from that — "thinking level stays the agent file's
            // business" — was too wide, and cost a real capability for months. PI carries effort in
            // the MODEL STRING: `provider/id:max`, levels off|minimal|low|medium|high|xhigh|max,
            // read by `resolveEffectiveThinking` (shared/model-info.ts:36) and applied on the launch
            // path (runs/foreground/subagent-executor.ts:2146), where it outranks both the agent
            // file and any override. That route needs no unvalidated argument, so it is the one we
            // use: a tier declares `thinkingLevel` in routing.json, `resolveTier` moves it into the
            // model string, and `target.model` above carries the suffix through untouched. See
            // `splitThinkingSuffix` in thinking.ts.
          } catch (err) {
            if (!(err instanceof DispatchError)) throw err;
            // Name where the value came from. "unknown_model: github-copilot/gpt-5.1" is acted on
            // very differently depending on whether the model just typed it or an agent file has
            // carried it for weeks, and only this frame knows which.
            const origin = fromCall
              ? `the \`model\` argument of this call`
              : tierScope === "workflow-floor"
                ? `config/dispatch.json's defaultTier, used as the floor for this workflowScript's ` +
                  `children because the call named no model`
                : `the \`model:\` frontmatter of agent "${def?.name ?? "?"}" (${def?.file ?? "unknown file"})`;
            return {
              block: true,
              reason:
                `cannot route this dispatch: ${err.kind}: ${err.message} ` +
                `(the value "${spec}" came from ${origin}). ` +
                `Nothing was substituted; re-issue the call with a value that resolves.`,
            };
          }
        }

        // 2. per-provider concurrency, from routing.json's map. Lower only, never raise.
        if (provider !== undefined && isFanoutCall(input)) {
          const cap = capFor(routing, provider, state.settings.dispatch);
          const outcome = clampConcurrency(input, cap, state.settings.dispatch);
          if (outcome?.changed) applied.concurrency = outcome;
        }

        // 3. isolation: worktree.
        if (def && def.isolation === "worktree") {
          const outcome = await applyIsolation(input, def.isolation, {
            agent: def.name,
            toolCallId: event.toolCallId,
            cwd: ctx.cwd,
          });
          if (outcome.kind === "refused") return { block: true, reason: outcome.reason };
          applied.isolation = outcome;
        }

        if (Object.keys(applied).length > 0) {
          try {
            state.semaphores.for(provider ?? "_unknown");
          } catch {
            // Only creates the bookkeeping entry `/agents` shows; never load-bearing.
          }
        }
        return { block: false };
      },
    },
  ];
}

function agentOf(state: State, event: ToolCallEvent): AgentDef | undefined {
  const registry = state.registry;
  if (!registry) return undefined;
  const requested = firstString(event.input as Record<string, unknown>, AGENT_KEYS);
  return requested === undefined ? undefined : registry.byName.get(requested);
}

/**
 * Which shape of dispatch call the default tier may be written onto, and what the write means
 * there. `undefined` = this call launches nothing we can route, so leave `model` alone.
 *
 * Only one shape qualifies today, and it is not the obvious one:
 *
 * `action:` makes the call a management/control operation (`status`, `stop`, `schedule.create`, …).
 * It starts no child at all, so a `model` on it would be honoured by nothing.
 *
 * A call that names an agent needs nothing here: `registry.ts` already gives every definition whose
 * frontmatter omits `model:` the spec `tier:<defaultTier>`, so it arrives with a spec and is
 * resolved by the ordinary path above.
 *
 * `workflowScript` IS pinned, as a FLOOR. Its children are launched by the package, past the point
 * where this rule sees them; a child that names no model gets its agent file's tier word, and
 * `pi-subagents` hands an unmatched string on unchanged for PI to substring-match — which resolves
 * a word like `fast` onto whatever provider happens to contain it, typically one
 * `config/models.json` never declared, and the run then dies with a credentials error that is
 * really a silent provider substitution. Pinning our own resolved model as the workflow-level
 * default closes that: children that name no model inherit it, children that name one are
 * untouched.
 *
 * THIS RESTS ON A PACKAGE INTERNAL — `pi-subagents` 0.41.0,
 * `src/runs/foreground/subagent-executor.ts`:
 *
 *   - `:4106` (async branch) destructures the workflow request into `workflowChildDefaults`,
 *     dropping `action, agent, task, tasks, chain, concurrency, foregroundOnly, clarify, timeoutMs,
 *     maxRuntimeMs, usageBudget`. `model` is NOT among them, so it survives into the defaults.
 *     `:4178` is the foreground twin and drops the same set plus `workflowScript, async,
 *     chatProgress` — also keeping `model`.
 *   - `:4142` / `:4202` build every child as
 *     `prepareWorkflowChildParams({ ...workflowChildDefaults, ...childParams, … })`, so a top-level
 *     `model` is the children's DEFAULT and a per-child `model` overrides it by spread order. The
 *     package documents that precedence itself ("child fields override workflow defaults").
 *   - `:4040` rejects only `action`/`agent`/`step`/`tasks`/`chain` beside `workflowScript`, so
 *     sending `model` with it is legal.
 *
 * Re-check `:4106` and `:4142` whenever `pi-subagents` is upgraded. If `model` joins the omit list
 * the floor stops reaching the children; if the spread order flips it starts overriding children
 * that chose their own model. `test/dispatch/rules.test.ts` fails loudly on either.
 */
type DefaultTierScope = "workflow-floor";

function defaultTierScope(input: Record<string, unknown>): DefaultTierScope | undefined {
  if (typeof input.action === "string" && input.action.trim().length > 0) return undefined;
  if (typeof input.workflowScript === "string" && input.workflowScript.trim().length > 0) {
    return "workflow-floor";
  }
  return undefined;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Exported for tests: the prompt keys `EXT-03`'s gate and this module agree on. */
export { AGENT_KEYS, PROMPT_KEYS };

function renderStatus(state: State, cwd: string): string {
  const cfg = state.settings.dispatch;
  const lines: string[] = [];
  lines.push(
    `dispatch: depth ${state.depth}/${cfg.maxDepth}, session egress ${state.sessionEgress} (${state.egressSource}), ` +
      `default tier ${cfg.defaultTier}`,
  );
  lines.push(`config: ${state.settings.sources.dispatch} + ${state.settings.sources.routing}`);
  lines.push(`registry dirs: ${describeRegistryDirs(cfg, cwd)}`);
  if (state.settings.routing) {
    const caps = Object.entries(state.settings.routing.concurrency)
      .map(([p, n]) => `${p}=${n}`)
      .join(", ");
    lines.push(`per-provider concurrency: ${caps || "(none configured)"} (default ${cfg.concurrencyDefault})`);
  }
  if (state.ceilingNotes.length > 0) lines.push(`capability ceiling: ${state.ceilingNotes.join("; ")}`);
  if (state.vetoIds.length > 0) lines.push(`dispatch vetoes registered: ${state.vetoIds.join(", ")}`);
  const live = state.semaphores.snapshot();
  if (live.length > 0) {
    lines.push(`lanes: ${live.map((l) => `${l.provider} ${l.active}/${l.limit}${l.waiting ? ` (+${l.waiting} queued)` : ""}`).join(", ")}`);
  }
  lines.push(
    `model registry: ${state.catalogue ? `${state.catalogue.ids.length} model(s) available; a call-time provider/id is checked against them` : "UNAVAILABLE — a call-time provider/id is NOT checked for existence"}`,
  );
  lines.push("");
  lines.push(state.registry ? renderRegistry(state.registry, cwd) : "registry not loaded yet");
  if (state.menu) {
    // The same text the model is given, shown verbatim: if the human and the model are reading
    // different lists, the one nobody can see is the one that is wrong.
    lines.push("");
    lines.push(state.menu);
  }
  if (state.problems.length > 0) {
    lines.push("");
    lines.push(`problems (${state.problems.length}):`);
    for (const p of state.problems) lines.push(`  - ${p}`);
  }
  return lines.join("\n");
}

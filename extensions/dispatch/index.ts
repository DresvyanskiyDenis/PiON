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
 *      set is put in the system prompt so the orchestrating model can pick a cheaper model on
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
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { SubagentCapabilityCeilingHandle } from "pi-subagents/capability-ceiling";
import { guardedHandler, type GuardRule, type GuardVerdict } from "../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../lib/escape-hatch.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import type { EgressClass } from "../lib/dispatch-veto.ts";
import { logEvent } from "../session-index/index.ts";
import {
  describeRegistryDirs,
  loadDispatchSettings,
  registryDirs,
  type DispatchSettings,
} from "./config.ts";
import { createFleetWidget } from "./fleet-widget.ts";
import { applyMaxDepthEnv, currentDepth, evaluateDepth } from "./depth.ts";
import { capFor, clampConcurrency, isFanoutCall } from "./concurrency.ts";
import { ProviderSemaphoreSet } from "./semaphore.ts";
import { applyIsolation } from "./isolation.ts";
import { loadAgentRegistry, renderRegistry, type AgentDef, type AgentRegistry } from "./registry.ts";
import { installCeiling, installVetoes } from "./ceiling.ts";
import { agentRosterDirs, readAgentRoster } from "./roster.ts";
import { configDir } from "../lib/paths.ts";
import { homedir } from "node:os";
import { assertDispatchShape } from "./contract.ts";
import { describeRelaxation, relaxDispatchOutputSchemas } from "./output-schema.ts";
import { applyWaitStopOnAttention, WAIT_DEFAULT_NOTICE } from "./wait-attention.ts";
import { DispatchError, resolveModelSpec, resolveSessionEgress } from "./tiers.ts";
import {
  admissibleProviders,
  catalogueDisclosure,
  describeServing,
  injectMenuOnce,
  makeCatalogue,
  providersServing,
  renderModelMenu,
  restrictCatalogue,
  splitModelId,
  type ModelCatalogue,
  type ProviderAdmission,
} from "./catalogue.ts";
import { requestedLevel, splitThinkingSuffix } from "./thinking.ts";
import { reorderResultContent, resolveFullOutputPointer } from "./failure-slot.ts";
import { slimDispatchDetails } from "./result-slim.ts";
import {
  createAsyncFleet,
  formatAnnouncement,
  noteAsyncConsumption,
  noteAsyncSpawn,
  reconcile,
  renderAsyncFleet,
  retireSettledRuns,
  takeAnnouncements,
} from "./async-fleet.ts";

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
   * `ctx.modelRegistry.getAvailable()`, snapshotted at `session_start` and then RESTRICTED to the
   * providers this install actually configured (`restrictCatalogue`). `undefined` means the
   * registry could not be read — existence is then NOT asserted, and the reduced check is in
   * `problems`. It is never an empty catalogue: "no models exist" and "we cannot see the models"
   * must not produce the same refusal.
   *
   * Restricted once, here, rather than at each consumer: the menu, `suggestModels` and the
   * existence gate all read this field, and filtering it in one place is what makes them agree.
   */
  catalogue?: ModelCatalogue;
  /**
   * Which providers dispatch will accept — configured in `models.json` AND classified in
   * `routing.json`. Built at construction, because it depends on config rather than on the registry
   * and must refuse an unconfigured provider even when the registry could not be read.
   *
   * `undefined` only when `routing.json` itself could not be loaded, which the shipped rules already
   * refuse every dispatch for; there is then no egress map to admit anyone against.
   */
  admission?: ProviderAdmission;
  /** Memoised system-prompt block; rebuilt only when `session_start` re-runs. */
  menu?: string;
  ceiling?: SubagentCapabilityCeilingHandle;
  ceilingNotes: readonly string[];
  vetoIds: readonly string[];
  /** Problems from config + registry, reported once at session_start and again by `/agents`. */
  problems: string[];
}

export function register(pi: ExtensionAPI): void {
  // Deliberately NOT part of `State`: this is per-session runtime, `State` is per-session config,
  // and `State` is constructed by name in `test/dispatch/rules.test.ts`. See `async-fleet.ts` for
  // why it exists at all.
  const fleet = createAsyncFleet();
  // The screen's view of that fleet. Owns one timer, only while a run is tracked — see
  // `fleet-widget.ts` for why it polls and how the timer is bounded.
  const fleetWidget = createFleetWidget(fleet);
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
    ...(settings.routing !== undefined
      ? { admission: admissibleProviders(settings.routing, settings.configuredProviders) }
      : {}),
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

  pi.on("session_shutdown", (_event, ctx) => {
    fleetWidget.dispose(ctx);
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

  // The async fleet, reconciled against each run's own `status.json`. `pi-subagents` promises at
  // spawn time that "Pi will wake you on completion"; when its result-watcher does not deliver,
  // nothing enters the transcript and the orchestrator keeps calling a dead run active. These two
  // handlers close that gap without duplicating any lifecycle — see `async-fleet.ts`.
  pi.on("tool_execution_end", (event, ctx) => {
    try {
      if (state.settings.dispatch.dispatchTools.includes(event.toolName)) noteAsyncSpawn(fleet, event.result);
      // Every result, not just a dispatch tool's: the model inspects a finished run through
      // `subagent_wait` (not a dispatch tool) and through a read of the run's own artifact just as
      // often as through `subagent({action:"status"})`. Cheap when nothing is tracked.
      noteAsyncConsumption(fleet, event.result);
      // A spawn is the moment the panel has to appear; waiting for `turn_end` would hide the
      // fleet for exactly the stretch in which the user most wants to see it.
      fleetWidget.refresh(ctx);
    } catch (err) {
      surfaceOnce(undefined, "dispatch:async-track", () => {
        pi.appendEntry("dispatch_problem", { phase: "async-track", problem: describeError(err) });
      });
    }
  });

  // Two edits to a finished dispatch, both of which need the one PI event documented to modify a
  // result — `tool_execution_end` above is notification-only and cannot.
  //
  // The failure slot. `pi-subagents` hands the parent the child's WHOLE stderr tail as the run's
  // error text, so a classified provider abort ends up underneath whichever extension announced
  // itself first at the child's session_start. This reorders that one text part, and bounds what
  // follows the classified block to `failureOutputMaxLines`/`failureOutputMaxChars` — that tail is
  // billed to the parent on every later turn of the session, and the elision names the file it can
  // be read back from. The diagnosis itself is never shortened; see `failure-slot.ts`.
  //
  // The transcript slot. A detached or interrupted child slips past the package's own
  // `compactForegroundDetails` and carries its live `messages` array into `details`, which is
  // written verbatim to the session JSONL that `bin/pi-digest-drain` slices BY BYTES and feeds to a
  // summariser. It costs no provider tokens — `details` never reaches the model — but it evicts
  // real conversation from that slice. Dropped only while the child still names where its full
  // record lives; see `result-slim.ts` for the measurement and for the case it refuses.
  //
  // The return type is inferred rather than annotated: PI's `ToolResultEventResult` type is not
  // re-exported from the package root as of 0.84.0, unlike its `ToolCallEventResult` sibling.
  // Reaching into `dist/` for it would pin us to that layout, so the `pi.on("tool_result", …)`
  // overload contextually types the literal below instead.
  pi.on("tool_result", (event: ToolResultEvent) => {
    try {
      if (!state.settings.dispatch.dispatchTools.includes(event.toolName)) return undefined;
      // The pointer is read off `details` BEFORE `slimDispatchDetails` rewrites it, and it is what
      // makes an elision permissible at all: with no file named, `reorderResultContent` keeps the
      // remainder whole rather than cutting the only copy of it.
      const cfg = state.settings.dispatch;
      const content = reorderResultContent(
        event.content,
        { maxLines: cfg.failureOutputMaxLines, maxChars: cfg.failureOutputMaxChars },
        resolveFullOutputPointer(event.details),
      );
      // `isError` is the runner's own verdict and is never restated: this handler reorders text,
      // bounds a failed child's remaining output and drops a transcript the child already wrote to
      // disk, and none of the three re-judges the run.
      // `details` is patched only when a child carried a droppable `messages` array — the async
      // run's own metadata (`asyncId`, `asyncDir`, which `noteAsyncSpawn` reads) and every other
      // field are copied through untouched.
      const details = slimDispatchDetails(event.details);
      if (content === undefined && details === undefined) return undefined;
      return { ...(content !== undefined ? { content } : {}), ...(details !== undefined ? { details } : {}) };
    } catch (err) {
      surfaceOnce(undefined, "dispatch:failure-slot", () => {
        pi.appendEntry("dispatch_problem", { phase: "failure-slot", problem: describeError(err) });
      });
      return undefined;
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    try {
      fleetWidget.refresh(ctx);
      const reports = reconcile(fleet);
      const announcement = formatAnnouncement(takeAnnouncements(fleet, reports));
      // After announcing, never before: a run becomes retirable BY being announced, and the sweep
      // must not be able to drop one on the same pass that would have reported it.
      retireSettledRuns(fleet, reports);
      if (announcement === undefined) return;
      pi.sendMessage(
        { customType: "dispatch-async-terminal", content: [{ type: "text", text: announcement }], display: true },
        { deliverAs: "nextTurn" },
      );
    } catch (err) {
      report(ctx, `[pi-config] dispatch: async reconciliation failed: ${describeError(err)}`, "error");
    }
  });

  /**
   * Kept, not retired, and deliberately **not** turned into a launcher for the fleet inspector.
   *
   * Its async section is not the duplicate it looks like: `renderAsyncFleet` prints *this
   * extension's own* reconciliation verdicts (`async-fleet.ts:409`), which include a run that
   * never wrote a status file at all — `NEVER STARTED`. `pi-subagents`' navigable inspector
   * lists `listAsyncRuns`, so a run that never registered is exactly the one it cannot show.
   * Folding this into that view would lose the only surface that reports it.
   *
   * What it genuinely was is the *discoverable* command that looked like a fleet view while the
   * live, navigable ones stayed hidden. The trailer fixes that without deleting a diagnostic.
   */
  pi.registerCommand("agents", {
    description: "Sub-agent registry: what can be dispatched, on what model, and what cannot",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const pointer =
        "\n\nThis is a one-shot snapshot. In the TUI the async section above is also a live panel " +
        "over the editor whenever a run is in flight, so you rarely need to ask. For a live, " +
        "navigable view: /subagents-fleet (subagents, running and past) or /jobs (detached " +
        "background jobs).";
      ctx.ui.notify(`${renderStatus(state, ctx.cwd)}${renderAsyncFleet(fleet)}${pointer}`, "info");
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
    const models = ctx.modelRegistry.getAvailable();
    const ids = models.map((m) => `${m.provider}/${m.id}`);
    // The reasoning vocabulary is snapshotted alongside the ids, from the same registry read: it is
    // what makes a dispatch able to report the effort it will REALLY run at. PI clamps the level in
    // the child process, past any point this extension can observe, so the only honest way to name
    // the effective level here is to apply the same rule to the same data.
    const full = makeCatalogue(
      ids,
      models.map((m) => [
        `${m.provider}/${m.id}`,
        {
          reasoning: m.reasoning,
          ...(m.thinkingLevelMap !== undefined ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        },
      ] as const),
    );
    // A provider that is not configured does not exist. PI's registry carries providers it knows
    // natively whether or not this install ever set them up, and everything downstream — the menu,
    // `suggestModels`, the existence gate, `loadAgentRegistry`'s availability pass — reads this one
    // value, so it is restricted here, once, and they cannot disagree afterwards.
    const restricted =
      state.admission !== undefined ? restrictCatalogue(full, state.admission) : { catalogue: full, dropped: [] };
    state.catalogue = restricted.catalogue;
    available = new Set(restricted.catalogue.ids);
    if (restricted.dropped.length > 0) {
      // Operator-facing, and deliberately NOT in the system prompt: telling the orchestrating model
      // which models it may not have is an invitation to try one. A human needs to know, because
      // "why is that model not on the menu" is otherwise unanswerable.
      const providers = [...new Set(restricted.dropped.map((m) => splitModelId(m).provider))].sort();
      state.problems.push(
        `${restricted.dropped.length} model(s) from provider(s) ${providers.join(", ")} are in this ` +
          `session's model registry but are NOT dispatchable and are not offered: each is missing ` +
          `from config/models.json, from config/routing.json's egress map, or from both` +
          (state.admission?.degraded === true
            ? ` (models.json could not be read, so only the egress map was applied)`
            : ``),
      );
    }
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
    configuredProviders: state.settings.configuredProviders,
  });

  const registry = loadAgentRegistry({
    dirs: registryDirs(cfg, ctx.cwd),
    routing: state.settings.routing,
    config: cfg,
    ...(available !== undefined ? { availableModels: available } : {}),
    // So an agent file naming an unconfigured provider is refused at LOAD with the same named
    // reason a dispatch would give, instead of a bare "not in the model registry".
    ...(state.admission !== undefined ? { admission: state.admission } : {}),
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
      roster: readAgentRoster(agentRosterDirs({ cwd: process.cwd(), homeDir: homedir(), agentDir: configDir() })),
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
        // Only `routing` is load-bearing here. This used to bail when the registry was missing too,
        // which meant a session whose registry failed to load dispatched with NO model resolution at
        // all — the same silent fall-through this rule exists to close, reached by a different door.
        // `agentOf` already returns `undefined` without a registry, so a call-time `model` is still
        // resolved and checked for existence, and a `workflowScript` still gets its floor.
        if (!routing) return { block: false };
        const input = event.input as Record<string, unknown>;
        const def = agentOf(state, event);

        const applied: Record<string, unknown> = {};
        // Set whenever `spec` resolves, independently of whether `applied.model` gets written —
        // "the call already named exactly the model we resolved to" is still a resolution the
        // event log must carry, not only the cases where a rewrite happened. This is what the
        // `logEvent` call below reports as "what did this delegation actually run on, and why".
        let resolvedModel: Record<string, unknown> | undefined;

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
            const target = resolveModelSpec(
              routing,
              spec,
              state.settings.dispatch.defaultTier,
              state.catalogue,
              state.admission,
            );
            provider = target.provider;
            // What effort this will ACTUALLY run at. PI clamps an unsupported level against the
            // model's own vocabulary before the wire (`clampThinkingLevel`,
            // @earendil-works/pi-ai/dist/models.js:562), and it is right to: a gateway that does
            // not serve `reasoning_effort=max` answers 400, so shipping it would abort the run
            // rather than think harder. The clamp was never the defect — the SILENCE was.
            // `_meta.json` records the launch string verbatim (`model: target.model`,
            // pi-subagents/src/runs/foreground/execution.ts:137 and the background twin at
            // runs/background/subagent-runner.ts:255), so a string reading `:max` put `"max"` in
            // the run metadata and `effort max` on the menu for runs that shipped `high`. That
            // read as max for an afternoon of work; it never was.
            //
            // So the suffix is rewritten to the effective level HERE, before the package sees it.
            // That is disclosure, not substitution: the wire value is identical either way (PI would
            // clamp to exactly this), and it is the one field we control that reaches `_meta.json`.
            // The REQUESTED level is not lost — `from` below still carries the string as written,
            // and the audit entry names both.
            const disclosure = catalogueDisclosure(state.catalogue, target.model);
            const effectiveModel = disclosure?.clamped ? disclosure.effectiveModel : target.model;
            // "Then what WOULD serve it?" is the reader's next question every single time, and the
            // registry can answer it. A hint only — nothing below reroutes, and the egress class
            // rides along with every candidate because leaving `internal` for `confidential` or
            // `public` is the operator's call and not a routing optimisation.
            //
            // `configuredProviders` is what keeps the answer honest: the registry alone would
            // volunteer endpoints this install never configured (see `providersServing`).
            const serving = disclosure?.clamped
              ? describeServing(
                  providersServing(state.catalogue, routing, disclosure.requested, state.settings.configuredProviders),
                  disclosure.requested,
                )
              : undefined;
            if (disclosure?.clamped && state.settings.dispatch.onThinkingClamp === "abort") {
              return {
                block: true,
                reason:
                  `refusing this dispatch: it asked for reasoning effort \`${disclosure.requested}\` and ` +
                  `${splitThinkingSuffix(target.model).baseModel} serves only ` +
                  `${disclosure.supported.join(", ")}, so the run would have been silently downgraded to ` +
                  `\`${disclosure.effective}\`. config/dispatch.json sets onThinkingClamp="abort", which ` +
                  `says a downgraded effort is worse than no run here. ${serving} Or ask again at ` +
                  `\`${disclosure.effective}\` to accept what this model can do.`,
              };
            }
            resolvedModel = {
              from: spec,
              to: effectiveModel,
              tier: target.tier,
              ...(disclosure !== undefined
                ? {
                    thinking: {
                      requested: disclosure.requested,
                      effective: disclosure.effective,
                      clamped: disclosure.clamped,
                      ...(disclosure.clamped ? { supported: disclosure.supported } : {}),
                    },
                  }
                : {}),
              // Which kind of write this was. A reader of the bookkeeping cannot tell "we
              // resolved what the call asked for" from "we set a floor the children may still
              // override" without it, and only one of the two is overridable downstream.
              ...(tierScope !== undefined ? { defaultedScope: tierScope } : {}),
            };
            if (input.model !== effectiveModel) {
              input.model = effectiveModel;
              applied.model = resolvedModel;
            }
            if (disclosure?.clamped) {
              report(
                ctx,
                `[pi-config] dispatch: "${agentLabel(input, def)}" asked for reasoning effort ` +
                  `\`${disclosure.requested}\` and will run at \`${disclosure.effective}\` — ` +
                  `${splitThinkingSuffix(target.model).baseModel} does not serve ` +
                  `\`${disclosure.requested}\` (it serves ${disclosure.supported.join(", ")}, per ` +
                  `config/models.json's thinkingLevelMap). PI clamps this before the wire either way; ` +
                  `the model string was rewritten to \`${effectiveModel}\` so the run metadata and this ` +
                  `line agree with what is actually sent. Nothing was rerouted — the model is unchanged. ` +
                  `${serving}`,
                "warning",
              );
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
                // Naming the target as well as the value: a refusal that quotes only a tier word
                // does not say which delegation died, and a fan-out produces several of these.
                `(dispatch target: agent "${agentLabel(input, def)}"; the value "${spec}" came ` +
                `from ${origin}). ` +
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

        // REQ-CTX-22 / `/index`: persist what this delegation actually resolved to, so that
        // "what model did it run on, and why" has an answer beyond the transcript — `/agents`
        // only describes what CAN be dispatched. Only meaningful once a model was resolved: a
        // control action (`action: "status"` and friends) launches nothing and has no model to
        // report. `logEvent` never throws (session-index's own contract) and the session id is
        // fetched defensively, so this can never become a reason a dispatch fails or changes
        // shape. A call refused above never reaches here — that block is already carried by
        // `guardedHandler`'s own audit entry.
        if (resolvedModel !== undefined) {
          const agent = agentLabel(input, def);
          logEvent(dispatchSessionId(ctx), "dispatch", `dispatch.resolve:${agent}`, true, undefined, {
            tool: event.toolName,
            agent,
            provider,
            model: resolvedModel,
            ...(applied.concurrency !== undefined ? { concurrency: applied.concurrency } : {}),
            ...(applied.isolation !== undefined ? { isolation: applied.isolation } : {}),
          });
        }
        return { block: false };
      },
    },
    {
      // A model-authored `outputSchema` that closes itself with `additionalProperties: false`
      // discards a finished run whenever the child answers with MORE than it was asked for, and
      // `pi-subagents` cannot recover from that even when the child immediately retries correctly.
      // `output-schema.ts` carries the transcript this came from and the argument for opening the
      // object rather than tightening the prompt. Never blocks; runs last, after every refusal.
      id: "DSP-SCHEMA",
      evaluate(event, ctx): GuardVerdict {
        if (!isDispatch(event)) return { block: false };
        const input = event.input as Record<string, unknown>;
        const applied = relaxDispatchOutputSchemas(input);
        if (applied.length === 0) return { block: false };
        const agent = firstString(input, AGENT_KEYS) ?? "?";
        report(ctx, `[pi-config] ${describeRelaxation(agent, applied)}`, "info");
        return { block: false };
      },
    },
    {
      // The one rule here that fires on a tool which dispatches nothing: `subagent_wait` blocks,
      // and the package's own default ends that block on any `needs_attention` run, including the
      // two heartbeats (idle, one long tool) that are not a question to the lead. Each of those
      // wakes costs a full context re-read. The default is written onto the call because the
      // package exposes no key for it; `wait-attention.ts` has the cites and the argument. Never
      // blocks, and never overrides an explicit parameter.
      id: "DSP-WAIT",
      evaluate(event, ctx): GuardVerdict {
        if (!state.settings.dispatch.waitTools.includes(event.toolName)) return { block: false };
        const outcome = applyWaitStopOnAttention(event.input as Record<string, unknown>, state.settings.dispatch);
        // Constant text, so `report`'s dedup announces the changed default once per session rather
        // than on every wait: the lead needs to know the semantics, not to be told each time.
        if (outcome?.changed) report(ctx, `[pi-config] ${WAIT_DEFAULT_NOTICE}`, "info");
        return { block: false };
      },
    },
  ];
}

/**
 * Every tier whose declared reasoning effort the resolved model will not serve, as
 * `tier: requested -> effective` lines. Empty when the registry is unavailable — an unknown
 * vocabulary must not be rendered as "nothing is clamped".
 *
 * Exported for `test/dispatch/rules.test.ts`, which asserts the `/agents` line without a session.
 */
export function clampedTiers(state: State): string[] {
  const routing = state.settings.routing;
  if (routing === undefined || state.catalogue === undefined) return [];
  const out: string[] = [];
  for (const [tier, def] of Object.entries(routing.tiers)) {
    const asked = requestedLevel(def.model) ?? def.thinkingLevel;
    if (asked === undefined) continue;
    const disclosure = catalogueDisclosure(state.catalogue, `${splitThinkingSuffix(def.model).baseModel}:${asked}`);
    if (disclosure?.clamped !== true) continue;
    out.push(`${tier} asks ${disclosure.requested}, runs ${disclosure.effective} (serves ${disclosure.supported.join("|")})`);
  }
  return out;
}

/**
 * Mirrors `teammates/index.ts`'s `sessionId()`: a missing or unreachable session id degrades the
 * event log, never the dispatch it is describing.
 */
function dispatchSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}

/** What the call asked for, falling back to what we matched — a refusal has to name the subagent. */
function agentLabel(input: Record<string, unknown>, def: AgentDef | undefined): string {
  return firstString(input, AGENT_KEYS) ?? def?.name ?? "(unnamed)";
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
 * a tier word onto whatever provider id happens to contain it, typically one
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
  // The tiers whose declared effort the model will not actually serve. Shown unconditionally rather
  // than only on dispatch, because the question this answers — "am I really getting the effort
  // routing.json promises?" — is one an operator asks after the fact, not during a call.
  const clamped = clampedTiers(state);
  if (clamped.length > 0) {
    lines.push(`reasoning effort CLAMPED: ${clamped.join("; ")}`);
  }
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

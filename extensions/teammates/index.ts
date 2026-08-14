/**
 * `EXT-25` — teammates: long-lived named child sessions, with a delivery obligation that is part of
 * the spawn path rather than part of a prompt someone hopes was read.
 *
 * What this module is *not*: a dispatcher. `EXT-05` owns sub-agent dispatch and `pi-subagents` owns
 * the machinery under it — discovery, the agent file format, the async fleet, the supervisor channel
 * (`contact_supervisor` / `subagent_supervisor`). None of that is re-implemented here.
 *
 * What is here is the part no package supplies:
 *
 *   1. **The obligation, appended by the runtime.** `runtime.ts` welds `DELIVERY_CONTRACT` into every
 *      child's system prompt, injects `reply_to_lead`, and widens the agent's tool allowlist so the
 *      tool is reachable. An agent file cannot opt out; a caller cannot forget.
 *   2. **Bounded reminders instead of a hard block.** `obligation.ts` hands out at most two, then
 *      releases with `abandoned` recorded — never the stop-hook loop the old harness had to cap.
 *   3. **A distinct tool name.** `teammate`, not `dispatch_agent` and not `subagent`. The two return
 *      contracts differ in exactly the way that produces silent data loss, so they do not share a
 *      name or a mental model, and the tool description says so in the first sentence.
 *   4. **A named session-scoped registry** (`team.ts`), so `reviewer` still means the same live
 *      session three turns later.
 *
 * The rule that *"naming is the opt-in to the expensive mode, exactly inverted from the old
 * default"* is satisfied structurally: there is no way to reach this module without calling a tool
 * called `teammate` and passing a name. Everything else routes through `EXT-05`'s dispatch, which is
 * cheaper and returns its result the ordinary way.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { admissibleProviders } from "../dispatch/catalogue.ts";
import { loadDispatchSettings, registryDirs, type DispatchSettings } from "../dispatch/config.ts";
import { currentDepth, evaluateDepth } from "../dispatch/depth.ts";
import { loadAgentRegistry, type AgentDef, type AgentRegistry } from "../dispatch/registry.ts";
import { ProviderSemaphoreSet } from "../dispatch/semaphore.ts";
import { logEvent } from "../session-index/index.ts";
import { REPLY_TOOL } from "./contract.ts";
import { runExchange } from "./exchange.ts";
import { describeOutcome } from "./obligation.ts";
import { createReplyTool, type TeammateSpawner } from "./runtime.ts";
import { buildSpawnRequest } from "./spawn.ts";
import { spillReport } from "./spill.ts";
import { TeamRegistry, TeammateError } from "./team.ts";

export const id = "teammates";

export interface State {
  registry?: TeamRegistry;
  agents?: AgentRegistry;
  settings: DispatchSettings;
  semaphores?: ProviderSemaphoreSet;
  spawner: TeammateSpawner;
  problems: string[];
  /** Teammates already announced as stranded, so `turn_end` says it once and not every turn. */
  announced: Set<string>;
}

export interface RegisterOptions {
  /**
   * The spawner that opens a teammate's session. Defaults to the refusing spawner below; pass
   * `createSdkSpawner({ resolveModel })` from `./runtime.ts` to make `spawn` actually start a
   * session. Also the seam the tests inject a scripted spawner through.
   */
  readonly spawner?: TeammateSpawner;
}

/**
 * The spawner this extension falls back to when nobody supplied one, and the reason `teammate`
 * refuses out of the box.
 *
 * `createSdkSpawner` (in `./runtime.ts`) needs a `resolveModel` callback to turn an agent's
 * `provider/id` into the model object the SDK session wants, and there is no way to build that
 * callback from inside an extension: it comes from the host's model registry. Constructed without
 * one, it throws *after* the tool call has been accepted, from inside the SDK, with a message that
 * blames the agent file or the provider config — neither of which is at fault.
 *
 * So the refusal is moved to the boundary, where it can say something useful. It names the two
 * supported ways to delegate, and it names the single line that turns spawning back on for anyone
 * embedding this tree in a host that *can* resolve models. Wiring a `resolveModel` in here by
 * guessing is the one thing not done: that trades a hard failure for a teammate silently running on
 * a model its agent file never asked for.
 */
function refusingSpawner(): TeammateSpawner {
  return () => {
    throw new TeammateError(
      `teammate(action="spawn") is not wired up in this installation — nothing was started. ` +
        `Delegate with the \`subagent\` tool instead: one call per agent, or a \`workflowScript\` ` +
        `using \`runs.all([...])\` to fan out, each child naming its own fully-qualified \`model\` ` +
        `(an id from config/routing.json), never a bare tier word. To enable spawning, register ` +
        `this extension with a spawner that can resolve models: ` +
        `register(pi, { spawner: createSdkSpawner({ resolveModel }) }).`,
    );
  };
}

export function register(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  const state: State = {
    settings: loadDispatchSettings(),
    spawner: options.spawner ?? refusingSpawner(),
    problems: [],
    announced: new Set(),
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      await onSessionStart(ctx, state);
    } catch (err) {
      // A teammate registry that failed to build must refuse spawns by name, not take the session
      // down; `requireReady` below reads the same problem list.
      const line = `[pi-config] teammates: session_start failed: ${describeError(err)}`;
      state.problems.push(line);
      report(ctx, "teammates:session_start", line);
    }
  });

  pi.registerTool({
    name: "teammate",
    label: "Teammate",
    description:
      "Create or message a long-lived NAMED teammate session. A teammate is not a sub-agent: it " +
      "persists across turns, it is addressed by name, and its final message is delivered nowhere — " +
      "it reports through reply_to_lead, which this runtime injects. Use it only when you must talk " +
      "to the same agent repeatedly; a single question is a normal sub-agent dispatch, which is cheaper.",
    promptSnippet: "Create or message a persistent named teammate",
    promptGuidelines: [
      "Use teammate only for multi-turn collaboration with the same agent; one question is a normal sub-agent dispatch.",
      "Always read a teammate's reply before sending it the next message.",
      `A teammate that is reported as UNDELIVERED produced nothing you can use — read its transcript or re-ask it.`,
      "Close a teammate with teammate(action=\"close\") as soon as you are done with it; each one is a full extra session.",
    ],
    parameters: Type.Object({
      action: StringEnum(["spawn", "send", "list", "close"] as const, {
        description: "what to do",
      }),
      name: Type.Optional(
        Type.String({ description: "teammate handle, e.g. 'reviewer'; required except for list" }),
      ),
      agent: Type.Optional(
        Type.String({ description: "agent name from the registry; required for spawn" }),
      ),
      message: Type.Optional(Type.String({ description: "what to ask; required for send" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const registry = requireReady(state);

      switch (params.action) {
        case "list":
          return {
            content: [{ type: "text" as const, text: registry.render() }],
            details: { team: registry.names(), stranded: registry.stranded().map((s) => s.record.name) },
          };

        case "spawn": {
          const name = requireArg(params.name, "name", "spawn");
          const agentName = requireArg(params.agent, "agent", "spawn");
          registry.assertCanSpawn(name);
          const def = resolveAgent(state, agentName);
          assertDepthAllows(state, name);

          const request = buildSpawnRequest(name, def, ctx.cwd);
          const record = registry.add({
            name,
            agent: agentName,
            spawnedAt: Date.now(),
            session: await state.spawner({
              ...request,
              customTools: [createReplyTool(name, registry)],
            }),
          });
          logEvent(sessionId(ctx), "dispatch", `teammate.spawn:${name}`, true, undefined, {
            agent: agentName,
            model: def.target?.model,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `teammate "${name}" (${agentName}${def.target ? `, ${def.target.model}` : ""}) is live. ` +
                  `It has been told, by this runtime, that only ${REPLY_TOOL} delivers its work. ` +
                  `Transcript: ${record.session.sessionFile ?? `(unsaved session ${record.session.sessionId})`}.`,
              },
            ],
            details: { name, agent: agentName, model: def.target?.model, sessionId: record.session.sessionId },
          };
        }

        case "send": {
          const name = requireArg(params.name, "name", "send");
          const message = requireArg(params.message, "message", "send");
          const record = registry.require(name);
          const provider = providerOf(state, record.agent);
          const started = Date.now();

          const result = await runInLane(state, provider, () =>
            runExchange({
              registry,
              name,
              message,
              signal,
              onUpdate: (line) =>
                onUpdate?.({ content: [{ type: "text", text: line }], details: undefined }),
            }),
          );
          const ms = Date.now() - started;
          const outcome = result.outcome;
          logEvent(sessionId(ctx), "dispatch", `teammate.send:${name}`, outcome.phase !== "abandoned", ms, {
            phase: outcome.phase,
            reminders: outcome.reminders,
          });

          if (outcome.delivery === undefined) {
            state.announced.add(name);
            // Fail loud. This is the 488f77ad shape and it must never read like an empty answer.
            throw new TeammateError(
              [
                `teammate "${name}" (agent ${record.agent}) did not deliver: ${describeOutcome(outcome)}.`,
                `Its work, if any, is in its transcript: ${result.sessionFile ?? `(unsaved session ${record.session.sessionId})`}.`,
                result.salvage
                  ? `Its last message was, UNVERIFIED and not a delivery — do not treat it as the report:\n${clip(result.salvage)}`
                  : `It produced no final message to salvage.`,
                `Re-ask it with teammate(action="send"), or close it and dispatch a normal sub-agent instead.`,
              ].join("\n"),
              name,
            );
          }

          const spilled = await spillReport(sessionId(ctx), name, outcome.delivery.report);
          const head =
            outcome.delivery.status === "blocked"
              ? `teammate "${name}" reports it is BLOCKED:\n\n`
              : "";
          return {
            content: [{ type: "text" as const, text: `${head}${spilled.text}` }],
            details: {
              name,
              agent: record.agent,
              status: outcome.delivery.status,
              reminders: outcome.reminders,
              report: outcome.delivery.report,
              ...(spilled.file !== undefined ? { reportFile: spilled.file } : {}),
            },
          };
        }

        case "close": {
          const name = requireArg(params.name, "name", "close");
          const record = registry.require(name);
          const stranded = registry.stranded().some((s) => s.record.name === name);
          await registry.remove(name);
          state.announced.delete(name);
          logEvent(sessionId(ctx), "dispatch", `teammate.close:${name}`, !stranded);
          return {
            content: [
              {
                type: "text" as const,
                text: stranded
                  ? `closed "${name}" with work that never reached you; its transcript is at ` +
                    `${record.session.sessionFile ?? `(unsaved session ${record.session.sessionId})`}.`
                  : `closed "${name}".`,
              },
            ],
            details: { name, stranded },
          };
        }
      }
    },
  });

  pi.registerCommand("teammates", {
    description: "Live named teammates: who is there, what they delivered, and what they did not",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const registry = state.registry;
      const lines = [
        registry === undefined
          ? `teammates: not ready — ${state.problems.join(" | ") || "session_start has not run"}`
          : registry.render(),
      ];
      const stranded = registry?.stranded() ?? [];
      if (stranded.length > 0) {
        lines.push("", "UNDELIVERED work:");
        for (const s of stranded) {
          lines.push(
            `  ${s.record.name}: ${s.why}`,
            `    transcript: ${s.record.session.sessionFile ?? `(unsaved session ${s.record.session.sessionId})`}`,
          );
        }
      }
      if (state.problems.length > 0) lines.push("", ...state.problems.map((p) => `problem: ${p}`));
      ctx.ui.notify(lines.join("\n"), stranded.length > 0 ? "warning" : "info");
    },
  });

  /**
   * The needs-attention notice. On the old harness the lead's only signal was 22 *empty* idle
   * notifications; here a teammate that is stranded is named, once, with the file to read.
   */
  pi.on("turn_end", async (_event, ctx) => {
    try {
      const stranded = state.registry?.stranded() ?? [];
      const fresh = stranded.filter((s) => !state.announced.has(s.record.name));
      if (fresh.length === 0) return;
      for (const s of fresh) state.announced.add(s.record.name);
      pi.sendMessage(
        {
          customType: "teammate-undelivered",
          content: [
            {
              type: "text",
              text:
                `Teammate work that has not reached you: ` +
                fresh
                  .map(
                    (s) =>
                      `${s.record.name} (${s.why}; transcript ${s.record.session.sessionFile ?? "unsaved"})`,
                  )
                  .join("; ") +
                `. Use teammate(action="list") or /teammates.`,
            },
          ],
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    } catch (err) {
      report(ctx, "teammates:turn_end", `[pi-config] teammates: turn_end failed: ${describeError(err)}`);
    }
  });

  /**
   * Teardown. Every child session is disposed, and anything that never delivered is named on the
   * way out with the path to its transcript — a stranded report that nobody is told about is the
   * original failure, and it is not acceptable to reproduce it at exit.
   */
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const registry = state.registry;
      if (registry === undefined) return;
      const stranded = registry.stranded();
      if (stranded.length > 0) {
        const line =
          `[pi-config] teammates: ${stranded.length} teammate(s) ended with undelivered work — ` +
          stranded
            .map(
              (s) => `${s.record.name} (${s.why}) -> ${s.record.session.sessionFile ?? "unsaved session"}`,
            )
            .join("; ");
        emitNotice(ctx, line, "warning");
        logEvent(sessionId(ctx), "dispatch", "teammate.stranded", false, undefined, {
          count: stranded.length,
          names: stranded.map((s) => s.record.name),
        });
      }
      await registry.clear();
      state.registry = undefined;
      state.announced.clear();
    } catch (err) {
      report(ctx, "teammates:session_shutdown", `[pi-config] teammates: shutdown failed: ${describeError(err)}`);
    }
  });
}

// --------------------------------------------------------------------------------------------

async function onSessionStart(ctx: ExtensionContext, state: State): Promise<void> {
  const sid = sessionId(ctx);
  const cfg = state.settings.dispatch;
  state.registry = new TeamRegistry({ ownerSessionId: sid || "(no session id)" });

  if (state.settings.routing === undefined) {
    state.problems.push(...state.settings.problems);
    state.problems.push(
      `config/routing.json is unusable, so no agent's model can be resolved; ` +
        `teammate(action="spawn") is refused. Nothing was guessed.`,
    );
    return;
  }
  const routing = state.settings.routing;

  let available: Set<string> | undefined;
  try {
    available = new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));
  } catch (err) {
    state.problems.push(
      `model registry unavailable (${describeError(err)}); teammate models are resolved but not ` +
        `checked for existence`,
    );
  }

  // A teammate is a dispatch, so the admission rule applies here exactly as it does for subagents:
  // a provider absent from `config/models.json` and from `routing.json`'s `egress` map is not
  // somewhere a teammate can be spawned, and the file that names one is refused here rather than in
  // a live session much later. Without this argument the gate would be enforced for subagents and
  // silently skipped for teammates — the same registry loader, two different answers.
  state.agents = loadAgentRegistry({
    dirs: registryDirs(cfg, ctx.cwd),
    routing,
    config: cfg,
    admission: admissibleProviders(routing, state.settings.configuredProviders),
    ...(available !== undefined ? { availableModels: available } : {}),
  });
  state.semaphores = new ProviderSemaphoreSet(routing.concurrency, cfg.concurrencyDefault);
}

function requireReady(state: State): TeamRegistry {
  if (state.registry === undefined) {
    throw new TeammateError(
      `teammates: not ready — ${state.problems.join(" | ") || "session_start has not run yet"}.`,
    );
  }
  return state.registry;
}

function requireArg(value: string | undefined, arg: string, action: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new TeammateError(`teammate: action="${action}" needs a non-empty "${arg}".`);
  }
  return trimmed;
}

/**
 * The agent must resolve *before* a session is opened. `EXT-05`'s registry already answers "would
 * dispatching this agent work right now" — the file parses, and its model is being served — so this
 * refuses by name with that verdict rather than discovering it after a child is running.
 */
function resolveAgent(state: State, agentName: string): AgentDef {
  if (state.agents === undefined) {
    throw new TeammateError(
      `teammate: the agent registry did not load, so "${agentName}" cannot be validated; ` +
        `spawn refused. ${state.problems.join(" | ")}`,
    );
  }
  const def = state.agents.byName.get(agentName);
  if (def === undefined) {
    const usable = state.agents.agents.filter((a) => a.status === "ok").map((a) => a.name);
    throw new TeammateError(
      `teammate: no agent "${agentName}". Available: ${usable.join(", ") || "(none)"}.`,
    );
  }
  if (def.status !== "ok") {
    throw new TeammateError(
      `teammate: agent "${agentName}" is ${def.status} and cannot be spawned: ${def.problem ?? "no reason recorded"}`,
    );
  }
  return def;
}

/** A teammate is a child agent run, so the same nesting limit applies as to a dispatch. */
function assertDepthAllows(state: State, name: string): void {
  const verdict = evaluateDepth(currentDepth(), state.settings.dispatch.maxDepth);
  if (!verdict.blocked) return;
  throw new TeammateError(
    `teammate "${name}" refused: ${verdict.reason} A teammate is a full child session and counts ` +
      `against the same limit.`,
    name,
  );
}

function providerOf(state: State, agentName: string): string {
  return state.agents?.byName.get(agentName)?.target?.provider ?? "unknown";
}

/** The per-provider concurrency lane `EXT-05` owns. Absent it, the exchange still runs. */
function runInLane<T>(state: State, provider: string, fn: () => Promise<T>): Promise<T> {
  const semaphores = state.semaphores;
  return semaphores === undefined ? fn() : semaphores.run(provider, fn);
}

function sessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    // A missing session id degrades scratch paths and the event log, not the exchange itself.
    return "";
  }
}

const SALVAGE_CHARS = 2000;

function clip(text: string): string {
  return text.length <= SALVAGE_CHARS
    ? text
    : `${text.slice(0, SALVAGE_CHARS)}\n[...clipped at ${SALVAGE_CHARS} chars; read the transcript for the rest]`;
}

function report(ctx: ExtensionContext | undefined, key: string, line: string): void {
  // One channel, whichever this run mode has — see `lib/announce.ts`.
  surfaceOnce(ctx, key, () => emitNotice(ctx, line, "error"));
}

/**
 * The spawn path — the one place a teammate session is ever created, and therefore the one place
 * the delivery obligation can be made structural rather than advisory.
 *
 * Three things are welded on here and cannot be opted out of by a caller, a prompt or an agent
 * file:
 *
 *   1. `DELIVERY_CONTRACT` is appended to the child's system prompt (`appendSystemPrompt`).
 *   2. `reply_to_lead` is injected as a custom tool. It is the sole write path into the obligation.
 *   3. If the agent declares a tool allowlist, `reply_to_lead` is added to it. Without this a
 *      teammate whose agent file says `tools: [read, grep]` would be *structurally incapable* of
 *      delivering — the exact silent-loss shape this design exists to prevent, reintroduced through a
 *      field nobody would think to check.
 *
 * `TeammateSpawner` is a seam, not decoration: the SDK implementation opens a real model session
 * and costs money, so every test in `test/teammates/` drives a fake through the same interface and
 * the obligation logic is verified without a token.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { REPLY_TOOL } from "./contract.ts";
import type { DeliveryStatus } from "./obligation.ts";

/** The subset of `AgentSession` a teammate needs. Kept small so a fake is honest. */
export interface TeammateSession {
  readonly sessionId: string;
  /** Where the transcript lives. Named in every abandonment report — the work must stay findable. */
  readonly sessionFile: string | undefined;
  prompt(text: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Salvage only. Never treated as a delivery; see `index.ts`'s abandonment path. */
  lastAssistantText(): string | undefined;
  dispose(): void;
}

export interface SpawnRequest {
  readonly name: string;
  readonly agent: string;
  readonly cwd: string;
  /** Persona block first, delivery contract last — recency matters and the contract must win. */
  readonly systemPromptAppend: readonly string[];
  /** `provider/id`, already resolved and egress-checked by the caller. */
  readonly model?: { readonly provider: string; readonly id: string };
  /** Allowlist from the agent file, already widened with `reply_to_lead` by the caller. */
  readonly tools?: readonly string[];
  readonly customTools: readonly ToolDefinition[];
}

export type TeammateSpawner = (req: SpawnRequest) => Promise<TeammateSession>;

/** What the reply tool writes into. Implemented by `index.ts` over the live team registry. */
export interface DeliverySink {
  deliver(
    teammate: string,
    report: string,
    status: DeliveryStatus,
  ): { readonly accepted: boolean; readonly note: string };
}

/**
 * The delivery tool, built per teammate so the name is closed over and a child cannot deliver on
 * another child's behalf.
 *
 * `promptSnippet` and `promptGuidelines` are set because the child sees them in its own default
 * system prompt's tool section — a second, independent statement of the obligation that survives
 * even if the append block is compacted away.
 */
export function createReplyTool(teammate: string, sink: DeliverySink): ToolDefinition {
  return defineTool({
    name: REPLY_TOOL,
    label: "Reply to lead",
    description:
      "Deliver your full report to the lead. This is the ONLY way your work reaches anyone: your " +
      "final assistant message is discarded. Call it once you are done, or with status=\"blocked\" " +
      "and the reason if you cannot finish.",
    promptSnippet: "Deliver your report to the lead (your final message is discarded)",
    promptGuidelines: [
      `Call ${REPLY_TOOL} before you stop; without it your work is lost.`,
      `Put the complete report in the report argument — prose outside it is not delivered.`,
      `Use ${REPLY_TOOL} with status="blocked" instead of stopping silently when you cannot proceed.`,
    ],
    parameters: Type.Object({
      report: Type.String({ description: "the complete report, not a summary of one" }),
      status: Type.Optional(
        StringEnum(["complete", "blocked"] as const, {
          description: 'defaults to "complete"; use "blocked" when you could not finish',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const status: DeliveryStatus = params.status === "blocked" ? "blocked" : "complete";
      const verdict = sink.deliver(teammate, params.report, status);
      return {
        content: [{ type: "text" as const, text: verdict.note }],
        details: { teammate, status, accepted: verdict.accepted, chars: params.report.length },
      };
    },
  });
}

export interface SdkSpawnerOptions {
  /**
   * Whether the child session loads the discovered extension tree.
   *
   * `false` (the default) is deliberate and is a real capability reduction, recorded in the
   * manifest: a teammate is created *from inside* this extension tree, in this process, so loading
   * it again would re-register the teammate tool inside the teammate, re-register the guard's
   * `tool_call` handlers, and let a child's `model_select` reach the lead's statusline (V-09).
   * A teammate therefore has PI's built-in tools plus `reply_to_lead`, and nothing else.
   */
  readonly childExtensions?: boolean;
  /** Injected by tests. Defaults to the process's agent dir. */
  readonly agentDir?: string;
  /** Resolves `provider/id` to the SDK's model object. Defaults to none (session default model). */
  readonly resolveModel?: (provider: string, id: string) => unknown;
}

/** The real spawner. Opens a full PI session per teammate. */
export function createSdkSpawner(options: SdkSpawnerOptions = {}): TeammateSpawner {
  return async (req) => {
    const agentDir = options.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.create(req.cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: req.cwd,
      agentDir,
      settingsManager,
      noExtensions: options.childExtensions !== true,
      appendSystemPrompt: [...req.systemPromptAppend],
    });
    await loader.reload();

    const model =
      req.model !== undefined && options.resolveModel !== undefined
        ? options.resolveModel(req.model.provider, req.model.id)
        : undefined;
    if (req.model !== undefined && model === undefined) {
      // Fail loud (REQ-PRV-32): a teammate quietly running on the session's default model instead
      // of the one its agent file names is precisely the "looks like the real thing" failure the
      // dispatch registry refuses `fallbackModels` for.
      throw new Error(
        `teammate "${req.name}" (agent ${req.agent}): model ${req.model.provider}/${req.model.id} ` +
          `could not be resolved from the model registry, so the teammate was not started. ` +
          `Fix the agent's model: line or the provider's configuration; nothing was substituted.`,
      );
    }

    const { session } = await createAgentSession({
      cwd: req.cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      customTools: [...req.customTools] as ToolDefinition[],
      ...(model !== undefined ? { model: model as never } : {}),
      ...(req.tools !== undefined ? { tools: [...req.tools] } : {}),
    });

    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      // `PromptOptions` carries no `AbortSignal` at 0.84.0 — `AgentSession.abort()` is the only
      // cancellation path — so the lead's signal is bridged onto it here rather than dropped.
      prompt: async (text, opts) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          await session.abort();
          return;
        }
        const onAbort = (): void => {
          void session.abort();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await session.prompt(text, { source: "extension" });
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      },
      lastAssistantText: () => session.getLastAssistantText(),
      dispose: () => session.dispose(),
    };
  };
}

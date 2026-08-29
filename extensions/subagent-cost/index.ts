/**
 * The subagent half of the statusline's money pair. The package's `cost` segment shows what the
 * *main* agent spent; this publishes what its children spent, beside it, as its own extension
 * status. See `summary.ts` for why the two numbers are separate and why the package cannot know
 * about the second one.
 *
 * ADOPTED PACKAGE, NOT FORKED. `@narumitw/pi-statusline` is a dependency, and the supported seam
 * into its footer is `ctx.ui.setStatus(key, text)` plus a `config/pi-statusline.json`
 * `extensionStatusIcons` entry. A patch under `node_modules` would survive exactly until the next
 * install, so nothing here touches it.
 *
 * Follows the non-index module contract (`export const id` + `export function register(pi)`) and
 * is composed by `extensions/index.ts`, like every other module in this tree.
 *
 * POSTURE: this is a footer. Every handler is a lifecycle hook and every one of them is guarded —
 * a bug in an optional cost display must never take down a turn, let alone the session. There is
 * no user-initiated command here, so unlike `quota` there is no fail-loud half to balance it.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolExecutionStartEvent,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { registerMessageCost } from "./message-cost.ts";
import { renderSubagentCost, summarizeSubagentCost } from "./summary.ts";
import { describeError } from "../lib/once.ts";

export const id = "subagent-cost";

const STATUS_KEY = "subagent-cost";

/** The tools whose activity can change the number. Anything else is not worth a re-sum. */
const WATCHED_TOOLS = new Set(["subagent", "subagent_wait"]);

export function register(pi: ExtensionAPI): void {
  // The same money question, asked per message rather than per session.
  registerMessageCost(pi, isSubscriptionModel);

  const refresh = (ctx: ExtensionContext): void => {
    const summary = summarizeSubagentCost(ctx.sessionManager.getEntries(), (modelRef) =>
      isSubscriptionModel(ctx, modelRef),
    );
    ctx.ui.setStatus(STATUS_KEY, renderSubagentCost(summary));
  };

  // `session_start` seeds from the file, so a resumed or forked session shows the children it
  // already paid for rather than restarting at zero beside a parent total that did not.
  pi.on("session_start", guarded("session_start", refresh));
  // A launch going out is what turns the pending count on; a result coming back is what lands the
  // money. Both are gated on the tool name: re-summing on every `read` would be pure waste.
  pi.on(
    "tool_execution_start",
    guarded("tool_execution_start", (ctx, event: ToolExecutionStartEvent) => {
      if (WATCHED_TOOLS.has(event.toolName)) refresh(ctx);
    }),
  );
  pi.on(
    "tool_result",
    guarded("tool_result", (ctx, event: ToolResultEvent) => {
      if (WATCHED_TOOLS.has(event.toolName)) refresh(ctx);
    }),
  );
  // Backstop for anything the two above miss — a compaction, a branch, a run collected by a path
  // that does not surface as a tool result here.
  pi.on("turn_end", guarded("turn_end", refresh));
}

/**
 * Resolves a child's `provider/model-id` reference against the live registry to ask the same
 * question the package asks about the parent: is this spend billed against a seat rather than a
 * card. Unknown or unparseable references answer `false` — an unmarked figure is a smaller error
 * than a `(sub)` on a model that is genuinely metered.
 */
function isSubscriptionModel(ctx: ExtensionContext, modelRef: string): boolean {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) return false;
  const provider = modelRef.slice(0, slash);
  const rest = modelRef.slice(slash + 1);
  // Children carry the thinking level on the reference (`provider/model-id:high`); the registry
  // is keyed on the bare model id, so fall back to the reference with it stripped.
  const colon = rest.lastIndexOf(":");
  const candidates = colon > 0 ? [rest, rest.slice(0, colon)] : [rest];
  for (const modelId of candidates) {
    const model = ctx.modelRegistry.find(provider, modelId);
    if (model) return ctx.modelRegistry.isUsingOAuth(model);
  }
  return false;
}

/** Never lets a footer bug propagate into the session lifecycle it observes — mirrors
 *  `extensions/quota/index.ts`'s `guardedLifecycle`. */
function guarded<E extends SessionStartEvent | TurnEndEvent | ToolExecutionStartEvent | ToolResultEvent>(
  reason: string,
  run: (ctx: ExtensionContext, event: E) => void,
): (event: E, ctx: ExtensionContext) => void {
  return (event, ctx) => {
    try {
      run(ctx, event);
    } catch (err) {
      process.stderr.write(
        `[pi-config] subagent-cost: ${reason} refresh failed: ${describeError(err)}\n`,
      );
    }
  };
}

/**
 * The gate: end the session the first time a model bills tokens whose price nobody declared.
 *
 * `authorship.ts` carries the reasoning about *what* is wrong and how the verdict is reached.
 * This file is the wiring, and it makes three choices worth stating.
 *
 * **Why `message_end` and not `session_start`.** A startup check would have to decide whether an
 * unpriced model matters before knowing whether it will be used, and would have to fire on every
 * unpriced model in the file, including the ones that are unpriced on purpose. Waiting for
 * the response means the evidence exists when the gate fires: this model, this many tokens, and a
 * status line about to claim they were free. It is also the earliest moment at which that evidence
 * exists, which is not the same as early: on a fresh install it is turn one, and the turn was
 * billed before the gate could read it. That cost is why the same question is also asked without
 * evidence, statically, by `bin/rules/pc-27-declared-models-are-priced.mjs` during install.
 *
 * **Why the verdict is re-read from `models.json` rather than carried on the model.** The
 * substituted-vs-authored bit is destroyed inside PI's provider composer, which is in
 * `node_modules` and not ours to change. `models.json` still has it. Nothing downstream branches
 * on a `cost` field to recover it, and nothing should: a cost object that some readers treat as
 * data and others as a sentinel is how this whole class of bug starts.
 *
 * **Why `ctx.abort()` and not `ctx.shutdown()`.** Abort stops the run and leaves the notification
 * on screen; shutdown exits the process from inside an event handler and takes the TUI — and the
 * message — with it. The operator needs to read why. In headless mode there is no TUI to preserve,
 * so the exit code carries it instead, exactly as `provider-error.ts` does.
 */
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

import { configPaths } from "../dispatch/config.ts";
import { surfaceOnce } from "../lib/once.ts";
import {
  billedTokens,
  classifyModelCost,
  formatCostSubstitution,
  summariseCostSubstitution,
  type CostSubstitutionReport,
} from "./authorship.ts";

export const id = "cost-gate";

/** Same test seam `credentials.ts` and `dispatch/config.ts` use. */
function resolveModelsJson(): { readonly raw: unknown; readonly source: string } | undefined {
  const override = process.env.PI_CONFIG_MODELS_JSON;
  const found = configPaths("models.json", override).find((p) => existsSync(p));
  if (found === undefined) return undefined;
  try {
    return { raw: JSON.parse(readFileSync(found, "utf8")), source: found };
  } catch {
    // Unreadable or malformed. `no-opinion` by the same rule the classifier applies: this gate
    // never fires on a guess, and a broken models.json is `/doctor`'s report to make.
    return undefined;
  }
}

/** Injectable for the test, which must not abort a real session or write to a real terminal. */
export interface GateSinks {
  readonly log?: (line: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly readModels?: () => { readonly raw: unknown; readonly source: string } | undefined;
}

/**
 * One response, judged. Exported for the test; `register` is the only production caller.
 *
 * Never throws. It runs inside a `message_end` handler, and a gate that crashes the host while
 * reporting an accounting error has made things worse than the error it found.
 *
 * @returns true when the gate fired.
 */
export function judgeResponse(
  event: MessageEndEvent,
  ctx: ExtensionContext | undefined,
  sinks: GateSinks = {},
): boolean {
  const message = event.message as {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    usage?: unknown;
  };
  if (message.role !== "assistant") return false;

  const tokens = billedTokens(message.usage);
  if (tokens <= 0) return false;

  const provider = typeof message.provider === "string" ? message.provider : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  // A response that does not say which model produced it cannot be checked against a per-model
  // declaration. Silence beats naming the wrong one.
  if (provider === undefined || model === undefined) return false;

  const models = (sinks.readModels ?? resolveModelsJson)();
  if (models === undefined) return false;

  const verdict = classifyModelCost(models.raw, provider, model);
  if (verdict.verdict !== "substituted") return false;

  const report: CostSubstitutionReport = {
    provider,
    model,
    source: models.source,
    missing: verdict.missing,
    tokens,
  };

  // Keyed by provider/model rather than by session: switching to a second unpriced model is a
  // different undeclared price, and the operator has to fix both entries.
  const fired = surfaceOnce(ctx, `${id}:${provider}/${model}`, () => {
    const write = sinks.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
    write(formatCostSubstitution(report));
    if (ctx?.hasUI) ctx.ui.notify(summariseCostSubstitution(report), "error");
    if (ctx?.hasUI === false) {
      const setExitCode = sinks.setExitCode ?? ((code: number) => void (process.exitCode = code));
      setExitCode(1);
    }
    ctx?.abort();
  });
  return fired;
}

export function register(pi: ExtensionAPI): void {
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    try {
      judgeResponse(event, ctx);
    } catch {
      // See the contract above: this handler is not allowed to throw.
    }
  });
}

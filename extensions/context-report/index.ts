/**
 * `/context` — the wiring. All arithmetic and all formatting live in `report.ts`, which has no PI
 * import and is therefore unit-testable; this file only collects the live values and hands them
 * over. See `report.ts` for the measurements that justify the command existing at all.
 *
 * **Where each value comes from, because they are not all on the same object.**
 * `registerCommand`'s handler receives an `ExtensionCommandContext`
 * (`dist/core/extensions/types.d.ts:850`), which extends the base context with
 * `getSystemPromptOptions()` — declared on the command context only, since PI treats it as safe
 * only in user-initiated commands. `getSystemPrompt()` and `getContextUsage()` are on the base
 * context. `getAllTools()` is on **`ExtensionAPI`**, not on either context
 * (`types.d.ts:861,943`), so it is reached through the captured `pi` rather than through `ctx`.
 *
 * **Fails open, and reports the failure as the failure it is.** A report is a diagnostic; a
 * diagnostic that takes the session down is worse than the missing number. Any throw from PI's
 * accessors degrades to a one-line notice naming the cause, never a rethrow. `surfaceOnce` is
 * deliberately NOT used: this is a command the operator just typed, so silence on a second
 * invocation would read as success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { emitNotice } from "../lib/announce.ts";
import { describeError } from "../lib/once.ts";
import { CONFIG_DIR_NAME, configDir } from "../lib/paths.ts";
import { readKeepRecentTokens, readReserveTokens } from "../compaction/threshold.ts";
import {
  buildContextReport,
  formatContextReport,
  type SystemPromptOptionsInput,
  type ToolInput,
} from "./report.ts";

export const id = "context-report";

/**
 * `compaction.enabled` is not on `ExtensionAPI` either, and unlike the two numeric keys it has no
 * consumer here beyond suppressing a trigger line that would otherwise be wrong. Read from the
 * same layers PI reads, defaulting to PI's own default of `true`.
 */
export function readCompactionEnabled(agentDir: string, cwd: string): boolean {
  for (const path of [join(cwd, CONFIG_DIR_NAME, "settings.json"), join(agentDir, "settings.json")]) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { compaction?: { enabled?: unknown } };
      const value = raw?.compaction?.enabled;
      if (typeof value === "boolean") return value;
    } catch {
      // Missing or unparseable: PI surfaces its own settings errors; fall through to the default.
    }
  }
  return true;
}

export function register(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Break down what occupies the context window and whether /compact would run",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const systemPrompt = ctx.getSystemPrompt() ?? "";
        const options = (ctx.getSystemPromptOptions() ?? {}) as SystemPromptOptionsInput;
        const tools = (pi.getAllTools() ?? []) as ReadonlyArray<ToolInput>;
        const usage = ctx.getContextUsage();

        const agentDir = configDir();
        const resolveArgs = { agentDir, cwd: ctx.cwd, configDirName: CONFIG_DIR_NAME };
        const reserve = readReserveTokens(resolveArgs);
        const keepRecent = readKeepRecentTokens(resolveArgs);

        const report = buildContextReport({
          systemPrompt,
          options,
          tools,
          usage,
          reserveTokens: reserve.value,
          keepRecentTokens: keepRecent.value,
          compactionEnabled: readCompactionEnabled(agentDir, ctx.cwd),
        });

        emitNotice(ctx, formatContextReport(report, options.contextFiles?.length ?? 0), "info");
      } catch (err) {
        emitNotice(ctx, `[pi-config] context: report failed — ${describeError(err)}`, "error");
      }
    },
  });
}

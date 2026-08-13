/**
 * `EXT-15` — the declarative hook layer, fully custom (the `pi-yaml-hooks` adoption was
 * cancelled; see `docs/DENYLIST.md` §4a). A colleague adds a guard by editing YAML, never
 * TypeScript. Deliberately not expressive enough to become a language — five fields
 * (`event`/`match.tool`/`match.pattern`/`action`/`reason`) plus `run` for the one action that
 * shells out. `schema.ts` owns validation, `run.ts` owns the fail-closed script executor, this
 * file owns loading and the three event bindings (`tool_call`, `input`, `session_start`).
 *
 * **The one inversion that matters.** Every other `tool_call` handler in this tree
 * (`guard.ts`) registers with `onInternalError: "open"` — REQ-EXT-16's default, so our own bug
 * never blanket-blocks every tool call. This module is the deliberate exception, for the reason
 * `guarded-handler.ts`'s own docstring names: "a rule whose absence is itself unsafe." A
 * declarative guard that silently stops applying *is* pi-yaml-hooks' bug. So `onInternalError`
 * is `"closed"` here, and every one of the four failure classes that made the package fail open
 * — evaluation throws, action throws, bash times out, script missing — blocks instead
 * (`docs/DENYLIST.md` §4a, findings #1-#4).
 *
 * **`input` has no platform-level fail-closed wrapper.** PI's own `emitInput` already catches a
 * throwing `input` handler and continues with the text unchanged (see `input-transform.ts`'s
 * note) — there is no "closed" option to ask for, because the platform's failure mode for this
 * event is baked in as fail-open. So this module wraps its own `input` handler in its own
 * try/catch and returns `{action:"handled"}` (swallow the message) on any internal error,
 * rather than letting the exception reach PI's fail-open catch.
 *
 * **A malformed hooks.yaml FILE degrades this module to "no hooks" — it does NOT contain the
 * session.** Changed 2026-08-11 by owner decision. It used to set a `refused` flag that blocked
 * every subsequent `tool_call`, swallowed every `input`, and called `ctx.shutdown()`, on the
 * reasoning of `docs/DENYLIST.md` §4a finding #5 ("a hooks.yaml that fails to parse → every tool
 * call proceeds unhooked"). That reasoning treated this file as the last line of defence, which it
 * is not: `guard.ts` (`EXT-03`) owns the hard gates — `DB-RM-ROOT` and the rest — and it is a
 * separate module that keeps working when this one has nothing loaded. `hooks.yaml` is the
 * operator-editable convenience layer on top of that floor.
 *
 * The practical cost of the old polarity was the whole argument against it: one typo in a
 * hand-edited YAML file locked the operator out of `bash`, `write` and `edit` for the entire
 * session — a config mistake escalated into a containment, with the fix requiring the very tools
 * it had just blocked. So a file-level failure now loads **zero rules and gets out of the way**,
 * loudly: an `error`-level announcement on stderr and in the UI every session, plus a `degraded`
 * flag `/doctor` reports. Fail loud, not fail locked-out.
 *
 * What stays fail-closed is a different thing and still correct: a rule that LOADED but cannot be
 * EVALUATED at call time (`onInternalError: "closed"` above). A guard that is present and broken
 * blocks; a guard that never loaded announces and stands aside. A single BAD RULE inside an
 * otherwise-valid file is the lesser case again — named and dropped, the rest of the file still
 * loads (`schema.ts`'s header explains the split).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { guardedHandler, type GuardRule, type GuardVerdict } from "../lib/guarded-handler.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { CONFIG_DIR_NAME, configDir } from "../lib/paths.ts";
import { compileHooksFile, HooksFileError, type CompiledRule } from "./schema.ts";
import { runGuardScript } from "./run.ts";

export const id = "hooks";

/** Module-level state — deliberate, see `once.ts`'s note: exactly one PI extension file exists. */
const compiledRules: CompiledRule[] = [];
let degraded: { readonly reason: string } | undefined;

/** Exported so tests can assemble a fresh module without importing `register`'s closures twice. */
export function resetHooksState(): void {
  compiledRules.length = 0;
  degraded = undefined;
}

/**
 * Why the hook layer is carrying no rules, or `undefined` when it is healthy. `/doctor` reads
 * this: a degraded hook layer is invisible from the outside — every tool call simply proceeds —
 * so the state has to be reportable, not merely announced once at session start.
 */
export function hooksDegradedReason(): string | undefined {
  return degraded?.reason;
}

export function register(pi: ExtensionAPI): void {
  resetHooksState();

  pi.on("session_start", async (_event, ctx) => {
    await load(ctx);
  });

  const toolCallRule: GuardRule = {
    id,
    evaluate: (event, ctx) => evaluateToolCall(event, ctx),
  };

  pi.on(
    "tool_call",
    guardedHandler({
      owner: id,
      rules: [toolCallRule],
      onInternalError: "closed", // the deliberate exception — see the file header
      audit: (type, data) => pi.appendEntry(type, data),
    }),
  );

  pi.on("input", (event, ctx) => handleInput(event, ctx));
}

async function load(ctx: ExtensionContext): Promise<void> {
  resetHooksState();

  const globalFile = join(configDir(), "hooks.yaml");
  const projectFile = join(ctx.cwd, CONFIG_DIR_NAME, "hooks.yaml");
  // Project rules only when the project is trusted — the same gate `EXT-03`'s policy loader
  // uses for `config/hooks.yaml`.
  const candidates = ctx.isProjectTrusted() ? [globalFile, projectFile] : [globalFile];

  const warnings: string[] = [];
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // no file here is normal, not a failure
      // Unreadable for any other reason (permissions, a directory in its place, ...) is still a
      // file-level failure: drop to zero rules rather than silently proceed with whatever rules
      // the OTHER file happened to contribute, which would be a half-applied policy nobody wrote.
      degrade(ctx, `${file}: could not be read: ${describeError(err)}`);
      return;
    }

    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (err) {
      degrade(ctx, `${file}: invalid YAML: ${describeError(err)}`);
      return;
    }

    try {
      const { rules, warnings: fileWarnings } = compileHooksFile(doc, file);
      compiledRules.push(...rules);
      warnings.push(...fileWarnings);
    } catch (err) {
      if (err instanceof HooksFileError) {
        degrade(ctx, err.message);
      } else {
        degrade(ctx, `${file}: ${describeError(err)}`);
      }
      return;
    }
  }

  for (const w of warnings) announce(ctx, w, "warning");
  announce(ctx, `hooks: ${compiledRules.length} rule(s) loaded`, "info");
}

/**
 * File-level failure: load nothing, say so loudly, let the session run. See the file header for
 * why this no longer refuses. The announcement is `error`-level on purpose — this is the only
 * signal the operator gets, because a hook layer carrying zero rules is otherwise indistinguishable
 * from a machine with no `hooks.yaml` at all.
 */
function degrade(ctx: ExtensionContext, reason: string): void {
  degraded = { reason };
  compiledRules.length = 0;
  announce(
    ctx,
    `hooks: DEGRADED — no hook rules are in effect for this session. ${reason}. ` +
      `EXT-03's hard gates (guard.ts) are unaffected; fix the file and restart to restore the hook layer.`,
    "error",
  );
}

/** One channel, whichever this run mode has. `emitNotice` keeps the old safety property — a
 *  `ctx.ui.notify` that throws (no tty, a broken dialog subsystem) must not turn a load-time
 *  announcement, a per-rule warning, or a refusal into an uncaught exception — while dropping
 *  the stderr copy that used to print every one of them twice in the TUI. */
function announce(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  emitNotice(ctx, `[pi-config] ${message}`, level);
}

async function evaluateToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<GuardVerdict> {
  // A degraded hook layer has no opinion — it does not block. `compiledRules` is empty in that
  // state anyway, so the loop below would fall through; the early return is here to make the
  // intent explicit and to keep the contrast with `onInternalError: "closed"` legible.
  if (degraded) return undefined;

  for (const rule of compiledRules) {
    if (rule.event !== "tool_call") continue;
    if (rule.tool && rule.tool !== event.toolName) continue;
    if (rule.pattern) {
      // `JSON.stringify` on tool input that carries a BigInt (or any other non-serialisable
      // value) throws here. That is a genuine "this hook cannot be evaluated" — it is left
      // UNCAUGHT on purpose, so `guardedHandler`'s `onInternalError: "closed"` blocks the call
      // instead of the match silently being skipped.
      const subject = JSON.stringify(event.input ?? {});
      if (!rule.pattern.test(subject)) continue;
    }

    const verdict = await runToolCallAction(rule, event, ctx);
    if (verdict) return verdict;
  }
  return undefined;
}

async function runToolCallAction(
  rule: CompiledRule,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<GuardVerdict> {
  const tag = (message: string): string => `${message} [hook:${rule.id}]`;

  switch (rule.action) {
    case "block":
      return { block: true, reason: tag(rule.reason ?? "blocked") };

    case "warn":
      ctx.ui.notify(tag(rule.reason ?? "warning"), "warning");
      return undefined;

    case "confirm": {
      // Fail CLOSED without a UI — the EXT-03 rule, restated here because a YAML author will
      // not think to restate it themselves.
      if (!ctx.hasUI) return { block: true, reason: tag(`${rule.reason ?? "confirmation required"} (no UI)`) };
      // A `ctx.ui.confirm` that throws (broken dialog subsystem) is left UNCAUGHT here too —
      // `guardedHandler`'s "closed" mode is what turns it into a block, not a local try/catch.
      const ok = await ctx.ui.confirm(rule.id, rule.reason ?? "Proceed?");
      return ok ? undefined : { block: true, reason: tag("declined") };
    }

    case "run": {
      const run = rule.run!; // schema.ts guarantees this is present when action === "run"
      const outcome = await runGuardScript(
        run.command,
        run.args,
        { event: "tool_call", ruleId: rule.id, tool: event.toolName, input: event.input, cwd: ctx.cwd },
        { cwd: ctx.cwd, timeoutMs: run.timeoutMs },
      );
      if (outcome.verdict === "deny") return { block: true, reason: tag(outcome.reason) };
      if (outcome.verdict === "blocked-internal") return { block: true, reason: tag(outcome.reason) };
      return undefined; // "no-opinion" — the script ran fine and chose to say nothing
    }
  }
}

async function handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
  try {
    if (degraded) return { action: "continue" }; // degraded: no rules, no opinion — see `degrade`

    for (const rule of compiledRules) {
      if (rule.event !== "input") continue;
      if (rule.pattern && !rule.pattern.test(event.text)) continue;

      if (rule.action === "warn") {
        ctx.ui.notify(`${rule.reason ?? "warning"} [hook:${rule.id}]`, "warning");
        continue;
      }
      if (rule.action === "block") return { action: "handled" };
    }
    return { action: "continue" };
  } catch (err) {
    // PI's own `emitInput` already catches a throwing `input` handler and continues with the
    // text UNCHANGED (fail-open, by platform design — see `input-transform.ts`'s note). That
    // is the opposite of what a hook layer needs, and there is no "closed" option to request
    // for this event, so the fail-closed behaviour has to be ours: swallow the message rather
    // than let the exception reach the platform's fail-open catch.
    surfaceOnce(ctx, `${id}:input:${signature(err)}`, () => {
      announce(ctx, `hooks: input evaluation failed internally, blocking the message: ${describeError(err)}`, "error");
    });
    return { action: "handled" };
  }
}

function signature(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return msg.slice(0, 120);
}

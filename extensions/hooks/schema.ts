/**
 * `EXT-15` — the declarative hook schema and its load-time validation.
 *
 * `pi-yaml-hooks` was rejected (`docs/DENYLIST.md` §4a) for being fail-open at every layer,
 * including finding #5: "a `hooks.yaml` that fails to parse → no hooks load at all → every tool
 * call proceeds unhooked", surfaced but not blocking. This module draws the line between two
 * different failures on purpose:
 *
 *   - the FILE itself is broken (bad YAML syntax, wrong top-level shape) → `HooksFileError`,
 *     thrown, never swallowed. `index.ts` turns this into a session refusal, not a quiet
 *     zero-rule load — that is the fix for finding #5.
 *   - ONE RULE inside an otherwise-valid file is broken (missing id, bad regex, an action that
 *     doesn't apply to its event) → named and dropped, the rest of the file still loads. This is
 *     the behaviour the original H2 acceptance test already expected,
 *     and it stays a warning, not a refusal — one colleague's typo in one rule must not disable
 *     every other rule in the file.
 *
 * Deliberately not expressive enough to become a language (the file's own non-goal, restated by
 * the task): five fields — `event`, `match.tool`, `match.pattern`, `action`, `reason` — plus
 * `run` for the one action that shells out. No conditionals, no variables, no loops.
 */

/**
 * Thrown for a file-level defect. `index.ts` must not catch this and continue silently.
 *
 * No TypeScript parameter properties here on purpose — Node's `--test` runs `.ts` files through
 * type-stripping only (no transform), and `constructor(readonly x: T)` is a real syntax
 * transform, not an erasure; it throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at run time. Verified
 * on Node 22.22.3. `tsc --noEmit` alone would not have caught this.
 */
export class HooksFileError extends Error {
  readonly source: string;

  constructor(source: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HooksFileError";
    this.source = source;
  }
}

export type HookEvent = "tool_call" | "input";
export type HookAction = "block" | "warn" | "confirm" | "run";

/** Which actions make sense on which event — enforced at load time, not left to convention. */
const ACTIONS_BY_EVENT: Readonly<Record<HookEvent, readonly HookAction[]>> = {
  tool_call: ["block", "warn", "confirm", "run"],
  // `run` is deliberately not offered on `input`: a script gate belongs on the thing it is
  // gating (a tool call), and `confirm` has no headless-safe meaning for text the user already
  // sent. Keeping the input surface to block/warn is the "not a language" line for this event.
  input: ["block", "warn"],
};

export interface CompiledRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface CompiledRule {
  readonly id: string;
  readonly event: HookEvent;
  readonly tool?: string;
  readonly pattern?: RegExp;
  readonly action: HookAction;
  readonly reason?: string;
  readonly run?: CompiledRun;
  /** File this rule came from, for diagnostics only. */
  readonly source: string;
}

export type CompileOutcome =
  | { readonly ok: true; readonly rule: CompiledRule }
  | { readonly ok: false; readonly warning: string };

/**
 * Validates and compiles the top-level shape (`{version: 1, rules: [...]}`). Throws
 * `HooksFileError` for anything wrong at this level — that is the file-level failure `index.ts`
 * turns into a refusal. Per-rule problems are collected as warnings, never thrown.
 */
export function compileHooksFile(
  doc: unknown,
  source: string,
): { readonly rules: readonly CompiledRule[]; readonly warnings: readonly string[] } {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new HooksFileError(source, `${source}: top-level document must be a mapping with "version" and "rules"`);
  }
  const d = doc as { version?: unknown; rules?: unknown };
  if (d.version !== 1) {
    throw new HooksFileError(
      source,
      `${source}: unsupported or missing "version" (expected 1, got ${JSON.stringify(d.version)})`,
    );
  }
  if (!Array.isArray(d.rules)) {
    throw new HooksFileError(source, `${source}: "rules" must be an array`);
  }

  const rules: CompiledRule[] = [];
  const warnings: string[] = [];
  d.rules.forEach((raw, index) => {
    const outcome = compileOneRule(raw, source, index);
    if (outcome.ok) rules.push(outcome.rule);
    else warnings.push(outcome.warning);
  });
  return { rules, warnings };
}

function compileOneRule(raw: unknown, source: string, index: number): CompileOutcome {
  const where = `${source}#${index}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, warning: `hooks: ${where} is not a mapping` };
  }
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === "string" && r.id.trim().length > 0 ? r.id : undefined;
  if (!id) return { ok: false, warning: `hooks: ${where} is missing a non-empty "id"` };
  const label = `${source}#${id}`;

  if (r.event !== "tool_call" && r.event !== "input") {
    return { ok: false, warning: `hooks: ${label} has an unsupported "event": ${JSON.stringify(r.event)}` };
  }
  const event = r.event;

  const allowedActions = ACTIONS_BY_EVENT[event];
  if (typeof r.action !== "string" || !(allowedActions as readonly string[]).includes(r.action)) {
    return {
      ok: false,
      warning:
        `hooks: ${label} has an unsupported "action" for event "${event}": ${JSON.stringify(r.action)} ` +
        `(allowed: ${allowedActions.join(", ")})`,
    };
  }
  const action = r.action as HookAction;

  let tool: string | undefined;
  let pattern: RegExp | undefined;
  if (r.match !== undefined) {
    if (typeof r.match !== "object" || r.match === null || Array.isArray(r.match)) {
      return { ok: false, warning: `hooks: ${label} has a "match" that is not a mapping` };
    }
    const m = r.match as Record<string, unknown>;
    if (m.tool !== undefined) {
      if (typeof m.tool !== "string" || m.tool.length === 0) {
        return { ok: false, warning: `hooks: ${label} has a "match.tool" that is not a non-empty string` };
      }
      if (event === "input") {
        return { ok: false, warning: `hooks: ${label} sets "match.tool" but event is "input" — tools do not apply there` };
      }
      tool = m.tool;
    }
    if (m.pattern !== undefined) {
      if (typeof m.pattern !== "string") {
        return { ok: false, warning: `hooks: ${label} has a "match.pattern" that is not a string` };
      }
      try {
        pattern = new RegExp(m.pattern);
      } catch (err) {
        return {
          ok: false,
          warning: `hooks: ${label} has an invalid regex in "match.pattern": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  const reason = typeof r.reason === "string" ? r.reason : undefined;

  let run: CompiledRun | undefined;
  if (action === "run") {
    if (typeof r.run !== "object" || r.run === null || Array.isArray(r.run)) {
      return { ok: false, warning: `hooks: ${label} has action "run" but no "run" block` };
    }
    const ru = r.run as Record<string, unknown>;
    if (typeof ru.command !== "string" || ru.command.trim().length === 0) {
      return { ok: false, warning: `hooks: ${label} has a "run.command" that is not a non-empty string` };
    }
    let args: string[] = [];
    if (ru.args !== undefined) {
      if (!Array.isArray(ru.args) || !ru.args.every((a): a is string => typeof a === "string")) {
        return { ok: false, warning: `hooks: ${label} has a "run.args" that is not an array of strings` };
      }
      args = ru.args;
    }
    let timeoutMs: number | undefined;
    if (ru.timeoutMs !== undefined) {
      if (typeof ru.timeoutMs !== "number" || !Number.isFinite(ru.timeoutMs) || ru.timeoutMs <= 0) {
        return { ok: false, warning: `hooks: ${label} has a "run.timeoutMs" that is not a positive number` };
      }
      timeoutMs = ru.timeoutMs;
    }
    run = { command: ru.command, args, timeoutMs };
  } else if (r.run !== undefined) {
    return { ok: false, warning: `hooks: ${label} has a "run" block but action is "${action}", not "run"` };
  }

  return { ok: true, rule: { id, event, tool, pattern, action, reason, run, source } };
}

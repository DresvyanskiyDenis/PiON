/**
 * `bash` hardening (EXT-18, `REQ-PRV-85`): a >= 60 min timeout ceiling, an order-independent
 * default, and a tail-retrieval hint on truncated output. 52 % of all observed tool calls are
 * bash and PI's `timeout` parameter is optional with no default — one `timeout`-less `ssh` or
 * `docker build` hangs the agent with no bound.
 *
 * ## Package split
 * `@mrclrchtr/supi-bash-timeout` 4.6.0 is installed and its `tool_call` handler already injects
 * a default when the model omits `timeout` — confirmed by reading its source
 * (`src/bash-timeout.ts`): it is a 28-line handler with no upper-bound check at all. The ceiling
 * is explicitly NOT the package's job (verified — VP-12), so this module supplies it. This
 * module ALSO injects the identical default (see "Defense in depth" below).
 *
 * ## Units: PI's bash `timeout` is SECONDS, not milliseconds
 * Verified against `@earendil-works/pi-coding-agent` 0.84.0
 * (`dist/core/bash-executor.js`): `resolveTimeoutMs = timeout * 1000`, and the tool's own
 * TypeBox schema documents the field as `"Timeout in seconds (optional, no default timeout)"`.
 * An earlier draft's skeleton uses millisecond constants (`CEILING_MS = 60 * 60_000`,
 * `DEFAULT_MS = 120_000`) and clamps with `input.timeout > CEILING_MS`. Applied literally to the
 * real (seconds) field, that "ceiling" would let a ~41-day timeout through and the "default"
 * would be ~33 hours — the opposite of both requirements. This module works in seconds
 * throughout; `config/bash-timeouts.json`'s keys are named accordingly.
 *
 * Also verified from the same source: PI's own native ceiling is `Number.MAX_SAFE` bounded only
 * by `setTimeout`'s 32-bit limit (`MAX_TIMEOUT_MS = 2_147_483_647`, i.e. ~24.8 days) — PI itself
 * accepts far more than 60 minutes (V-17(a) reads PASS from source: no build-time ceiling below
 * 60 min exists, so `EXT-24` background jobs are not forced onto long verify steps by this).
 * The >= 60 min ceiling this module enforces is OUR policy floor from `REQ-PRV-85`, not a limit
 * PI imposes.
 *
 * ## Defense in depth: this module injects the default too
 * PI calls every registered `tool_call` handler, across every loaded extension, on the SAME
 * mutable event object in extension-registration order
 * (`dist/core/extensions/runner.js` `emitToolCall`). Nothing in this tree controls whether
 * `@mrclrchtr/supi-bash-timeout`'s independently-discovered extension loads before or after our
 * composed `extensions/index.ts` — that ordering lives in `config/settings.json`, which this
 * item does not own. If it loads after ours, fails to load, or is disabled at runtime via
 * `/supi-settings`, a handler that only clamps an existing value would leave `REQ-PRV-85`'s
 * "no unbounded hang" unmet for that session. So this module injects the SAME default (120 s,
 * matching the package's own built-in default) whenever `timeout` is still absent when this
 * handler runs:
 *   - if the package ran first: `timeout` is already 120 (or the user's configured value), our
 *     branch is a no-op, and the ceiling check still applies to whatever value is there.
 *   - if the package runs after us (or never runs): `timeout` is already defined by the time it
 *     would look, so ITS `timeout !== undefined` guard makes it a no-op instead.
 * Either order, `REQ-PRV-85`'s default guarantee holds from this module alone, and the ceiling
 * is always evaluated against a concrete number. The one residual gap — the package's OWN
 * default reconfigured above the ceiling via `/supi-settings`, combined with the package
 * running strictly before us — is caught the same way: whatever value is present when THIS
 * handler runs is what gets clamped, regardless of who set it.
 *
 * ## Never a raw `tool_call` handler
 * PI's native semantics are "a `tool_call` handler that throws BLOCKS the tool". A bug in this
 * module's config load or arithmetic must not turn into every bash call being blocked, so the
 * mutation runs inside `guardedHandler` (`EXT-01`) as a rule that never returns `block: true`;
 * a throw is caught, surfaced once, and the call proceeds unmodified rather than being denied.
 * An earlier draft's skeleton registers a raw `pi.on("tool_call", ...)` instead — that
 * literal skeleton contradicts the binding convention it sits under, and the convention wins.
 *
 * ## Import extensions are `.ts`, not `.js`
 * Earlier drafts write `.js` specifiers. `node --test` (Node's native TS type-stripping)
 * does not map `.js` to `.ts` the way `tsc`/jiti's bundler resolution does, so `.js` imports are
 * untestable under this repo's `test:node` script. `EXT-01` already established `.ts`
 * specifiers as the working convention (see its manifest openQuestions); this module follows it.
 */
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "./lib/once.ts";
import { guardedHandler, type GuardRule } from "./lib/guarded-handler.ts";
import { declareModule } from "./lib/manifest.ts";
import { repoRoot } from "./lib/paths.ts";

export const id = "bash";

const MODULE_VERSION = "1.0.0";

/** REQ-PRV-85's own floor: our ceiling must never be configured below 60 minutes. */
const MIN_CEILING_SECONDS = 60 * 60;

export interface TimeoutPolicy {
  readonly defaultTimeoutSeconds: number;
  readonly ceilingSeconds: number;
  readonly minTimeoutSeconds: number;
  readonly maxLines: number;
  readonly maxBytes: number;
}

/**
 * Loads and validates `config/bash-timeouts.json` from the repo root (`repoRoot()`, `EXT-01`).
 * A missing or malformed file is NOT silently defaulted — it throws, `index.ts`'s per-module
 * `try`/`catch` records the failure and reports it loudly, exactly like
 * every other module-load failure in this tree (`REQ-PRV-32`).
 */
export function loadTimeoutPolicy(root: string = repoRoot()): TimeoutPolicy {
  const path = join(root, "config", "bash-timeouts.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`[pi-config] bash: cannot load timeout policy from ${path}: ${describeError(err)}`, {
      cause: err,
    });
  }
  return validatePolicy(raw, path);
}

function validatePolicy(raw: unknown, path: string): TimeoutPolicy {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`[pi-config] bash: ${path} must contain a JSON object`);
  }
  const r = raw as Record<string, unknown>;
  const defaultTimeoutSeconds = positiveNumber(r.defaultTimeoutSeconds, "defaultTimeoutSeconds", path);
  const ceilingSeconds = positiveNumber(r.ceilingSeconds, "ceilingSeconds", path);
  const minTimeoutSeconds = positiveNumber(r.minTimeoutSeconds, "minTimeoutSeconds", path);
  const maxLines = positiveNumber(r.maxLines, "maxLines", path);
  const maxBytes = positiveNumber(r.maxBytes, "maxBytes", path);

  if (ceilingSeconds < MIN_CEILING_SECONDS) {
    throw new Error(
      `[pi-config] bash: ${path} ceilingSeconds=${ceilingSeconds} is below REQ-PRV-85's floor of ` +
        `${MIN_CEILING_SECONDS}s (60 min)`,
    );
  }
  if (defaultTimeoutSeconds > ceilingSeconds) {
    throw new Error(
      `[pi-config] bash: ${path} defaultTimeoutSeconds=${defaultTimeoutSeconds} exceeds ` +
        `ceilingSeconds=${ceilingSeconds}`,
    );
  }
  if (minTimeoutSeconds > defaultTimeoutSeconds) {
    throw new Error(
      `[pi-config] bash: ${path} minTimeoutSeconds=${minTimeoutSeconds} exceeds ` +
        `defaultTimeoutSeconds=${defaultTimeoutSeconds}`,
    );
  }
  return { defaultTimeoutSeconds, ceilingSeconds, minTimeoutSeconds, maxLines, maxBytes };
}

function positiveNumber(value: unknown, key: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[pi-config] bash: ${path} field "${key}" must be a positive finite number, got ${String(value)}`);
  }
  return value;
}

/**
 * The `tool_call` mutation, run through `guardedHandler` so a bug here fails OPEN (the call
 * proceeds with whatever `timeout` the model gave it) rather than blocking every bash call.
 * Never returns `block: true` — blocking bash calls is `EXT-03`'s job, not this module's.
 */
export function timeoutRule(policy: TimeoutPolicy): GuardRule {
  return {
    id: "BASH-TIMEOUT",
    evaluate(event) {
      if (!isToolCallEventType("bash", event)) return undefined;
      const input = event.input;
      if (input.timeout == null) {
        // Absent: inject the default ourselves — see "Defense in depth" above. Matches
        // @mrclrchtr/supi-bash-timeout's own built-in default, so this is a no-op wherever
        // that package already ran first.
        input.timeout = policy.defaultTimeoutSeconds;
      } else if (!Number.isFinite(input.timeout) || input.timeout < policy.minTimeoutSeconds) {
        // Degenerate (NaN, zero, negative, sub-floor): PI's own executor would otherwise
        // reject this with "Invalid timeout: must be a finite number of seconds" at execution
        // time. Floor it instead of losing the call to a parameter typo.
        input.timeout = policy.minTimeoutSeconds;
      } else if (input.timeout > policy.ceilingSeconds) {
        // REQ-PRV-85: the >= 60 min ceiling. This is the check the installed package does not
        // do (verified — its handler has no upper bound at all).
        input.timeout = policy.ceilingSeconds;
      }
      return undefined;
    },
  };
}

/**
 * The `tool_result` hint: when bash output was truncated, name the boundary that was hit and
 * point at `BashExecutionMessage.fullOutputPath` with a retrieval command, so the model tails
 * the saved file instead of re-running the (possibly expensive) command. Reads the ACTUAL
 * truncation parameters PI applied (`details.truncation.maxLines`/`maxBytes`) rather than this
 * module's static policy, falling back to policy only if PI ever omits them.
 */
function buildTruncationHint(
  maxLines: number,
  maxBytes: number,
  truncatedBy: string,
  fullOutputPath: string,
): string {
  return (
    `\n[Output was truncated at ${maxLines} lines / ${maxBytes} bytes (limit hit: ${truncatedBy}). ` +
    `The complete output is saved at ${fullOutputPath}. Retrieve the end with ` +
    `\`tail -n 200 ${fullOutputPath}\`, or grep it — do NOT re-run the command.]`
  );
}

/**
 * The `tool_result` handler body, extracted so it is unit-testable without a fake
 * `ExtensionAPI`. Returns `undefined` for anything that isn't a truncated bash result — PI
 * treats an `undefined` handler result as "unchanged" (`dist/core/extensions/runner.js`
 * `emitToolResult`).
 */
export function handleBashToolResult(event: ToolResultEvent, policy: TimeoutPolicy) {
  if (!isBashToolResult(event)) return undefined;
  const details = event.details;
  const truncation = details?.truncation;
  const fullOutputPath = details?.fullOutputPath;
  if (!fullOutputPath || !truncation?.truncated) return undefined;

  const hint = buildTruncationHint(
    truncation.maxLines ?? policy.maxLines,
    truncation.maxBytes ?? policy.maxBytes,
    truncation.truncatedBy ?? "unknown",
    fullOutputPath,
  );

  const content = event.content.map((c) => ({ ...c }));
  const lastTextIndex = content.findLastIndex((c) => c.type === "text");
  if (lastTextIndex === -1) {
    content.push({ type: "text", text: hint.trimStart() });
  } else {
    const target = content[lastTextIndex] as { type: "text"; text: string };
    target.text = `${target.text}${hint}`;
  }
  return { content };
}

export function register(pi: ExtensionAPI): void {
  const policy = loadTimeoutPolicy();

  pi.on(
    "tool_call",
    guardedHandler({
      owner: id,
      rules: [timeoutRule(policy)],
      onInternalError: "open",
    }),
  );

  pi.on("tool_result", (event: ToolResultEvent) => handleBashToolResult(event, policy));

  pi.on("session_start", () => {
    declareModule({
      id,
      version: MODULE_VERSION,
      events: ["tool_call", "tool_result", "session_start"],
      apis: ["on"],
    });
  });
}

/**
 * The local lane: a session whose active model is served by a provider `routing.json` classes
 * `local` (a model server on this machine) keeps everything it spawns on that one model.
 *
 * Forcing is a deliberate, announced exception to "no substitution". A tier name AND an explicit
 * `provider/id` pin are both overridden, because a pin to a remote model is exactly the egress the
 * lane exists to prevent. The rewrite is never silent: `index.ts` reports it, and the audit entry
 * carries `forcedByLane`.
 *
 * Where a child's model can be named, and what happens to each:
 *   - top-level `model`                       set.
 *   - `tasks` / `parallel` / `chain` entries  every entry that names an agent or a model is set,
 *                                             recursively (a chain step may nest a `parallel`).
 *   - `workflowScript` literal `model: "x"`   rewritten in the source.
 *   - a `model:` the scan cannot rewrite      the call is BLOCKED, never guessed at: a non-literal
 *                                             value in a script, or any `model:` in a script file
 *                                             on disk (rewriting the user's file is not ours to do).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RoutingConfig } from "./config.ts";

import { LOCAL_EGRESS } from "../lib/routing-file.ts";

export interface LaneModel {
  readonly provider: string;
  readonly id: string;
}

/** `provider/id` as `resolveModelSpec` takes it; the split is on the FIRST slash, so an id with slashes is fine. */
export function laneSpec(model: LaneModel): string {
  return `${model.provider}/${model.id}`;
}

/** The session's active model when it is on the lane, else `undefined`. Read live: `/model` can move a session on or off. */
export function laneModel(routing: RoutingConfig | undefined, active: LaneModel | undefined): LaneModel | undefined {
  if (routing === undefined || active === undefined) return undefined;
  return routing.egress[active.provider] === LOCAL_EGRESS ? active : undefined;
}

const CHILD_KEYS = ["tasks", "parallel", "chain"] as const;

/** `model: "<literal>"` as a script object property; the lookbehind keeps `x.model:` and `myModel:` out. */
const SCRIPT_MODEL_LITERAL = /(?<![\w$.])model\s*:\s*(["'`])[^"'`\n]{1,200}\1/g;
const SCRIPT_MODEL_ANY = /(?<![\w$.])model\s*:/g;

export interface ForceOutcome {
  /** The specs that were replaced, as the call carried them. Empty when it already named only the lane model. */
  readonly replaced: readonly string[];
  /** Set when a child's model cannot be rewritten; the call must not run. */
  readonly blocked?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function forceEntry(entry: Record<string, unknown>, spec: string, replaced: string[]): void {
  if (typeof entry.agent === "string" || entry.model !== undefined) {
    if (typeof entry.model === "string" && entry.model !== spec) replaced.push(entry.model);
    entry.model = spec;
  }
  forceChildArrays(entry, spec, replaced);
}

function forceChildArrays(holder: Record<string, unknown>, spec: string, replaced: string[]): void {
  for (const key of CHILD_KEYS) {
    const value = holder[key];
    // `parallel` is an array of entries, or one template object beside an `expand`.
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const item of entries) {
      const entry = asRecord(item);
      if (entry !== undefined) forceEntry(entry, spec, replaced);
    }
  }
}

function forceScript(source: string, spec: string, replaced: string[]): { source: string; blocked?: string } {
  const literals = source.match(SCRIPT_MODEL_LITERAL)?.length ?? 0;
  const all = source.match(SCRIPT_MODEL_ANY)?.length ?? 0;
  if (all > literals) {
    return {
      source,
      blocked:
        `a workflowScript sets \`model\` from something other than a string literal, so the local ` +
        `lane cannot rewrite it to ${spec}. Write the model as a literal, or omit it.`,
    };
  }
  return {
    source: source.replace(SCRIPT_MODEL_LITERAL, (whole) => {
      replaced.push(whole);
      return `model: ${JSON.stringify(spec)}`;
    }),
  };
}

/**
 * Point every child of a dispatch call at `spec`. Mutates `input` in place, like the rest of
 * `DSP-RESOLVE`. `cwd` resolves a relative `workflowScriptPath`, the way the package does.
 */
export function forceLaneModel(input: Record<string, unknown>, spec: string, cwd: string): ForceOutcome {
  const replaced: string[] = [];
  if (typeof input.model === "string" && input.model.trim() !== "" && input.model !== spec) {
    replaced.push(input.model);
  }
  input.model = spec;
  forceChildArrays(input, spec, replaced);

  if (typeof input.workflowScript === "string") {
    const out = forceScript(input.workflowScript, spec, replaced);
    if (out.blocked !== undefined) return { replaced, blocked: out.blocked };
    input.workflowScript = out.source;
  }
  if (typeof input.workflowScriptPath === "string") {
    const path = isAbsolute(input.workflowScriptPath) ? input.workflowScriptPath : resolve(cwd, input.workflowScriptPath);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      return {
        replaced,
        blocked:
          `the workflowScriptPath ${input.workflowScriptPath} cannot be read (${err instanceof Error ? err.message : String(err)}), ` +
          `so the local lane cannot prove its children run on ${spec}.`,
      };
    }
    if (text.match(SCRIPT_MODEL_ANY) !== null) {
      return {
        replaced,
        blocked:
          `the workflow script ${input.workflowScriptPath} sets \`model\`, and the local lane does not ` +
          `rewrite files on disk. Remove the \`model\` property so its children take ${spec}, or pass the script inline.`,
      };
    }
  }
  return { replaced };
}

/** The one line the system prompt and `/agents` carry. */
export function laneNotice(model: LaneModel): string {
  return (
    `local lane: all sub-agents run on ${laneSpec(model)}. Every dispatch is forced to it, tier names ` +
    `(\`tier:strong\`) and explicit provider/id pins alike; there is no remote fallback.`
  );
}

/** The `## Sub-agent model selection` block on the lane: the one line, nothing to choose from. */
export function laneMenu(model: LaneModel): string {
  return `## Sub-agent model selection\n${laneNotice(model)}`;
}

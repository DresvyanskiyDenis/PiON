/**
 * Which children a dispatch tool call actually launches, and what each one names as its agent.
 *
 * `isolation: worktree` is a property of an AGENT, so honouring it is a property of a CHILD — not
 * of the tool call that carries the children. `index.ts` used to read one agent name off the top
 * level of the call (`agentOf`, the `AGENT_KEYS` scan) and apply isolation only when that resolved.
 * A `workflowScript` names no agent at the top level and a fanout names one per entry, so for both
 * shapes `def` was `undefined`, the isolation branch never ran, and an agent whose frontmatter says
 * "never run me in the user's checkout" was run in the user's checkout — silently, which is the
 * one outcome `isolation.ts` exists to prevent.
 *
 * This module answers the question that fixes that: *for this call, which agents will be launched?*
 *
 *   - **single** — `{agent, task}`. One child, addressable: `input.cwd` is its cwd, so `EXT-23`'s
 *     one-directory grant fits it exactly. Unchanged behaviour.
 *   - **children** — `workflowScript`/`workflowScriptPath`, or a `tasks`/`parallel`/`chain` fanout.
 *     N children, each with its own agent and its own cwd, none of them addressable from out here.
 *   - **none** — a management/control `action` (`status`, `stop`, `validate`, …) launches nothing.
 *
 * ## Reading agent names out of a workflow script
 *
 * A `workflowScript` is a JavaScript statement body executed in `pi-subagents`' sandbox, where
 * children are `runs.run(key, {agent, task})` / `runs.all([{key, agent, task}, …])`
 * (`node_modules/pi-subagents/src/extension/schemas.ts:315`). The script is a string on the call,
 * so the names are visible here — as literals. This module scans for exactly that: an `agent`
 * property whose value is a string literal.
 *
 * What it therefore cannot see is a name that only exists at run time (`agent: pick(i)`,
 * `...template`). That residue is stated rather than hidden: a scan is a lower bound on the
 * children, so the guarantee this restores is "an agent NAMED in the script gets its isolation",
 * not "no dynamic child can ever escape it". The direction of the error is the safe one — a false
 * positive (the string `agent: "surgeon"` inside a task's prose) isolates a call that did not need
 * it, and isolation is never the unsafe answer.
 *
 * `workflowScriptPath` is read from disk here, because the alternative is a hole shaped exactly
 * like the one this module closes: the same script, one indirection away, with the declaration
 * unhonoured. The package reads that file too, before its sandbox starts
 * (`src/extension/schemas.ts:316`), and resolves it against the request cwd — mirrored below. A
 * file we cannot read is reported, not fatal: the path may be relative to a cwd we resolved
 * differently, and refusing every unreadable path would refuse working dispatches.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { FANOUT_KEYS } from "./concurrency.ts";

export interface DispatchChild {
  readonly agent: string;
  /** Where the name was read from — a refusal has to tell the lead which child to fix. */
  readonly where: string;
}

export interface DispatchChildren {
  /**
   * `single`: one addressable child, whose agent the caller resolves itself — `index.ts` already
   * reads it through `AGENT_KEYS` for model routing, and duplicating that key list here would put
   * a second, drifting answer next to the first. `children`: N unaddressable ones, listed below.
   * `none`: the call launches nothing.
   */
  readonly shape: "single" | "children" | "none";
  /** The children of a `children`-shaped call. Always empty for the other two shapes. */
  readonly children: readonly DispatchChild[];
  /** A `workflowScriptPath` that could not be read, in one sentence, for a warning. */
  readonly unreadable?: string;
}

/**
 * The keys a fanout call carries its children under. `chain` steps may nest a `parallel` array.
 * `expand`'s own template lives under the step's `parallel` key, so it needs no entry of its own.
 */
const CHILD_ARRAY_KEYS = FANOUT_KEYS.filter((key) => key !== "expand");

/**
 * `agent: "<name>"` as a JavaScript object property. The lookbehind keeps `foo.agent:` and
 * `myAgent:` out; the value is a single-line literal in any of the three quote styles.
 */
const SCRIPT_AGENT_LITERAL = /(?<![\w$.])agent\s*:\s*(["'`])([^"'`\n]{1,128})\1/g;

export function dispatchChildren(input: Readonly<Record<string, unknown>>, cwd: string): DispatchChildren {
  // A management/control action launches no child at all, so it has no isolation to honour. Named
  // separately from "we found nothing": `action: "validate"` even compiles a workflowScript, and
  // compiling it must not create a worktree.
  if (typeof input.action === "string" && input.action.trim().length > 0) {
    return { shape: "none", children: [] };
  }

  const children: DispatchChild[] = [];
  let unreadable: string | undefined;

  const script = workflowSource(input, cwd);
  if (script.source !== undefined) {
    for (const [index, name] of scriptAgents(script.source).entries()) {
      children.push({ agent: name, where: `${script.origin} child ${index + 1} (agent: "${name}")` });
    }
  }
  if (script.unreadable !== undefined) unreadable = script.unreadable;

  for (const key of CHILD_ARRAY_KEYS) {
    collectEntries(input[key], key, children);
  }

  // The SHAPE is decided by the keys the call carries, not by how many names the scan recovered.
  // A fanout whose entries name nothing we could read is still a fanout: calling it `single` would
  // send it back to the one-directory path, which is the bug (`input.cwd` written for a call whose
  // children each have their own cwd) rather than a fallback.
  const fansOut = FANOUT_KEYS.some((key) => input[key] !== undefined);
  if (fansOut || script.source !== undefined || unreadable !== undefined) {
    return { shape: "children", children, ...(unreadable !== undefined ? { unreadable } : {}) };
  }
  return { shape: "single", children: [] };
}

/** The distinct agent names in the order they were first seen — a refusal lists them once. */
export function distinctAgents(children: readonly DispatchChild[]): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const child of children) {
    if (seen.has(child.agent)) continue;
    seen.add(child.agent);
    names.push(child.agent);
  }
  return names;
}

function workflowSource(
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): { source?: string; origin: string; unreadable?: string } {
  if (typeof input.workflowScript === "string" && input.workflowScript.trim().length > 0) {
    return { source: input.workflowScript, origin: "workflowScript" };
  }
  const path = input.workflowScriptPath;
  if (typeof path !== "string" || path.trim().length === 0) return { origin: "workflowScript" };
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    return { source: readFileSync(resolved, "utf8"), origin: `workflowScriptPath ${path}` };
  } catch (err) {
    return {
      origin: `workflowScriptPath ${path}`,
      unreadable:
        `workflowScriptPath ${path} could not be read from ${resolved} ` +
        `(${err instanceof Error ? err.message : String(err)}), so the agents it launches are not ` +
        `known here and an \`isolation: worktree\` declaration among them cannot be honoured.`,
    };
  }
}

function scriptAgents(source: string): readonly string[] {
  const names: string[] = [];
  for (const match of source.matchAll(SCRIPT_AGENT_LITERAL)) {
    const name = match[2]?.trim();
    if (name) names.push(name);
  }
  return names;
}

/** `tasks`/`parallel` entries, `chain` steps, and the `parallel` a chain step nests inside itself. */
function collectEntries(value: unknown, where: string, into: DispatchChild[]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) collectEntries(entry, `${where}[${index}]`, into);
    return;
  }
  if (typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  const name = firstAgentName(entry);
  if (name !== undefined) into.push({ agent: name, where });
  // A chain step carries its fanout under `parallel` — a static array, or the single template
  // object of a dynamic `expand` fanout, which names the agent every expanded child runs.
  if (entry.parallel !== undefined) collectEntries(entry.parallel, `${where}.parallel`, into);
}

function firstAgentName(record: Readonly<Record<string, unknown>>): string | undefined {
  // Deliberately narrower than `index.ts`'s AGENT_KEYS: inside a task entry only `agent` is the
  // package's own key, and `name` there means the child's label, not the agent to run.
  const value = record.agent;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

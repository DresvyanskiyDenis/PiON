/**
 * The agent registry — **our** load-time validation over `pi-subagents`' discovery.
 *
 * The package discovers agent files and parses their frontmatter perfectly well. What it does not
 * do is the thing this item makes an acceptance criterion: *"A typo in one of
 * 14 agent files is a `session_start` error, not a surprise at minute 40. The package discovers
 * agents; **we** assert that every one of ours resolved."* The package's failure mode is a
 * dispatch-time `Unknown agent: <name>`, which arrives after the model has already decided to
 * delegate.
 *
 * So this module reads the same files the package reads, from the same directories, and answers
 * one question per file: would dispatching this agent work, right now, in this session? Three
 * outcomes:
 *
 *   - **ok** — resolvable.
 *   - **invalid** — the file is wrong (bad frontmatter, unknown tier, a model the registry does
 *     not have, an incoherent return contract, a `fallbackModels` key). Dispatch is refused by
 *     name. Fixing it is an edit to the file.
 *   - **restricted** — the file is fine but its model is not being served right now: an `optional`
 *     tier (the local lane) whose backend is down. Dispatch is refused by name because there is
 *     nothing to dispatch onto; start the backend and the same file is `ok`.
 *
 * `restricted` used to have a second producer — egress containment, "this session's class may not
 * reach that provider's class". That rule was withdrawn on 2026-08-13 (`lib/dispatch-veto.ts`), so
 * the status now means the runtime condition and nothing else.
 *
 * `fallbackModels` is rejected outright: this item keeps the package's support
 * for it and refuses to use it, because a child that quietly answers from a weaker model is worse
 * than a child that fails — its output looks like the real thing.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { DispatchConfig, RoutingConfig } from "./config.ts";
import { DispatchError, resolveModelSpec, type ModelTarget } from "./tiers.ts";
import { splitThinkingSuffix } from "./thinking.ts";
import { describeReturnContract, parseReturnContract, type ReturnContract } from "./contract.ts";

export const AgentFrontmatterSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{1,63}$" }),
    description: Type.String({ minLength: 10 }),
    model: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    returns: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("object")])),
    mode: Type.Optional(Type.Union([Type.Literal("subagent"), Type.Literal("teammate")])),
    delivery: Type.Optional(Type.String({ minLength: 1 })),
    skills: Type.Optional(Type.Array(Type.String())),
    aliases: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);
export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

export type Isolation = "none" | "worktree";
export type AgentStatus = "ok" | "invalid" | "restricted";

export interface AgentDef {
  readonly name: string;
  readonly description: string;
  readonly file: string;
  /** The directory the file was found in, as configured. Later dirs override earlier ones. */
  readonly dir: string;
  readonly systemPrompt: string;
  /** Whatever the file wrote in `model:`, before resolution. */
  readonly spec: string;
  /** Absent when the spec did not resolve; `invalid` is set in that case. */
  readonly target?: ModelTarget;
  readonly tools?: readonly string[];
  readonly isolation: Isolation;
  readonly maxTurns?: number;
  readonly contract: ReturnContract;
  readonly status: AgentStatus;
  /** Set when `status !== "ok"`. The whole reason, in one sentence, naming the file. */
  readonly problem?: string;
}

export interface RegistryDirReport {
  readonly dir: string;
  readonly exists: boolean;
  readonly files: number;
}

export interface AgentRegistry {
  readonly agents: readonly AgentDef[];
  readonly byName: ReadonlyMap<string, AgentDef>;
  /** Every problem found, one line each. Surfaced once at `session_start`. */
  readonly problems: readonly string[];
  readonly dirs: readonly RegistryDirReport[];
}

export interface LoadRegistryOptions {
  readonly dirs: readonly string[];
  readonly routing: RoutingConfig | undefined;
  readonly config: DispatchConfig;
  /** `provider/id` strings from `ctx.modelRegistry.getAvailable()`. Skipped when undefined. */
  readonly availableModels?: ReadonlySet<string>;
}

interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly problem?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Minimal YAML frontmatter split. `lib/frontmatter.ts` was intended as
 * an `EXT-01` deliverable, but `EXT-01` shipped without it, so this
 * lives here rather than in a shared module another item would then own.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { data: {}, body: raw, problem: "no YAML frontmatter block (--- ... ---) at the top of the file" };
  const body = raw.slice(match[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (err) {
    return { data: {}, body, problem: `frontmatter is not valid YAML: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: {}, body, problem: "frontmatter must be a YAML mapping" };
  }
  return { data: parsed as Record<string, unknown>, body };
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
        continue;
      }
      if (extname(entry) !== ".md") continue;
      // `*.chain.md` is pi-subagents' chain format, not an agent definition.
      if (entry.endsWith(".chain.md")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

function firstProblem(file: string, message: string): string {
  return `${file}: ${message}`;
}

/**
 * `config.ts`'s `registryDirs()` already drops exact string duplicates. This drops the ones that
 * are only *spelled* differently: `scripts/install.sh` symlinks `<repo>/agents` to
 * `<agentDir>/agents`, so on an installed machine two of the four configured entries are one real
 * directory. Without this, every definition is discovered twice — same inode, two paths — and the
 * shadow warning below fires 12 times at every session start for a shadow that does not exist,
 * which is how an operator learns to stop reading startup warnings.
 *
 * **The LAST occurrence is the one kept**, not the first, because discovery lets later directories
 * override earlier ones. For `[A, B, A']` where `A'` resolves to `A` and both `A` and `B` define
 * `scout`, today's winner is `A`'s copy (scanned last, via `A'`). Keeping the last occurrence
 * yields `[B, A']` and the same winner; keeping the first yields `[A, B]` and hands the win to
 * `B` — a silent change of which file a name resolves to. It also keeps the path string reported
 * in `/agents` and in problems byte-identical to today's.
 */
function dedupeByRealPath(dirs: readonly string[]): string[] {
  const keys = dirs.map(realPathKey);
  const lastIndexOfKey = new Map<string, number>();
  keys.forEach((key, index) => lastIndexOfKey.set(key, index));
  return dirs.filter((_dir, index) => lastIndexOfKey.get(keys[index] as string) === index);
}

/** Resolution is best-effort by design: an entry may be absent, a broken symlink, or unreadable.
 *  None of that may take discovery down, so an unresolvable entry keeps its configured path as its
 *  identity — at worst it is compared as a string, exactly as it was before this existed. */
function realPathKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Synchronous: `session_start` runs it once and the file count is small. */
export function loadAgentRegistry(opts: LoadRegistryOptions): AgentRegistry {
  const problems: string[] = [];
  const dirs: RegistryDirReport[] = [];
  const byName = new Map<string, AgentDef>();

  for (const dir of dedupeByRealPath(opts.dirs)) {
    let exists = false;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      // An absent registry directory is not an error — `.pi/agents` exists in some repos only.
      dirs.push({ dir, exists: false, files: 0 });
      continue;
    }
    const files = listMarkdown(dir);
    dirs.push({ dir, exists: true, files: files.length });
    for (const file of files) {
      const def = loadOne(file, dir, opts, problems);
      if (def === undefined) continue;
      const previous = byName.get(def.name);
      if (previous !== undefined && previous.file !== def.file) {
        // Later directories override earlier ones (repo -> user -> project), and the shadowing is
        // announced: two files claiming one name is almost always a copy nobody meant to keep.
        problems.push(
          `agent "${def.name}" in ${def.file} shadows ${previous.file}; the later definition wins`,
        );
      }
      byName.set(def.name, def);
    }
  }

  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { agents, byName, problems, dirs };
}

function loadOne(
  file: string,
  dir: string,
  opts: LoadRegistryOptions,
  problems: string[],
): AgentDef | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    problems.push(firstProblem(file, `unreadable: ${(err as Error).message}`));
    return undefined;
  }

  const { data, body, problem } = parseFrontmatter(raw);
  const fallbackName = basename(file, ".md");
  if (problem) {
    problems.push(firstProblem(file, problem));
    return brokenAgent(fallbackName, file, dir, body, problem);
  }

  if (!Value.Check(AgentFrontmatterSchema, data)) {
    const detail = [...Value.Errors(AgentFrontmatterSchema, data)]
      .slice(0, 6)
      // typebox 1.3.7 reports `instancePath`, not `path`.
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    problems.push(firstProblem(file, `bad frontmatter: ${detail}`));
    return brokenAgent(fallbackName, file, dir, body, `bad frontmatter: ${detail}`);
  }
  const fm = data as AgentFrontmatter & Record<string, unknown>;

  const local: string[] = [];
  if (fm.name !== fallbackName) {
    local.push(`frontmatter name "${fm.name}" does not match the filename "${fallbackName}.md"`);
  }
  if (fm.fallbackModels !== undefined) {
    local.push(
      `"fallbackModels" is present. Per-agent model fallback is refused: ` +
        `a child that quietly answers from a weaker model is worse than a child that fails.`,
    );
  }

  const { contract, problems: contractProblems } = parseReturnContract(
    { mode: fm.mode, returns: fm.returns, delivery: fm.delivery },
    fm.name,
  );
  local.push(...contractProblems);

  const spec = typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : `tier:${opts.config.defaultTier}`;
  let target: ModelTarget | undefined;
  /** Set only by the `optional`-tier runtime condition; see this file's header. */
  let restricted: string | undefined;

  if (opts.routing === undefined) {
    local.push(`routing.json could not be loaded, so "${spec}" cannot be resolved to a provider/id`);
  } else {
    try {
      target = resolveModelSpec(opts.routing, spec, opts.config.defaultTier);
    } catch (err) {
      local.push(err instanceof DispatchError ? `${err.kind}: ${err.message}` : String(err));
    }
    // Against the BASE id: `ctx.modelRegistry` is keyed by bare `provider/id`, and since a tier's
    // `thinkingLevel` moved into the model string (`tiers.ts`), `target.model` normally carries a
    // `:level` suffix. This check is separate from `assertAvailable`'s in `tiers.ts` and was missed
    // when that one was fixed: asking the registry about the suffixed string made every tier-bound
    // agent look absent at session start, with a message blaming the registry.
    const baseModel = target ? splitThinkingSuffix(target.model).baseModel : undefined;
    if (target && baseModel && opts.availableModels && !opts.availableModels.has(baseModel)) {
      if (target.optional) {
        // An `optional: true` tier (the local lane) is allowed to be absent: a local model server is not
        // always running. It is still refused at dispatch, but as "not available now", not as a
        // broken file.
        restricted = `model ${target.model} (from "${spec}") is not in the model registry; the "${target.tier}" tier is optional, so this is a runtime condition, not a file error`;
      } else {
        local.push(`model "${target.model}" (from "${spec}") is not in the model registry`);
      }
    }
  }

  const isolation: Isolation = fm.isolation === "worktree" ? "worktree" : "none";

  if (local.length > 0) {
    for (const line of local) problems.push(firstProblem(file, line));
    return {
      name: fm.name,
      description: fm.description,
      file,
      dir,
      systemPrompt: body.trim(),
      spec,
      ...(target ? { target } : {}),
      ...(fm.tools ? { tools: fm.tools } : {}),
      isolation,
      ...(fm.maxTurns !== undefined ? { maxTurns: fm.maxTurns } : {}),
      contract,
      status: "invalid",
      problem: local.join("; "),
    };
  }

  if (restricted !== undefined) {
    problems.push(firstProblem(file, restricted));
    return {
      name: fm.name,
      description: fm.description,
      file,
      dir,
      systemPrompt: body.trim(),
      spec,
      ...(target ? { target } : {}),
      ...(fm.tools ? { tools: fm.tools } : {}),
      isolation,
      ...(fm.maxTurns !== undefined ? { maxTurns: fm.maxTurns } : {}),
      contract,
      status: "restricted",
      problem: restricted,
    };
  }

  return {
    name: fm.name,
    description: fm.description,
    file,
    dir,
    systemPrompt: body.trim(),
    spec,
    ...(target ? { target } : {}),
    ...(fm.tools ? { tools: fm.tools } : {}),
    isolation,
    ...(fm.maxTurns !== undefined ? { maxTurns: fm.maxTurns } : {}),
    contract,
    status: "ok",
  };
}

function brokenAgent(name: string, file: string, dir: string, body: string, problem: string): AgentDef {
  return {
    name,
    description: "(unreadable)",
    file,
    dir,
    systemPrompt: body.trim(),
    spec: "",
    isolation: "none",
    contract: { mode: "subagent", returns: "text" },
    status: "invalid",
    problem,
  };
}

/** Agent names this session may dispatch. Feeds the capability ceiling's `allowedAgents`. */
export function dispatchableNames(registry: AgentRegistry): string[] {
  return registry.agents.filter((a) => a.status === "ok").map((a) => a.name);
}

/** The `/agents` table. One row per agent, wide enough to debug from and no wider. */
export function renderRegistry(registry: AgentRegistry, cwd: string): string {
  if (registry.agents.length === 0) {
    return (
      `no agents found. Looked in:\n` +
      registry.dirs.map((d) => `  ${d.dir}${d.exists ? ` (${d.files} file(s))` : " (absent)"}`).join("\n")
    );
  }
  const rows = registry.agents.map((a) => {
    const mark = a.status === "ok" ? "ok " : a.status === "restricted" ? "RES" : "ERR";
    const model = a.target ? `${a.spec} -> ${a.target.model}` : `${a.spec} -> (unresolved)`;
    const where = safeRelative(cwd, a.file);
    const tail = a.problem ? `\n      ${a.problem}` : "";
    return `  [${mark}] ${a.name.padEnd(22)} ${model}\n      ${describeReturnContract(a.contract)} | isolation: ${a.isolation} | ${where}${tail}`;
  });
  const counts = {
    ok: registry.agents.filter((a) => a.status === "ok").length,
    restricted: registry.agents.filter((a) => a.status === "restricted").length,
    invalid: registry.agents.filter((a) => a.status === "invalid").length,
  };
  return (
    `${registry.agents.length} agent(s): ${counts.ok} ok, ${counts.restricted} restricted, ${counts.invalid} invalid\n` +
    rows.join("\n")
  );
}

function safeRelative(from: string, to: string): string {
  try {
    const rel = relative(from, to);
    return rel && !rel.startsWith("..") ? rel : to;
  } catch {
    return to;
  }
}

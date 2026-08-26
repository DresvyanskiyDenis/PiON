/**
 * The roster PI itself can resolve — the second half of the ceiling's `allowedAgents`.
 *
 * `registerSubagentCapabilityCeiling({ allowedAgents })` is a **closed-world** allowlist: a name
 * absent from it is refused in preflight with `restricted_agent`. Our own registry
 * (`registry.ts`) only ever sees `config/dispatch.json`'s `registryDirs`, so it is an
 * *open-world* view — it knows the agents this configuration ships and nothing else. Building
 * the former out of the latter refuses every agent `pi-subagents` itself provides (`worker`,
 * `reviewer`, `oracle`, `scout`, `delegate`) and every agent a project supplies, for no reason
 * beyond "we do not own the file".
 *
 * `pi-subagents` does export the resolution itself — `discoverAgentsAll()` in
 * `src/agents/agents.ts` — but not through its `exports` map, and Node enforces that:
 * `import("pi-subagents/src/agents/agents.ts")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. So we
 * read the same directories it reads and take only the two fields the ceiling needs: the name,
 * and whether the agent is an external-CLI adapter.
 *
 * This reader is deliberately **generous**. It does not reproduce precedence, `disabled`,
 * settings overrides or `subagents.overrides` — it only widens an allowlist, and PI still
 * resolves every name for real afterwards. Over-including a name PI cannot resolve costs an
 * honest "no agent <name>" from PI; under-including one costs a `restricted_agent` refusal of a
 * working agent, which is the failure this exists to end.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listMarkdown, parseFrontmatter } from "./registry.ts";

/** `runner.type` of the CLI-adapter builtins. See `planCeiling` for why they are excluded. */
export const EXTERNAL_CLI_RUNNER = "external-cli";

/** `pi-subagents/src/agents/agents.ts` — `EXTRA_AGENT_DIRS_ENV`, PATH-style. */
const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

export interface RosterEntry {
  readonly name: string;
  /** `runner.type` from the frontmatter, when the file declares one. */
  readonly runnerType?: string;
  readonly file: string;
}

export interface RosterDirsInput {
  readonly cwd: string;
  readonly homeDir: string;
  /** PI's agent directory, whose `agents/` subdirectory is a user source. */
  readonly agentDir?: string;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The directories `discoverAgents()` reads, in its own order: builtin, then user
 * (`$PI_SUBAGENT_EXTRA_AGENT_DIRS`, `<agentDir>/agents`, `~/.agents`), then project.
 * Absent ones are harmless — `readAgentRoster` skips what it cannot stat.
 */
export function agentRosterDirs(input: RosterDirsInput): string[] {
  const env = input.env ?? process.env;
  const dirs: (string | undefined)[] = [
    builtinAgentsDir(),
    ...(env[EXTRA_AGENT_DIRS_ENV] ?? "").split(delimiter).map((d) => d.trim()).filter((d) => d.length > 0),
    input.agentDir !== undefined ? join(input.agentDir, "agents") : undefined,
    join(input.homeDir, ".agents"),
    join(input.cwd, ".pi", "agents"),
    join(input.cwd, ".agents"),
  ];
  return [...new Set(dirs.filter((d): d is string => d !== undefined))];
}

/**
 * `<pi-subagents>/agents`, found by walking up from an *exported* subpath until a `package.json`
 * names the package. Resolving the directory this way rather than hard-coding
 * `node_modules/pi-subagents/agents` survives hoisting, workspaces and pnpm's store layout.
 */
export function builtinAgentsDir(): string | undefined {
  let current: string;
  try {
    current = dirname(fileURLToPath(import.meta.resolve("pi-subagents/capability-ceiling")));
  } catch {
    return undefined;
  }
  for (let up = 0; up < 8; up += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf-8")) as { name?: string };
      if (manifest.name === "pi-subagents") {
        const agents = join(current, "agents");
        return statSync(agents).isDirectory() ? agents : undefined;
      }
    } catch {
      // Not the package root, or not readable. Keep walking; the loop bound ends it.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * `isLegacyAgentSkillPath` in `pi-subagents/src/agents/agents.ts`: anything under
 * `.agents/skills/` is a skill, not an agent, and is skipped. Note the rule keys on the literal
 * directory name — a `.agents/skills-archived/` left beside it is *not* excluded, and its
 * `SKILL.md` files surface as agents named after their skills. That is upstream behaviour we
 * mirror rather than correct: the ceiling's job is to allow what PI resolves, not to adjudicate
 * what PI should have resolved.
 */
function isLegacySkillPath(root: string, file: string): boolean {
  const parts = relative(root, file).split(sep).map((p) => p.toLowerCase());
  if (root.toLowerCase().endsWith(`${sep}.agents`)) parts.unshift(".agents");
  return parts.some((part, i) => part === ".agents" && parts[i + 1] === "skills");
}

/** Reads `name` and `runner.type` out of every agent definition in `dirs`. Never throws. */
export function readAgentRoster(dirs: readonly string[]): RosterEntry[] {
  const byName = new Map<string, RosterEntry>();
  for (const dir of dirs) {
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // One realpath for both the walk and the skill test: `listMarkdown` returns paths under
    // whatever root it was given, and `isLegacySkillPath` measures them relative to that root.
    // Handing it the unresolved `dir` on a platform where the temp root is a symlink (macOS)
    // makes every relative path start with `../`, and the skill exclusion stops matching.
    let root: string;
    let files: string[];
    try {
      root = realpathSync(dir);
      files = listMarkdown(root, () => {});
    } catch {
      continue;
    }
    for (const file of files) {
      if (isLegacySkillPath(root, file)) continue;
      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(raw);
      const name = data["name"];
      if (typeof name !== "string" || name.trim().length === 0) continue;
      const runner = data["runner"];
      const runnerType =
        runner !== null && typeof runner === "object" && typeof (runner as { type?: unknown }).type === "string"
          ? (runner as { type: string }).type
          : undefined;
      // First writer wins: `dirs` is already in discovery order.
      if (!byName.has(name.trim())) {
        byName.set(name.trim(), { name: name.trim(), file, ...(runnerType !== undefined ? { runnerType } : {}) });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

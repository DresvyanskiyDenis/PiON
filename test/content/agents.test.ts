/**
 * Validates the shipped sub-agent definitions the same way `session_start` would — by running them
 * through the real `EXT-05` registry loader against the repository's own routing table — plus the
 * personal-data hygiene checks `bin/pi-check` asserts.
 *
 * Deliberately does NOT re-implement frontmatter parsing: importing `extensions/dispatch/registry.ts`
 * means a change to the real schema (`AgentFrontmatterSchema`) breaks this test the same day it breaks
 * `session_start`, instead of silently drifting.
 *
 * **`agents-private/` is git-ignored and does not ship.** It is where a user puts their own
 * definitions, so it is absent on a clean checkout and present on an install. Every assertion here is
 * therefore written over `agents/` ∪ (`agents-private/` when it exists): the shipped set is pinned by
 * name, and anything the operator added is held to the same hygiene rules without being enumerated.
 */
import "../lib/repo-config.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, shippedConfig } from "../lib/repo-config.ts";
import { loadAgentRegistry, dispatchableNames, type AgentRegistry } from "../../extensions/dispatch/registry.ts";
import { DEFAULT_DISPATCH_CONFIG } from "../../extensions/dispatch/config.ts";
import { loadDispatchSettings } from "../../extensions/dispatch/config.ts";

const sharedDir = join(REPO, "agents");
const privateDir = join(REPO, "agents-private");
const schemasDir = join(REPO, "config", "schemas");

/** The twelve definitions this repository ships. */
const SHIPPED = [
  "ai-engineer",
  "app-builder",
  "architect-reviewer",
  "code-reviewer",
  "data-engineer",
  "debugger",
  "docs-architect",
  "frontend-developer",
  "local-llm-engineer",
  "prompt-engineer",
  "researcher",
  "security-reviewer",
] as const;

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** `agents/` plus `agents-private/` when the operator has one — every file the registry will see. */
const agentDirs = [sharedDir, privateDir].filter((dir) => existsSync(dir));

function loadRegistry(): AgentRegistry {
  // The repository's own routing table: the generated `config/routing.json` when the installer has
  // produced one, otherwise the tracked `config/routing.default.json` it is generated from. Not a
  // synthetic RoutingConfig (test/dispatch/helpers.ts has that, for its own unit tests) — this file
  // wants the shipped tier bindings.
  const settings = loadDispatchSettings({ routingPath: shippedConfig("routing") });
  assert.equal(settings.routing !== undefined, true, `routing must load: ${settings.problems.join("; ")}`);
  return loadAgentRegistry({
    dirs: agentDirs,
    routing: settings.routing,
    config: DEFAULT_DISPATCH_CONFIG,
    // No session egress class is passed, because the loader no longer takes one: egress containment
    // was withdrawn on 2026-08-13, so a file's verdict no longer depends on who is asking. This test
    // always meant to assert the FILES are well-formed, which is now the only thing it can assert.
  });
}

describe("agent registry — the shipped definitions", () => {
  it("ships exactly twelve agents in agents/, and agents-private/ is optional", () => {
    assert.deepEqual(
      mdFiles(sharedDir),
      SHIPPED.map((name) => `${name}.md`),
    );
    // agents-private/ is git-ignored: absent on a clean checkout, whatever the operator wrote on an
    // install. Asserting a name here would pin someone's personal tree into the public repository.
    assert.ok(
      !existsSync(privateDir) || mdFiles(privateDir).length >= 0,
      "agents-private/, when present, must be a readable directory of .md files",
    );
  });

  it("every discovered agent file loads as status 'ok' through the real EXT-05 registry", () => {
    const registry = loadRegistry();
    const names = registry.agents.map((a) => a.name).sort();
    const expected = agentDirs.flatMap((dir) => mdFiles(dir).map((f) => f.replace(/\.md$/, ""))).sort();
    assert.deepEqual(names, expected);
    for (const name of SHIPPED) assert.ok(names.includes(name), `${name} must load`);
    const notOk = registry.agents.filter((a) => a.status !== "ok");
    assert.deepEqual(
      notOk.map((a) => `${a.name}: ${a.problem}`),
      [],
      `every agent must resolve cleanly; registry.problems: ${registry.problems.join("\n")}`,
    );
  });

  it("dispatchableNames returns every discovered agent (nothing invalid, nothing egress-restricted)", () => {
    const registry = loadRegistry();
    assert.equal(dispatchableNames(registry).length, registry.agents.length);
    assert.ok(dispatchableNames(registry).length >= SHIPPED.length);
  });

  it("model tiers: the six review/engineering agents are strong, the rest fast", () => {
    const registry = loadRegistry();
    const byName = registry.byName;
    const strongTier = ["ai-engineer", "architect-reviewer", "debugger", "security-reviewer", "code-reviewer", "data-engineer"];
    const fastTier = ["app-builder", "docs-architect", "frontend-developer", "local-llm-engineer", "prompt-engineer", "researcher"];
    for (const name of strongTier) {
      assert.equal(byName.get(name)?.spec, "strong", `${name} must declare model: strong`);
    }
    for (const name of fastTier) {
      assert.equal(byName.get(name)?.spec, "fast", `${name} must declare model: fast`);
    }
    // Every shipped agent is accounted for by exactly one of the two lists.
    assert.deepEqual([...strongTier, ...fastTier].toSorted(), [...SHIPPED].toSorted());
  });

  it("no bare model id anywhere in an agent file — a tier name or nothing", () => {
    for (const dir of agentDirs) {
      for (const file of mdFiles(dir)) {
        const text = readFileSync(join(dir, file), "utf8");
        const modelLine = text.match(/^model:\s*(.+)$/m);
        assert.ok(modelLine, `${file} must declare a model: line`);
        const value = modelLine![1].trim();
        assert.ok(
          !/\b(opus|sonnet|haiku|claude-|gpt-|gemini-)/i.test(value),
          `${file}: model: "${value}" looks like a bare model id, not a tier name`,
        );
        assert.match(value, /^(strong|fast|cheap|confidential|local)$/, `${file}: model: "${value}" is not a routing tier`);
      }
    }
  });

  it("returns:object agents each have a matching file under config/schemas/", () => {
    const registry = loadRegistry();
    const reportAgents: Record<string, string> = {
      debugger: "debug-report.ts",
      "code-reviewer": "code-review-report.ts",
      "architect-reviewer": "architect-review-report.ts",
      "security-reviewer": "security-review-report.ts",
    };
    for (const [name, schemaFile] of Object.entries(reportAgents)) {
      const def = registry.byName.get(name);
      assert.ok(def, `${name} must be loadable`);
      assert.equal(def!.contract.returns, "object", `${name} must declare returns: object`);
      assert.ok(existsSync(join(schemasDir, schemaFile)), `config/schemas/${schemaFile} must exist for ${name}`);
    }
    // And no OTHER shipped agent claims a structured return it has no schema for.
    for (const def of registry.agents) {
      if (def.name in reportAgents) continue;
      if (def.dir !== sharedDir) continue;
      assert.equal(def.contract.returns, "text", `${def.name} should not declare returns: object without a schema`);
    }
  });

  it("every shipped agent is mode: subagent (none is a teammate) — dispatch() gets a real return value", () => {
    const registry = loadRegistry();
    for (const def of registry.agents) {
      if (def.dir !== sharedDir) continue;
      assert.equal(def.contract.mode, "subagent", `${def.name} must be mode: subagent, not teammate`);
    }
  });

  it("shipped agents carry no mcp__ grant and no machine, tenant or operator name", () => {
    // The publication gate, asserted in the suite so a re-imported personal definition fails here
    // rather than in review. Deliberately shape-based, not a generic hostname regex: agent prose
    // legitimately contains `llama.cpp`, `e.g.` and file names, and a rule that flags those gets
    // switched off within a week.
    //
    // The site-specific half of this list used to be literal — one operator's home-server hostname,
    // employer's GitHub Enterprise tenant, laptop asset-tag prefix and cloud workspace id. Those
    // came out when the repo was published: a deny-list is read by everyone who clones you, and
    // spelling out the names you are hiding hides nothing. The generic shapes below stay, and your
    // own literals go in $PI_PUBLICATION_DENY (a `|`-joined regex source), which is where a fork
    // adds the four strings that matter to IT:
    //
    //     PI_PUBLICATION_DENY='\bmy-server\b|\bacme\.example\.com\b' npm test
    const forbidden: Array<[RegExp, string]> = [
      [/mcp__/, "an mcp__ tool grant"],
      [/\b[a-z0-9][a-z0-9-]*\.ghe\.com\b/i, "an enterprise GitHub host"],
      [/\b(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}(?:\.\d{1,3}){0,2}\b/,
        "a private, link-local or tailnet IP address"],
      [/\/(?:Users|home)\/[a-z][a-z0-9_.-]*\//i, "an absolute path through somebody's home directory"],
      [/\b[a-z][a-z0-9-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b/i, "a personal account or e-mail address"],
      [/\bhttps?:\/\/[a-z0-9-]*\d{8,}[a-z0-9-]*\./i, "a tenant/workspace id inside a hostname"],
      // The same shape `isSoulShaped()` in extensions/compaction/pinned.ts refuses: a personal
      // identity file is never shipped, so a shipped agent has no business naming one.
      [/(^|[^a-z])soul([^a-z]|$)/i, "a personal identity file"],
    ];
    // A fork's own literals, opt-in through the environment. Invalid regex source fails loudly here
    // rather than silently disabling the check.
    const extra = process.env.PI_PUBLICATION_DENY?.trim();
    if (extra) forbidden.push([new RegExp(extra, "i"), "a string listed in $PI_PUBLICATION_DENY"]);
    for (const file of mdFiles(sharedDir)) {
      const text = readFileSync(join(sharedDir, file), "utf8");
      for (const [pattern, what] of forbidden) {
        const hit = text.match(pattern);
        assert.equal(hit, null, `${file}: a shipped agent must not name ${what} (found ${JSON.stringify(hit?.[0])})`);
      }
    }
  });

  it("no agent file uses Glob, Skill-as-a-tool, or an mcp__context7 hard grant (the three common porting mistakes)", () => {
    const registry = loadRegistry();
    for (const def of registry.agents) {
      assert.ok(def.tools?.length, `${def.file} must declare tools:`);
      for (const tool of def.tools ?? []) {
        assert.ok(!/^Glob$/.test(tool), `${def.file}: tools: still lists Glob, must be find`);
        assert.ok(!/^Skill$/.test(tool), `${def.file}: tools: still lists Skill, which is not a PI tool`);
        assert.ok(!/mcp__context7/.test(tool), `${def.file}: tools: hard-grants mcp__context7, which is off by default`);
      }
    }
  });

  it("no agent, shipped or private, grants an mcp__ tool (D5/WONT applies harness-wide)", () => {
    // Checks the parsed `tools:` allowlist only, not the whole file: a definition may legitimately
    // *discuss* an mcp verb in prose. Read through the registry rather than a regex over the line: a
    // regex has to assume a YAML list shape, and assuming the wrong one is precisely how `tools:`
    // broke once already (see test/agents/frontmatter.test.ts).
    const registry = loadRegistry();
    for (const def of registry.agents) {
      assert.ok(def.tools?.length, `${def.file} must declare tools:`);
      for (const tool of def.tools ?? []) {
        assert.ok(!/mcp__/.test(tool), `${def.file}: tools: must not grant an mcp__ tool — gone entirely in this harness (D5/WONT)`);
      }
    }
  });

  it("frontmatter name: matches the filename for every agent (registry.ts's own shadow-detection rule)", () => {
    for (const dir of agentDirs) {
      for (const file of mdFiles(dir)) {
        const text = readFileSync(join(dir, file), "utf8");
        const nameLine = text.match(/^name:\s*(.+)$/m);
        assert.ok(nameLine, `${file} must declare name:`);
        assert.equal(nameLine![1].trim(), file.replace(/\.md$/, ""));
      }
    }
  });
});

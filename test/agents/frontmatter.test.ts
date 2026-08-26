/**
 * Regression guard for the agent-definition frontmatter list shape.
 *
 * Two consumers read the same `tools:` / `skills:` keys and disagree about what a list is:
 *
 *   1. **Our** `extensions/dispatch/registry.ts` parses the block with a real YAML parser and
 *      checks `AgentFrontmatterSchema`, where `tools` and `skills` are `Type.Array(Type.String())`.
 *      Anything that is not a YAML sequence is `bad frontmatter: /tools must be array` and the
 *      agent is refused by name at `session_start`.
 *   2. **pi-subagents 0.41.0** does not YAML-parse those keys at all. `parseFrontmatterList`
 *      (`node_modules/pi-subagents/src/agents/frontmatter.ts`, consumed by `src/agents/agents.ts`)
 *      takes the raw scalar, strips a leading `- ` per line and splits on commas. Its README
 *      documents two accepted forms: a comma-separated scalar, or a `- item` block list.
 *
 * A YAML flow sequence — `tools: [read, grep, find, bash, web_search, web_fetch]` — satisfies (1)
 * and breaks (2): the brackets are ordinary characters to a comma splitter, so the first and last
 * entries become `[read` and `web_fetch]`. Since `tools` is the child's strict allowlist, the child
 * ran without `read` and `web_fetch`, and the parent then discarded its answer with
 * `Agent 'researcher' requested unavailable child tools: [read, web_fetch]`.
 *
 * A comma scalar — `tools: read, grep` — is the mirror-image trap: it satisfies (2) and breaks (1).
 *
 * The one shape both consumers read identically is a block sequence, so these assertions run both
 * parsers over the real definitions and require them to agree entry for entry.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { AgentFrontmatterSchema, parseFrontmatter } from "../../extensions/dispatch/registry.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT_DIRS = ["agents", "agents-private"] as const;
const SKILL_DIRS = ["skills"] as const;

/** The keys pi-subagents feeds through `parseFrontmatterList`, intersected with the ones our
 *  schema types as arrays. Both consumers must agree on every one of them. */
const LIST_KEYS = ["tools", "skills", "aliases"] as const;

/** Verbatim port of `parseFrontmatterList` from pi-subagents 0.41.0 — the second consumer. */
function parseFrontmatterList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split("\n")
    .flatMap((line) => {
      const value = line.trim();
      const listItem = value.match(/^-\s+(.+)$/);
      return (listItem?.[1] ?? value).split(",");
    })
    .map((value) => value.trim())
    .filter(Boolean);
}

/** pi-subagents reads the raw scalar of a key, block continuation lines included. */
function rawScalar(frontmatterBlock: string, key: string): string | undefined {
  const lines = frontmatterBlock.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start === -1) return undefined;
  const first = (lines[start] ?? "").slice(key.length + 1).trim();
  if (first) return first;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return block.join("\n");
}

interface AgentFile {
  readonly id: string;
  readonly raw: string;
  readonly block: string;
}

function loadAgents(): AgentFile[] {
  const found: AgentFile[] = [];
  for (const dir of AGENT_DIRS) {
    const abs = join(repoRoot, dir);
    // agents-private/ is git-ignored and absent on a fresh clone.
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).filter((f) => f.endsWith(".md"))) {
      const raw = readFileSync(join(abs, name), "utf-8");
      found.push({ id: `${dir}/${name}`, raw, block: /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "" });
    }
  }
  return found;
}

const agents = loadAgents();

describe("agent frontmatter list fields", () => {
  it("finds the tracked agent definitions", () => {
    assert.ok(agents.length >= 12, `expected the agents/ definitions, found ${agents.length}`);
    assert.ok(agents.some((a) => a.id === "agents/researcher.md"), "agents/researcher.md must be discoverable");
  });

  it("passes our own dispatch schema, which types the list keys as YAML arrays", () => {
    for (const agent of agents) {
      const { data, problem } = parseFrontmatter(agent.raw);
      assert.equal(problem, undefined, `${agent.id}: ${problem}`);
      const errors = [...Value.Errors(AgentFrontmatterSchema, data)].map((e) => `${e.instancePath || "/"} ${e.message}`);
      assert.deepEqual(errors, [], `${agent.id}: bad frontmatter — ${errors.join("; ")}`);
      assert.ok(Array.isArray((data as { tools?: unknown }).tools), `${agent.id}: tools: must be a YAML sequence`);
    }
  });

  it("parses identically under pi-subagents' comma splitter", () => {
    for (const agent of agents) {
      const { data } = parseFrontmatter(agent.raw);
      for (const key of LIST_KEYS) {
        const yamlValue = (data as Record<string, unknown>)[key];
        if (yamlValue === undefined) continue;
        assert.deepEqual(
          parseFrontmatterList(rawScalar(agent.block, key)),
          yamlValue,
          `${agent.id}: ${key}: is read differently by pi-subagents than by our YAML schema` +
            " — write it as a `- item` block list, the only shape both consumers agree on",
        );
      }
    }
  });

  it("names skills that exist in this repo", () => {
    const available = new Set<string>();
    for (const dir of SKILL_DIRS) {
      const abs = join(repoRoot, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        if (statSync(join(abs, name)).isDirectory()) available.add(name);
      }
    }
    for (const agent of agents) {
      const skills = (parseFrontmatter(agent.raw).data as { skills?: unknown }).skills;
      if (!Array.isArray(skills)) continue;
      for (const skill of skills) {
        assert.ok(available.has(String(skill)), `${agent.id}: skills entry ${JSON.stringify(skill)} has no skill directory`);
      }
    }
  });

  it("pins both failure modes", () => {
    // Flow sequence: our schema accepts it, pi-subagents mangles the ends.
    assert.deepEqual(parseFrontmatterList("[read, grep, web_fetch]"), ["[read", "grep", "web_fetch]"]);
    // Comma scalar: pi-subagents accepts it, our schema rejects it as a non-array.
    const commaScalar = parseFrontmatter("---\nname: scout\ndescription: a fixture description\ntools: read, grep\n---\n").data;
    assert.equal(typeof (commaScalar as { tools?: unknown }).tools, "string");
    assert.ok(!Value.Check(AgentFrontmatterSchema, commaScalar), "a comma scalar must fail the dispatch schema");
    // Block list: both agree.
    assert.deepEqual(parseFrontmatterList("\n- read\n- web_fetch"), ["read", "web_fetch"]);
    const blockList = parseFrontmatter("---\nname: scout\ndescription: a fixture description\ntools:\n  - read\n  - grep\n---\n").data;
    assert.deepEqual((blockList as { tools?: unknown }).tools, ["read", "grep"]);
    assert.ok(Value.Check(AgentFrontmatterSchema, blockList), "a block list must pass the dispatch schema");
  });
});

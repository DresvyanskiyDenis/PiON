import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchableNames,
  loadAgentRegistry,
  parseFrontmatter,
  renderRegistry,
} from "../../extensions/dispatch/registry.ts";
import type { EgressClass } from "../../extensions/lib/dispatch-veto.ts";
import { ALL_MODELS, CONFIG, GOOD_SCOUT, ROUTING, scratch, writeAgents, type AgentFile } from "./helpers.ts";

function load(files: readonly AgentFile[], sessionEgress: EgressClass = "public") {
  const dir = writeAgents(join(scratch(), "agents"), files);
  return {
    dir,
    registry: loadAgentRegistry({
      dirs: [dir],
      routing: ROUTING,
      config: CONFIG,
      sessionEgress,
      availableModels: ALL_MODELS,
    }),
  };
}

const problemText = (r: { problems: readonly string[] }) => r.problems.join("\n");

describe("parseFrontmatter", () => {
  it("splits a well-formed file", () => {
    const fm = parseFrontmatter("---\nname: scout\n---\nbody text\n");
    assert.equal(fm.problem, undefined);
    assert.deepEqual(fm.data, { name: "scout" });
    assert.equal(fm.body.trim(), "body text");
  });

  it("reports a missing block, bad YAML and a non-mapping", () => {
    assert.match(parseFrontmatter("just a prompt\n").problem ?? "", /no YAML frontmatter block/);
    assert.match(parseFrontmatter("---\nname: [unclosed\n---\nx\n").problem ?? "", /not valid YAML/);
    assert.match(parseFrontmatter("---\n- a\n- b\n---\nx\n").problem ?? "", /must be a YAML mapping/);
  });
});

describe("loadAgentRegistry", () => {
  it("accepts a good agent and resolves its tier", () => {
    const { registry } = load([GOOD_SCOUT]);
    assert.deepEqual(registry.problems, []);
    const scout = registry.byName.get("scout");
    assert.equal(scout?.status, "ok");
    assert.equal(scout?.target?.model, "databricks/databricks-claude-haiku-4-5");
    assert.equal(scout?.contract.mode, "subagent");
    assert.deepEqual(scout?.tools, ["read", "grep"]);
    assert.deepEqual(dispatchableNames(registry), ["scout"]);
  });

  it("defaults the model to the configured default tier when the file omits it", () => {
    const { registry } = load([
      { name: "plain", frontmatter: "name: plain\ndescription: A perfectly ordinary agent for testing." },
    ]);
    assert.deepEqual(registry.problems, []);
    assert.equal(registry.byName.get("plain")?.spec, `tier:${CONFIG.defaultTier}`);
  });

  // The plan's first acceptance criterion: a typo in one of 14 agent files is a session_start
  // error, not a surprise at minute 40. Each of these is a distinct typo class.
  it("ACCEPTANCE: a name/filename mismatch is invalid at load", () => {
    const { registry } = load([
      { name: "scout", frontmatter: "name: scount\ndescription: Typo in the name field, not the filename." },
    ]);
    assert.equal(registry.byName.get("scount")?.status, "invalid");
    assert.match(problemText(registry), /does not match the filename "scout\.md"/);
  });

  it("ACCEPTANCE: broken YAML is invalid at load", () => {
    const { registry } = load([{ name: "broken", frontmatter: "name: broken\n  description: [oops" }]);
    assert.equal(registry.byName.get("broken")?.status, "invalid");
    assert.match(problemText(registry), /not valid YAML|bad frontmatter/);
  });

  it("ACCEPTANCE: an unknown tier is invalid at load and the known tiers are named", () => {
    const { registry } = load([
      { name: "deep", frontmatter: "name: deep\ndescription: Asks for a tier that does not exist.\nmodel: tier:deepthink" },
    ]);
    assert.equal(registry.byName.get("deep")?.status, "invalid");
    assert.match(problemText(registry), /unknown tier "deepthink"/);
    assert.match(problemText(registry), /strong, fast, cheap/);
  });

  it("ACCEPTANCE: a schema violation is invalid at load", () => {
    const { registry } = load([{ name: "short", frontmatter: "name: short\ndescription: too short" }]);
    assert.equal(registry.byName.get("short")?.status, "invalid");
    assert.match(problemText(registry), /bad frontmatter/);
  });

  it("ACCEPTANCE: a teammate without a delivery channel is invalid at load", () => {
    const { registry } = load([
      { name: "mate", frontmatter: "name: mate\ndescription: A teammate that never says where it delivers.\nmode: teammate" },
    ]);
    assert.equal(registry.byName.get("mate")?.status, "invalid");
    assert.match(problemText(registry), /requires delivery/);
  });

  it("rejects fallbackModels outright", () => {
    const { registry } = load([
      {
        name: "hedged",
        frontmatter: "name: hedged\ndescription: Wants a quieter model when the first one fails.\nfallbackModels: [cheap]",
      },
    ]);
    assert.equal(registry.byName.get("hedged")?.status, "invalid");
    assert.match(problemText(registry), /Per-agent model fallback is refused/);
  });

  it("rejects a model that is not in the model registry", () => {
    const { registry } = load([
      { name: "ghost", frontmatter: "name: ghost\ndescription: Names a model nobody has.\nmodel: databricks/gpt-0.1" },
    ]);
    assert.equal(registry.byName.get("ghost")?.status, "invalid");
    assert.match(problemText(registry), /is not in the model registry/);
  });

  it("treats an absent OPTIONAL tier as restricted, not as a broken file", () => {
    // ALL_MODELS deliberately omits local/qwen3.6-35b: llama-swap is not always running.
    const { registry } = load([
      { name: "offline", frontmatter: "name: offline\ndescription: Runs on the local lane when it is up.\nmodel: local" },
    ], "confidential");
    const agent = registry.byName.get("offline");
    assert.equal(agent?.status, "restricted");
    assert.match(agent?.problem ?? "", /runtime condition, not a file error/);
    assert.deepEqual(dispatchableNames(registry), []);
  });

  // The plan's second acceptance criterion: egress containment.
  it("ACCEPTANCE: a confidential session cannot dispatch an agent pinned to a public provider", () => {
    // `scout`'s own `cheap` tier is `databricks` (confidential) now, so it no longer doubles as an
    // "internal is also out of bounds" example the way it did when `cheap` was litellm — that
    // provider is deleted from config/routing.json and nothing replaced it in the `internal` class.
    // `internal-agent` below is pinned, via a synthetic routing fixture built just for this test,
    // to a provider explicitly classed `internal` so that containment path stays exercised even
    // though no shipped provider is `internal` any more.
    const internalRouting = {
      ...ROUTING,
      egress: { ...ROUTING.egress, "test-internal-provider": "internal" as const },
    };
    const dir = writeAgents(join(scratch(), "agents"), [
      GOOD_SCOUT,
      { name: "big", frontmatter: "name: big\ndescription: Runs on the strong public tier.\nmodel: strong" },
      {
        name: "internal-agent",
        frontmatter:
          "name: internal-agent\ndescription: Pinned to a synthetic internal-class provider.\nmodel: test-internal-provider/some-model",
      },
    ]);
    const registry = loadAgentRegistry({
      dirs: [dir],
      routing: internalRouting,
      config: CONFIG,
      sessionEgress: "confidential",
      availableModels: new Set([...ALL_MODELS, "test-internal-provider/some-model"]),
    });
    assert.equal(registry.byName.get("big")?.status, "restricted");
    assert.equal(
      registry.byName.get("internal-agent")?.status,
      "restricted",
      "internal is also out of bounds for a confidential session",
    );
    assert.match(problemText(registry), /a confidential session may not dispatch onto a public provider/);
    // scout's own tier already resolves to the strictest class, so it is legitimately dispatchable
    // here — unlike when `cheap` was litellm and nothing at all was dispatchable in this session.
    assert.deepEqual(dispatchableNames(registry), ["scout"]);
  });

  it("the same agents are fine in a public session", () => {
    const { registry } = load([GOOD_SCOUT, { name: "big", frontmatter: "name: big\ndescription: Runs on the strong public tier.\nmodel: strong" }], "public");
    assert.deepEqual(dispatchableNames(registry), ["big", "scout"]);
  });

  it("announces shadowing and lets the later directory win", () => {
    const root = scratch();
    const first = writeAgents(join(root, "a"), [GOOD_SCOUT]);
    const second = writeAgents(join(root, "b"), [
      { name: "scout", frontmatter: "name: scout\ndescription: The overriding definition from the later directory.\nmodel: strong" },
    ]);
    const registry = loadAgentRegistry({
      dirs: [first, second],
      routing: ROUTING,
      config: CONFIG,
      sessionEgress: "public",
      availableModels: ALL_MODELS,
    });
    assert.match(problemText(registry), /shadows/);
    assert.equal(registry.byName.get("scout")?.target?.model, "github-copilot/claude-opus-5");
    assert.equal(registry.agents.length, 1);
  });

  /**
   * `scripts/install.sh` symlinks `<repo>/agents` to `<agentDir>/agents`, and `config/dispatch.json`
   * lists both — so on an installed machine two configured entries are one real directory and every
   * definition used to be discovered twice, warning about a shadow that does not exist (12 lines at
   * every session start). Real symlinks in `$TMPDIR`, not mocks: an unresolved symlink is the bug.
   */
  describe("registry directories that are the same real directory", () => {
    it("scans one real directory once, however many paths reach it, and says nothing", () => {
      const root = scratch();
      const real = writeAgents(join(root, "agents"), [GOOD_SCOUT]);
      const alias = join(root, "linked-agents");
      symlinkSync(real, alias);
      const registry = loadAgentRegistry({
        dirs: [real, alias],
        routing: ROUTING,
        config: CONFIG,
        sessionEgress: "public",
        availableModels: ALL_MODELS,
      });
      assert.deepEqual(registry.problems, [], "one real directory reached twice is not a shadow");
      assert.equal(registry.agents.length, 1);
      assert.equal(registry.dirs.length, 1, "the duplicate must not even be scanned");
    });

    it("still announces a real shadow — two different files, one agent name", () => {
      const root = scratch();
      const first = writeAgents(join(root, "a"), [GOOD_SCOUT]);
      const second = writeAgents(join(root, "b"), [
        { name: "scout", frontmatter: "name: scout\ndescription: A genuinely different definition of the same name.\nmodel: strong" },
      ]);
      const registry = loadAgentRegistry({
        dirs: [first, second],
        routing: ROUTING,
        config: CONFIG,
        sessionEgress: "public",
        availableModels: ALL_MODELS,
      });
      assert.match(problemText(registry), /shadows/);
      assert.equal(registry.dirs.length, 2);
    });

    it("keeps the LAST occurrence, so the directory that wins today still wins", () => {
      // [A, B, A'] with A' -> A, and `scout` defined in both A and B. Scanned in order, A's copy
      // wins today because A' is last. Deduping to [B, A'] preserves that; deduping to [A, B] would
      // silently hand the name to B.
      const root = scratch();
      const a = writeAgents(join(root, "a"), [GOOD_SCOUT]);
      const b = writeAgents(join(root, "b"), [
        { name: "scout", frontmatter: "name: scout\ndescription: The definition that must NOT win here.\nmodel: strong" },
      ]);
      const aAlias = join(root, "a-alias");
      symlinkSync(a, aAlias);
      const registry = loadAgentRegistry({
        dirs: [a, b, aAlias],
        routing: ROUTING,
        config: CONFIG,
        sessionEgress: "public",
        availableModels: ALL_MODELS,
      });
      const scout = registry.byName.get("scout");
      assert.equal(
        scout?.target?.model,
        "databricks/databricks-claude-haiku-4-5",
        "A's cheap-tier definition must still be the winner",
      );
      assert.equal(scout?.dir, aAlias, "and it must still be reported under the last-listed path");
      assert.match(problemText(registry), /shadows/, "A vs B is a real shadow and stays announced");
    });

    it("carries on when an entry cannot be resolved at all", () => {
      const root = scratch();
      const real = writeAgents(join(root, "agents"), [GOOD_SCOUT]);
      const broken = join(root, "broken-link");
      symlinkSync(join(root, "nowhere"), broken);
      const registry = loadAgentRegistry({
        dirs: [broken, real],
        routing: ROUTING,
        config: CONFIG,
        sessionEgress: "public",
        availableModels: ALL_MODELS,
      });
      assert.deepEqual(registry.problems, []);
      assert.equal(registry.byName.get("scout")?.status, "ok", "one unresolvable entry must not stop discovery");
      assert.equal(registry.dirs.find((d) => d.dir === broken)?.exists, false);
    });
  });

  it("an absent registry directory is reported, not an error", () => {
    const registry = loadAgentRegistry({
      dirs: [join(scratch(), "definitely-not-here")],
      routing: ROUTING,
      config: CONFIG,
      sessionEgress: "public",
      availableModels: ALL_MODELS,
    });
    assert.deepEqual(registry.problems, []);
    assert.equal(registry.dirs[0]?.exists, false);
    assert.equal(registry.agents.length, 0);
  });

  it("skips pi-subagents chain files", () => {
    const dir = join(scratch(), "agents");
    writeAgents(dir, [GOOD_SCOUT]);
    writeAgents(dir, [{ name: "review.chain", frontmatter: "steps: []" }]);
    const registry = loadAgentRegistry({
      dirs: [dir],
      routing: ROUTING,
      config: CONFIG,
      sessionEgress: "public",
      availableModels: ALL_MODELS,
    });
    assert.deepEqual(registry.agents.map((a) => a.name), ["scout"]);
  });

  it("refuses every agent when routing.json is missing, rather than guessing a model", () => {
    const dir = writeAgents(join(scratch(), "agents"), [GOOD_SCOUT]);
    const registry = loadAgentRegistry({
      dirs: [dir],
      routing: undefined,
      config: CONFIG,
      sessionEgress: "public",
    });
    assert.equal(registry.byName.get("scout")?.status, "invalid");
    assert.match(problemText(registry), /routing\.json could not be loaded/);
  });

  it("honours isolation: worktree from the frontmatter", () => {
    const { registry } = load([
      { name: "surgeon", frontmatter: "name: surgeon\ndescription: Edits code and therefore needs its own worktree.\nisolation: worktree" },
    ]);
    assert.equal(registry.byName.get("surgeon")?.isolation, "worktree");
  });
});

describe("renderRegistry", () => {
  it("marks each row with its status and prints the problem underneath", () => {
    const { registry, dir } = load([
      GOOD_SCOUT,
      { name: "deep", frontmatter: "name: deep\ndescription: Asks for a tier that does not exist.\nmodel: tier:deepthink" },
    ]);
    const text = renderRegistry(registry, dir);
    assert.match(text, /2 agent\(s\): 1 ok, 0 restricted, 1 invalid/);
    assert.match(text, /\[ok \] scout/);
    assert.match(text, /\[ERR\] deep/);
    assert.match(text, /unknown tier "deepthink"/);
  });

  it("says where it looked when it found nothing", () => {
    const dir = join(scratch(), "empty");
    const registry = loadAgentRegistry({ dirs: [dir], routing: ROUTING, config: CONFIG, sessionEgress: "public" });
    assert.match(renderRegistry(registry, dir), /no agents found\. Looked in:/);
  });
});

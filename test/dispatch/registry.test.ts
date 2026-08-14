import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchableNames,
  loadAgentRegistry,
  parseFrontmatter,
  renderRegistry,
} from "../../extensions/dispatch/registry.ts";
import { ALL_MODELS, CONFIG, GOOD_SCOUT, ROUTING, scratch, writeAgents, type AgentFile } from "./helpers.ts";

function load(files: readonly AgentFile[]) {
  const dir = writeAgents(join(scratch(), "agents"), files);
  return {
    dir,
    registry: loadAgentRegistry({
      dirs: [dir],
      routing: ROUTING,
      config: CONFIG,
      availableModels: ALL_MODELS,
    }),
  };
}

const problemText = (r: { problems: readonly string[] }) => r.problems.join("\n");

/** `chmod 000` does not stop `root`, and CI containers often run as root. */
function readdirSucceeds(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

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
    // 2026-08-13: `cheap` declares `thinkingLevel: "low"`, and the field now has an effect —
    // `resolveTier` appends `:low` to the model string, the only place PI reads a child's effort
    // from. This is the correct expectation now, not the bare id. Used to assert the bare id.
    assert.equal(scout?.target?.model, "databricks/databricks-claude-haiku-4-5:low");
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
    ]);
    const agent = registry.byName.get("offline");
    assert.equal(agent?.status, "restricted");
    assert.match(agent?.problem ?? "", /runtime condition, not a file error/);
    assert.deepEqual(dispatchableNames(registry), []);
  });

  /**
   * WITHDRAWN 2026-08-13. This pair used to assert that the SAME two agent files were `restricted`
   * in a confidential session and `ok` in a public one — which agents existed depended on the
   * session's egress class, and a provider the config had simply forgotten to classify made an
   * agent unloadable outright. The registry no longer takes a session class at all, so there is
   * exactly one verdict per file, and these two replace them: the class is read and reported,
   * never used to withhold.
   */
  it("ACCEPTANCE: an agent pinned to any classed provider loads ok, whatever the session is", () => {
    const { registry } = load([
      GOOD_SCOUT,
      { name: "big", frontmatter: "name: big\ndescription: Runs on the strong public tier.\nmodel: strong" },
      { name: "tenant", frontmatter: "name: tenant\ndescription: Runs on the confidential tenant tier.\nmodel: confidential" },
    ]);
    assert.deepEqual(registry.problems, []);
    assert.deepEqual(dispatchableNames(registry), ["big", "scout", "tenant"]);
    assert.equal(registry.byName.get("big")?.target?.egress, "public", "the class is still reported");
    assert.equal(registry.byName.get("scout")?.target?.egress, "confidential");
    assert.equal(registry.byName.get("tenant")?.target?.egress, "confidential");
  });

  it("loads an agent on an UNCLASSED provider, leaving its label empty rather than refusing", () => {
    const { registry } = load([
      { name: "seeker", frontmatter: "name: seeker\ndescription: Pinned to a provider routing.json says nothing about.\nmodel: deepseek/deepseek-v4-flash" },
    ]);
    assert.deepEqual(registry.problems, []);
    assert.equal(registry.byName.get("seeker")?.status, "ok");
    assert.equal(registry.byName.get("seeker")?.target?.egress, undefined);
    assert.deepEqual(dispatchableNames(registry), ["seeker"]);
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
      availableModels: ALL_MODELS,
    });
    assert.match(problemText(registry), /shadows/);
    // 2026-08-13: `strong` declares `thinkingLevel: "high"`, so the resolved target carries the
    // `:high` suffix. Used to assert the bare id.
    assert.equal(registry.byName.get("scout")?.target?.model, "github-copilot/claude-opus-5:high");
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
        availableModels: ALL_MODELS,
      });
      const scout = registry.byName.get("scout");
      // 2026-08-13: `cheap` declares `thinkingLevel: "low"`; the resolved target carries `:low`.
      // Used to assert the bare id.
      assert.equal(
        scout?.target?.model,
        "databricks/databricks-claude-haiku-4-5:low",
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
        availableModels: ALL_MODELS,
      });
      assert.deepEqual(registry.problems, []);
      assert.equal(registry.byName.get("scout")?.status, "ok", "one unresolvable entry must not stop discovery");
      assert.equal(registry.dirs.find((d) => d.dir === broken)?.exists, false);
    });
  });

  /**
   * The optional-overlay contract: `agents-private/` and `<cwd>/.pi/agents` are directories the
   * installer links optionally and most machines simply do not have, so being absent is legitimate
   * — but ONLY absent is. An overlay that is there and cannot be read used to come back as zero
   * agents and zero problems, indistinguishable from "you have no private agents", and the next
   * signal the operator got was a refused dispatch by name.
   */
  describe("an optional overlay directory: absent is silent, unreadable is not", () => {
    it("absent -> an empty overlay, no problem, and the other directories still load", () => {
      const root = scratch();
      const real = writeAgents(join(root, "agents"), [GOOD_SCOUT]);
      const registry = loadAgentRegistry({
        dirs: [real, join(root, "agents-private")],
        routing: ROUTING,
        config: CONFIG,
        availableModels: ALL_MODELS,
      });
      assert.deepEqual(registry.problems, []);
      assert.equal(registry.byName.get("scout")?.status, "ok");
      assert.equal(registry.dirs.find((d) => d.dir === join(root, "agents-private"))?.exists, false);
    });

    it("present but unreadable -> named as a problem, and discovery carries on", () => {
      const root = scratch();
      const real = writeAgents(join(root, "agents"), [GOOD_SCOUT]);
      const locked = writeAgents(join(root, "agents-private"), [
        { name: "librarian", frontmatter: "name: librarian\ndescription: A private agent nobody can read." },
      ]);
      chmodSync(locked, 0o000);
      try {
        const registry = loadAgentRegistry({
          dirs: [real, locked],
          routing: ROUTING,
          config: CONFIG,
          availableModels: ALL_MODELS,
        });
        if (readdirSucceeds(locked)) return; // running as root: the mode bits do not bite.
        assert.match(problemText(registry), /agent directory could not be read \(EACCES\)/);
        assert.ok(problemText(registry).includes(locked), "the problem must name the directory");
        assert.equal(registry.byName.get("scout")?.status, "ok", "the readable directory still loads");
      } finally {
        chmodSync(locked, 0o700);
      }
    });

    it("a file where a directory is configured -> named as a problem", () => {
      const root = scratch();
      const real = writeAgents(join(root, "agents"), [GOOD_SCOUT]);
      const notADir = join(root, "agents-private");
      writeFileSync(notADir, "this is a file, not an overlay\n");
      const registry = loadAgentRegistry({
        dirs: [real, notADir],
        routing: ROUTING,
        config: CONFIG,
        availableModels: ALL_MODELS,
      });
      assert.match(problemText(registry), /configured as an agent directory but is not one/);
      assert.equal(registry.byName.get("scout")?.status, "ok");
    });
  });

  it("an absent registry directory is reported, not an error", () => {
    const registry = loadAgentRegistry({
      dirs: [join(scratch(), "definitely-not-here")],
      routing: ROUTING,
      config: CONFIG,
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
    const registry = loadAgentRegistry({ dirs: [dir], routing: ROUTING, config: CONFIG });
    assert.match(renderRegistry(registry, dir), /no agents found\. Looked in:/);
  });
});

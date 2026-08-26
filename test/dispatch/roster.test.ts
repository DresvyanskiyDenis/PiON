import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_CLI_RUNNER,
  agentRosterDirs,
  builtinAgentsDir,
  readAgentRoster,
} from "../../extensions/dispatch/roster.ts";
import { scratch } from "./helpers.ts";

function write(dir: string, relative: string, frontmatter: string): void {
  const full = join(dir, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `---\n${frontmatter}\n---\n\nbody\n`);
}

describe("readAgentRoster", () => {
  it("reads the name and the runner type, and takes the first writer per name", () => {
    const first = join(scratch(), "one");
    const second = join(scratch(), "two");
    write(first, "worker.md", "name: worker\ndescription: internal");
    write(first, "vendor-cli.md", `name: vendor-cli\ndescription: adapter\nrunner:\n  type: ${EXTERNAL_CLI_RUNNER}`);
    write(second, "worker.md", "name: worker\ndescription: a later copy that must not win");

    const roster = readAgentRoster([first, second]);
    assert.deepEqual(roster.map((e) => e.name), ["vendor-cli", "worker"]);
    assert.equal(roster.find((e) => e.name === "vendor-cli")?.runnerType, EXTERNAL_CLI_RUNNER);
    assert.equal(roster.find((e) => e.name === "worker")?.runnerType, undefined);
    assert.ok(roster.find((e) => e.name === "worker")?.file.endsWith(join("one", "worker.md")));
  });

  it("skips .agents/skills, .chain.md and files without a usable name", () => {
    const root = join(scratch(), ".agents");
    write(root, "keeper.md", "name: keeper\ndescription: an agent");
    write(root, "skills/drawio/SKILL.md", "name: drawio\ndescription: a skill, not an agent");
    write(root, "pipeline.chain.md", "name: pipeline\ndescription: a chain, not an agent");
    write(root, "nameless.md", "description: no name key at all");

    assert.deepEqual(readAgentRoster([root]).map((e) => e.name), ["keeper"]);
  });

  /**
   * Upstream keys the skill exclusion on the literal directory name `skills`, so a renamed
   * `skills-archived/` beside it surfaces its `SKILL.md` files as agents. PI resolves those names,
   * so the ceiling has to allow them — mirroring the behaviour is the point, not correcting it.
   */
  it("mirrors upstream and does NOT skip a renamed skills directory", () => {
    const root = join(scratch(), ".agents");
    write(root, "skills-archived/databricks/SKILL.md", "name: databricks\ndescription: an archived skill");
    assert.deepEqual(readAgentRoster([root]).map((e) => e.name), ["databricks"]);
  });

  it("skips absent, unreadable and non-directory entries instead of throwing", () => {
    const base = scratch();
    writeFileSync(join(base, "not-a-dir"), "x");
    assert.deepEqual(readAgentRoster([join(base, "missing"), join(base, "not-a-dir")]), []);
  });
});

describe("agentRosterDirs", () => {
  it("lists the directories pi-subagents discovers from, in its order, without duplicates", () => {
    const dirs = agentRosterDirs({
      cwd: "/work/project",
      homeDir: "/home/u",
      agentDir: "/home/u/.pi/agent",
      env: { PI_SUBAGENT_EXTRA_AGENT_DIRS: "/extra/a" },
    });
    assert.deepEqual(dirs.slice(-5), [
      "/extra/a",
      "/home/u/.pi/agent/agents",
      "/home/u/.agents",
      "/work/project/.pi/agents",
      "/work/project/.agents",
    ]);
    assert.equal(new Set(dirs).size, dirs.length);
  });
});

describe("builtinAgentsDir", () => {
  /**
   * `discoverAgentsAll()` is not in the package's `exports` map, so the roster is read from disk
   * instead. If the package's builtin agent directory ever stops resolving, the union silently
   * narrows back to our own registry — so the resolution itself is pinned.
   */
  it("resolves the pi-subagents builtin agent directory and its external-cli adapters", () => {
    const dir = builtinAgentsDir();
    assert.ok(dir, "the builtin agents directory must resolve through the exports map");
    const roster = readAgentRoster([dir]);
    const names = roster.map((e) => e.name);
    for (const internal of ["worker", "reviewer", "oracle", "scout", "delegate", "researcher"]) {
      assert.ok(names.includes(internal), `${internal} must be in the builtin roster`);
      assert.equal(roster.find((e) => e.name === internal)?.runnerType, undefined);
    }
    assert.ok(
      roster.some((e) => e.runnerType === EXTERNAL_CLI_RUNNER),
      "the package ships external-cli adapters; if none is seen, planCeiling's exclusion is untested",
    );
  });
});

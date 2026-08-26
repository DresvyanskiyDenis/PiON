import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import {
  __resetForTests,
  __setPendingPostExtendRefreshForTests,
  applyEnv,
  computeSkillsRoot,
  envVarName,
  register,
  skillDirFromPath,
} from "../extensions/skills-env.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";

/**
 * Captures both handlers the module registers and fakes `getCommands()`. `getCommands` is a
 * mutable function reference (not a snapshot) so a test can swap in a longer roster between
 * `fireResourcesDiscover()` and `fireAgentStart()` to simulate `extendResources` landing an
 * extension-contributed skill in between — exactly the ordering `agent-session.js:1764-1777`
 * guarantees.
 */
function fakePi(initialCommands: SlashCommandInfo[]): {
  pi: ExtensionAPI;
  setCommands: (commands: SlashCommandInfo[]) => void;
  fireResourcesDiscover: () => unknown;
  fireAgentStart: () => unknown;
} {
  let commands = initialCommands;
  let resourcesDiscoverHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  let agentStartHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const pi = {
    on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "resources_discover") resourcesDiscoverHandler = h;
      else if (event === "agent_start") agentStartHandler = h;
    },
    getCommands: () => commands,
  } as unknown as ExtensionAPI;
  return {
    pi,
    setCommands: (next) => {
      commands = next;
    },
    fireResourcesDiscover: () => {
      if (!resourcesDiscoverHandler) throw new Error("resources_discover handler was never registered");
      return resourcesDiscoverHandler({ type: "resources_discover", cwd: "/repo", reason: "startup" }, { hasUI: false });
    },
    fireAgentStart: () => {
      if (!agentStartHandler) throw new Error("agent_start handler was never registered");
      return agentStartHandler({ type: "agent_start" }, { hasUI: false });
    },
  };
}

/**
 * A `source: "skill"` entry as `_bindExtensionCore`'s `getCommands()` really emits it: `path` is
 * always the skill's own `SKILL.md`, while `baseDir` is whatever `ResourceMetadata` the resolver
 * attached — absent, or a resolution root far above the skill. Both are modelled explicitly so a
 * test can no longer accidentally assert the two are the same directory.
 */
function skillCommand(name: string, skillDir: string | undefined, metadataBaseDir?: string): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    description: `${name} description`,
    source: "skill",
    sourceInfo: {
      path: skillDir === undefined ? undefined : `${skillDir}/SKILL.md`,
      source: "user",
      scope: "user",
      origin: "top-level",
      ...(metadataBaseDir !== undefined ? { baseDir: metadataBaseDir } : {}),
    },
  } as unknown as SlashCommandInfo;
}

function extensionCommand(name: string): SlashCommandInfo {
  return {
    name,
    description: "not a skill",
    source: "extension",
    sourceInfo: { path: "/x", source: "extension", scope: "user", origin: "top-level" },
  } as unknown as SlashCommandInfo;
}

/** Swallows and returns everything written to stderr while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T> | T): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    process.stderr.write = original;
  }
}

describe("skills-env: envVarName", () => {
  it("upper-cases and turns hyphens into underscores", () => {
    assert.equal(envVarName("release-notes"), "PI_SKILL_DIR_RELEASE_NOTES");
    assert.equal(envVarName("sofa"), "PI_SKILL_DIR_SOFA");
    assert.equal(envVarName("agent-swarm-workflow"), "PI_SKILL_DIR_AGENT_SWARM_WORKFLOW");
  });
});

describe("skills-env: skillDirFromPath", () => {
  it("returns the directory holding SKILL.md", () => {
    assert.equal(skillDirFromPath("/repo/skills/sofa/SKILL.md"), "/repo/skills/sofa");
  });

  it("handles a loose <root>/<name>.md skill, whose directory is the discovery root itself", () => {
    assert.equal(skillDirFromPath("/repo/skills/quick.md"), "/repo/skills");
  });

  it("refuses absent, empty and synthetic paths rather than guessing", () => {
    assert.equal(skillDirFromPath(undefined), undefined);
    assert.equal(skillDirFromPath(""), undefined);
    assert.equal(skillDirFromPath("<sdk:probe>"), undefined);
    assert.equal(skillDirFromPath("SKILL.md"), undefined);
  });
});

describe("skills-env: computeSkillsRoot", () => {
  it("returns undefined for an empty list", () => {
    assert.equal(computeSkillsRoot([]), undefined);
  });

  it("picks the parent shared by the most baseDirs", () => {
    const root = computeSkillsRoot([
      "/repo/skills/sofa",
      "/repo/skills/council",
      "/repo/skills/pr-describe",
      "/other/.agents/skills/changelog",
      "/other/.agents/skills/csv-import",
    ]);
    assert.equal(root, "/repo/skills");
  });

  it("does not let a large nested bundle outvote the top-level root", () => {
    // Mirrors the real shape: 3 top-level skills vs 2 databricks-* bundle members that,
    // per the layout decision, should never even be in this list — but if one leaked in,
    // a 2-vs-3 count must still not flip the root.
    const root = computeSkillsRoot([
      "/repo/skills/a",
      "/repo/skills/b",
      "/repo/skills/c",
      "/repo/skill-bundles/databricks/x",
      "/repo/skill-bundles/databricks/y",
    ]);
    assert.equal(root, "/repo/skills");
  });

  it("breaks ties alphabetically", () => {
    const root = computeSkillsRoot(["/repo/b/one", "/repo/a/one"]);
    assert.equal(root, "/repo/a");
  });
});

describe("skills-env: applyEnv", () => {
  afterEach(() => __resetForTests());

  it("sets one PI_SKILL_DIR_<NAME> per skill plus PI_SKILLS_ROOT", () => {
    applyEnv([
      { name: "sofa", baseDir: "/repo/skills/sofa" },
      { name: "council", baseDir: "/repo/skills/council" },
    ]);
    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
    assert.equal(process.env.PI_SKILL_DIR_COUNCIL, "/repo/skills/council");
    assert.equal(process.env.PI_SKILLS_ROOT, "/repo/skills");
  });

  it("clears vars from a previous call that are no longer present (reload shrinks the set)", () => {
    applyEnv([{ name: "sofa", baseDir: "/repo/skills/sofa" }, { name: "council", baseDir: "/repo/skills/council" }]);
    assert.equal(process.env.PI_SKILL_DIR_COUNCIL, "/repo/skills/council");

    applyEnv([{ name: "sofa", baseDir: "/repo/skills/sofa" }]);
    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
    assert.equal(process.env.PI_SKILL_DIR_COUNCIL, undefined);
  });

  it("clears PI_SKILLS_ROOT when there are no skills at all", () => {
    applyEnv([{ name: "sofa", baseDir: "/repo/skills/sofa" }]);
    assert.equal(process.env.PI_SKILLS_ROOT, "/repo/skills");
    applyEnv([]);
    assert.equal(process.env.PI_SKILLS_ROOT, undefined);
    assert.equal(process.env.PI_SKILL_DIR_SOFA, undefined);
  });
});

describe("skills-env: register + resources_discover end-to-end", () => {
  /** Real fixture directories, one `mkdtemp` root per test, torn down in `afterEach`. */
  let tmpRoot: string | undefined;
  function makeTmpRoot(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "skills-env-test-"));
    return tmpRoot;
  }

  before(() => resetSurfaced());
  afterEach(() => {
    __resetForTests();
    resetSurfaced();
    if (tmpRoot !== undefined) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it("filters out non-skill commands and exports env for the rest", async () => {
    const { pi, fireResourcesDiscover: fire } = fakePi([
      extensionCommand("ctx-dump"),
      skillCommand("sofa", "/repo/skills/sofa"),
      skillCommand("release-notes", "/repo/skills/release-notes"),
    ]);
    register(pi);
    await fire();

    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
    assert.equal(process.env.PI_SKILL_DIR_RELEASE_NOTES, "/repo/skills/release-notes");
    assert.equal(process.env.PI_SKILLS_ROOT, "/repo/skills");
    // The extension command must never produce a PI_SKILL_DIR_* var.
    assert.equal(process.env["PI_SKILL_DIR_CTX-DUMP".toUpperCase()], undefined);
  });

  // REGRESSION (2026-08-07). The 9 skills reached through `config/settings.json`'s
  // `skills: ["~/.pi/agent/skills"]` arrive with `sourceInfo.baseDir === undefined`, because
  // `PackageManager.resolve` attaches `{source:"local",scope,origin}` with no `baseDir` and
  // `DefaultResourceLoader.updateSkillsFromPaths` lets that metadata overwrite the skill's own
  // sourceInfo. The module used to skip every one of them and print a "contradicts V-05" line
  // per skill; `sourceInfo.path` was correct the whole time.
  it("sets PI_SKILL_DIR_<NAME> from sourceInfo.path when sourceInfo.baseDir is absent, silently", async () => {
    const root = makeTmpRoot();
    const skillsDir = join(root, ".pi", "agent", "skills");
    const sofaDir = join(skillsDir, "sofa");
    const councilDir = join(skillsDir, "council");
    mkdirSync(sofaDir, { recursive: true });
    mkdirSync(councilDir, { recursive: true });

    const { pi, fireResourcesDiscover: fire } = fakePi([skillCommand("sofa", sofaDir), skillCommand("council", councilDir)]);
    register(pi);

    const { lines } = await captureStderr(() => fire());

    assert.equal(process.env.PI_SKILL_DIR_SOFA, realpathSync(sofaDir));
    assert.equal(process.env.PI_SKILL_DIR_COUNCIL, realpathSync(councilDir));
    assert.equal(process.env.PI_SKILLS_ROOT, realpathSync(skillsDir));
    assert.deepEqual(lines, []);
  });

  // REGRESSION (2026-08-07), the silent half of the same bug: `~/.agents/skills/tickets` reports
  // `baseDir: "~/.agents"` and a package skill reports the package install root. Trusting either
  // exported a directory two or three levels above the skill, and dragged PI_SKILLS_ROOT up with
  // it — `$PI_SKILLS_ROOT/release-notes/scripts/render.py` would have resolved under $HOME.
  it("ignores a sourceInfo.baseDir that names a resolution root instead of the skill directory", async () => {
    const root = makeTmpRoot();
    const agentsSkillsDir = join(root, ".agents", "skills");
    const ticketsDir = join(agentsSkillsDir, "tickets");
    const wikiDir = join(agentsSkillsDir, "wiki");
    const pkgRoot = join(root, "pi-config", "node_modules", "pi-subagents");
    const pkgSkillDir = join(pkgRoot, "skills", "pi-subagents");
    mkdirSync(ticketsDir, { recursive: true });
    mkdirSync(wikiDir, { recursive: true });
    mkdirSync(pkgSkillDir, { recursive: true });

    const { pi, fireResourcesDiscover: fire } = fakePi([
      skillCommand("tickets", ticketsDir, agentsSkillsDir),
      skillCommand("wiki", wikiDir, agentsSkillsDir),
      skillCommand("pi-subagents", pkgSkillDir, pkgRoot),
    ]);
    register(pi);

    const { lines } = await captureStderr(() => fire());

    assert.equal(process.env.PI_SKILL_DIR_TICKETS, realpathSync(ticketsDir));
    assert.equal(process.env.PI_SKILL_DIR_WIKI, realpathSync(wikiDir));
    assert.equal(process.env.PI_SKILL_DIR_PI_SUBAGENTS, realpathSync(pkgSkillDir));
    assert.equal(process.env.PI_SKILLS_ROOT, realpathSync(agentsSkillsDir));
    assert.deepEqual(lines, []);
  });

  it("skips a skill with no usable sourceInfo.path, reports it once, and still sets the rest", async () => {
    const { pi, fireResourcesDiscover: fire } = fakePi([
      skillCommand("sofa", "/repo/skills/sofa"),
      skillCommand("broken", undefined),
    ]);
    register(pi);

    const { lines } = await captureStderr(() => fire());

    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
    assert.equal(process.env.PI_SKILL_DIR_BROKEN, undefined);
    assert.ok(lines.some((l) => l.includes('skill "broken"') && l.includes("no usable sourceInfo.path")));

    // Reported once: firing again with the same broken skill must not print a second line.
    const { lines: secondLines } = await captureStderr(() => fire());
    assert.ok(!secondLines.some((l) => l.includes('skill "broken"')));
  });

  // REGRESSION (2026-08-12). `~/.pi/agent/skills` is itself a symlink to `~/pi-config/skills`,
  // and PI reports `sourceInfo.path` through the declared (symlinked) location. Left
  // unresolved, the exported dir contains `.pi/agent/`, which `secret-paths.ts`'s `SEC-PI-STATE`
  // gate matched and — until it became audit-only on 2026-08-15 — refused unconditionally, and a
  // skill's own `..` escape collapses lexically through the symlink name instead of the real one.
  // Resolving to the realpath here fixes both; it now also keeps ordinary skill reads out of the
  // audit log.
  it("resolves a symlinked skill directory to its physical path", async () => {
    const root = makeTmpRoot();
    const realSkillsDir = join(root, "real-repo", "skills");
    const linkedAgentDir = join(root, ".pi", "agent");
    mkdirSync(join(realSkillsDir, "foo"), { recursive: true });
    mkdirSync(linkedAgentDir, { recursive: true });
    // Mirrors the live layout: `~/.pi/agent/skills` -> `~/pi-config/skills`.
    symlinkSync(realSkillsDir, join(linkedAgentDir, "skills"));

    const symlinkedFooDir = join(linkedAgentDir, "skills", "foo");
    const { pi, fireResourcesDiscover: fire } = fakePi([skillCommand("foo", symlinkedFooDir)]);
    register(pi);

    const { lines } = await captureStderr(() => fire());

    const physicalFooDir = realpathSync(join(realSkillsDir, "foo"));
    assert.equal(process.env.PI_SKILL_DIR_FOO, physicalFooDir);
    assert.equal(process.env.PI_SKILLS_ROOT, realpathSync(realSkillsDir));
    // The exported path must not retain the symlinked segment.
    assert.ok(!process.env.PI_SKILL_DIR_FOO?.includes(join(".pi", "agent")));
    assert.deepEqual(lines, []);
  });

  // The other half of the same fix: realpath must fail open, not crash discovery, when a
  // baseDir no longer exists on disk (moved skill, dangling symlink, stale metadata).
  it("falls back to the unresolved path and reports once when realpath throws", async () => {
    const root = makeTmpRoot();
    const ghostDir = join(root, "ghost", "skill");
    // Deliberately never created — `mkdirSync` is skipped so realpathSync(ghostDir) throws ENOENT.

    const { pi, fireResourcesDiscover: fire } = fakePi([skillCommand("ghost", ghostDir)]);
    register(pi);

    const { lines } = await captureStderr(() => fire());

    assert.equal(process.env.PI_SKILL_DIR_GHOST, ghostDir);
    assert.equal(process.env.PI_SKILLS_ROOT, join(root, "ghost"));
    assert.ok(
      lines.some(
        (l) => l.includes("realpath failed") && l.includes('skill "ghost"') && l.includes(JSON.stringify(ghostDir)),
      ),
    );

    // Reported once per distinct dir: firing again must not print a second line.
    const { lines: secondLines } = await captureStderr(() => fire());
    assert.ok(!secondLines.some((l) => l.includes("realpath failed")));
  });

  it("fails open when pi.getCommands() itself throws — no crash, error surfaced once", async () => {
    const { pi, fireResourcesDiscover } = fakePi([]);
    (pi as unknown as { getCommands: () => never }).getCommands = () => {
      throw new Error("boom");
    };
    register(pi);

    const { lines } = await captureStderr(() => fireResourcesDiscover());
    assert.ok(lines.some((l) => l.includes("skills-env: skill discovery failed") && l.includes("boom")));
    assert.equal(process.env.PI_SKILLS_ROOT, undefined);
  });
});

describe("skills-env: extension-contributed skills reach the roster after resources_discover", () => {
  before(() => resetSurfaced());
  afterEach(() => {
    __resetForTests();
    resetSurfaced();
  });

  // REGRESSION. `AgentSession.extendResourcesFromExtensions` (`agent-session.js:1764-1777`)
  // collects every `resources_discover` handler's return value and only calls `extendResources`
  // AFTER all of them have returned — so a skill contributed by one `resources_discover` handler
  // by any extension is invisible to `pi.getCommands()` inside another
  // `resources_discover` handler firing in the same pass (this module). Modelled here by a
  // `getCommands()` that returns a short roster during `resources_discover` and a longer one — the
  // same list, plus the extension-contributed skill — once `extendResources` would have landed it,
  // by the time `agent_start` fires.
  it("picks up a skill that only appears after resources_discover, on the next agent_start", async () => {
    const early = [skillCommand("sofa", "/repo/skills/sofa")];
    const late = [...early, skillCommand("release-notes", "/other/.agents/skills/release-notes")];
    const { pi, setCommands, fireResourcesDiscover, fireAgentStart } = fakePi(early);
    register(pi);

    await fireResourcesDiscover();
    // Old behaviour: this is where the module stopped. The extension-contributed skill's var is
    // not set, and — because from this module's point of view the skill did not exist yet — no
    // warning fires either. That silence is exactly what made the defect invisible for weeks.
    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
    assert.equal(process.env.PI_SKILL_DIR_RELEASE_NOTES, undefined);

    // `extendResources` has now landed the extension-contributed skill (agent-session.js:1777),
    // and the mode is about to start the first turn.
    setCommands(late);
    await fireAgentStart();

    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
    assert.equal(process.env.PI_SKILL_DIR_RELEASE_NOTES, "/other/.agents/skills/release-notes");
  });

  it("does not redo the discovery pass on a second agent_start with no prior resources_discover", async () => {
    const { pi, setCommands, fireResourcesDiscover, fireAgentStart } = fakePi([
      skillCommand("sofa", "/repo/skills/sofa"),
    ]);
    register(pi);

    await fireResourcesDiscover();
    await fireAgentStart(); // consumes the pending catch-up
    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");

    // A skill disappearing here must NOT be picked up — the catch-up gate only opens again on
    // the next `resources_discover` (a fresh startup or reload), not on every turn.
    setCommands([]);
    await fireAgentStart();
    assert.equal(process.env.PI_SKILL_DIR_SOFA, "/repo/skills/sofa");
  });

  it("agent_start is a no-op when it fires with no prior resources_discover in the session", async () => {
    const { pi, fireAgentStart } = fakePi([skillCommand("sofa", "/repo/skills/sofa")]);
    register(pi);

    __setPendingPostExtendRefreshForTests(false);
    await fireAgentStart();
    assert.equal(process.env.PI_SKILL_DIR_SOFA, undefined);
  });
});

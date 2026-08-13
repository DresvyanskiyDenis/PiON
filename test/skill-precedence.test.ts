/**
 * Which copy of a duplicated skill name actually loads.
 *
 * This repository ships **zero skills** — only the loading mechanisms. So every fixture below is
 * synthetic: the test builds its own throwaway `$HOME` and writes its own `SKILL.md` files. What is
 * pinned is the *resolver*, against the real `@earendil-works/pi-coding-agent` 0.84.0 rather than a
 * re-implementation of it:
 *
 * 1. **The precedence rule** — `DefaultPackageManager.resolve()` sorts every discovered resource by
 *    `resourcePrecedenceRank` (`dist/core/package-manager.js:61`): project-local 0, project-auto 1,
 *    user-local 2, user-auto 3, package 4. `loadSkills` then takes the FIRST entry per skill name and
 *    reports every later one as a `collision` diagnostic (`dist/core/skills.js:309-326`). A root named
 *    in `config/settings.json`'s `skills` array is user-**local** (rank 2); `~/.agents/skills` is
 *    user-**auto** (rank 3). So a settings-declared root wins, and that is the only lever this repo has.
 *
 * 2. **`resources_discover` cannot win** — `extendResources` appends the extension's paths to the end
 *    of the already-resolved list (`dist/core/resource-loader.js:243`, a `mergePaths` union), so a root
 *    contributed by `extensions/skill-mask.ts` is scanned last and loses every name collision to
 *    whatever `~/.agents/skills` happens to hold. It cannot subtract either (see `skill-mask.ts`).
 *
 * The consequence, and the reason the last test exists: **a skill root a user is told to put content
 * in must be named in `config/settings.json`.** A root reachable only through `skill-mask`'s
 * `resources_discover` handler is shadowed, silently, by any same-named skill in `~/.agents/skills` —
 * measured on a live install, not theorised.
 */
import { readShippedConfig } from "./lib/repo-config.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** A temp `$HOME` shaped like a real install: `~/.pi/agent`, `~/.agents/skills`, `~/pi-config`. */
let home: string;
let cwd: string;
const originalHome = process.env.HOME;

function writeSkill(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: fixture skill ${name}\n---\n\nbody\n`);
  return file;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "pi-skill-precedence-home-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-skill-precedence-cwd-"));
  process.env.HOME = home;
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

interface Resolution {
  winners: Map<string, string>;
  collisions: Array<{ name: string; winnerPath: string; loserPath: string }>;
}

/**
 * Runs PI's own loader end to end: settings-driven resolution, then the `resources_discover`
 * contribution exactly as `AgentSession.buildExtensionResourcePaths` shapes it
 * (`dist/core/agent-session.js:1781` — source `extension:<name>`, scope `temporary`).
 */
async function resolve(settingsSkills: string[], extensionRoots: string[]): Promise<Resolution> {
  const agentDir = join(home, ".pi", "agent");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({ skills: settingsSkills }, { projectTrusted: true }),
    noExtensions: true,
    noContextFiles: true,
  });
  await loader.reload();
  if (extensionRoots.length > 0) {
    loader.extendResources({
      skillPaths: extensionRoots.map((path) => ({
        path,
        metadata: {
          source: "extension:skill-mask",
          scope: "temporary" as const,
          origin: "top-level" as const,
          baseDir: join(home, "pi-config", "extensions"),
        },
      })),
    });
  }
  const { skills, diagnostics } = loader.getSkills();
  return {
    winners: new Map(skills.map((skill) => [skill.name, skill.filePath])),
    collisions: diagnostics
      .filter((d) => d.type === "collision" && d.collision !== undefined)
      .map((d) => ({
        name: d.collision!.name,
        winnerPath: d.collision!.winnerPath,
        loserPath: d.collision!.loserPath,
      })),
  };
}

describe("PI 0.84.0 skill precedence", () => {
  before(() => {
    // `~/.pi/agent/skills` is what `config/settings.json` names; `install.sh` creates it.
    writeSkill(join(home, ".pi", "agent", "skills", "changelog"), "changelog");
    // The unversioned, standard-location tree that shadows an undeclared root.
    writeSkill(join(home, ".agents", "skills", "changelog"), "changelog");
    writeSkill(join(home, ".agents", "skills", "release-notes"), "release-notes");
    // A user's own extra root, contributed by extensions/skill-mask.ts.
    writeSkill(join(home, "pi-config", "skills-private", "release-notes"), "release-notes");
  });

  it("ranks a settings-declared root above ~/.agents/skills", async () => {
    const { winners, collisions } = await resolve(["~/.pi/agent/skills"], []);
    assert.equal(winners.get("changelog"), join(home, ".pi", "agent", "skills", "changelog", "SKILL.md"));
    assert.deepEqual(
      collisions.filter((c) => c.name === "changelog").map((c) => c.loserPath),
      [join(home, ".agents", "skills", "changelog", "SKILL.md")],
    );
  });

  it("ranks ~/.agents/skills above a root contributed by resources_discover — the shadowing bug", async () => {
    const { winners, collisions } = await resolve(["~/.pi/agent/skills"], [join(home, "pi-config", "skills-private")]);
    // The extension's root is merged last, so it loses even though the user maintains that copy.
    assert.equal(winners.get("release-notes"), join(home, ".agents", "skills", "release-notes", "SKILL.md"));
    assert.deepEqual(
      collisions.filter((c) => c.name === "release-notes").map((c) => c.loserPath),
      [join(home, "pi-config", "skills-private", "release-notes", "SKILL.md")],
    );
  });

  it("puts the user's copy back in front once its root is declared in settings", async () => {
    const { winners, collisions } = await resolve(
      ["~/.pi/agent/skills", "~/pi-config/skills-private"],
      [join(home, "pi-config", "skills-private")],
    );
    assert.equal(winners.get("release-notes"), join(home, "pi-config", "skills-private", "release-notes", "SKILL.md"));
    assert.deepEqual(
      collisions.filter((c) => c.name === "release-notes").map((c) => c.loserPath),
      [join(home, ".agents", "skills", "release-notes", "SKILL.md")],
    );
    // Declaring the root does not double-load it: the extension contributes the same directory, and
    // loadSkills dedupes by canonical path before the name check (dist/core/skills.js:304-308).
    assert.equal(collisions.filter((c) => c.name === "release-notes").length, 1);
  });
});

describe("the shipped settings template declares the skill root users are told to write into", () => {
  // Not hermetic on purpose: this is the assertion that would have caught the live bug. A root that
  // only extensions/skill-mask.ts contributes is a root that loses every name collision, so the
  // documented drop-your-skills-here directory has to appear in `settings.skills` as well.
  // `config/settings.json` is generated by scripts/install.sh and git-ignored — absent on a clean
  // checkout — so the subject is the tracked template it is generated from.
  const settings = readShippedConfig<{ skills?: string[] }>("settings");
  const declared = new Set(
    (settings.skills ?? []).map((entry) => {
      const expanded = entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
      return expanded.endsWith(sep) ? expanded.slice(0, -1) : expanded;
    }),
  );

  it("names skills-private/", () => {
    assert.ok(
      declared.has(join(homedir(), "pi-config", "skills-private")),
      `the settings template's "skills" array must contain "~/pi-config/skills-private". ` +
        `Without it the root is only contributed by extensions/skill-mask.ts, which PI merges last, ` +
        `so every skill in it loses a name collision to ~/.agents/skills. Declared today: ` +
        `${JSON.stringify(settings.skills ?? [])}`,
    );
  });

  it("names the install-managed root ~/.pi/agent/skills", () => {
    assert.ok(
      declared.has(join(homedir(), ".pi", "agent", "skills")),
      `the settings template's "skills" array must contain "~/.pi/agent/skills" — the root ` +
        `docs/extending/skills.md tells users to drop a SKILL.md into. Declared today: ` +
        `${JSON.stringify(settings.skills ?? [])}`,
    );
  });
});

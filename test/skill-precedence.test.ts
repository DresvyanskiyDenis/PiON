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
    // A root that an extension contributes at runtime and settings.json does not declare. No such
    // root ships any more — this fixture is what proves why. See the second test below.
    writeSkill(join(home, "pi-config", "contributed-only", "release-notes"), "release-notes");
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
    const { winners, collisions } = await resolve(["~/.pi/agent/skills"], [join(home, "pi-config", "contributed-only")]);
    // The extension's root is merged last, so it loses even though the user maintains that copy.
    // This is the measurement that retired the multi-bucket layout: two of its three roots existed
    // only as a runtime contribution, so every skill in them silently lost to ~/.agents/skills.
    assert.equal(winners.get("release-notes"), join(home, ".agents", "skills", "release-notes", "SKILL.md"));
    assert.deepEqual(
      collisions.filter((c) => c.name === "release-notes").map((c) => c.loserPath),
      [join(home, "pi-config", "contributed-only", "release-notes", "SKILL.md")],
    );
  });

  it("puts the user's copy back in front once its root is declared in settings", async () => {
    const { winners, collisions } = await resolve(
      ["~/.pi/agent/skills", "~/pi-config/contributed-only"],
      [join(home, "pi-config", "contributed-only")],
    );
    assert.equal(winners.get("release-notes"), join(home, "pi-config", "contributed-only", "release-notes", "SKILL.md"));
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
  // is only contributed at runtime loses every name collision, so the documented
  // drop-your-skills-here directory has to appear in `settings.skills`. Since the bucket collapse
  // there is exactly one such root and it is the install-managed one, so this reduces to "the
  // template names it, and names nothing else". `config/settings.json` is generated by
  // scripts/install.sh and git-ignored — absent on a clean checkout — so the subject is the tracked
  // template it is generated from.
  const settings = readShippedConfig<{ skills?: string[] }>("settings");
  const declared = new Set(
    (settings.skills ?? []).map((entry) => {
      const expanded = entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
      return expanded.endsWith(sep) ? expanded.slice(0, -1) : expanded;
    }),
  );

  it("names exactly one root, so nothing is left to be contributed at runtime", () => {
    assert.equal(
      declared.size,
      1,
      `the settings template's "skills" array must name exactly one root. A second root is either ` +
        `redundant with this one or is the multi-bucket layout coming back — and a bucket PI can ` +
        `only see through a runtime contribution loses every name collision to ~/.agents/skills, ` +
        `which is what retired that layout. Declared today: ${JSON.stringify(settings.skills ?? [])}`,
    );
  });

  it("names the install-managed root ~/pi-config/skills", () => {
    assert.ok(
      declared.has(join(homedir(), "pi-config", "skills")),
      `the settings template's "skills" array must contain "~/pi-config/skills" — the root ` +
        `docs/extending/skills.md tells users to drop a SKILL.md into. Declared today: ` +
        `${JSON.stringify(settings.skills ?? [])}`,
    );
  });

  it("declares no root inside the ~/.pi/agent state tree", () => {
    // The same directory is reachable as `~/.pi/agent/skills`, which the installer symlinks. Naming
    // it that way is what makes `sourceInfo.path` — and therefore every path the model sees for a
    // skill — sit under the agent's state directory, so a skill reaching a sibling tree with `..`
    // normalizes into it. `SEC-PI-STATE` records a finding for the result and the file is not there
    // anyway. Naming the physical root costs nothing and the arithmetic lands in the checkout.
    assert.deepEqual(
      (settings.skills ?? []).filter((root: string) => root.includes(".pi/agent")),
      [],
    );
  });
});

/**
 * A registered no-op. It contributes no skill roots, and it masks nothing — it never could.
 *
 * **Why it cannot mask (measured, not assumed).** In the pinned 0.84.0 package,
 * `AgentSession.extendResourcesFromExtensions()` (`dist/core/agent-session.js:1764`) calls
 * `DefaultResourceLoader.extendResources()`, which does
 * `this.lastSkillPaths = this.mergePaths(this.lastSkillPaths, ...)` (`dist/core/resource-loader.js:229`)
 * — a **union** with whatever the settings-driven scan already found. No path in that chain removes
 * a root, so a `resources_discover` handler can only ever ADD skills, never subtract them.
 *
 * **Why it contributed roots, and why it stopped.** This module used to add two further roots,
 * `skills-private/` and `skills-work/`, because neither was named in `config/settings.json`'s
 * `skills` array and PI's built-in scan therefore never found them. That was the whole reason the
 * three-bucket layout worked at all — and it is also why the layout was wrong. The split read as a
 * privacy boundary; it was not one. Exactly one of the three was git-ignored, and the other two
 * were visible only through this runtime side channel, which is strictly *worse* than a declared
 * root: `extendResources` appends, `loadSkills` keeps the FIRST loader of each skill name
 * (`dist/core/skills.js:309-326`), and everything settings-driven is resolved first and
 * rank-ordered ahead of it (`resourcePrecedenceRank`, `dist/core/package-manager.js:61`). A root
 * contributed only from here therefore loses every name collision — measured, not theorised: two
 * such skills were silently shadowed by stale same-named copies under `~/.agents/skills` and never
 * ran.
 *
 * The layout is now one root, `skills/`, named once in `config/settings.json` as
 * `~/.pi/agent/skills` (which `scripts/install.sh` symlinks to `<repo>/skills`). Declared beats
 * contributed, so there is nothing left for this handler to do.
 *
 * **Why the module survives at all.** Its `id` is load-bearing elsewhere — `extensions/index.ts`'s
 * registration table, `extensions/lib/manifest.ts`, `extensions/trust.ts`'s deadman list and
 * `/doctor`'s load registry all name it. Deleting the file would mean editing four unrelated
 * consumers to prove a directory listing changed. It stays registered and does nothing, which is
 * exactly what the current layout requires of it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const id = "skill-mask";

export function register(_pi: ExtensionAPI): void {
  // Deliberately empty: see the module docstring. Registering no handler is not the same as not
  // registering the module — the id must stay present in the load registry.
}

/**
 * Adds the two extra skill roots — `skills-private/` and `skills-work/` — to every session, via
 * `resources_discover`. That is the whole module. Despite the filename it masks nothing.
 *
 * **Why it cannot mask (V-04, measured, not assumed).** In the pinned 0.84.0 package,
 * `AgentSession.extendResourcesFromExtensions()` (`dist/core/agent-session.js:1764`) calls
 * `DefaultResourceLoader.extendResources()`, which does
 * `this.lastSkillPaths = this.mergePaths(this.lastSkillPaths, ...)` (`dist/core/resource-loader.js:229`)
 * — a **union** with whatever the settings-driven scan already found. No path in that chain removes
 * a root. So a `resources_discover` handler can only ever ADD skills, never subtract them; the
 * module id stays `skill-mask` only because `config/settings.json` and the install symlinks name it.
 *
 * **Why it is load-bearing.** `config/settings.json`'s `skills` array lists exactly one root,
 * `~/.pi/agent/skills`, which `scripts/install.sh` symlinks to `<repo>/skills`. Neither
 * `skills-private/` nor `skills-work/` is named there or anywhere else, so PI's built-in scan never
 * finds them — they load *only* because this module contributes them here.
 *
 * **What contributing them here does NOT buy, and why the roots must also be declared in
 * `config/settings.json` (measured 2026-08-12, `test/skill-precedence.test.ts`).** Additive means
 * *appended*: `extendResources` merges these paths onto the END of the already-resolved list, and
 * `loadSkills` keeps the FIRST loader of each skill name and reports every later one as a collision
 * (`dist/core/skills.js:309-326`). Everything settings-driven is resolved first and is itself
 * rank-ordered by `resourcePrecedenceRank` (`dist/core/package-manager.js:61`): a root named in
 * `settings.json` is user-*local* (rank 2), the standard `~/.agents/skills` tree is user-*auto*
 * (rank 3). So a root contributed only from here sits behind BOTH and loses every name collision —
 * measured, not theorised: two skills contributed only from here were silently shadowed by stale
 * same-named copies in `~/.agents/skills`, and never ran. The fix is not in this module and cannot be: name the
 * roots in `config/settings.json`. This handler then becomes
 * a harmless duplicate — `loadSkills` dedupes by canonical path before the name check
 * (`dist/core/skills.js:304-308`) — and stays as the fallback for an install whose settings file is
 * not this repo's.
 *
 * `skills-private/` is git-ignored, so a clone without it simply has no such directory; the
 * `existsSync` guard on each root makes a missing directory a silent no-op rather than an error.
 *
 * **The cwd-gated work profile was removed 2026-08-12 at the owner's instruction** — one profile,
 * everything always on, because this machine is used for work anyway. `skills-work/` is now
 * contributed exactly like `skills-private/`. Nothing reads `PI_SKILLS_WORK_PATHS` any more, so a
 * leftover `export` of it in a shell profile is inert.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeError, surfaceOnce } from "./lib/once.ts";
import { repoRoot } from "./lib/paths.ts";

export const id = "skill-mask";

/**
 * The `skills-work/` root, when the directory exists. PI's loader recurses a root the same way a
 * `config/settings.json` `skills` entry does, so one directory path is enough — this module does
 * not enumerate the skills inside it.
 */
export function resolveWorkRoot(): string | undefined {
  const root = join(repoRoot(), "skills-work");
  return existsSync(root) ? root : undefined;
}

/** The `skills-private/` root, when the directory exists. Same contract as `resolveWorkRoot()`. */
export function resolvePrivateRoot(): string | undefined {
  const root = join(repoRoot(), "skills-private");
  return existsSync(root) ? root : undefined;
}

export function register(pi: ExtensionAPI): void {
  // `event`/`ctx` are contextually typed from the `ExtensionAPI.on("resources_discover", ...)`
  // overload, same reasoning as `skills-env.ts` — `ResourcesDiscoverEvent` /
  // `ResourcesDiscoverResult` are not re-exported from the package's public `index.ts`.
  pi.on("resources_discover", (_event, ctx) => {
    try {
      // Order is `skills-private/` then `skills-work/`, preserved from the cwd-gated version.
      const roots = [resolvePrivateRoot(), resolveWorkRoot()].filter((root): root is string => root !== undefined);
      return roots.length > 0 ? { skillPaths: roots } : undefined;
    } catch (err) {
      // Fail open: additive widening is a convenience, not a guarantee. A bug here must cost these
      // two roots, not the session's resource discovery — the settings-driven skills are
      // unaffected either way (see file header: this handler cannot subtract from them).
      surfaceOnce(ctx, "skill-mask:handler-error", () => {
        process.stderr.write(`[pi-config] skill-mask: resources_discover handler failed — ${describeError(err)}\n`);
      });
      return undefined;
    }
  });
}

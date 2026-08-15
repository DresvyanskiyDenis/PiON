/**
 * `EXT-16` — the env-shim half. PI has no `${CLAUDE_SKILL_DIR}`, so a discovered skill's
 * `SKILL.md` prose or a script it ships has no way to name its own directory
 * (`REQ-EXT-02`). This module fills that gap on
 * `resources_discover`.
 *
 * **Why `resources_discover` and not `session_start`,
 * and why that is safe — read from the pinned 0.84.0 package, not assumed:**
 * `AgentSession.bindExtensions()` (`dist/core/agent-session.js`) runs every `session_start`
 * handler FIRST, then calls `extendResourcesFromExtensions()`, which is what emits
 * `resources_discover`. By the time that happens, `DefaultResourceLoader.reload()`
 * (`dist/core/resource-loader.js`) has ALREADY called `updateSkillsFromPaths()` with the
 * settings-resolved skill set for this session. So `pi.getCommands()` inside a
 * `resources_discover` handler returns the session's real, final skill list — this module
 * does not re-implement PI's own discovery scan and does not race it.
 *
 * **V-05 ("is `sourceInfo.baseDir` populated for `source: 'skill'` entries?") — the earlier
 * "yes, always" answer was WRONG, and this module used to act on it. Corrected 2026-08-07
 * against the pinned 0.84.0 package plus a live `getCommands()` dump:**
 * `dist/core/skills.js` `createSkillSourceInfo(filePath, baseDir, source)` does thread
 * `dirname(SKILL.md)` into `sourceInfo.baseDir` — but that object is **discarded**.
 * `DefaultResourceLoader.updateSkillsFromPaths` (`dist/core/resource-loader.js:513-518`)
 * rebuilds every skill as `{...skill, sourceInfo: findSourceInfoForPath(...) ?? skill.sourceInfo
 * ?? getDefaultSourceInfoForPath(...)}`, and `findSourceInfoForPath` — tried FIRST — wins for any
 * skill whose `SKILL.md` is in `metadataByPath`. What it returns is
 * `createSourceInfo(path, ResourceMetadata)`, whose `baseDir` means **"the root this resource was
 * resolved from"**, not "the skill's own directory", and is **optional**:
 *
 *   - listed in `settings.json`'s `skills` array -> `PackageManager.resolve`
 *     (`dist/core/package-manager.js:706-715`) supplies `{source:"local", scope, origin}` with
 *     **no `baseDir` at all** -> `sourceInfo.baseDir === undefined`;
 *   - auto-discovered under `~/.agents/skills` -> `baseDir` is `~/.agents`;
 *   - shipped by a package -> `baseDir` is the package install root.
 *
 * So `baseDir` is undefined for the whole `config/settings.json` skill set, and where it *is*
 * defined it names a directory several levels above the skill. By the runbook's own criterion
 * ("FAIL — `baseDir` is null, absent, **or points at the package root rather than the skill
 * folder**") V-05 is a **FAIL**: the env shim is mandatory, not belt-and-braces, and
 * `sourceInfo.baseDir` must never be read here.
 *
 * **What is reliable instead: `sourceInfo.path`.** Every branch above sets it to the skill's own
 * `filePath` — `createSyntheticSourceInfo(filePath, …)` in `skills.js`, `createSourceInfo(
 * resourcePath, …)` and `{...sourceInfo, path: resourcePath}` in `resource-loader.js`, all with
 * `resourcePath === skill.filePath`. `loadSkillFromFile` (`dist/core/skills.js:214`, `:236`)
 * defines the skill's directory as exactly `dirname(filePath)`, so `dirname(sourceInfo.path)`
 * reproduces `skill.baseDir` byte-for-byte on every discovery path, including a loose
 * `<root>/<name>.md` skill whose directory is the discovery root itself.
 *
 * **How the vars reach a spawned skill script:** PI's own `bash` tool builds its child
 * environment from `{...process.env}` (`utils/shell.js` `getShellEnv()`, read live at spawn
 * time, not snapshotted at import time) — this module sets `process.env` directly, which is
 * the same mechanism `lib/detach.ts` already relies on elsewhere in this tree.
 *
 * **Known limitation, not fixed here:** `ResourcesDiscoverEvent` / `ResourcesDiscoverResult`
 * are NOT re-exported from the package's public `index.ts` (only from the internal
 * `core/extensions/types.ts` — checked by grepping `dist/index.d.ts`, which is silent on
 * both names even though it re-exports dozens of siblings from the same source file). This
 * module therefore never imports either type by name; `pi.on("resources_discover", handler)`
 * still type-checks because TypeScript infers the handler's parameter types contextually from
 * the matching `ExtensionAPI.on` overload. Any other module that needs to construct or narrow
 * one of these two types explicitly will hit the same wall — worth a name for integration to
 * decide once, not per module (see this file's manifest entry).
 *
 * **Extension-contributed skills never got their variable — fixed here.**
 * `AgentSession.extendResourcesFromExtensions` (`dist/core/agent-session.js:1764-1777`) calls
 * `this._extensionRunner.emitResourcesDiscover(...)` — which is what fires every
 * `resources_discover` handler, this module's included — and only AFTER every handler has
 * returned does it call `this._resourceLoader.extendResources(extensionPaths)` with their
 * combined contributions. So inside a `resources_discover` handler, `pi.getCommands()` can
 * never see a skill contributed by ANOTHER `resources_discover` handler in the same firing
 * (`extensions/skill-mask.ts`, concretely) — that skill is added to the roster strictly after
 * this handler already ran. Measured directly against the pinned 0.84.0 source, not inferred.
 *
 * **The fix: a second, later pass on `agent_start`, not a hook that does not exist.** PI 0.84.0
 * exposes no event that fires strictly after `extendResources` and before `resources_discover`
 * fires again (checked every `type: "..."` in `dist/core/extensions/types.d.ts` — there is no
 * `resources_extended` or equivalent). `agent_start` is the nearest correct substitute: it is
 * only emitted from inside a turn (`agent-session.js:441-443`), and every caller of
 * `bindExtensions()` — `interactive-mode.js:1364`, `print-mode.js:53`, `rpc-mode.js:230` — awaits
 * it (which awaits `extendResourcesFromExtensions`) before the mode can start a turn at all; the
 * same is true of `reload()` (`agent-session.js:2072-2073`), awaited by its own command handler
 * before another turn can run. So by the time `agent_start` fires, for every mode and after every
 * reload, `extendResources` has already committed. Skill scripts only ever run from a tool call
 * inside a turn, which happens after `agent_start`, so this closes the gap before it can matter —
 * this is a genuine correctness argument from the source, not a timer or a retry.
 * `pendingPostExtendRefresh` below gates the re-run to once per `resources_discover` firing
 * (startup or reload) rather than every turn, since the roster cannot change mid-session outside
 * those two triggers.
 */
import type { AgentStartEvent, ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { emitNotice } from "./lib/announce.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";

export const id = "skills-env";

/** `PI_SKILL_DIR_<NAME>` prefix. */
const DIR_VAR_PREFIX = "PI_SKILL_DIR_";
/** The single "most common parent" convenience var. */
const ROOT_VAR = "PI_SKILLS_ROOT";

/**
 * Every env var this module has ever set, so a skill that disappears on `/reload` also loses
 * its stale var instead of leaving a dangling path behind. `ROOT_VAR` is always a member so a
 * skill-less session (`--no-skills`, or every skill missing `baseDir`) still clears it.
 */
const managed = new Set<string>([ROOT_VAR]);

/**
 * `foo-bar` -> `PI_SKILL_DIR_FOO_BAR`. Skill names are constrained to `[a-z0-9-]+`
 * (`dist/core/skills.js` `validateName`), so within one session this mapping is injective:
 * the only way two names could produce the same var is if they already collided as skill
 * names, which PI's own loader rejects as a name collision (`collisionDiagnostics`) before
 * this module ever sees the list.
 */
export function envVarName(skillName: string): string {
  return `${DIR_VAR_PREFIX}${skillName.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * The most common `dirname(baseDir)` across every discovered skill, ties broken
 * alphabetically for determinism. A heuristic, not a guarantee — a skill whose root differs
 * from the majority (a colleague's second `--skills` path, a future fourth split directory)
 * needs its own `PI_SKILL_DIR_<NAME>` instead. The 32 `databricks-*` bundle members are
 * deliberately kept out of every discovery root so they never
 * count here at all — the majority is never accidentally the bundle.
 */
export function computeSkillsRoot(baseDirs: readonly string[]): string | undefined {
  if (baseDirs.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const baseDir of baseDirs) {
    const parent = dirname(baseDir);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [parent, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  return best;
}

export interface DiscoveredSkill {
  readonly name: string;
  readonly baseDir: string;
}

/**
 * The skill's own directory, derived from `sourceInfo.path` (== the skill's `filePath`) rather
 * than from `sourceInfo.baseDir` — see the V-05 correction in this file's header for why the
 * latter is either absent or points at a resolution root.
 *
 * Returns `undefined` only for a path this module cannot turn into a directory: absent/empty, or
 * one of PI's synthetic `<sdk:…>` / `<builtin:…>` placeholders (`getDefaultSourceInfoForPath`
 * mints those for pathless resources). Neither shape occurs for a disk-loaded skill today; both
 * are reported rather than guessed at.
 */
export function skillDirFromPath(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  if (path.startsWith("<")) return undefined;
  const dir = dirname(path);
  return dir === "" || dir === "." ? undefined : dir;
}

/**
 * Resolves `dir` to its physical (symlink-free) path before it is ever exported as
 * `PI_SKILL_DIR_<NAME>` or folded into `computeSkillsRoot`.
 *
 * Why this matters here specifically: `~/.pi/agent/skills` (the path `command.sourceInfo.path`
 * is built from, per `config/settings.json`) is a symlink to `~/pi-config/skills`. Left
 * unresolved, every exported dir contains the literal substring `.pi/agent/` and
 * `guard/gates/secret-paths.ts`'s `SEC-PI-STATE` rule (`/(^|\/)\.pi\/agent\//`, no override)
 * refuses any read built from it — and a skill's own `..` escape (e.g. the `databricks` router's
 * `$PI_SKILLS_ROOT/../skill-bundles/...` dispatch rows) resolves lexically through the symlink
 * name instead of the real one, landing on a directory that doesn't exist. Resolving to the
 * realpath here fixes both at the source, for every caller, without teaching either
 * `secret-paths.ts` or the router skill about the symlink.
 *
 * Fails open: a baseDir that no longer exists, or a dangling symlink, must cost this one skill
 * its resolved path, not the whole `resources_discover` handler. Reported once per distinct
 * `dir`, not per skill name, so a shared broken root doesn't spam one line per skill.
 */
export function resolveSkillDir(dir: string, skillName: string, ctx: ExtensionContext | undefined): string {
  try {
    return realpathSync(dir);
  } catch (err) {
    surfaceOnce(ctx, `skills-env:realpath-failed:${dir}`, () =>
      emitNotice(
        ctx,
        `[pi-config] skills-env: realpath failed for skill "${skillName}" directory ` +
          `${JSON.stringify(dir)} — using the unresolved path (${describeError(err)})`,
        "warning",
      ),
    );
    return dir;
  }
}

/**
 * Clears every var this module previously set, then sets the current set. Idempotent and
 * safe to call once per `resources_discover` firing (startup, reload, and any future
 * `session_start` reason that re-triggers resource discovery).
 */
export function applyEnv(skills: readonly DiscoveredSkill[]): void {
  for (const key of managed) delete process.env[key];
  managed.clear();
  managed.add(ROOT_VAR);

  for (const skill of skills) {
    const key = envVarName(skill.name);
    process.env[key] = skill.baseDir;
    managed.add(key);
  }

  const root = computeSkillsRoot(skills.map((s) => s.baseDir));
  if (root !== undefined) process.env[ROOT_VAR] = root;
}

/**
 * Set every time `resources_discover` fires (startup or reload) and cleared by the next
 * `agent_start`, which then re-runs `discoverAndApplySkillEnv` once the extension-contributed
 * skills that `resources_discover` handlers race against have actually landed. See the fix note
 * in this file's header for why `agent_start` — not a fictitious "post-extend" event — is the
 * correct hook.
 */
let pendingPostExtendRefresh = false;

/** Test-only. */
export function __resetForTests(): void {
  for (const key of managed) delete process.env[key];
  managed.clear();
  managed.add(ROOT_VAR);
  pendingPostExtendRefresh = false;
}

/** Test-only: lets a test observe/reset the catch-up gate without waiting on real timing. */
export function __setPendingPostExtendRefreshForTests(value: boolean): void {
  pendingPostExtendRefresh = value;
}

function skillNameFromCommand(command: SlashCommandInfo): string {
  // `_bindExtensionCore`'s `getCommands()` names every skill entry `skill:<name>`.
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
}

/**
 * Reads the current skill roster from `pi.getCommands()` and (re)applies every
 * `PI_SKILL_DIR_<NAME>`. Shared by both the `resources_discover` pass (fast, but may run before
 * `extendResources` has applied an extension-contributed skill — see this file's header) and the
 * `agent_start` catch-up pass (slower to arrive, but guaranteed to run after it).
 */
function discoverAndApplySkillEnv(pi: ExtensionAPI, ctx: ExtensionContext | undefined): void {
  try {
    const skills: DiscoveredSkill[] = [];
    for (const command of pi.getCommands()) {
      if (command.source !== "skill") continue;
      const name = skillNameFromCommand(command);
      const rawBaseDir = skillDirFromPath(command.sourceInfo.path);
      if (rawBaseDir === undefined) {
        surfaceOnce(ctx, `skills-env:no-skill-dir:${name}`, () =>
          emitNotice(
            ctx,
            `[pi-config] skills-env: skill "${name}" has no usable sourceInfo.path ` +
              `(${JSON.stringify(command.sourceInfo.path)}) — its ${envVarName(name)} will not be ` +
              `set; every disk-loaded skill is supposed to carry its SKILL.md path here, so ` +
              `report it`,
            "warning",
          ),
        );
        continue;
      }
      const baseDir = resolveSkillDir(rawBaseDir, name, ctx);
      skills.push({ name, baseDir });
    }
    applyEnv(skills);
  } catch (err) {
    // Fail open: a bug here must cost skill scripts their env vars, not the session its
    // resource discovery. PI already wraps the `resources_discover` handler
    // (`emitResourcesDiscover` in `dist/core/extensions/runner.js`) and reports the throw via
    // `emitError`, but that channel is not something every other module observes — surface it
    // here too so it is not lost. The `agent_start` pass is wrapped the same way for the same
    // reason, even though PI does not itself guard that event.
    surfaceOnce(ctx, "skills-env:handler-error", () =>
      emitNotice(ctx, `[pi-config] skills-env: skill discovery failed — ${describeError(err)}`, "error"),
    );
  }
}

export function register(pi: ExtensionAPI): void {
  // `event`/`ctx` are contextually typed from the `ExtensionAPI.on("resources_discover", ...)`
  // overload — see the file header for why neither type is imported by name.
  pi.on("resources_discover", (_event, ctx) => {
    discoverAndApplySkillEnv(pi, ctx);
    pendingPostExtendRefresh = true;
    // Never contributes skillPaths/promptPaths/themePaths — this module only reads what was
    // already discovered and exports it as environment, so returning nothing is correct.
  });

  pi.on("agent_start", (_event: AgentStartEvent, ctx) => {
    if (!pendingPostExtendRefresh) return;
    pendingPostExtendRefresh = false;
    discoverAndApplySkillEnv(pi, ctx);
  });
}

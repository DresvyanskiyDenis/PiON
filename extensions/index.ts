/**
 * The composition root — the one and only PI extension in this tree.
 *
 * Exactly one file is a PI extension; every other module exports
 * `id` + `register(pi)` and is composed here in a fixed order. PI's own discovery would
 * decide the order for us (and the `tool_call` chaining order with it), and PI does not
 * expose `LoadExtensionsResult` to extensions, so a per-module try/catch here gives
 * `EXT-10`'s `/doctor` better granularity than the platform does (`REQ-EXT-16`).
 *
 * ORDER is exactly `lib/manifest.ts`'s `DECLARED_MODULES`. The invariants encoded in that
 * order, restated so nobody "tidies" them away:
 *
 *   - `guard` is FIRST. A blocked tool call must never be mutated by `bash`/`hooks` first.
 *   - `trust` (`EXT-30`) is SECOND, immediately after `guard`, so its `session_start` deadman
 *     reads a load registry in which `guard`'s entry is already written, and so its
 *     `project_trust` handler is bound before any project resource is considered.
 *   - `hooks` (`EXT-15`) stacks on the guard and may only add denial, so it follows it.
 *   - `path-defaults`, `path-rules` and `skills-env` publish configuration later modules read;
 *     `skill-mask` keeps its slot beside them although it registers nothing.
 *   - `dispatch` precedes `teammates`/`worktree`/`jobs`: those register providers and vetoes
 *     into registries `dispatch` owns.
 *   - `doctor` is LAST so its session_start pass observes everything above it.
 *
 * Loading is intentionally NOT via directory discovery. PI discovers `extensions/*.ts` and
 * `extensions/<dir>/index.ts` (`core/extensions/loader.js` → `discoverExtensionsInDir`), so a
 * symlinked `~/.pi/agent/extensions -> <repo>/extensions` would try to load all 27 modules as
 * separate extensions, in readdir order, and fail every one that has no default export.
 * `config/settings.json` therefore names this file explicitly, exactly as
 * the bootstrap install already prescribes for `extensions`.
 *
 * The limit of the per-module try/catch, stated so nobody over-trusts it: it contains failures
 * *inside* a `register()` call, and nothing else. The imports below are static ESM, so every one
 * of them resolves before the first line of this module's body runs — a module that throws at
 * import time (a bad top-level `await`, a missing native binding, a syntax error) takes the whole
 * extension down before any handler exists to record it, and `/doctor` reports nothing because
 * `/doctor` never loaded either. That is why `manifest.ts` records both a load *and* an absence:
 * a module missing from the registry with no failure entry beside it was never even tried.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { id as guardId, register as registerGuard } from "./guard.ts";
import { id as trustId, register as registerTrust } from "./trust.ts";
import { id as ctxId, register as registerSessionContext } from "./session-context.ts";
import { id as credId, register as registerCredentials } from "./credentials.ts";
import { id as costGateId, register as registerCostGate } from "./cost-gate/index.ts";
import { id as pathDefaultsId, register as registerPathDefaults } from "./path-defaults/index.ts";
import { id as pathRulesId, register as registerPathRules } from "./path-rules/index.ts";
import { id as skillsEnvId, register as registerSkillsEnv } from "./skills-env.ts";
import { id as skillMaskId, register as registerSkillMask } from "./skill-mask.ts";
import { id as webId, register as registerWeb } from "./web.ts";
import { id as bashId, register as registerBash } from "./bash.ts";
import { id as hooksId, register as registerHooks } from "./hooks/index.ts";
import { id as inputTransformId, register as registerInputTransform } from "./input-transform.ts";
import { id as bigResultsId, register as registerBigResults } from "./big-results/index.ts";
import { id as dispatchId, register as registerDispatch } from "./dispatch/index.ts";
import { id as teammatesId, register as registerTeammates } from "./teammates/index.ts";
import { id as worktreeId, register as registerWorktree } from "./worktree/index.ts";
import { id as jobsId, register as registerJobs } from "./jobs/index.ts";
import { id as tasksId, register as registerTasks } from "./tasks/index.ts";
import { id as quotaId, register as registerQuota } from "./quota/index.ts";
import { id as digestId, register as registerDigest } from "./digest/index.ts";
import { id as compactionId, register as registerCompaction } from "./compaction/index.ts";
import { id as contextReportId, register as registerContextReport } from "./context-report/index.ts";
import { id as contextImportsId, register as registerContextImports } from "./context-imports/index.ts";
import { id as sessionIndexId, register as registerSessionIndex } from "./session-index/index.ts";
import { id as autoTitleId, register as registerAutoTitle } from "./auto-title/index.ts";
import { id as skillsLintId, register as registerSkillsLint } from "./skills-lint.ts";
import { id as doctorId, register as registerDoctor } from "./doctor.ts";

import { recordLoad, recordLoadFailure } from "./manifest.ts";

type Registrar = (pi: ExtensionAPI) => void | Promise<void>;

/** Fixed order. See the module docstring before changing a single line of it. */
const ORDER: ReadonlyArray<readonly [string, Registrar]> = [
  // safety and identity — first, always
  [guardId, registerGuard],
  [trustId, registerTrust],
  [ctxId, registerSessionContext],
  [credId, registerCredentials],
  [costGateId, registerCostGate],
  // capability configuration that later modules read
  [pathDefaultsId, registerPathDefaults],
  [pathRulesId, registerPathRules],
  [skillsEnvId, registerSkillsEnv],
  [skillMaskId, registerSkillMask],
  // tool providers and input mutators — after the guard, never before it
  [webId, registerWeb],
  [bashId, registerBash],
  [hooksId, registerHooks],
  [inputTransformId, registerInputTransform],
  [bigResultsId, registerBigResults],
  // orchestration
  [dispatchId, registerDispatch],
  [teammatesId, registerTeammates],
  [worktreeId, registerWorktree],
  [jobsId, registerJobs],
  [tasksId, registerTasks],
  // observability and lifecycle
  [quotaId, registerQuota],
  [digestId, registerDigest],
  [compactionId, registerCompaction],
  [contextReportId, registerContextReport],
  [contextImportsId, registerContextImports],
  [sessionIndexId, registerSessionIndex],
  [autoTitleId, registerAutoTitle],
  [skillsLintId, registerSkillsLint],
  // diagnostics last, so it observes everything above
  [doctorId, registerDoctor],
];

/** Exported for tests: the composed order, as ids, without invoking anything. */
export const MODULE_ORDER: readonly string[] = ORDER.map(([id]) => id);

export default async function (pi: ExtensionAPI): Promise<void> {
  for (const [id, register] of ORDER) {
    try {
      await register(pi);
      recordLoad(id);
    } catch (err) {
      // One module's failure must not take the others down — but it MUST be visible.
      // doctor.ts reads this registry; EXT-30's deadman will read `guard`'s entry specifically.
      recordLoadFailure(id, err);
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stderr.write(`[pi-config] extension module "${id}" failed to load: ${detail}\n`);
      if (err instanceof Error && err.cause !== undefined) {
        process.stderr.write(`[pi-config]   caused by: ${String(err.cause)}\n`);
      }
    }
  }
}

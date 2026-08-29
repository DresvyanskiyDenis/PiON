/**
 * `D-01` .. `D-10`: pure functions over plain data, no `ExtensionAPI`/`ExtensionContext` import,
 * so they run under `node --test` with fixtures instead of a live `pi` process. `doctor.ts` is the
 * only module that gathers `DoctorInputs` from a real session; `declared.ts` gathers the
 * filesystem half.
 *
 * Every check returns `Finding[]`, empty when clean — there is no separate "ok" check, `ok` is
 * derived (`reportIsOk` in `types.ts`) from the absence of an `"error"`-severity finding.
 */
import { splitThinkingSuffix } from "../dispatch/thinking.ts";
import { authoredInstructionText, extractReferences, type ExtractedReferences } from "./extract.ts";
import { ACKNOWLEDGED_GUIDELINES } from "./guidelines.ts";
import { reportIsOk, type DoctorReport, type Finding, type Severity } from "./types.ts";

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
  readonly credentialed: boolean;
}

export interface RoutingTierInput {
  readonly tier: string;
  readonly modelRef: string;
  readonly fallbackRef?: string;
  readonly optional: boolean;
}

export interface ManifestInput {
  readonly declared: readonly string[];
  readonly loaded: readonly string[];
  /** `[moduleId, errorText]` */
  readonly failed: readonly (readonly [string, string])[];
  readonly absent: readonly string[];
}

export interface GuardSelfTestInput {
  /** Did `manifest.ts` record `guard` as loaded (its `register()` returned)? See `doctor.ts`'s
   *  module docstring for why this — not the `guard:ready` event — is what gates D-06. */
  readonly moduleLoaded: boolean;
  /** Was the `guard:ready` event handshake observed this run? Best-effort, see `doctor.ts`. */
  readonly handshakeObserved: boolean;
  readonly version?: string;
  readonly gateIds?: readonly string[];
  /** `matchDangerous("rm -rf /")?.id`, called directly — no event dependency. */
  readonly selfTestPatternId: string | null;
}

/** `D-10`. One entry per registered tool that ships `promptGuidelines`, in `getAllTools()` order.
 *  `guidelines` is the array exactly as PI holds it: the index is the ledger key, so nothing may
 *  be filtered out or re-sorted on the way in. */
export interface ToolGuidelinesInput {
  readonly tool: string;
  readonly guidelines: readonly string[];
}

export interface PackageAuditInput {
  readonly name: string;
  readonly declaredVersion: string;
  readonly vendor: boolean;
  readonly installedVersion: string | undefined;
}

export interface DoctorInputs {
  readonly systemPrompt: string;
  readonly liveToolNames: readonly string[];
  readonly declaredToolNames: readonly string[];
  /** `declared.ts`'s three repo skill roots — includes roots this session never widened into. */
  readonly declaredSkillIds: readonly string[];
  /** `pi.getCommands()` filtered to `source === "skill"` — includes skills installed outside the
   *  repo (`~/.agents/skills/`) or shipped inside an adopted package. `D-02` unions the two. */
  readonly liveSkillIds: readonly string[];
  readonly agents: { readonly rootExists: boolean; readonly ids: readonly string[] };
  readonly routingTiers: readonly RoutingTierInput[];
  readonly availableModels: readonly ModelRef[];
  readonly manifest: ManifestInput;
  readonly guard: GuardSelfTestInput;
  readonly declaredServerNames: readonly string[];
  readonly packages: readonly PackageAuditInput[];
  /** `D-09`. `extensions/hooks/index.ts`'s `hooksDegradedReason()` — `undefined` when the hook
   *  layer loaded normally, otherwise why it is carrying no rules at all. */
  readonly hooksDegradedReason: string | undefined;
  /** `D-10`. `pi.getAllTools()` narrowed to the tools that ship `promptGuidelines`. Those entries
   *  are copies, so reading them cannot disturb the live definitions and writing to them would
   *  achieve nothing — this check only ever reads. */
  readonly toolGuidelines: readonly ToolGuidelinesInput[];
  /** `D-11`. `declared.ts`'s `readOnProviderErrorReport` — `config/routing.json`'s
   *  `onProviderError.report` field list, read verbatim. */
  readonly onProviderErrorReport: readonly string[];
}

/** `DB-RM-ROOT` is the literal pattern id the acceptance tests name.
 *  Sourced from `extensions/guard/patterns.ts`'s `DANGER_PATTERNS`, but kept as a plain string
 *  here rather than imported: `checks.ts` must stay free of any module with real side effects, and
 *  the id is a stable, load-bearing contract (breaking it is exactly what the acceptance test
 *  fires on) rather than an implementation detail that should drift with `patterns.ts`. */
export const EXPECTED_GUARD_SELF_TEST_PATTERN_ID = "DB-RM-ROOT";

function finding(
  check: Finding["check"],
  severity: Severity,
  subject: string,
  message: string,
  action: string,
): Finding {
  return { check, severity, subject, message, action };
}

/** The names the **authored** instruction text mentions. `authoredInstructionText` narrows the
 *  assembled system prompt to this repo's own `<project_instructions>` regions first, so PI's
 *  preamble and its `<available_skills>` registry render — neither of which this repo writes, and
 *  neither of which can drift against a roster — are never scanned for references. See
 *  `extract.ts`'s module docstring for the eight false `/doctor` errors raw-prompt scanning
 *  produced on 2026-08-07. */
function referencesIn(inputs: DoctorInputs): ExtractedReferences {
  return extractReferences(authoredInstructionText(inputs.systemPrompt));
}

/** `D-01` — every tool name mentioned in the instruction text resolves against the live roster or
 *  `config/tools.declared.json`. */
export function checkTools(inputs: DoctorInputs): Finding[] {
  const mentioned = referencesIn(inputs).tools;
  const known = new Set([...inputs.liveToolNames, ...inputs.declaredToolNames]);
  return mentioned
    .filter((name) => !known.has(name))
    .map((name) =>
      finding(
        "D-01",
        "error",
        name,
        `tool "${name}" named in the instruction text does not exist`,
        `remove the reference, register the tool, or add it to config/tools.declared.json`,
      ),
    );
}

/**
 * `D-02` — every skill name mentioned resolves against the declared filesystem roster **union** the
 * live one, exactly the way `D-01` resolves a tool against `liveToolNames ∪ declaredToolNames`.
 *
 * Both halves are load-bearing and neither subsumes the other:
 *
 *   - `declaredSkillIds` (`declared.ts`, the repo's `skills/` root) covers a repo skill the live
 *     set can still miss — a skill on disk that PI has not loaded this session, because the
 *     settings file in force is not this repo's. Live-only would false-positive on it.
 *   - `liveSkillIds` (`pi.getCommands()`, `source === "skill"`) covers a skill installed outside
 *     this repo entirely — `~/.agents/skills/…`, or one shipped inside an adopted package such as
 *     `pi-mcp-adapter`'s `mcp-scripting`. Those are real, PI discovered them, and no roster under
 *     `<root>` will ever list them. Declared-only false-positived on six of them on 2026-08-07.
 *
 * A hand-maintained `config/skills.declared.json` mirroring `~/.agents/skills/` was the obvious
 * alternative and is strictly worse: it is a second copy of a directory listing, it goes stale the
 * moment a skill is added there, and PI's own registry is the authoritative answer to "does this
 * skill exist" — the same reasoning that makes `liveToolNames` the first half of `D-01`.
 */
export function checkSkills(inputs: DoctorInputs): Finding[] {
  const mentioned = referencesIn(inputs).skills;
  const known = new Set([...inputs.declaredSkillIds, ...inputs.liveSkillIds]);
  return mentioned
    .filter((name) => !known.has(name))
    .map((name) =>
      finding(
        "D-02",
        "error",
        name,
        `skill "${name}" named in the instruction text has no SKILL.md under skills/, ` +
          `and PI did not discover it anywhere else`,
        `remove the reference or add the skill`,
      ),
    );
}

/** `D-03` — every agent name mentioned has a file in `agents/`. Warn while `agents/` does not
 *  exist at all (wave 1, content not ported — `EXT-05` has not landed the 14 agent files); error
 *  once it does (wave 2+), because at that point an unresolved name is unambiguous drift rather
 *  than "the system doesn't exist yet". */
export function checkAgents(inputs: DoctorInputs): Finding[] {
  const mentioned = referencesIn(inputs).agents;
  const declared = new Set(inputs.agents.ids);
  const severity: Severity = inputs.agents.rootExists ? "error" : "warn";
  return mentioned
    .filter((name) => !declared.has(name))
    .map((name) =>
      finding(
        "D-03",
        severity,
        name,
        inputs.agents.rootExists
          ? `agent "${name}" named in the instruction text has no agents/${name}.md`
          : `agent "${name}" named in the instruction text, but agents/ does not exist yet (EXT-05 content not ported)`,
        inputs.agents.rootExists
          ? `remove the reference or add the agent file`
          : `no action yet — this becomes an error once agents/ is populated`,
      ),
    );
}

function splitModelRef(ref: string): { provider: string; id: string } {
  const i = ref.indexOf("/");
  if (i === -1) return { provider: ref, id: "" };
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

/**
 * The one place a `routing.json` model reference is turned into a registry entry.
 *
 * A tier's reasoning effort travels inside the model string — `provider/id:high` — and
 * `dispatch/tiers.ts` puts it there itself from `thinkingLevel`. The model registry is keyed by the
 * BARE `provider/id`, so the suffix comes off before the lookup, exactly as `dispatch/tiers.ts` and
 * `dispatch/registry.ts` already do it. Asking the registry about the suffixed string reports a
 * well-configured tier as unresolved — an invented error in the one tool whose job is to say
 * whether the configuration is sound.
 *
 * `checkModels` and `buildReport` both need this and would otherwise carry two copies: a divergence
 * between them would mean `/doctor`'s summary line and its `D-04` findings disagree about the same
 * tier, which is worse than either being wrong alone.
 */
function resolveModelRef(ref: string, available: readonly ModelRef[]): ModelRef | undefined {
  const { provider, id } = splitModelRef(splitThinkingSuffix(ref).baseModel);
  return available.find((m) => m.provider === provider && m.id === id);
}

/** Every `provider/id` the routing tiers point at, model and fallback alike, deduplicated and in
 *  declaration order. Unresolved refs are skipped — `D-04` is what reports those. */
function referencedModels(inputs: DoctorInputs): ModelRef[] {
  const seen = new Map<string, ModelRef>();
  for (const t of inputs.routingTiers) {
    for (const ref of [t.modelRef, t.fallbackRef]) {
      if (ref === undefined) continue;
      const match = resolveModelRef(ref, inputs.availableModels);
      if (match !== undefined) seen.set(`${match.provider}/${match.id}`, match);
    }
  }
  return [...seen.values()];
}

/** `D-04` — every `routing.json` tier's model (and `fallback`, if the field is ever reintroduced)
 *  resolves in the model registry. Unknown id -> error, UNLESS the tier is `optional` (audit 25:
 *  a colleague missing a local-provider setup must still start) -> warn. Known but uncredentialed
 *  -> warn always, optional or not. */
export function checkModels(inputs: DoctorInputs): Finding[] {
  const findings: Finding[] = [];
  const available = inputs.availableModels;

  const checkRef = (tier: string, ref: string, label: "model" | "fallback", optional: boolean) => {
    const match = resolveModelRef(ref, available);
    if (match === undefined) {
      findings.push(
        finding(
          "D-04",
          optional ? "warn" : "error",
          `${tier}.${label}`,
          `tier "${tier}" ${label} unresolved: "${ref}" is not in the model registry`,
          optional
            ? `start the provider, or ignore: routing.json marks this tier optional`
            : `fix routing.json's "${ref}" or add the model to models.json`,
        ),
      );
      return;
    }
    if (!match.credentialed) {
      findings.push(
        finding(
          "D-04",
          "warn",
          `${tier}.${label}`,
          `tier "${tier}" ${label} "${ref}" resolves but has no configured credential`,
          `add the credential, or ignore if this tier is not needed on this machine`,
        ),
      );
    }
  };

  for (const t of inputs.routingTiers) {
    checkRef(t.tier, t.modelRef, "model", t.optional);
    if (t.fallbackRef !== undefined) checkRef(t.tier, t.fallbackRef, "fallback", t.optional);
  }
  return findings;
}

/** `D-05` — `loadedModules() == DECLARED_MODULES`. A module that threw is named with its error; a
 *  module that never even attempted `register()` (`absent`) is named too — both are `REQ-EXT-16`'s
 *  load half and both are `"error"`, because the fix differs (read the stack trace vs. check
 *  `index.ts`'s import graph) but the severity does not. */
export function checkModuleLoad(inputs: DoctorInputs): Finding[] {
  const findings: Finding[] = [];
  for (const [id, err] of inputs.manifest.failed) {
    findings.push(
      finding("D-05", "error", id, `extension module "${id}" failed to load: ${err}`, `fix the error and restart`),
    );
  }
  for (const id of inputs.manifest.absent) {
    findings.push(
      finding(
        "D-05",
        "error",
        id,
        `extension module "${id}" is declared but never attempted registration`,
        `check extensions/index.ts's import graph and composition order`,
      ),
    );
  }
  return findings;
}

/** `D-06` — the guardrail is healthy. Gates on `manifest.ts`'s `guard` load record (deterministic,
 *  every session) rather than the `guard:ready` event, whose payload — version, gate ids — is
 *  still surfaced when it happens to be observed. See `doctor.ts`'s module docstring for the
 *  event-ordering reason `handshakeObserved` cannot be the pass/fail signal. The self-test
 *  (`matchDangerous("rm -rf /")` still resolving to `DB-RM-ROOT`) has no such caveat — it is a
 *  direct, synchronous call with no event involved. */
export function checkGuard(inputs: DoctorInputs): Finding[] {
  const findings: Finding[] = [];
  const g = inputs.guard;

  if (!g.moduleLoaded) {
    findings.push(
      finding(
        "D-06",
        "error",
        "guard",
        `the guard extension module did not load — no tool call is protected this session`,
        `see D-05 for the load failure, fix it, and restart`,
      ),
    );
    // The self-test is meaningless without a loaded module; do not also report a pattern failure.
    return findings;
  }

  if (g.selfTestPatternId !== EXPECTED_GUARD_SELF_TEST_PATTERN_ID) {
    findings.push(
      finding(
        "D-06",
        "error",
        "guard/patterns.ts",
        `synthetic probe matchDangerous("rm -rf /") returned ` +
          `${g.selfTestPatternId === null ? "no match" : `"${g.selfTestPatternId}"`}, expected ` +
          `"${EXPECTED_GUARD_SELF_TEST_PATTERN_ID}" — the catastrophic-command pattern is broken`,
        `restore extensions/guard/patterns.ts's DB-RM-ROOT rule before doing anything else`,
      ),
    );
  }

  return findings;
}

/** `D-07` — every MCP server name mentioned resolves against `config/mcp.json`'s declared
 *  servers, regardless of `disabled`. */
export function checkServers(inputs: DoctorInputs): Finding[] {
  const mentioned = referencesIn(inputs).servers;
  const declared = new Set(inputs.declaredServerNames);
  return mentioned
    .filter((name) => !declared.has(name))
    .map((name) =>
      finding(
        "D-07",
        "error",
        name,
        `MCP server "${name}" named in the instruction text is not declared in config/mcp.json`,
        `remove the reference or add the server to config/mcp.json`,
      ),
    );
}

/** `D-08` — the adopted-package report (R-13): every `config/packages.lock.json` entry cross-
 *  referenced against `node_modules/`. Absent or a version other than the pinned one is `"warn"`,
 *  not `"error"` — the rollback shape is "the capability goes
 *  absent, and /doctor says so", a session that still starts, not one that refuses to. The hard
 *  pin-agreement gate (`VP-10`) is `EXT-04`'s `bin/pi-check`; this is the greppable report R-13
 *  asked for, not a second enforcer of the same rule. */
export function checkPackages(inputs: DoctorInputs): Finding[] {
  const findings: Finding[] = [];
  for (const p of inputs.packages) {
    if (p.installedVersion === undefined) {
      findings.push(
        finding(
          "D-08",
          "warn",
          p.name,
          `package "${p.name}"@${p.declaredVersion} is declared in packages.lock.json but not installed`,
          `npm install --ignore-scripts ${p.name}@${p.declaredVersion} --prefix ~/.pi/agent, or accept the capability as absent`,
        ),
      );
      continue;
    }
    if (p.installedVersion !== p.declaredVersion) {
      findings.push(
        finding(
          "D-08",
          "warn",
          p.name,
          `package "${p.name}" installed@${p.installedVersion} does not match the pinned ${p.declaredVersion}`,
          `reinstall the pinned version, or update packages.lock.json after a deliberate re-review`,
        ),
      );
    }
  }
  return findings;
}

/** `D-09` — the hook layer is carrying rules rather than sitting degraded.
 *
 *  `error`, not `warn`: the operator wrote denials in `hooks.yaml` and none of them are in effect.
 *  It is not a session-ending error though — `doctor.ts` shuts down only over `D-06`, and `EXT-03`'s
 *  hard gates are unaffected by a broken hooks file. See `extensions/hooks/index.ts`'s header for
 *  the polarity and `docs/DENYLIST.md` §4a finding #5 for why it was reversed.
 *
 *  Zero rules with no degraded reason is NOT reported: a machine with no `hooks.yaml` at all is the
 *  normal case, and `D-09` fires on "the file exists and is broken", not on "the file is absent". */
export function checkHooks(inputs: DoctorInputs): Finding[] {
  const reason = inputs.hooksDegradedReason;
  if (reason === undefined) return [];
  return [
    finding(
      "D-09",
      "error",
      "hooks.yaml",
      `the hook layer is DEGRADED — no hook rules are in effect this session: ${reason}`,
      `fix the file and restart; EXT-03's hard gates (guard.ts) are unaffected meanwhile`,
    ),
  ];
}

/**
 * The header PI writes above the guidelines when it builds its stock system prompt, carrying
 * enough of the preceding sentence to be unmistakable. Copied verbatim from `core/system-prompt.js`.
 *
 * Finding it is proof that this session has **no** `customPrompt` and PI is still rendering every
 * tool's `promptGuidelines` itself — in which case nothing is being lost and `D-10` has nothing to
 * report. `getSystemPromptOptions().customPrompt` answers the same question more directly but
 * exists only on `ExtensionCommandContext`, which the `session_start` pass never receives; the
 * assembled prompt is available to both.
 *
 * If a future PI release rewords this block the probe stops matching, and `D-10` runs and reports.
 * That polarity is deliberate: a template change should make the check louder, never quietly
 * switch it off.
 */
const PI_GUIDELINES_SECTION_MARKER =
  "In addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n";

/**
 * `D-10` — every tool `promptGuidelines` bullet has a recorded disposition in
 * `extensions/doctor/guidelines.ts`.
 *
 * `SYSTEM.md` is this configuration's `customPrompt`, and `buildSystemPrompt` returns on that
 * branch before the `Guidelines:` section is built. Every registered tool's guidelines are
 * discarded together — PI's own and every package's. `SYSTEM.md` restates the ones worth restating
 * in its own words, which is precisely why matching guideline text against the prompt would flag
 * the covered ones and miss the point. The ledger is the honest alternative: it records what
 * became of each bullet, the deliberately abandoned ones included, and `D-10` fires on the ones
 * nobody has looked at.
 *
 * `warn`, never `error`. A guideline nobody restated is a prompt-quality call to make, not a
 * broken session. It belongs to the cheap `session_start` set because the failure it exists to
 * catch — a package update quietly adding a bullet — has no other moment where anyone would see
 * it, and the scan is string work over data already in memory.
 *
 * Ledger rows with no live tool behind them are **not** reported. They are inert, they cost a
 * line, and reporting them would turn every package you do not install into recurring noise.
 */
export function checkGuidelines(inputs: DoctorInputs): Finding[] {
  if (inputs.systemPrompt.includes(PI_GUIDELINES_SECTION_MARKER)) return [];

  const findings: Finding[] = [];
  for (const { tool, guidelines } of inputs.toolGuidelines) {
    guidelines.forEach((text, index) => {
      const key = `${tool}:${index}`;
      const ack = ACKNOWLEDGED_GUIDELINES[key];
      if (ack === undefined) {
        findings.push(
          finding(
            "D-10",
            "warn",
            key,
            `tool "${tool}" guideline ${index} is dropped by SYSTEM.md and has no recorded ` +
              `disposition: "${text}"`,
            `restate it in SYSTEM.md, or record it in extensions/doctor/guidelines.ts as ` +
              `system-prompt / tool-contract / elsewhere / dropped`,
          ),
        );
        return;
      }
      const [disposition, marker] = ack;
      if (!text.includes(marker)) {
        findings.push(
          finding(
            "D-10",
            "warn",
            key,
            `tool "${tool}" guideline ${index} was recorded as "${disposition}" on the strength of ` +
              `"${marker}", which its current text no longer contains: "${text}"`,
            `re-read the guideline and update its row in extensions/doctor/guidelines.ts — the ` +
              `package reworded it, so the recorded disposition may no longer hold`,
          ),
        );
      }
    });
  }
  return findings;
}

/** The fields `extensions/lib/provider-error.ts`'s `formatProviderFailure` actually renders.
 *  Named here rather than derived from `provider-error.ts` by inspection: `checks.ts` stays free
 *  of any module with real side effects or a parser dependency (see the module docstring), the
 *  same tradeoff `EXPECTED_GUARD_SELF_TEST_PATTERN_ID` already makes for `D-06`. */
export const IMPLEMENTED_PROVIDER_ERROR_FIELDS: readonly string[] = [
  "provider",
  "model",
  "errorClass",
  "message",
  "causeChain",
];

/** `D-11` — every field `config/routing.json`'s `onProviderError.report` names has a renderer
 *  behind it in `formatProviderFailure`.
 *
 *  `warn`, not `error`: a declared field nobody renders is a doctrine mismatch worth resolving the
 *  next time `routing.json` is touched, not a broken session — every field that IS implemented
 *  still reaches the operator in full, so this check exists to stop a written promise from
 *  drifting away from the code behind it a second time, not to report that it already has. */
export function checkProviderErrorReport(inputs: DoctorInputs): Finding[] {
  const implemented = new Set(IMPLEMENTED_PROVIDER_ERROR_FIELDS);
  return inputs.onProviderErrorReport
    .filter((field) => !implemented.has(field))
    .map((field) =>
      finding(
        "D-11",
        "warn",
        field,
        `routing.json's onProviderError.report names "${field}", which provider-error.ts does not render`,
        `extend formatProviderFailure to carry it, or drop it from routing.json's report array`,
      ),
    );
}

export interface RunAllOptions {
  /** The cheap subset run at `session_start` — everything except `D-04` (network-shaped: model
   *  registry availability) and `D-08` (filesystem stat per package). Both are still fast in
   *  practice, but the cheap/full split holds because D-06's self-test plus
   *  D-01/02/03/05/07/09/10's string scans and getters are the part that must never be skipped — a broken guardrail
   *  has to be caught every session, not only on an explicit `/doctor`. */
  readonly cheapOnly?: boolean;
}

export function runAllChecks(inputs: DoctorInputs, opts?: RunAllOptions): Finding[] {
  const cheap = [
    ...checkTools(inputs),
    ...checkSkills(inputs),
    ...checkAgents(inputs),
    ...checkModuleLoad(inputs),
    ...checkGuard(inputs),
    ...checkServers(inputs),
    ...checkHooks(inputs),
    ...checkGuidelines(inputs),
    ...checkProviderErrorReport(inputs),
  ];
  if (opts?.cheapOnly) return cheap;
  return [...cheap, ...checkModels(inputs), ...checkPackages(inputs)];
}

/** Assembles the full `DoctorReport` (findings + the summary counts §13.3's sample output shows)
 *  from the same `DoctorInputs` the checks ran against. Pure — `doctor.ts` supplies live data,
 *  tests supply fixtures. */
export function buildReport(inputs: DoctorInputs, findings: readonly Finding[]): DoctorReport {
  // NOT `availableModels.filter(m => !m.credentialed)` — that is the registry's uncredentialed
  // tail, which this configuration never asked for and which nothing is missing. See the `models`
  // field's docstring in `types.ts` for the label that mistake produced.
  const referencedWithoutCredential = referencedModels(inputs)
    .filter((m) => !m.credentialed)
    .map((m) => `${m.provider}/${m.id}`);
  const packagesResolved = inputs.packages.filter((p) => p.installedVersion !== undefined).length;
  const packagesAbsent = inputs.packages.filter((p) => p.installedVersion === undefined).map((p) => p.name);
  const packagesMismatch = inputs.packages
    .filter((p) => p.installedVersion !== undefined && p.installedVersion !== p.declaredVersion)
    .map((p) => p.name);

  return {
    findings: [...findings],
    modules: {
      declared: inputs.manifest.declared.length,
      loaded: inputs.manifest.loaded.length,
      failed: inputs.manifest.failed.map(([id]) => id),
    },
    skills: { count: inputs.declaredSkillIds.length },
    agents: { count: inputs.agents.ids.length },
    tools: { count: inputs.liveToolNames.length, names: [...inputs.liveToolNames] },
    servers: { count: inputs.declaredServerNames.length, names: [...inputs.declaredServerNames] },
    guard: {
      moduleLoaded: inputs.guard.moduleLoaded,
      handshakeObserved: inputs.guard.handshakeObserved,
      ...(inputs.guard.version !== undefined ? { version: inputs.guard.version } : {}),
      ...(inputs.guard.gateIds !== undefined ? { gateCount: inputs.guard.gateIds.length } : {}),
      selfTestPatternId: inputs.guard.selfTestPatternId,
      selfTestOk: inputs.guard.selfTestPatternId === EXPECTED_GUARD_SELF_TEST_PATTERN_ID,
    },
    models: {
      inRegistry: inputs.availableModels.length,
      usableHere: inputs.availableModels.filter((m) => m.credentialed).length,
      referencedWithoutCredential,
    },
    hooks: inputs.hooksDegradedReason !== undefined ? { degradedReason: inputs.hooksDegradedReason } : {},
    packages: {
      declared: inputs.packages.length,
      resolved: packagesResolved,
      absent: packagesAbsent,
      versionMismatch: packagesMismatch,
    },
    ok: reportIsOk(findings),
  };
}

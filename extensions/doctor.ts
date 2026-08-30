/**
 * `EXT-10` — `/doctor` + a `session_start` warn pass. Every skill, agent, tool and MCP server
 * named in the assembled instruction text resolves
 * against **declared** resources (`extensions/doctor/declared.ts`), not merely enabled ones — a
 * skill scoped out of this session's cwd, or a package tool whose provider lacks a credential
 * today, must not read as drift. It also reports the adopted packages (R-13): which loaded, which
 * version, and which is expected-but-absent (`D-08`), built on `manifest.ts`'s registry rather
 * than a "list every loaded extension" API PI does not expose (`V-31`).
 *
 * ## The `guard:ready` race — read before touching D-06
 *
 * `extensions/guard.ts` (`EXT-03`, already shipped, not owned by this module) emits its
 * `"guard:ready"` handshake **synchronously inside its own `register(pi)` call**:
 * `pi.events.emit("guard:ready", {...})`. `EventBus` (`core/event-bus.ts`) is a bare
 * `node:events` `EventEmitter` with **no replay buffer** — a listener attached after `emit()` has
 * already run receives nothing, ever, for that emission. `extensions/index.ts`'s own
 * `ORDER` array lists `doctor` **last**, after `guard`. Under that order — or any order where
 * `doctor` does not register strictly before `guard` — `doctor.ts`'s `register()` always runs
 * after `guard.ts`'s `register()` has already returned, so subscribing to `"guard:ready"` here can
 * never observe it. Verified by reading `core/event-bus.js` directly (plain `EventEmitter.emit`,
 * no queue) rather than assumed from the `.d.ts`.
 *
 * Consequence: **D-06 does not gate on the event.** It gates on `manifest.ts`'s `guard` load
 * record (`recordLoad("guard")`, written unconditionally by `index.ts`'s composition loop right
 * after `guard.register()` returns — a mechanism with no ordering dependency) plus a direct,
 * synchronous call to `matchDangerous("rm -rf /")`, which needs no event at all. The subscription
 * below is kept anyway — cheap, harmless, and it starts working the moment `index.ts` ever
 * reorders `doctor` before `guard`, or `guard.ts` is revised to also emit at `session_start` — and
 * its payload (version, gate ids) is surfaced in the report as an enrichment when it does fire,
 * never as the pass/fail signal.
 *
 * As of the EXT-30 hand-off that subscription is no longer dangling: `guard.ts` answers
 * `guard:whois` by re-emitting `guard:ready`, and `register()`
 * below sends that probe right after subscribing. `handshakeObserved` therefore becomes true under
 * the documented order. **This changes no verdict** — D-06 still gates on the load record and the
 * `matchDangerous` probe, exactly as before, because a handshake proves the module ran, not that
 * its policy is intact.
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildReport,
  runAllChecks,
  type DoctorInputs,
  type ManifestInput,
  type ModelRef,
  type RoutingTierInput,
  type ToolGuidelinesInput,
} from "./doctor/checks.ts";
import {
  discoverDeclaredAgents,
  discoverDeclaredSkills,
  readDeclaredServers,
  readDeclaredTools,
  readOnProviderErrorReport,
  readPackagesLock,
  readRoutingTiers,
  resolveInstalledPackageVersion,
} from "./doctor/declared.ts";
import { renderTable, renderWarnLine } from "./doctor/render.ts";
import type { DoctorReport, Finding } from "./doctor/types.ts";
import { matchDangerous } from "./guard/patterns.ts";
// `D-09`. A pure getter over `hooks`'s module state — importing it wires nothing, `register()` does
// that. Read live rather than mirrored into `manifest.ts` because the state changes at every
// `session_start` load, not once at registration.
import { hooksDegradedReason, hooksScriptFailures } from "./hooks/index.ts";
import { emitNotice } from "./lib/announce.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";
import { repoRoot } from "./lib/paths.ts";
import { declareModule, manifestReport, moduleStatus } from "./manifest.ts";
import { DEADMAN_BLOCKED_TOOLS, evaluateDeadman } from "./trust.ts";

export const id = "doctor";
const MODULE_VERSION = "1.0.0";
const GUARD_SELF_TEST_PROBE = "rm -rf /";

/** Best-effort capture of `guard.ts`'s handshake — see the module docstring for why this can
 *  legitimately never fire under the documented composition order. */
interface GuardHandshake {
  readonly version?: string;
  readonly gates?: readonly string[];
}
let guardHandshake: GuardHandshake | undefined;

/**
 * The skill half of `D-02`'s known roster, read off PI's live registry rather than the filesystem.
 * `_bindExtensionCore`'s `getCommands()` names every skill entry `skill:<name>` — the same contract
 * `skills-env.ts` reads for `PI_SKILL_DIR_*`, so the prefix is stated in one shape in two places on
 * purpose rather than shared: `skills-env.ts` needs `sourceInfo.baseDir` and its own fail-open
 * reporting, this needs only the name and must not import a module with `register()` side effects.
 *
 * Unlike `discoverDeclaredSkills`, this sees skills that live outside the repo — `~/.agents/skills/`
 * and package-bundled `skills/` directories — which is exactly the half `declared.ts` structurally
 * cannot supply. See `checks.ts`'s `checkSkills` for why `D-02` needs both.
 */
function liveSkillNames(pi: ExtensionAPI): string[] {
  return pi
    .getCommands()
    .filter((c) => c.source === "skill")
    .map((c) => (c.name.startsWith("skill:") ? c.name.slice("skill:".length) : c.name));
}

async function gatherInputs(ctx: ExtensionContext | ExtensionCommandContext, pi: ExtensionAPI): Promise<DoctorInputs> {
  const root = repoRoot();
  const systemPrompt = ctx.getSystemPrompt();

  const allTools = pi.getAllTools();
  const liveToolNames = allTools.map((t) => t.name);

  // `D-10`. `getAllTools()` hands back copies, so this is a snapshot read that cannot disturb the
  // live definitions. Registered-but-inactive tools are included on purpose: a tool masked off by
  // `/review`, or narrowed away by `setActiveTools`, is one `/ship` from contributing again, and a
  // check about what the prompt layer silently loses must not turn on this instant's mask.
  const toolGuidelines: ToolGuidelinesInput[] = allTools
    .filter((t) => (t.promptGuidelines?.length ?? 0) > 0)
    .map((t) => ({ tool: t.name, guidelines: [...(t.promptGuidelines ?? [])] }));
  const declaredToolNames = readDeclaredTools(root).map((t) => t.name);

  const declaredSkillIds = discoverDeclaredSkills(root);
  const liveSkillIds = liveSkillNames(pi);
  const agents = discoverDeclaredAgents(root);
  const declaredServerNames = readDeclaredServers(root);
  const onProviderErrorReport = readOnProviderErrorReport(root);

  const routingTiers: RoutingTierInput[] = readRoutingTiers(root).map((t) => ({
    tier: t.tier,
    modelRef: t.modelRef,
    ...(t.fallbackRef !== undefined ? { fallbackRef: t.fallbackRef } : {}),
    optional: t.optional,
  }));

  const availableModels: ModelRef[] = ctx.modelRegistry.getAvailable().map((m) => ({
    provider: m.provider,
    id: m.id,
    credentialed: ctx.modelRegistry.hasConfiguredAuth(m),
  }));

  const mr = manifestReport();
  const manifest: ManifestInput = {
    declared: mr.declared,
    loaded: mr.loaded,
    failed: mr.failed,
    absent: mr.absent,
  };

  const selfTestPatternId = matchDangerous(GUARD_SELF_TEST_PROBE)?.id ?? null;
  const guard = {
    moduleLoaded: mr.loaded.includes("guard"),
    handshakeObserved: guardHandshake !== undefined,
    ...(guardHandshake?.version !== undefined ? { version: guardHandshake.version } : {}),
    ...(guardHandshake?.gates !== undefined ? { gateIds: guardHandshake.gates } : {}),
    selfTestPatternId,
  };

  const lockEntries = readPackagesLock(root);
  const packages = lockEntries.map((p) => ({
    name: p.name,
    declaredVersion: p.version,
    vendor: p.vendor,
    installedVersion: resolveInstalledPackageVersion(root, p.name),
  }));

  return {
    systemPrompt,
    liveToolNames,
    declaredToolNames,
    declaredSkillIds,
    liveSkillIds,
    agents,
    routingTiers,
    availableModels,
    manifest,
    guard,
    declaredServerNames,
    packages,
    hooksDegradedReason: hooksDegradedReason(),
    hooksScriptFailures: hooksScriptFailures(),
    toolGuidelines,
    onProviderErrorReport,
  };
}

async function runChecks(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  opts?: { cheapOnly?: boolean },
): Promise<DoctorReport> {
  const inputs = await gatherInputs(ctx, pi);
  const findings = runAllChecks(inputs, opts);
  return buildReport(inputs, findings);
}

/** Truncated because a transcript-rendered table (unlike raw stdout) counts toward context, and
 *  a tree with 30 extensions, 20 skills and 14 agents can produce a report worth bounding. */
function boundedTable(report: DoctorReport): string {
  const rendered = renderTable(report);
  const t = truncateTail(rendered, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return t.truncated ? `${t.content}\n… truncated (${t.totalLines} lines total)` : t.content;
}

/**
 * Who owns the terminal response when a guardrail module did not load.
 *
 * `EXT-30`'s deadman (`trust.ts`) and this module's `D-06` fire on the *same* condition and used to
 * answer it twice: the deadman blocks `bash`/`write`/`edit`/`multiedit` and shows `GUARD OFF`,
 * then `D-06` called `ctx.shutdown()` a moment later and killed the session anyway. One condition,
 * one behaviour — so `D-06` defers, and the deadman keeps the terminal response. Three reasons,
 * in order of weight:
 *
 *   1. Every remediation this module prints ends in "run /doctor". `ctx.shutdown()` at
 *      `session_start` is the one response that makes that impossible. The deadman's containment
 *      leaves a read-only session in which `/doctor` still runs.
 *   2. The deadman is not quieter. It writes the reason to stderr, raises it once as a
 *      `ui.notify(..., "error")`, pins `GUARD OFF` in the status line for the whole session, writes
 *      a `trust.deadman` audit entry, and refuses every dangerous tool by name. A shutdown is one
 *      message and then silence. "Fail loud" is satisfied strictly better by the survivor.
 *   3. Containment is narrower than termination and provably sufficient here: the tools a missing
 *      guard would have protected are exactly the tools the deadman refuses.
 *
 * The deferral is conditional, never blanket. It applies only when the deadman actually armed for
 * every D-06 error raised — `trust` itself loaded, reached `session_start` (its heartbeat proves
 * `armDeadman` ran to completion), and its verdict names the same module the finding names. So:
 *
 *   - `guard` absent AND `trust` absent  -> nothing armed, D-06 shuts down. Correct: there is no
 *     containment at all, and nobody to run `/doctor` for.
 *   - `guard` loaded but `matchDangerous("rm -rf /")` no longer matches `DB-RM-ROOT` -> the deadman
 *     is disarmed by construction (the module loaded), so its findings name nothing, the deferral
 *     does not apply, and D-06 shuts down. Correct: a subverted-but-loaded guard is precisely the
 *     failure the deadman documents itself as unable to see.
 *
 * Returns the operator-facing line to print, or `undefined` when this module must still shut down.
 */
export function deadmanOwns(
  guardErrors: readonly Finding[],
  report = manifestReport(),
  trust = moduleStatus("trust"),
): string | undefined {
  if (guardErrors.length === 0) return undefined;
  if (trust.state !== "loaded" || !trust.heartbeat) return undefined;
  const verdict = evaluateDeadman(report);
  if (!verdict.armed) return undefined;
  const armedFor = new Set(verdict.findings.map((f) => f.id));
  if (!guardErrors.every((f) => armedFor.has(f.subject))) return undefined;
  return (
    `doctor: D-06 — ${[...armedFor].join(", ")} did not load. EXT-30's trust deadman owns the ` +
    `response to this condition and has already armed: ${DEADMAN_BLOCKED_TOOLS.join("/")} are ` +
    `blocked and the status line reads GUARD OFF. /doctor deliberately does NOT also shut the ` +
    `session down — a shutdown here would kill the session before you could run /doctor on it. ` +
    `Fix the load failure and restart.`
  );
}

export function register(pi: ExtensionAPI): void {
  // Never unsubscribed: the handshake, if it ever arrives (see module docstring), is
  // session-lifetime state, and this module has no `session_shutdown` teardown to run it from.
  pi.events.on("guard:ready", (data) => {
    const payload = data as { version?: unknown; gates?: unknown } | undefined;
    guardHandshake = {
      ...(typeof payload?.version === "string" ? { version: payload.version } : {}),
      ...(Array.isArray(payload?.gates) ? { gates: payload.gates.filter((g): g is string => typeof g === "string") } : {}),
    };
  });
  // `guard.ts` now answers `guard:whois` by re-emitting `guard:ready`, so the subscription above
  // is no longer dangling: ask, and the payload arrives synchronously regardless of composition
  // order. Still enrichment only — D-06's
  // verdict remains `lib/manifest.ts`'s load record plus the direct `matchDangerous` probe.
  pi.events.emit("guard:whois", {});

  pi.registerCommand("doctor", {
    description: "Validate that every name in the instruction text resolves, and that the guardrails loaded",
    async handler(args: string, ctx: ExtensionCommandContext) {
      let report: DoctorReport;
      try {
        report = await runChecks(pi, ctx);
      } catch (err) {
        // gatherInputs/runAllChecks are not supposed to throw (declared.ts absorbs ENOENT), so a
        // throw here is a real bug or a corrupt config file (declared.ts's JSON.parse failure) —
        // REQ-CTX-46: fail at dispatch loudly, never a silent empty report.
        const msg = `/doctor failed to run: ${describeError(err)}`;
        // One channel, whichever this run mode has: the TUI when there is one, stdout when there
        // is not (this is command output, so stdout is the right headless sink — see the `--json`
        // branch below). The extra stderr copy printed the failure twice in the TUI.
        emitNotice(ctx, `[pi-config] doctor: ${msg}`, "error", (line) => void process.stdout.write(`${line}\n`));
        return;
      }

      if (args.includes("--json")) {
        // verify.sh parses this. appendEntry keeps it out of the LLM context.
        pi.appendEntry("doctor.report", report);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }
      const table = boundedTable(report);
      // `ctx.ui.notify` is the established pattern for command output across this tree
      // (`quota`'s `/quota`, `session-context`'s `/ctx-dump`) — a no-op in `-p`/`--mode json`,
      // so the stdout write below is not a redundant belt-and-braces, it is the only
      // channel those modes have.
      if (ctx.hasUI) ctx.ui.notify(table, report.ok ? "info" : "warning");
      else process.stdout.write(`${table}\n`);
    },
  });

  // The warn pass: cheap subset, once per session, non-blocking — except D-06, which refuses the
  // session outright (REQ-CTX-46, REQ-EXT-16: a broken guardrail must never run silently).
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    let report: DoctorReport;
    try {
      report = await runChecks(pi, ctx, { cheapOnly: true });
    } catch (err) {
      const msg = `doctor's session_start warn pass failed: ${describeError(err)}`;
      // One channel, whichever this run mode has — see `lib/announce.ts`. The stderr copy that sat
      // outside `surfaceOnce` is gone with it, so this is deduped in headless runs too.
      surfaceOnce(ctx, "doctor:warn-pass-error", () => emitNotice(ctx, `[pi-config] doctor: ${msg}`, "error"));
      declareModule({ id, version: MODULE_VERSION, events: ["session_start"], apis: ["on", "registerCommand", "getAllTools", "appendEntry", "events.on"] });
      return;
    }

    const guardErrors = report.findings.filter((f) => f.check === "D-06" && f.severity === "error");

    for (const f of report.findings) {
      if (f.severity === "ok") continue;
      // One channel, whichever this run mode has — see `lib/announce.ts`. Writing both printed
      // every warn-pass finding twice in the TUI, once bare and once as `Warning: …`.
      emitNotice(ctx, `[pi-config] ${renderWarnLine(f)}`, f.severity === "error" ? "error" : "warning");
    }

    if (guardErrors.length > 0) {
      const deferral = deadmanOwns(guardErrors);
      if (deferral !== undefined) {
        // DEFERRAL, not a downgrade — see `deadmanOwns` for the whole argument. The finding was
        // already surfaced as an error in the loop above; this line says who is holding the
        // session instead of `ctx.shutdown()`.
        emitNotice(ctx, `[pi-config] ${deferral}`, "error");
      } else {
        const msg =
          "doctor: the guardrail is broken (D-06) — refusing to continue this session. " +
          "See the errors above, fix extensions/guard/patterns.ts, and restart.";
        emitNotice(ctx, `[pi-config] ${msg}`, "error");
        ctx.shutdown();
        return;
      }
    }

    declareModule({
      id,
      version: MODULE_VERSION,
      events: ["session_start"],
      apis: ["on", "registerCommand", "getAllTools", "appendEntry", "events.on"],
    });
  });
}

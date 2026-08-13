/**
 * `EXT-30` — scoped project trust, plus the guardrail deadman.
 *
 * Two jobs that look unrelated and are not:
 *
 * 1. **`project_trust`** answers `"yes"` only inside the roots declared in
 *    `config/trusted-roots.json`, and `"undecided"` everywhere else. `REQ-PRV-58` originally read
 *    "set `defaultProjectTrust: always`"; audit finding 29 rewrote it, because that setting trusts
 *    *every* directory PI is ever started in — including a freshly cloned third-party repo whose
 *    `.pi/extensions/` then runs with full system permissions and no sandbox. `"ask"` stays in
 *    `settings.json` (enforced by `PC-14`), headless runs pass `--approve` explicitly, and this
 *    handler narrows the automatic answer to declared ground. It never answers `"no"`: that would
 *    suppress PI's own prompt and turn a question into a silent refusal.
 *
 * 2. **The deadman** (`REQ-PRV-86`, `REQ-EXT-16` load half). A guardrail that failed to load is a
 *    fail-OPEN, and a *silent* fail-open is the worst outcome in this whole design. At
 *    `session_start` this module reads `lib/manifest.ts`'s expected-but-absent report and, if a
 *    guardrail module is absent or failed, says so on every surface available and blocks the
 *    dangerous tools outright.
 *
 * 3. **The MCP project-config gate.** `pi-mcp-adapter` reads a
 *    project's `.mcp.json` / `.pi/mcp.json` before PI's trust decision exists. This module installs
 *    the read gate that closes it — see `register()` — and reconciles it against
 *    `ctx.isProjectTrusted()` at `session_start`.
 *
 *    That gate does **not** answer from `config/trusted-roots.json`. Path trust answers "may PI run
 *    here without asking?"; MCP-config trust answers "may this directory name the processes this
 *    agent spawns with its full credential environment?". Wiring the first answer into the second
 *    made `git clone <hostile> ~/code/x && cd ~/code/x && pi` sufficient to spawn an
 *    eager stdio server holding every token in `process.env`, silently, with no `tool_call` for
 *    `guard.ts` to see. The gate now requires an explicit persisted approval of the project path
 *    AND the sha256 of its MCP config — see `extensions/lib/mcp-approvals.ts`.
 *
 * ## Why the deadman does not gate on `guard:ready`
 *
 * There is a `guard:whois` round trip: `pi.events` is a bare `EventBus`
 * (`core/event-bus.ts`, a plain `EventEmitter` with no replay buffer), `guard.register()` runs
 * before `trust.register()` in `index.ts`'s fixed order, so a one-shot `guard:ready` emit is always
 * missed unless someone asks. `guard.ts` now answers `guard:whois` by re-emitting `guard:ready`, so
 * the round trip completes — but the deadman still does not gate on it, and that is deliberate: a
 * handshake proves a module *ran*, and it is owned by `EXT-03`, which may change it. The pass/fail
 * signal stays `manifestReport()`'s load record, written unconditionally by `index.ts`'s
 * composition loop with no ordering dependency, exactly as `doctor.ts`'s D-06 resolved the same
 * race. The `guard:ready` subscription and the `guard:whois` probe are *enrichment only*: they
 * populate the status line with a version, and change no verdict.
 *
 * Also deliberately unused: `manifestReport().silent`. `guard.ts` registers no `session_start`
 * handler at all, so it never calls `recordHeartbeat` and is permanently "silent" — gating on that
 * would arm the deadman on every single session.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { declareModule, manifestReport, type ManifestReport } from "./lib/manifest.ts";
import {
  describeRefusal,
  evaluateProjectMcpConfig,
  normaliseProjectDir,
  type McpApprovalDecision,
} from "./lib/mcp-approvals.ts";
import { emitNotice } from "./lib/announce.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";
import { repoRoot } from "./lib/paths.ts";
import { setProjectConfigTrustGate } from "../pi-packages/pi-mcp-adapter/config.ts";

export const id = "trust";
export const MODULE_VERSION = "1.0.0";

/**
 * The modules whose absence is a fail-OPEN, i.e. the ones the deadman blocks tools over.
 *
 * The admission rule is narrow on purpose: a module belongs here only if its absence *removes a
 * safety property* from tools that still exist without it. Not "is useful", not "is security-
 * adjacent" — removes a denial that would otherwise have happened.
 *
 * `guard` (`EXT-03`) — the whole permission layer. Uncontested.
 *
 * `hooks` (`EXT-15`) — ADDED by the EXT-30 hand-off, reversing this module's original call. The
 * original argument was "hooks may only *add* denial, so its absence is a loss of policy, not of
 * containment". That is true and it is not the test. Two facts decide it:
 *   1. `hooks` is the only other module in the tree whose `tool_call` handler can *deny* a call
 *      that would otherwise proceed, over tools (`bash`/`write`/`edit`) that survive its absence.
 *      Everything else in `index.ts` fails the test: `bash.ts`'s only rule is a timeout
 *      (robustness); `dispatch`'s routing veto guards a tool that disappears with the module, so
 *      its absence is self-nullifying; `credentials`, `web`, `skills-env`, `skill-mask`,
 *      `big-results`, `input-transform`, `session-context` and the whole orchestration and
 *      observability tail add or shape capability rather than remove it, and a capability that
 *      fails to appear fails visibly at the call site.
 *   2. Its absence is *silent*. Every other way the hook layer ends up carrying zero rules
 *      announces itself: a broken `hooks.yaml` degrades with an `error`-level announcement and is
 *      reported by `/doctor` (`hooksDegradedReason()`), and a single dropped rule is named. A
 *      module that was never registered says nothing at all, so nothing but this deadman notices.
 * The operator's declared `hooks.yaml` denials silently ceasing to apply is exactly the silent
 * fail-open this deadman exists for.
 *
 * What this deliberately does NOT cover: a malformed `hooks.yaml` does not arm the deadman. The
 * module is loaded, it says loudly that it is carrying no rules, and `guard` (`EXT-03`) — the
 * actual hard floor — is untouched. Containing the whole session over an operator's YAML typo was
 * the older behaviour and was withdrawn 2026-08-11; see `docs/DENYLIST.md` §4a finding #5.
 *
 * `trust` itself is deliberately NOT here: a module cannot meaningfully assert its own presence,
 * and listing it would make the check pass by construction. `doctor.ts` reports a missing `trust`
 * and shuts the session down (see `deadmanOwns` there) — the two watch each other, neither watches
 * itself.
 */
export const GUARDRAIL_MODULES: readonly string[] = ["guard", "hooks"];

/**
 * What the deadman refuses once armed: `read`, `grep`, and the first four below.
 *
 * `read` and `grep` are additions, and they are not optional. When `guard` is absent,
 * `guard/gates/secret-paths.ts` is absent with it — and that gate exists primarily to stop a *read*
 * of `~/.aws/credentials`, `~/.ssh/id_ed25519`, `~/.pi/agent/auth.json` or
 * `~/.cache/pi/dbx-token-*`. A deadman that blocks `bash` but permits `read` blocks the noisy path
 * to a credential and leaves the quiet one open; the model can put every one of those files into
 * the transcript, and the transcript goes to a provider.
 *
 * `grep` is in for the same reason and one step less obviously: PI's `grep` tool returns *matching
 * lines*, not just file names (`core/tools/grep.js` — "Returns matching lines with file paths and
 * line numbers"), so `grep -e . ~/.ssh/id_ed25519` is a read by another name.
 *
 * PI's glob tool is `find` (`core/tools/find.js`) and it returns PATHS only — no file contents, no
 * matched lines. It is deliberately NOT here: the deadman's admission rule is loss of a denial over
 * content, and a directory listing is metadata. `ls` is out for the same reason. Both remain
 * covered by `secret-paths.ts` whenever `guard` IS loaded, which is the normal case.
 */
export const DEADMAN_BLOCKED_TOOLS: readonly string[] = [
  "bash",
  "write",
  "edit",
  "multiedit",
  "read",
  "grep",
];

const DEADMAN_MESSAGE =
  "GUARDRAILS NOT LOADED — a guardrail extension failed to register. " +
  `${DEADMAN_BLOCKED_TOOLS.join("/")} are blocked until it loads. Run /doctor.`;

// ---------------------------------------------------------------------------
// config/trusted-roots.json
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseTrustedRoots` when the file is structurally not a root list.
 *
 * No constructor parameter properties: Node's strip-only TypeScript loader — which is what
 * `node --test` uses on this tree — rejects them with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
 */
export class TrustConfigError extends Error {
  readonly source: string;

  constructor(message: string, source: string) {
    super(message);
    this.name = "TrustConfigError";
    this.source = source;
  }
}

export interface TrustedRoots {
  /** Expanded, realpath'd, safety-screened. Empty means "auto-trust nothing". */
  readonly roots: readonly string[];
  /** The entries exactly as written in the file, for the operator-facing report. */
  readonly declared: readonly string[];
  readonly source: string;
  /** True when the file was missing, unusable, or partly rejected. */
  readonly degraded: boolean;
  /** Set when something was wrong. `register()` prints it; nothing swallows it. */
  readonly problem?: string;
}

/** Candidate locations, first existing wins. Mirrors `guard/policy.ts`'s `policyPaths()`. */
export function trustedRootsPaths(): string[] {
  const candidates: string[] = [];
  const override = process.env.PI_TRUSTED_ROOTS;
  if (override) candidates.push(override);
  // `extensions/` is symlinked into `~/.pi/agent/extensions`, so `import.meta.url` points at the
  // symlink. realpath() is what gets us back to the repo the file actually lives in.
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    candidates.push(resolve(dirname(here), "..", "config", "trusted-roots.json"));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  candidates.push(resolve(repoRoot(), "config", "trusted-roots.json"));
  return candidates;
}

/**
 * `~` expansion + `realpath`, so a symlinked checkout cannot sit outside its own declared root.
 * A path that does not exist yet keeps its resolved-but-unreal form rather than being dropped:
 * `~/work` may legitimately be created later, and dropping it would silently shrink the root set.
 */
export function expandRoot(p: string): string {
  const expanded = p.startsWith("~") ? resolve(homedir(), p.slice(1).replace(/^\/+/, "")) : resolve(p);
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

/** Prefix match at a path-segment boundary — "/a/bc" is NOT under "/a/b". */
export function isUnder(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Roots that would re-create the `defaultProjectTrust: "always"` blanket that audit finding 29
 * rejected — `/`, `$HOME`, and anything that resolves to a filesystem root. Rejected per entry
 * and reported; the rest of the list still applies.
 */
function unsafeReason(expanded: string): string | undefined {
  if (expanded === sep || expanded === resolve(sep)) return "the filesystem root";
  if (expanded === expandRoot(homedir())) return "the home directory";
  if (expanded === "") return "an empty path";
  return undefined;
}

/**
 * Pure structural parse. Throws `TrustConfigError` when the document is not a root list at all;
 * returns per-entry complaints for the recoverable cases.
 */
export function parseTrustedRoots(
  parsed: unknown,
  source: string,
): { roots: string[]; declared: string[]; problems: string[] } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TrustConfigError(`${source} must be a JSON object`, source);
  }
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.roots)) {
    throw new TrustConfigError(`${source} must carry a "roots" array`, source);
  }

  const problems: string[] = [];
  const declared: string[] = [];
  const roots: string[] = [];
  for (const [index, entry] of raw.roots.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push(`roots[${index}] is not a non-empty string — ignored`);
      continue;
    }
    declared.push(entry);
    const expanded = expandRoot(entry.trim());
    const unsafe = unsafeReason(expanded);
    if (unsafe !== undefined) {
      // Rejecting the entry rather than throwing is deliberate: a throw here would take the whole
      // module down with it, and the deadman with the module. Never auto-trusting is the safe
      // direction; the operator hears about it on every surface at session_start.
      problems.push(
        `roots[${index}] "${entry}" resolves to ${unsafe} (${expanded}) — refused, ` +
          `that is defaultProjectTrust:"always" by another name (audit finding 29)`,
      );
      continue;
    }
    roots.push(expanded);
  }
  return { roots: [...new Set(roots)], declared, problems };
}

/** Synchronous by contract: `register()` must not start async work. */
export function loadTrustedRoots(explicitPath?: string): TrustedRoots {
  // An override that does not exist is an operator error, not a reason to quietly use the shipped
  // file: whoever set `PI_TRUSTED_ROOTS` meant to change the trusted set, and falling through
  // would widen it behind their back. `guard/policy.ts` falls through here; this does not.
  const override = explicitPath ?? process.env.PI_TRUSTED_ROOTS;
  if (override !== undefined && override !== "" && !existsSync(override)) {
    return {
      roots: [],
      declared: [],
      source: override,
      degraded: true,
      problem:
        `trusted-roots override ${override} does not exist. ` +
        `NOTHING is auto-trusted; PI's own trust prompt runs in every directory.`,
    };
  }

  const candidates = explicitPath ? [explicitPath] : trustedRootsPaths();
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    return {
      roots: [],
      declared: [],
      source: "<not found>",
      degraded: true,
      problem:
        `trusted-roots.json not found (looked in: ${candidates.join(", ")}). ` +
        `NOTHING is auto-trusted; PI's own trust prompt runs in every directory.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found, "utf8"));
  } catch (err) {
    return {
      roots: [],
      declared: [],
      source: found,
      degraded: true,
      problem:
        `trusted-roots ${found} is not valid JSON (${describeError(err)}). ` +
        `NOTHING is auto-trusted; PI's own trust prompt runs in every directory.`,
    };
  }

  let result: { roots: string[]; declared: string[]; problems: string[] };
  try {
    result = parseTrustedRoots(parsed, found);
  } catch (err) {
    // Not a swallow: the error text is carried verbatim into `problem`, which `register()` writes
    // to stderr and `session_start` raises as a UI error. The alternative — rethrowing — costs the
    // deadman, which is the one thing in this module that must survive a bad config.
    return {
      roots: [],
      declared: [],
      source: found,
      degraded: true,
      problem: `${describeError(err)}. NOTHING is auto-trusted; PI's own trust prompt runs in every directory.`,
    };
  }

  if (result.problems.length === 0) {
    return { roots: result.roots, declared: result.declared, source: found, degraded: false };
  }
  return {
    roots: result.roots,
    declared: result.declared,
    source: found,
    degraded: true,
    problem: `trusted-roots ${found}: ${result.problems.join("; ")}`,
  };
}

/**
 * The whole `project_trust` policy, as a pure function of cwd and the root list.
 *
 * `remember: false` on the YES path is not an oversight — never write a decision into
 * `~/.pi/agent/trust.json`. The repo is the source of truth, and a stale remembered "yes"
 * outlives the root list that justified it.
 */
export function decideTrust(cwd: string, roots: readonly string[]): ProjectTrustEventResult {
  const here = expandRoot(cwd);
  if (roots.some((root) => isUnder(here, root))) return { trusted: "yes", remember: false };
  return { trusted: "undecided" };
}

// ---------------------------------------------------------------------------
// the deadman
// ---------------------------------------------------------------------------

export type GuardrailState = "loaded" | "failed" | "absent";

export interface GuardrailFinding {
  readonly id: string;
  readonly state: GuardrailState;
  readonly detail: string;
}

export interface DeadmanVerdict {
  /** True when a guardrail module is not loaded and the dangerous tools must be blocked. */
  readonly armed: boolean;
  /** Guardrail modules that are not `loaded`. Empty when disarmed. */
  readonly findings: readonly GuardrailFinding[];
  /** The full expected-but-absent report — reported to the operator even when disarmed. */
  readonly absent: readonly string[];
  /** Every module whose `register()` threw, guardrail or not. */
  readonly failed: readonly string[];
  /** One line, ready for stderr / `ui.notify`. */
  readonly summary: string;
}

/**
 * `EXT-01`'s registry in, a verdict out. Pure, so `test/` and a future `/doctor` check can
 * evaluate the same rule without a live `pi`.
 */
export function evaluateDeadman(
  report: ManifestReport,
  guardrails: readonly string[] = GUARDRAIL_MODULES,
): DeadmanVerdict {
  const failedIds = report.failed.map(([moduleId]) => moduleId);
  const findings: GuardrailFinding[] = [];

  for (const moduleId of guardrails) {
    const failure = report.failed.find(([m]) => m === moduleId);
    if (failure !== undefined) {
      findings.push({ id: moduleId, state: "failed", detail: failure[1] });
      continue;
    }
    if (report.loaded.includes(moduleId)) continue;
    findings.push({
      id: moduleId,
      state: "absent",
      detail: "register() was never attempted — the module is declared but did not load",
    });
  }

  const armed = findings.length > 0;
  const summary = armed
    ? `${DEADMAN_MESSAGE} (${findings.map((f) => `${f.id}: ${f.state} — ${f.detail}`).join("; ")})`
    : `guardrails present: ${guardrails.join(", ")}`;

  return { armed, findings, absent: report.absent, failed: failedIds, summary };
}

/**
 * The blocking half. Registered only once the verdict is armed.
 *
 * `missing` names the guardrails that actually failed, not the whole `GUARDRAIL_MODULES` list —
 * with more than one guardrail, "a guardrail is missing" is not an actionable refusal. The model
 * reads this reason and so does the operator; both need the module name to do anything with it.
 */
export function deadmanToolBlock(
  event: ToolCallEvent,
  missing: readonly string[] = GUARDRAIL_MODULES,
): ToolCallEventResult | undefined {
  if (!DEADMAN_BLOCKED_TOOLS.includes(event.toolName)) return undefined;
  const names = missing.length > 0 ? missing : GUARDRAIL_MODULES;
  const subject =
    names.length === 1
      ? `the ${names[0]} extension is not loaded`
      : `the ${names.join("/")} extensions are not loaded`;
  return {
    block: true,
    reason:
      `${event.toolName} is disabled: ${subject} (trust deadman). ` +
      `Run /doctor, fix the load failure, and restart the session.`,
  };
}

/**
 * Arm first, announce second.
 *
 * The `pi.on("tool_call", ...)` registration is the FIRST statement and everything else is inside a
 * try/catch, because the ordering used to be the other way round and that was a fail-open in the
 * one component whose whole job is to fail closed. `ctx.ui.notify`, `ctx.ui.setStatus` and
 * `pi.appendEntry` are host APIs this module does not own; any of them can throw. PI catches a
 * throwing `session_start` handler and routes it to `emitError` (`core/extensions/runner.js`), so
 * the session CONTINUES — previously with `GUARD OFF` on screen, no `guard` module, and no deadman
 * listener, which is precisely the state the deadman exists to make survivable.
 *
 * The catch never rethrows: the block is already installed by then, and letting the throw escape
 * would skip the rest of `session_start` (the MCP reconciliation and `declareModule`) for no gain.
 */
function armDeadman(pi: ExtensionAPI, ctx: ExtensionContext, verdict: DeadmanVerdict): void {
  const missing = verdict.findings.map((f) => f.id);
  pi.on("tool_call", (event: ToolCallEvent) => deadmanToolBlock(event, missing));

  try {
    // One channel, whichever this run mode has — see `lib/announce.ts`. The stderr copy that used
    // to sit outside `surfaceOnce` is gone with it, so the deadman summary is now deduped in
    // headless runs too, not just in the TUI; `REQ-EXT-16` asks for exactly one surfacing and this
    // notice repeats verbatim across a reload/fork.
    surfaceOnce(ctx, "trust:deadman", () =>
      emitNotice(ctx, `[pi-config] trust: ${verdict.summary}`, "error"),
    );
    ctx.ui.setStatus("guard", "GUARD OFF");
    pi.appendEntry("trust.deadman", {
      at: Date.now(),
      findings: verdict.findings,
      absent: verdict.absent,
      failed: verdict.failed,
      blockedTools: DEADMAN_BLOCKED_TOOLS,
    });
  } catch (error) {
    try {
      process.stderr.write(
        `[pi-config] trust: deadman is ARMED (${DEADMAN_BLOCKED_TOOLS.join("/")} blocked) but ` +
          `reporting it failed: ${describeError(error)}\n`,
      );
    } catch {
      // stderr is gone too. Nothing left to report on, and nothing left that needs reporting:
      // the tool_call block above is registered and that is the property being protected.
    }
  }
}

// ---------------------------------------------------------------------------
// MCP project-config trust gate
// ---------------------------------------------------------------------------

/**
 * Projects whose MCP config this session has vetoed after the fact — populated only by
 * `reconcileMcpTrust` when PI turns out to be stricter than `config/trusted-roots.json`.
 * Session-scoped and deliberately not persisted: it is a containment reflex, not a policy edit.
 */
const mcpProjectVeto = new Set<string>();

/** The last refusal per project dir, so `session_start` can surface what the gate decided. */
const mcpRefusals = new Map<string, McpApprovalDecision>();

/** `${dir}\0${digest}` pairs already written to stderr — the gate is consulted many times a session. */
const mcpReported = new Set<string>();

/**
 * Exported for `test/` — all three collections are process-global session state, so tests must be
 * able to clear them.
 */
export function resetMcpProjectVeto(): void {
  mcpProjectVeto.clear();
  mcpRefusals.clear();
  mcpReported.clear();
}

/**
 * The gate itself: may the project rooted at `cwd` contribute MCP servers?
 *
 * It takes NO root list. `config/trusted-roots.json` decides whether PI may run in a directory
 * without asking; it says nothing about whether that directory may name the processes this agent
 * spawns. While the two were the same predicate, `git clone <hostile> ~/code/x && cd
 * ~/code/x && pi` was enough: `~/code` is a root, so the clone's `.pi/mcp.json` was
 * admitted on arrival, and a `"lifecycle": "eager"` stdio entry was spawned during MCP
 * initialization with the whole of `process.env` (`server-manager.ts`'s `resolveEnv`) — every
 * credential, in one `fetch`, with no `tool_call` for `guard.ts` to intercept and no prompt,
 * because `decideTrust` answered `{trusted: "yes", remember: false}` silently.
 *
 * The answer now comes from `extensions/lib/mcp-approvals.ts`: an explicit, persisted approval of
 * this exact directory at this exact config digest. Unknown project => deny. Changed config =>
 * deny. No project MCP file at all => allow, because there is nothing to read and refusing every
 * ordinary repo would teach the operator to scroll past the refusal that matters.
 *
 * Deny is DEFAULT and deny is FINAL for the session: eager servers spawn during initialization,
 * so there is no moment at which an interactive "approve?" could be answered before the child
 * process exists. The refusal is loud instead — stderr here, `ui.notify` at `session_start` — and
 * carries the command that grants the approval.
 */
export function mcpProjectConfigAllowed(cwd: string): boolean {
  return evaluateMcpGate(cwd).allowed;
}

interface McpGateResult {
  /** What the adapter is told: the session veto and the approval both have to say yes. */
  readonly allowed: boolean;
  readonly decision: McpApprovalDecision;
  readonly vetoed: boolean;
}

/** The same gate with its reasoning kept, for `session_start`, which needs more than a boolean. */
function evaluateMcpGate(cwd: string): McpGateResult {
  const dir = normaliseProjectDir(cwd);
  const vetoed = mcpProjectVeto.has(dir);

  const { decision, ledger } = evaluateProjectMcpConfig(dir);
  for (const problem of ledger.problems) {
    if (mcpReported.has(problem)) continue;
    mcpReported.add(problem);
    process.stderr.write(`[pi-config] trust: mcp-approvals ${problem}\n`);
  }

  if (decision.allowed) {
    mcpRefusals.delete(dir);
    return { allowed: !vetoed, decision, vetoed };
  }

  mcpRefusals.set(dir, decision);
  const key = `${dir} ${decision.digest.digest}`;
  if (!mcpReported.has(key)) {
    mcpReported.add(key);
    process.stderr.write(`[pi-config] ${describeRefusal(decision, repoRoot())}\n`);
  }
  return { allowed: false, decision, vetoed };
}

/**
 * PI's answer vs. ours, at the first moment both exist. Pure, so the wording is testable.
 *
 * Divergence is never "fine": one side read a project file the other would have refused, or the
 * operator is quietly missing the MCP servers they expect. Both directions are reported; only the
 * dangerous direction (we were more permissive than PI) is also *acted* on.
 */
export function mcpTrustDivergence(
  cwd: string,
  piTrusted: boolean,
  gateAllowed: boolean,
): { message: string; severity: "error" | "warning"; veto: boolean } | undefined {
  if (piTrusted === gateAllowed) return undefined;
  if (gateAllowed) {
    return {
      severity: "error",
      veto: true,
      message:
        `trust: MCP project-config gate was MORE permissive than PI for ${cwd} — ` +
        "this project's MCP config carries a recorded approval but PI does not trust the " +
        "directory, so .mcp.json / .pi/mcp.json may already have been read and any eager or " +
        "keep-alive server already spawned. Project MCP config is vetoed for the rest of this " +
        "session; audit the running servers with /mcp and revoke the approval in " +
        "~/.config/pi-config/mcp-approvals.jsonl if it is not wanted.",
    };
  }
  return {
    severity: "warning",
    veto: false,
    message:
      `trust: PI trusts ${cwd} but its MCP config is not approved, so .mcp.json / .pi/mcp.json ` +
      "were ignored and project-defined MCP servers are absent. Approve it with " +
      "config/bin/pi-mcp-approve if those servers are wanted.",
  };
}

function reconcileMcpTrust(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cwd = ctx.cwd;
  const gate = evaluateMcpGate(cwd);
  const gateAllowed = gate.allowed;

  // The refusal happened during the adapter's session_start, before any UI existed. This is the
  // first surface that can show it, and it is more specific than the divergence line below.
  const refusal = mcpRefusals.get(normaliseProjectDir(cwd));
  if (refusal !== undefined) {
    const message = describeRefusal(refusal, repoRoot());
    surfaceOnce(ctx, `trust:mcp-refused:${refusal.cwd}:${refusal.digest.digest}`, () =>
      ctx.ui.notify(message, "error"),
    );
    pi.appendEntry("trust.mcp_refused", {
      at: Date.now(),
      cwd: refusal.cwd,
      outcome: refusal.outcome,
      digest: refusal.digest.digest,
      files: refusal.digest.files,
      ...(refusal.approvedDigest !== undefined ? { approvedDigest: refusal.approvedDigest } : {}),
    });
  }

  // A project with no `.mcp.json` and no `.pi/mcp.json` cannot diverge: there was nothing for
  // either side to read, so PI's "don't trust this directory" and our "nothing to refuse" are not
  // in conflict. Reporting it would fire on every ordinary untrusted repo.
  if (gate.decision.outcome === "no-project-config") return;

  const divergence = mcpTrustDivergence(cwd, ctx.isProjectTrusted(), gateAllowed);
  if (divergence === undefined) return;
  // A refusal already said this, with the digest and the approval command. Saying it again in
  // vaguer words is alarm fatigue, not loudness. The dangerous direction still always reports.
  if (!divergence.veto && refusal !== undefined) return;
  if (divergence.veto) mcpProjectVeto.add(normaliseProjectDir(cwd));
  // One channel, whichever this run mode has — see `lib/announce.ts`. As with the deadman above,
  // the unconditional stderr copy is gone, so this is now deduped per `cwd` in headless runs too.
  surfaceOnce(ctx, `trust:mcp-divergence:${cwd}`, () =>
    emitNotice(ctx, `[pi-config] ${divergence.message}`, divergence.severity),
  );
  pi.appendEntry("trust.mcp_divergence", {
    at: Date.now(),
    cwd,
    piTrusted: ctx.isProjectTrusted(),
    gateAllowed,
    vetoed: divergence.veto,
  });
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

interface GuardHandshake {
  readonly version?: string;
  readonly gates?: readonly string[];
}

export function register(pi: ExtensionAPI): void {
  const config = loadTrustedRoots();
  if (config.problem !== undefined) {
    // Fail loud at load time; repeated at session_start where there is a UI to hear it.
    process.stderr.write(`[pi-config] trust: ${config.problem}\n`);
  }

  /** Enrichment only — see the module docstring. Never consulted by `evaluateDeadman`. */
  let handshake: GuardHandshake | undefined;
  pi.events.on("guard:ready", (data) => {
    const payload = data as { version?: unknown; gates?: unknown } | undefined;
    handshake = {
      ...(typeof payload?.version === "string" ? { version: payload.version } : {}),
      ...(Array.isArray(payload?.gates)
        ? { gates: payload.gates.filter((g): g is string => typeof g === "string") }
        : {}),
    };
  });
  // The `guard:whois` round trip now completes: `guard.ts` answers `guard:whois` by
  // re-emitting `guard:ready` with the same payload. `pi.events` has no replay buffer and `guard`
  // registers FIRST, so guard's own start-up emit is always missed here — asking is the only way
  // to see it. Still enrichment: `evaluateDeadman` reads the load registry, never this.
  pi.events.emit("guard:whois", {});

  pi.on("project_trust", (event: ProjectTrustEvent): ProjectTrustEventResult => {
    if (config.roots.length === 0) return { trusted: "undecided" };
    return decideTrust(event.cwd, config.roots);
  });

  // `pi-mcp-adapter` reads `<cwd>/.mcp.json` and `<cwd>/.pi/mcp.json`
  // regardless of PI's trust decision, and PI resolves `settings.packages` BEFORE
  // `settings.extensions`, so the adapter's `session_start` runs before ours — an untrusted repo
  // gets to name the MCP servers this agent talks to, and `lifecycle: "eager" | "keep-alive"`
  // servers are spawned during initialization, before any `tool_call` a gate could intercept. The
  // read is the boundary, so the gate goes at the read. There is no PI hook and no adapter setting
  // that reaches it (`overridePath` swaps only the *global* source), so this is a LOCAL PATCH to
  // the vendored package — `pi-packages/pi-mcp-adapter/config.ts`, three hunks in
  // `getConfigSources`, recorded in `pi-packages/vendor.lock.json` and re-applied on every upgrade.
  // The patched default is DENY, so the window between the package loading and this line is closed
  // too. The predicate is deliberately NOT `decideTrust` — see `mcpProjectConfigAllowed`.
  setProjectConfigTrustGate(
    (cwd) => mcpProjectConfigAllowed(cwd),
    (message) => process.stderr.write(`[pi-config] ${message}\n`),
  );

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const verdict = evaluateDeadman(manifestReport());

    if (verdict.armed) {
      armDeadman(pi, ctx, verdict);
    } else {
      ctx.ui.setStatus("guard", handshake?.version !== undefined ? `guard ${handshake.version}` : "guard on");
    }

    if (config.problem !== undefined) {
      surfaceOnce(ctx, "trust:config-problem", () =>
        ctx.ui.notify(`trust: ${config.problem}`, config.degraded ? "error" : "warning"),
      );
    }

    // First moment PI's own answer is readable. The gate had to decide before this.
    reconcileMcpTrust(pi, ctx);

    pi.appendEntry("trust.session", {
      at: Date.now(),
      source: config.source,
      declaredRoots: config.declared,
      resolvedRoots: config.roots,
      degraded: config.degraded,
      deadmanArmed: verdict.armed,
      guardrails: GUARDRAIL_MODULES,
      mcpProjectConfigAllowed: mcpProjectConfigAllowed(ctx.cwd),
    });

    declareModule({
      id,
      version: MODULE_VERSION,
      events: ["project_trust", "session_start", ...(verdict.armed ? ["tool_call"] : [])],
      apis: ["on", "appendEntry", "events.on", "events.emit"],
    });
  });
}

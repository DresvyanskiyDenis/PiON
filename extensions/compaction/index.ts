/**
 * EXT-11 — the compaction suite (`REQ-CTX-31`, `-32`, `-35`, `-37`).
 *
 * Five parts, in the order they matter:
 *
 * 1. **The loop guard** (`REQ-CTX-35`, MUST). N consecutive non-reducing automatic compaction
 *    passes abort the run with a typed error. `./loop-guard.ts` holds the whole decision.
 * 2. **The keep/drop contract** (`REQ-CTX-32`, MUST) — reaches PI's summariser as
 *    `customInstructions`, *appended* to PI's structured template, never replacing it.
 * 3. **Pinned-block regeneration** (`REQ-CTX-37`) — see `./pinned.ts` for why regeneration is the
 *    only honest reading of "pin a region".
 * 4. **Threshold reporting** (`REQ-CTX-31`) — PI has no absolute-count key; the effective trigger
 *    is `contextWindow - reserveTokens`, which is per-model. `./threshold.ts` computes it for the
 *    active model, classifies the gap, and says so **once ever** per (model, window, reserve,
 *    absolute) tuple rather than once per session. Read that module's header for why the only
 *    honest lever is `models.json` `modelOverrides.<id>.contextWindow` and why the previously
 *    recommended global `compaction.reserveTokens` would have tripped the loop guard above.
 * 5. **The route** (`./route.ts`) — which endpoint the summary call goes to. Compaction is the one
 *    call that has to succeed while the lead's own provider is refusing, so it no longer borrows
 *    `ctx.model`: `config/routing.json`'s `compaction.route` names an ordered list of candidates,
 *    and a failure the route is configured to survive moves to the next one. Read that module's
 *    header for why this is not the provider failover the working path forbids.
 *
 * ---------------------------------------------------------------------------------------------
 * **V-08, answered against the shipped code of pi 0.84.0 rather than the docs.** The runbook asked
 * whether an extension can abort a session in print mode. Both documented candidates fail, and the
 * second fails for a reason the runbook did not anticipate:
 *
 * - `ctx.shutdown()` → `dist/core/agent-session.js` `shutdown: () => this._extensionShutdownHandler?.()`.
 *   Print mode's `bindExtensions()` call (`dist/modes/print-mode.js`) passes `mode`,
 *   `commandContextActions` and `onError` — **no `shutdownHandler`** — so the call is a no-op in
 *   `-p` and `--mode json`. Interactive mode does bind one.
 * - `ctx.abort()` → falls through to `AgentSession.abort()` → `agent.abort()` →
 *   `this.activeRun?.abortController.abort()`. `session_before_compact` is emitted from
 *   `_runAutoCompaction()`, which is called by `_handlePostAgentRun()` — i.e. *between*
 *   `agent.prompt()` and `agent.continue()` in `_runAgentPrompt()`'s `while` loop. `finishRun()`
 *   has already cleared `activeRun` by then, so on the automatic paths **`ctx.abort()` is a no-op
 *   in every mode**, not only headless.
 *
 * What does work, and is what this module uses:
 *
 * - `{ cancel: true }` genuinely stops the loop everywhere: `_runAutoCompaction()` returns false,
 *   `_checkCompaction()` returns false, `_handlePostAgentRun()` returns false and the `while` loop
 *   ends. That is mode-independent and is always applied.
 * - The **exit code** is not covered by `cancel` alone. `runPrintMode()` only sets `exitCode = 1`
 *   when the last assistant message has `stopReason` `"error"`/`"aborted"`, which a cancelled
 *   threshold compaction does not produce — the run would exit **0** with output, which
 *   `REQ-CTX-35` forbids. In `print`/`json` mode this module therefore writes the typed entry and
 *   the stderr block and then calls `process.exit(headlessExitCode)` — after `pi.appendEntry()`,
 *   which is a synchronous `appendFileSync` to the session JSONL, and after a synchronous
 *   `writeSync(2, …)`, so nothing is lost to the exit. Set `headlessExitCode: 0` in
 *   `config/compaction.json` to keep the cancel and drop the exit.
 * - In `tui`/`rpc` the session is **not** killed. Cancel plus a loud, typed report leaves the user
 *   in control of their own scrollback; the guard stays tripped, so every later pass is cancelled
 *   too and the session cannot quietly resume looping.
 *
 * A wrapper sentinel is written in every mode at
 * `<stateRoot>/compaction-loop/<sessionId>.json`, so `bin/pi-run` can turn a `--mode json` run
 * (whose exit code PI leaves at 0 by design) into a non-zero exit without parsing prose.
 * ---------------------------------------------------------------------------------------------
 *
 * Auto-discovered through the `extensions/<dir>/index.ts` subdirectory pattern, like
 * `extensions/tasks/` and `extensions/big-results/` — `settings.json`'s `"extensions"` array needs
 * no entry.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeProviderRequestEvent,
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { compact, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configPaths as sharedConfigPaths } from "../dispatch/config.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { CONFIG_DIR_NAME, configDir, repoRoot, stateRoot } from "../lib/paths.ts";
import {
  buildProviderFailure,
  surfaceProviderFailure,
  type ProviderErrorClass,
  type ProviderFailure,
} from "../lib/provider-error.ts";
import { readRoutingFile } from "../lib/routing-file.ts";
import { mergeInstructions } from "./instructions.ts";
import {
  DEFAULT_COMPACTION_ROUTE,
  describeTarget,
  parseCompactionRoute,
  resolveCompactionRoute,
  walkRoute,
  type CompactionRouteSettings,
  type RouteAttemptOutcome,
  type RouteTarget,
} from "./route.ts";
import {
  CompactionLoopError,
  createLoopGuardState,
  DEFAULT_LOOP_GUARD,
  formatLoopFailure,
  observePass,
  type CompactionReason,
  type LoopGuardConfig,
  type LoopGuardState,
} from "./loop-guard.ts";
import {
  appendFact,
  DEFAULT_FACTS_LIMITS,
  DEFAULT_FACTS_WARN_RATIO,
  factsPathFor,
  nearingCapLine,
  readFacts,
  renderFacts,
  type FactsLimits,
} from "./facts.ts";
import {
  DEFAULT_PINNED_LIMITS,
  readPinned,
  renderPinned,
  resolvePinnedSources,
  type PinnedLimits,
} from "./pinned.ts";
import {
  absoluteTokensForWindow,
  declaredContextWindows,
  findContextWindow,
  formatThresholdLine,
  formatThresholdNotice,
  readReserveTokens,
  thresholdKey,
  thresholdReport,
  UNIVERSAL_ABSOLUTE_TOKENS,
  type DeclaredWindow,
  type ReserveTokens,
  type ThresholdReport,
} from "./threshold.ts";
import {
  estimatePromptTokens,
  MAX_CONSECUTIVE_REFUSALS,
  passedAnywayLine,
  type PreflightFacts,
  preflightVerdict,
  refusalLine,
  selfResumeLine,
} from "./preflight.ts";
import { formatCtxGaugeStatus, type GaugePreflightEstimate } from "./gauge.ts";

// Re-exported so `REQ-CTX-31`'s arithmetic keeps one public entry point for callers and tests.
export { thresholdReport, type ThresholdReport };

export const id = "compaction";

/**
 * PI 0.84.0 exports `SessionBeforeCompactEvent` from its package root but **not** the matching
 * result type — the same re-export gap `EXT-29` hit with `ToolResultEventResult` (both live in
 * `core/extensions/index.d.ts` and are dropped from `dist/index.d.ts`). Declared structurally
 * here rather than deep-importing past the package boundary; `CompactionResult` itself *is*
 * exported, so only the two-field wrapper is restated.
 */
type BeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

/* ---------------------------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------------------------- */

interface CompactionConfig {
  readonly loopGuard: LoopGuardConfig & { readonly headlessExitCode: number };
  readonly instructions: { readonly enabled: boolean };
  readonly pinned: PinnedLimits & {
    readonly enabled: boolean;
    readonly sources: readonly string[];
    /**
     * The session facts file (`./facts.ts`). A sibling of `sources` because it is re-stated on the
     * same event under the same doctrine — the difference is that its content is written during
     * the session rather than read from the repo.
     */
    readonly facts: FactsLimits & { readonly enabled: boolean; readonly warnRatio: number };
  };
  /**
   * `REQ-CTX-31`'s absolute count. PI cannot act on it (`shouldCompact()` only knows
   * `contextWindow - reserveTokens`), so it is a *stated intent* this module checks the effective
   * per-model trigger against. `absoluteTokens: 0` disables the check.
   */
  readonly threshold: { readonly absoluteTokens: number; readonly toleranceRatio: number };
}

const DEFAULT_CONFIG: CompactionConfig = {
  loopGuard: { ...DEFAULT_LOOP_GUARD, headlessExitCode: 91 },
  instructions: { enabled: true },
  pinned: {
    ...DEFAULT_PINNED_LIMITS,
    enabled: true,
    sources: ["AGENTS.md", "CLAUDE.md"],
    facts: { ...DEFAULT_FACTS_LIMITS, enabled: true, warnRatio: DEFAULT_FACTS_WARN_RATIO },
  },
  threshold: { absoluteTokens: 0, toleranceRatio: 0.2 },
};

/** Candidate locations for `config/compaction.json`, first existing wins. Mirrors `tasks/index.ts`. */
function configPaths(): string[] {
  const candidates: string[] = [];
  // `extensions/` is symlinked into `~/.pi/agent/extensions`, so `import.meta.url` points at the
  // symlink. realpath() is what gets us back to the repo the file actually lives in.
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    candidates.push(resolve(dirname(here), "..", "..", "config", "compaction.json"));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  candidates.push(resolve(repoRoot(), "config", "compaction.json"));
  return candidates;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseConfig(raw: unknown): CompactionConfig {
  const root = (raw as { compaction?: Record<string, unknown> } | null)?.compaction ?? {};
  const lg = (root.loopGuard ?? {}) as Record<string, unknown>;
  const ins = (root.instructions ?? {}) as Record<string, unknown>;
  const pin = (root.pinned ?? {}) as Record<string, unknown>;
  const facts = (pin.facts ?? {}) as Record<string, unknown>;
  const thr = (root.threshold ?? {}) as Record<string, unknown>;
  return {
    loopGuard: {
      maxNonReducingPasses: Math.max(
        1,
        Math.trunc(num(lg.maxNonReducingPasses, DEFAULT_CONFIG.loopGuard.maxNonReducingPasses)),
      ),
      minReductionRatio: num(lg.minReductionRatio, DEFAULT_CONFIG.loopGuard.minReductionRatio),
      minEntriesBetweenPasses: Math.trunc(
        num(lg.minEntriesBetweenPasses, DEFAULT_CONFIG.loopGuard.minEntriesBetweenPasses),
      ),
      headlessExitCode: Math.trunc(num(lg.headlessExitCode, DEFAULT_CONFIG.loopGuard.headlessExitCode)),
    },
    instructions: { enabled: bool(ins.enabled, DEFAULT_CONFIG.instructions.enabled) },
    pinned: {
      enabled: bool(pin.enabled, DEFAULT_CONFIG.pinned.enabled),
      sources: Array.isArray(pin.sources)
        ? pin.sources.filter((s): s is string => typeof s === "string")
        : DEFAULT_CONFIG.pinned.sources,
      maxBytesPerSource: num(pin.maxBytesPerSource, DEFAULT_CONFIG.pinned.maxBytesPerSource),
      maxTotalBytes: num(pin.maxTotalBytes, DEFAULT_CONFIG.pinned.maxTotalBytes),
      // Absent key means defaults, and the defaults are what a tree that never records a fact
      // already does: no file, no block, nothing re-stated. Backwards compatibility is the
      // absence of the file, not the absence of the key.
      facts: {
        enabled: bool(facts.enabled, DEFAULT_CONFIG.pinned.facts.enabled),
        maxEntries: Math.max(0, Math.trunc(num(facts.maxEntries, DEFAULT_CONFIG.pinned.facts.maxEntries))),
        maxBytes: Math.max(0, Math.trunc(num(facts.maxBytes, DEFAULT_CONFIG.pinned.facts.maxBytes))),
        // Clamped rather than rejected, and both ends stay usable: 0 states usage on every reply,
        // 1 states it only once a cap is actually reached.
        warnRatio: Math.min(1, Math.max(0, num(facts.warnRatio, DEFAULT_CONFIG.pinned.facts.warnRatio))),
      },
    },
    threshold: {
      absoluteTokens: Math.trunc(num(thr.absoluteTokens, DEFAULT_CONFIG.threshold.absoluteTokens)),
      toleranceRatio: num(thr.toleranceRatio, DEFAULT_CONFIG.threshold.toleranceRatio),
    },
  };
}

/**
 * Synchronous by contract: `register()` must not start async work.
 *
 * The path is returned alongside the values because `/autocompact` writes back into this file, and
 * a writer that re-resolves the path independently is a writer that can edit a different file from
 * the one the running session read.
 */
function loadConfig(): { readonly config: CompactionConfig; readonly source: string | undefined } {
  const found = configPaths().find((p) => existsSync(p));
  if (found === undefined) return { config: DEFAULT_CONFIG, source: undefined };
  try {
    return { config: parseConfig(JSON.parse(readFileSync(found, "utf8"))), source: found };
  } catch (err) {
    process.stderr.write(
      `[pi-config] compaction: ${found} is not valid JSON (${describeError(err)}); using built-in defaults\n`,
    );
    return { config: DEFAULT_CONFIG, source: found };
  }
}

const loaded = loadConfig();
const cfg = loaded.config;

/* ---------------------------------------------------------------------------------------------
 * The compaction route — `config/routing.json` -> `compaction`
 * ------------------------------------------------------------------------------------------- */

/** Ours alone. Every extension that writes a status cell owns its own key. */
const ROUTE_STATUS_KEY = "compaction";

/** The `ctx` threshold gauge's own extension-status cell, next to `ROUTE_STATUS_KEY`. */
const GAUGE_STATUS_KEY = "ctx-gauge";

interface LoadedRoute {
  readonly settings: CompactionRouteSettings;
  readonly targets: readonly RouteTarget[];
  readonly source: string;
  readonly problems: readonly string[];
}

/**
 * Read once, at module load, for the same reason `loadConfig` is: `register()` must not start async
 * work, and a route that changed under a running session would let two compactions in one session
 * disagree about where they went.
 *
 * Never throws. A route that cannot be read degrades to the session's own model, and
 * {@link announceRoute} states that at every session start rather than once in a log nobody reads.
 */
function loadCompactionRoute(): LoadedRoute {
  try {
    const routing = readRoutingFile();
    const parsed = parseCompactionRoute(routing.raw);
    const resolved = resolveCompactionRoute(routing, parsed.settings);
    return {
      settings: parsed.settings,
      targets: resolved.targets,
      source: routing.source,
      problems: [...(routing.problem ? [routing.problem] : []), ...parsed.problems, ...resolved.problems],
    };
  } catch (err) {
    return {
      settings: DEFAULT_COMPACTION_ROUTE,
      targets: [],
      source: "<unreadable>",
      problems: [`the compaction route could not be read: ${describeError(err)}`],
    };
  }
}

const compactionRoute = loadCompactionRoute();

/**
 * States the route at every session start, and each complaint about it exactly once.
 *
 * Printed rather than kept quiet because the route is an **egress statement**: compaction ships the
 * whole conversation to whatever is named here, and a destination that is not the one the operator
 * is talking to must never be something they discover afterwards.
 */
function announceRoute(ctx: ExtensionContext): void {
  for (const problem of compactionRoute.problems) {
    surfaceOnce(ctx, `compaction:route:${problem}`, () => announce(ctx, problem, "warning"));
  }
  if (compactionRoute.targets.length === 0) {
    announce(
      ctx,
      `compaction route: nothing resolved from ${compactionRoute.source}, so compaction runs on the ` +
        `session's own model and a provider failure that stops the lead also stops the shrinking`,
      "warning",
    );
    return;
  }
  announce(ctx, `compaction route: ${compactionRoute.targets.map(describeTarget).join(" -> ")}`, "info");
}

/**
 * The threshold `REQ-CTX-31` is currently checked against.
 *
 * Separate from `cfg` — which is frozen at module load — because `/autocompact` changes it inside a
 * running session and `/compaction-status` must then report the new number rather than the one
 * this process happened to start with. The file is still the source of truth across sessions; this
 * is only what keeps the current session honest about what it just wrote.
 */
let activeThreshold: CompactionConfig["threshold"] = cfg.threshold;

/**
 * The universal threshold, applied at every session start so the operator never has to run
 * `/autocompact` to get it.
 *
 * Writes only when the file does not already say 200 000. That guard is the whole reason this is
 * tolerable at all: `config/compaction.json` is a tracked file, and a session start that rewrote
 * it unconditionally would put a spurious diff in front of every `git status` and re-touch the
 * file on every `/new`. `FIX-AUTOCOMPACT-RESERVE`'s open question named exactly this trade-off
 * and declined to pick it; the operator has now picked it, and the write-only-on-change guard is
 * what keeps the cost to the one start after the number actually moves.
 *
 * The line is printed every session either way, because it states what the session will do, not
 * what this function just did.
 */
function applyUniversalThreshold(ctx: ExtensionContext): void {
  const path = loaded.source;
  if (activeThreshold.absoluteTokens !== UNIVERSAL_ABSOLUTE_TOKENS) {
    if (path === undefined) {
      // No file to persist into: this session runs on the built-in defaults, so the number is
      // held in memory and the next session starts from the same place. Said, not hidden.
      activeThreshold = { ...activeThreshold, absoluteTokens: UNIVERSAL_ABSOLUTE_TOKENS };
      announce(
        ctx,
        `auto-compact: ${formatUniversal()} tokens (in this session only: no config/compaction.json ` +
          `exists to write to, looked in ${configPaths().join(", ")})`,
        "warning",
      );
      return;
    }
    writeAbsoluteTokens(path, UNIVERSAL_ABSOLUTE_TOKENS);
    activeThreshold = { ...activeThreshold, absoluteTokens: UNIVERSAL_ABSOLUTE_TOKENS };
  }
  announce(ctx, `auto-compact: ${formatUniversal()} tokens`, "info");
}

/** `200000` as the operator says it. Kept next to the constant so the two cannot drift apart. */
function formatUniversal(): string {
  return `${UNIVERSAL_ABSOLUTE_TOKENS / 1000}K`;
}

/* ---------------------------------------------------------------------------------------------
 * `/autocompact` — set the declared threshold: the universal 200 000, or one model's own trigger
 * ------------------------------------------------------------------------------------------- */

/** Test seam, mirroring `cost-gate`'s: the same `PI_CONFIG_MODELS_JSON` override. */
function readModelsJson(): { readonly raw: unknown; readonly source: string } {
  const override = process.env.PI_CONFIG_MODELS_JSON;
  const found = sharedConfigPaths("models.json", override).find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(
      `no config/models.json found (looked in ${sharedConfigPaths("models.json", override).join(", ")})`,
    );
  }
  try {
    return { raw: JSON.parse(readFileSync(found, "utf8")), source: found };
  } catch (err) {
    throw new Error(`${found} is not valid JSON: ${describeError(err)}`, { cause: err });
  }
}

function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * The parsed `compaction.json` with `threshold.absoluteTokens` replaced and **nothing else**
 * touched — every other key, including the ones this module never reads, is carried through by
 * identity.
 *
 * Written as a pure transform over the raw JSON rather than as a re-serialisation of
 * {@link CompactionConfig} on purpose: `parseConfig` fills in defaults for everything absent, so
 * round-tripping through it would silently materialise this build's defaults into the operator's
 * file as if they had been chosen. A config writer must only ever write what it was asked to.
 */
export function withAbsoluteTokens(raw: unknown, absoluteTokens: number): Record<string, unknown> {
  const root = plainObject(raw);
  const compaction = plainObject(root.compaction);
  const threshold = plainObject(compaction.threshold);
  threshold.absoluteTokens = absoluteTokens;
  compaction.threshold = threshold;
  root.compaction = compaction;
  return root;
}

/**
 * The same edit as {@link withAbsoluteTokens}, but performed on the file's *text* so that its
 * formatting survives.
 *
 * `JSON.stringify(_, null, 2)` is a re-formatter, not a round-trip: on the shipped
 * `config/compaction.json` it explodes `"sources": ["AGENTS.md", "CLAUDE.md"]` across three lines
 * and rewrites 14 lines to change one number. That is real damage to a tracked file — every future
 * `git blame` on those lines points at a command that only ever meant to set an integer.
 *
 * So the number is patched in place when the key is there exactly once, and the result is parsed
 * back and checked before it is offered: a regex that matched something unexpected returns
 * `undefined` and the caller falls back to re-serialising, which is uglier but always correct.
 */
export function replaceAbsoluteTokensText(text: string, absoluteTokens: number): string | undefined {
  const key = /"absoluteTokens"(\s*):(\s*)(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;
  const hits = [...text.matchAll(key)];
  if (hits.length !== 1) return undefined;

  const patched = text.replace(key, (_m, before: string, after: string) =>
    `"absoluteTokens"${before}:${after}${absoluteTokens}`,
  );
  try {
    const parsed = JSON.parse(patched) as { compaction?: { threshold?: { absoluteTokens?: unknown } } };
    return parsed.compaction?.threshold?.absoluteTokens === absoluteTokens ? patched : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrites one number in `path`, atomically and without changing the file's mode.
 *
 * temp+rename so a reader — this extension in another session, `bin/pi-check`, a test — never sees
 * a half-written config; the mode is carried across because `config/compaction.json` is a tracked
 * file and a permission change would show up as a spurious diff on a command whose whole job is to
 * change a single integer.
 */
export function writeAbsoluteTokens(path: string, absoluteTokens: number): void {
  const text = readFileSync(path, "utf8");
  const patched =
    replaceAbsoluteTokensText(text, absoluteTokens) ??
    `${JSON.stringify(withAbsoluteTokens(JSON.parse(text), absoluteTokens), null, 2)}\n`;
  const mode = statSync(path).mode & 0o777;
  const tmp = `${path}.autocompact.${process.pid}`;
  writeFileSync(tmp, patched, { mode });
  renameSync(tmp, path);
}

interface WindowResolution {
  readonly contextWindow: number;
  readonly model: string;
  /** Where the number came from, so the report can never present one source as another. */
  readonly source: string;
}

/**
 * The window `/autocompact <model-id>` will write from.
 *
 * `models.json` is authoritative and is now the only source. Before the universal threshold this
 * function also served the no-argument form, which needed a live-session fallback for a model
 * served from PI's built-in catalogue with no override of ours; the no-argument form reads no
 * window at all any more, so the fallback went with it. An explicitly named model never had one:
 * there is no live window for a model that is not running, so an undeclared one is refused rather
 * than guessed.
 */
function resolveTargetWindow(ctx: ExtensionContext, requested: string): WindowResolution {
  const models = readModelsJson();
  const declared: readonly DeclaredWindow[] = declaredContextWindows(models.raw);
  const lookup = findContextWindow(declared, requested, ctx.model?.provider);
  if (!lookup.ok) throw new Error(lookup.reason);
  return {
    contextWindow: lookup.window.contextWindow,
    model: requested,
    source: `${lookup.window.provider} ${lookup.window.declaredIn} in ${models.source}`,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Per-session state
 * ------------------------------------------------------------------------------------------- */

const guards = new Map<string, LoopGuardState>();

/**
 * Consecutive over-window refusals per session (`./preflight.ts`). Cleared by the first request
 * that fits, which is what makes the count a streak rather than a session total.
 */
const preflightRefusals = new Map<string, number>();

/**
 * A refusal waiting to be turned into a turn, per session.
 *
 * Written by the `before_provider_request` refusal, consumed by the `agent_settled` handler that
 * sends the resume. One slot per session and not a queue: a refusal aborts the run, so a run
 * produces at most one, and a stale entry that somehow survived its run must not resurrect a turn
 * later — the consumer deletes before it sends.
 */
const preflightResumes = new Map<string, { readonly facts: PreflightFacts; readonly refusals: number }>();

/**
 * What the credential preflight last found, per session: which route candidates had no usable
 * credential, when the check ran, and whether one is running right now.
 *
 * `dead` is what makes the check a report rather than a nag — a candidate is announced when it
 * *changes* state, not on every pass. `running` locks nothing shared: it only keeps two idle
 * re-checks from resolving the same credentials at once, which against an OAuth helper means two
 * token refreshes racing each other.
 */
interface CredentialPreflightState {
  dead: Set<string>;
  checkedAt: number;
  running: boolean;
}
const credentialPreflights = new Map<string, CredentialPreflightState>();

function sid(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionId() ?? "unknown-session";
}

function guardFor(session: string): LoopGuardState {
  let state = guards.get(session);
  if (!state) {
    state = createLoopGuardState();
    guards.set(session, state);
  }
  return state;
}

/** Test-only: drop all module state so each test starts from a clean registry. */
export function __resetForTests(): void {
  guards.clear();
  preflightRefusals.clear();
  preflightResumes.clear();
  credentialPreflights.clear();
}

function announce(ctx: ExtensionContext | undefined, line: string, level: "info" | "warning" | "error" = "warning"): void {
  // One channel, whichever this run mode has: `ctx.ui.notify` in the TUI, stderr in `-p`/
  // `--mode json` where notify is a no-op. Writing both, as this function
  // used to, printed every announcement twice in the TUI — see `lib/announce.ts`.
  emitNotice(ctx, `[pi-config] compaction: ${line}`, level);
}

/* ---------------------------------------------------------------------------------------------
 * Measurement — everything the guard needs, read off the event
 * ------------------------------------------------------------------------------------------- */

/**
 * Entries appended since the previous compaction entry on this branch, or -1 when there is none.
 *
 * -1 is load-bearing: the first compaction of a session cannot be evidence of a loop, and the
 * guard treats the signal as unavailable rather than as zero.
 */
export function entriesSinceLastCompaction(branchEntries: readonly SessionEntry[]): number {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === "compaction") return branchEntries.length - 1 - i;
  }
  return -1;
}

function droppedTokens(event: SessionBeforeCompactEvent): number {
  const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
  return total;
}

/* ---------------------------------------------------------------------------------------------
 * The abort path
 * ------------------------------------------------------------------------------------------- */

function sentinelPath(session: string): string {
  return join(stateRoot(), "compaction-loop", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/**
 * Writes the wrapper sentinel. Best effort by design: a state root that cannot be written must
 * not turn "the guard tripped" into "the guard crashed", but the failure is still announced.
 */
function writeSentinel(ctx: ExtensionContext, err: CompactionLoopError): string | null {
  const path = sentinelPath(err.details.sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({ error: err.name, code: err.code, message: err.message, ...err.details, at: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return path;
  } catch (writeErr) {
    announce(ctx, `could not write the loop sentinel ${path}: ${describeError(writeErr)}`, "error");
    return null;
  }
}

function abortOnLoop(pi: ExtensionAPI, ctx: ExtensionContext, err: CompactionLoopError): void {
  // 1. The typed record, in the session itself. `appendEntry` is a synchronous appendFileSync,
  //    so it is on disk before any exit below.
  try {
    pi.appendEntry("pi-config.compaction-loop", {
      error: err.name,
      code: err.code,
      message: err.message,
      ...err.details,
    });
  } catch (entryErr) {
    announce(ctx, `could not append the typed loop entry: ${describeError(entryErr)}`, "error");
  }

  // 2. The loud block — but only on the channel this run mode actually has (one channel, never
  //    both — see `lib/announce.ts`). `ctx.hasUI` is false exactly for `-p`/`--mode json`
  //    (`headless`, below), which is precisely the case that needs the raw fd write: those modes
  //    call `process.exit()` right after this function returns, and `writeSync`, not
  //    `process.stderr.write`, is what survives that — on a pipe the async path can still be
  //    buffered when `process.exit()` runs, and losing this block is losing the whole report.
  //    `tui`/`rpc` never exit here, so the block would otherwise print twice: once as a raw line
  //    interleaved with the TUI's own repaint, once as the rendered `ctx.ui.notify` entry below.
  const block = `${formatLoopFailure(err)}\n`;
  if (!ctx.hasUI) {
    try {
      writeSync(2, block);
    } catch {
      process.stderr.write(block);
    }
  }

  // 3. The wrapper's signal.
  const sentinel = writeSentinel(ctx, err);

  try {
    // The full block, not just `err.message`: `tui`/`rpc` never get the raw stderr write above,
    // so this is the only copy of the diagnostic the interactive user sees — a multi-line
    // `ctx.ui.notify` is an established pattern in this module (see the threshold report below).
    if (ctx.hasUI) ctx.ui.notify(block, "error");
  } catch {
    // See announce(): a closed TUI is not a reason to fail here.
  }

  const headless = ctx.mode === "print" || ctx.mode === "json";
  const code = cfg.loopGuard.headlessExitCode;
  if (headless && code !== 0) {
    try {
      writeSync(
        2,
        `[pi-config] compaction: exiting ${code} — REQ-CTX-35 forbids a headless run returning 0 ` +
          `on an un-shrinkable context${sentinel ? ` (sentinel: ${sentinel})` : ""}\n`,
      );
    } catch {
      // The block above already carried the reason.
    }
    process.exitCode = code;
    process.exit(code);
  }
}

/* ---------------------------------------------------------------------------------------------
 * The summariser call — PI's own template plus our keep/drop focus
 * ------------------------------------------------------------------------------------------- */

/** `ProviderHeaders` allows `null` to mean "delete this header"; `compact()` wants a plain map. */
function withoutDeletedHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** PI's own `Model`, as `ctx.model` carries it. Named so a candidate can hold one. */
type SessionModel = NonNullable<ExtensionContext["model"]>;

/**
 * One place on the route, plus the model object when the caller already holds it.
 *
 * The session's own model is the only candidate that arrives already resolved — it *is* `ctx.model`
 * — and asking the registry for it again would be a second answer to a settled question.
 */
interface RouteCandidate {
  readonly target: RouteTarget;
  readonly model?: SessionModel;
}

/** A failure this harness produced itself, carrying the class it KNOWS rather than one read out of text. */
function harnessFailure(
  target: RouteTarget,
  klass: ProviderErrorClass,
  message: string,
  cause?: unknown,
): ProviderFailure {
  return { provider: target.provider, model: target.modelId, klass, message, cause, midStream: false };
}

/**
 * The candidates, in order: the configured route, or — when nothing resolved — the session's own
 * model, which {@link announceRoute} has already named as the degradation it is.
 */
function compactionCandidates(ctx: ExtensionContext): readonly RouteCandidate[] {
  if (compactionRoute.targets.length > 0) return compactionRoute.targets.map((target) => ({ target }));
  const model = ctx.model;
  if (!model) return [];
  return [
    {
      target: {
        spec: "(session model)",
        provider: model.provider,
        modelId: model.id,
        ...(ctx.thinkingLevel !== undefined ? { thinkingLevel: ctx.thinkingLevel } : {}),
      },
      model,
    },
  ];
}

type AttemptOutcome = RouteAttemptOutcome<CompactionResult> & { readonly failure?: ProviderFailure };

/** `ResolvedRequestAuth` as the registry hands it back, read off the method so no second import can drift from it. */
type ResolvedAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

/** Its `ok: true` arm — the `apiKey`/`headers`/`baseUrl` triple `compact()` can be called with. */
type UsableAuth = Extract<ResolvedAuth, { ok: true }>;

/** Everything a candidate needs before it can be called, or the one classified reason it cannot be. */
export type PreparedCandidate =
  | { readonly ok: true; readonly model: SessionModel; readonly auth: UsableAuth }
  | { readonly ok: false; readonly failure: ProviderFailure };

/**
 * Find the candidate, probe its transport, resolve its credential — the whole "can this be called"
 * question in one place. Never throws; every exit is a classified {@link ProviderFailure}.
 *
 * **A refused credential is `auth` by construction.** Both credential exits below used to build
 * their failure with `buildProviderFailure`, which on this path has no HTTP status and no provider
 * prose to read, so `classifyProviderError` fell through to its last resort and answered `network`
 * — for a token the registry had just said was rejected. Two things follow from that class, and
 * both were observed: the retry policy's default classes are `["network", "empty-response"]`
 * (`lib/provider-retry.ts`), so a dead credential sits in the retry-eligible bucket and gets
 * re-presented; and the report points the operator at the wire instead of at the login command that
 * would actually fix it. {@link harnessFailure} exists for exactly this case — the class this
 * module KNOWS, rather than one guessed from text — and a registry refusing to produce a credential
 * is `auth`, always.
 *
 * `when` names the caller in the message, because the same refusal reads differently at the moment
 * of use and at the preflight below.
 */
export async function prepareCandidate(
  ctx: ExtensionContext,
  candidate: RouteCandidate,
  when: string,
): Promise<PreparedCandidate> {
  const { target } = candidate;
  let model = candidate.model;
  if (model === undefined) {
    try {
      model = ctx.modelRegistry.find(target.provider, target.modelId) as SessionModel | undefined;
    } catch (err) {
      return {
        ok: false,
        failure: harnessFailure(target, "model-not-found", `the model registry threw on lookup: ${describeError(err)}`, err),
      };
    }
    if (model === undefined) {
      return {
        ok: false,
        failure: harnessFailure(
          target,
          "model-not-found",
          `${describeTarget(target)} is not in this session's model registry; check config/models.json ` +
            `and the compaction.route in config/routing.json`,
        ),
      };
    }
  }

  // A provider registered with its own native stream function cannot be reproduced from here:
  // `compact()` takes a `streamFn` and PI passes `agent.streamFunction`, which extensions cannot
  // read. Rather than route the summary through the wrong transport, this candidate stands down —
  // and on a route, standing down is the next candidate's turn rather than the end of the matter.
  try {
    if (ctx.modelRegistry.getRegisteredNativeProvider(target.provider)) {
      return {
        ok: false,
        failure: harnessFailure(
          target,
          "model-not-found",
          `provider "${target.provider}" is registered with a native stream handler, so an extension ` +
            `cannot apply the keep/drop contract on it`,
        ),
      };
    }
  } catch (err) {
    surfaceOnce(ctx, "compaction:native-provider-probe", () =>
      announce(ctx, `could not probe native providers: ${describeError(err)}`, "warning"),
    );
  }

  let auth: ResolvedAuth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    return {
      ok: false,
      failure: harnessFailure(target, "auth", `credential resolution threw while preparing ${when}: ${describeError(err)}`, err),
    };
  }
  if (!auth.ok) {
    return {
      ok: false,
      failure: harnessFailure(target, "auth", `cannot resolve credentials for ${when}: ${auth.error}`),
    };
  }

  return { ok: true, model, auth };
}

/** One candidate: prepare it, then call it. Never throws; every exit is a classified outcome. */
async function attemptCandidate(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  candidate: RouteCandidate,
): Promise<AttemptOutcome> {
  const { target } = candidate;
  const prepared = await prepareCandidate(ctx, candidate, "a compaction summary");
  if (!prepared.ok) return { ok: false, failure: prepared.failure };
  const { model, auth } = prepared;

  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const instructions = mergeInstructions(event.customInstructions);

  try {
    const result = await compact(
      event.preparation,
      requestModel,
      auth.apiKey,
      withoutDeletedHeaders(auth.headers),
      instructions,
      event.signal,
      target.thinkingLevel ?? ctx.thinkingLevel,
    );
    return { ok: true, result };
  } catch (err) {
    // A cancelled compaction is not a failure and must not spend a hop. PI re-checks the signal
    // immediately after us.
    if (event.signal.aborted) return { ok: false, aborted: true };
    return {
      ok: false,
      failure: buildProviderFailure({
        provider: target.provider,
        model: target.modelId,
        message: `compaction summary with the keep/drop contract failed: ${describeError(err)}`,
        cause: err,
      }),
    };
  }
}

/**
 * Runs PI's own `compact()` with our merged instructions, on **compaction's own route**, and returns
 * the result for PI to append.
 *
 * Returning `undefined` means "PI, do it yourself". Every such path announces first, so the
 * degradation is loud.
 *
 * ## What changed here, and what did not
 *
 * This function used to call `compact()` with `ctx.model`, and this comment used to say so with
 * approval: *it never substitutes a different provider or model*. That was the right rule aimed at
 * the wrong path. Compaction is the one call that must work while the lead's provider is refusing,
 * and putting it on the lead's provider made a quota refusal a deadlock: the session could neither
 * do the work nor shrink enough to keep trying.
 *
 * So the model now comes from `compaction.route`, and a failure the route is configured to survive
 * moves to the next candidate. Three properties keep that from being the silent failover this repo
 * cancelled, and they are the whole difference:
 *
 *   1. **Declared, not discovered.** The route is config an operator wrote and `session_start`
 *      prints. Nothing picks a model by looking at what is currently broken.
 *   2. **Loud at every hop.** Each hop announces provider, model, egress class and error class, and
 *      is persisted as its own `compaction_route_hop` entry.
 *   3. **Service path only.** The working turn is untouched: `onProviderError` still aborts and
 *      still substitutes nothing.
 */
async function summariseWithContract(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<BeforeCompactResult | undefined> {
  // The persistence half of `surfaceProviderFailure`'s sinks — see `credentials.ts`'s identical
  // seam for why `stderr` and `ctx.ui.notify` alone leave `causeChain` unreadable in a TUI.
  const sinks = { appendEntry: (customType: string, data: unknown) => pi.appendEntry(customType, data) };
  const candidates = compactionCandidates(ctx);
  if (candidates.length === 0) {
    surfaceOnce(ctx, "compaction:no-model", () =>
      announce(
        ctx,
        "no active model and no resolvable compaction route — PI's default compaction runs without the keep/drop contract",
        "error",
      ),
    );
    return undefined;
  }

  const result = await walkRoute<RouteCandidate, CompactionResult, ProviderFailure>(
    candidates,
    compactionRoute.settings,
    (candidate) => attemptCandidate(event, ctx, candidate),
    {
      onHop: (candidate, failure, willHop) => recordHop(pi, ctx, candidate.target, failure, willHop),
      onRecovered: (candidate, index, tried) => {
        announce(
          ctx,
          `compaction summarised on ${describeTarget(candidate.target)} after ${index} failed ` +
            `candidate(s): ${tried.join("; ")}`,
          "warning",
        );
      },
      // The end of the route. THIS is the turn's outcome, so it goes out through the channel an
      // operator greps for dead turns — and, because a compaction that cannot run is news the next
      // context needs even after this one is cut, it is written to the facts file too.
      onExhausted: async (failure, tried, exhausted) => {
        surfaceProviderFailure(ctx, failure, sinks);
        announceRouteExhausted(ctx, tried, exhausted);
        await recordRouteExhaustedFact(ctx, candidates, tried, failure);
      },
    },
  );
  if (result === undefined) return undefined;
  clearRouteStatus(ctx);
  return { compaction: result };
}

/**
 * A hop is a routing decision this harness made, not the turn's verdict, so it is reported through
 * this module's own channel and filed under its own entry type — never as a `provider_failure`,
 * which is what the run tooling downstream reads as "the turn died".
 */
function recordHop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: RouteTarget,
  failure: ProviderFailure,
  willHop: boolean,
): void {
  announce(
    ctx,
    `compaction candidate ${describeTarget(target)} failed [${failure.klass}]: ${failure.message}` +
      (willHop ? " — trying the next candidate on the route" : ""),
    "warning",
  );
  try {
    pi.appendEntry("compaction_route_hop", {
      spec: target.spec,
      tier: target.tier,
      provider: target.provider,
      model: target.modelId,
      egress: target.egress,
      errorClass: failure.klass,
      message: failure.message,
      willHop,
    });
  } catch {
    // The announcement above already carried the fact. A failed session write must not turn a
    // reported failure into an unreported crash.
  }
}

/** The status line's copy of the same news. */
function setRouteStatus(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.setStatus(ROUTE_STATUS_KEY, text);
  } catch {
    // No UI, or a closed one. The announcement is the load-bearing channel; this is the reminder.
  }
}

function clearRouteStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus(ROUTE_STATUS_KEY, undefined);
  } catch {
    // See setRouteStatus.
  }
}

/**
 * The `ctx` gauge, published through the same side channel as `setRouteStatus`/`quota`'s meter —
 * `formatCtxGaugeStatus` is pure and untested-by-side-effect on its own (see `gauge.test.ts`); this
 * is only the wiring: read the live usage, read whatever preflight estimate is currently parked for
 * `session` (see `preflightResumes`'s own header — it holds exactly one deferred request's facts,
 * if any), and set the cell. `getContextUsage()` returning `undefined` (no model selected yet)
 * clears the cell instead of rendering a bar for a window that does not exist.
 */
function refreshGaugeStatus(ctx: ExtensionContext, session: string): void {
  try {
    const usage = ctx.getContextUsage();
    if (usage === undefined) {
      ctx.ui.setStatus(GAUGE_STATUS_KEY, undefined);
      return;
    }
    const parked = preflightResumes.get(session);
    const preflight: GaugePreflightEstimate | undefined =
      parked === undefined ? undefined : { estimatedTokens: parked.facts.estimatedTokens };
    ctx.ui.setStatus(GAUGE_STATUS_KEY, formatCtxGaugeStatus(usage, preflight));
  } catch {
    // Presentation only. See setRouteStatus's own comment: no UI, or a closed one.
  }
}

function announceRouteExhausted(ctx: ExtensionContext, tried: readonly string[], ranOut: boolean): void {
  const why = ranOut
    ? "every candidate on the compaction route failed"
    : "the compaction route stopped on a class it is not configured to survive";
  announce(
    ctx,
    `${why} — PI's default compaction runs without the keep/drop contract, on the session's own ` +
      `model, which is the path this route exists to avoid. Tried: ${tried.join("; ")}. ` +
      `Switch model by hand, or fix compaction.route in config/routing.json.`,
    "error",
  );
  setRouteStatus(ctx, `compaction route exhausted (${tried.length})`);
}

/**
 * The refusal has to be **heard**, not merely thrown.
 *
 * A session entry and a toast both die with this context, and the context is about to be cut, which
 * is the entire reason we are here. The facts file is the one surface that survives a compaction by
 * construction — `session_compact` re-states it — so a route that ran out is recorded there. The
 * next turn's model then reads "compaction has no working path" in its own pinned block, instead of
 * silently trying again and dying the same way.
 */
async function recordRouteExhaustedFact(
  ctx: ExtensionContext,
  candidates: readonly RouteCandidate[],
  tried: readonly string[],
  failure: ProviderFailure,
): Promise<void> {
  if (!cfg.pinned.facts.enabled) return;
  try {
    await appendFact(
      factsPath(ctx),
      `compaction cannot run on any configured candidate (${tried.join("; ")}); this session is not ` +
        `shrinking and will fail on context rather than on the work. Fix the provider, or switch model by hand.`,
      `compaction route exhausted; last failure ${failure.provider}/${failure.model} [${failure.klass}]: ` +
        `${failure.message.slice(0, 300)} (route: ${candidates.map((c) => describeTarget(c.target)).join(" -> ")})`,
      { kind: "fact" },
    );
  } catch (err) {
    announce(ctx, `could not record the exhausted compaction route as a fact: ${describeError(err)}`, "warning");
  }
}

/* ---------------------------------------------------------------------------------------------
 * Credential preflight — the route's credentials, resolved before the route is needed
 * ------------------------------------------------------------------------------------------- */

/**
 * How long a credential verdict is trusted before an idle turn re-checks it.
 *
 * The case this exists for is not a credential that was dead at session start — it is one that dies
 * **during** a long session and is then discovered by the last hop of the route, at compaction, with
 * a context too full to do anything about it. A session-start check alone would have said "fine" and
 * then been wrong for the rest of the session, so the check repeats. Ten minutes is short against a
 * session's length and long enough that a busy hour costs a handful of resolutions rather than one
 * per turn.
 */
const CREDENTIAL_RECHECK_MS = 10 * 60_000;

/** One candidate's verdict: the target as the operator reads it, plus why it cannot be called. */
export interface CredentialVerdict {
  readonly spec: string;
  /** Absent means the credential resolved. */
  readonly failure?: ProviderFailure;
}

export interface CredentialPreflightReport {
  /** Specs with no usable credential, after this pass. */
  readonly dead: readonly string[];
  readonly lines: readonly { readonly text: string; readonly level: "info" | "warning" | "error" }[];
  /** True when this pass learned something the last one did not. */
  readonly changed: boolean;
}

/**
 * Turn a pass's verdicts into what to say, given what was already said.
 *
 * A check that speaks on every pass is a check an operator mutes, and a muted check is worth less
 * than no check at all. So only transitions are announced: a candidate that just lost its
 * credential, and one that just got it back.
 */
export function credentialPreflightReport(
  verdicts: readonly CredentialVerdict[],
  previouslyDead: readonly string[],
): CredentialPreflightReport {
  const was = new Set(previouslyDead);
  const dead = verdicts.filter((verdict) => verdict.failure !== undefined).map((verdict) => verdict.spec);
  const lines: { text: string; level: "info" | "warning" | "error" }[] = [];

  for (const verdict of verdicts) {
    if (verdict.failure !== undefined) {
      if (was.has(verdict.spec)) continue;
      lines.push({
        level: "warning",
        text:
          `compaction route candidate ${verdict.spec} has no usable credential ` +
          `[${verdict.failure.klass}]: ${verdict.failure.message} — fix it now, while this session ` +
          `still has the context to act in: at compaction time this candidate is a lane that has to ` +
          `work while the lead's own provider does not.`,
      });
    } else if (was.has(verdict.spec)) {
      lines.push({ level: "info", text: `compaction route candidate ${verdict.spec} has a usable credential again` });
    }
  }

  const changed = dead.length !== was.size || dead.some((spec) => !was.has(spec));
  return { dead, lines, changed };
}

/**
 * Resolve every route candidate's credential *before* the route is walked.
 *
 * The route's whole point is to have a lane that works while the lead's provider does not, and a
 * credential resolved only at the moment of use is a lane nobody has checked. This is the same
 * `getApiKeyAndHeaders` call {@link prepareCandidate} makes at use time; the only thing that changes
 * is when it is asked, which is also why it is cheap enough to repeat.
 *
 * Never throws and never rejects: it is called detached from `session_start` (so a slow credential
 * helper cannot delay or hang a session start) and from `agent_settled`, where the run is over and
 * a few hundred milliseconds cost nothing.
 */
async function preflightRouteCredentials(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  trigger: "session_start" | "idle",
): Promise<void> {
  try {
    // The route is walked by `summariseWithContract` alone; with the contract off, nothing in this
    // module ever asks these candidates for a credential, so checking them is noise.
    if (!cfg.instructions.enabled) return;
    const session = sid(ctx);
    let state = credentialPreflights.get(session);
    if (state === undefined) {
      state = { dead: new Set<string>(), checkedAt: 0, running: false };
      credentialPreflights.set(session, state);
    }
    if (state.running) return;
    if (trigger === "idle" && Date.now() - state.checkedAt < CREDENTIAL_RECHECK_MS) return;
    const candidates = compactionCandidates(ctx);
    // No candidate at all is a route problem, and `announceRoute` has already said so at a volume
    // this function cannot improve on.
    if (candidates.length === 0) return;

    state.running = true;
    try {
      const verdicts: CredentialVerdict[] = [];
      for (const candidate of candidates) {
        const prepared = await prepareCandidate(ctx, candidate, "the compaction credential preflight");
        verdicts.push({
          spec: describeTarget(candidate.target),
          ...(prepared.ok ? {} : { failure: prepared.failure }),
        });
      }
      const report = credentialPreflightReport(verdicts, [...state.dead]);
      state.dead = new Set(report.dead);
      state.checkedAt = Date.now();
      for (const line of report.lines) announce(ctx, line.text, line.level);
      if (!report.changed) return;
      recordCredentialPreflight(pi, trigger, verdicts);
      if (report.dead.length === 0) clearRouteStatus(ctx);
      else setRouteStatus(ctx, `⚠ compaction credentials: ${report.dead.length}/${verdicts.length} unusable`);
    } finally {
      state.running = false;
    }
  } catch (err) {
    // A preflight's own bug must cost the preflight, never the session — the same posture as the
    // loop guard and the over-window preflight.
    surfaceOnce(ctx, `compaction:credential-preflight:${describeError(err).slice(0, 120)}`, () =>
      announce(ctx, `the credential preflight failed internally and was skipped: ${describeError(err)}`, "error"),
    );
  }
}

/**
 * The persisted half. Written only when the verdict set changed, for the same reason nothing is
 * announced twice: an entry per idle turn would bury the one pass that carried news.
 *
 * Its own entry type, never `provider_failure` — no provider was asked for a completion here, and a
 * harness's own probe filed where operators grep for dead turns is how a fleet ends up debugging a
 * gateway that was working all along. Same argument as {@link recordHop} and the `context_preflight`
 * entry.
 */
function recordCredentialPreflight(
  pi: ExtensionAPI,
  trigger: "session_start" | "idle",
  verdicts: readonly CredentialVerdict[],
): void {
  try {
    pi.appendEntry("compaction_credential_preflight", {
      trigger,
      candidates: verdicts.map((verdict) => ({
        spec: verdict.spec,
        ok: verdict.failure === undefined,
        errorClass: verdict.failure?.klass,
        message: verdict.failure?.message,
      })),
    });
  } catch {
    // The announcement above already carried the fact. A failed session write must not turn a
    // reported credential into an unreported crash.
  }
}

/* ---------------------------------------------------------------------------------------------
 * Re-statement after a compaction
 * ------------------------------------------------------------------------------------------- */

/** This session's facts file. One per session id, beside the transcript, outside every worktree. */
function factsPath(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return factsPathFor(ctx.sessionManager.getSessionFile() ?? undefined, sid(ctx), stateRoot());
}

async function restatePinnedSources(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!cfg.pinned.enabled || cfg.pinned.sources.length === 0) return;
  try {
    const result = await readPinned(resolvePinnedSources(ctx.cwd, cfg.pinned.sources), cfg.pinned);
    for (const problem of result.problems) {
      surfaceOnce(ctx, `compaction:pinned:${problem}`, () => announce(ctx, `pinned source ${problem}`, "warning"));
    }
    const content = renderPinned(result);
    if (content.length === 0) return;
    // `display:false` keeps it out of the transcript view; `nextTurn` + `triggerTurn:false`
    // guarantee it never interrupts a turn — the same idiom `extensions/tasks/` uses.
    pi.sendMessage(
      { customType: "pinned_context", content, display: false },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
  } catch (err) {
    surfaceOnce(ctx, `compaction:pinned-regen:${describeError(err).slice(0, 120)}`, () =>
      announce(ctx, `pinned-block regeneration failed and was skipped: ${describeError(err)}`, "error"),
    );
  }
}

/**
 * The same re-statement, over what this session *learned* rather than what the repo *declares*.
 * A session that recorded nothing has no file, `renderFacts` returns `""` and nothing is sent, so
 * this path is invisible until the first `fact` call — which is what makes it safe to default on.
 */
async function restateFacts(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!cfg.pinned.facts.enabled) return;
  try {
    const result = await readFacts(factsPath(ctx), cfg.pinned.facts);
    for (const problem of result.problems) {
      surfaceOnce(ctx, `compaction:facts:${problem}`, () => announce(ctx, `facts file ${problem}`, "warning"));
    }
    const content = renderFacts(result);
    if (content.length === 0) return;
    pi.sendMessage(
      { customType: "pinned_facts", content, display: false },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
  } catch (err) {
    surfaceOnce(ctx, `compaction:facts-restate:${describeError(err).slice(0, 120)}`, () =>
      announce(ctx, `facts re-statement failed and was skipped: ${describeError(err)}`, "error"),
    );
  }
}

/* ---------------------------------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------------------------------- */

/**
 * `REQ-CTX-31`'s missing half: do not SEND a prompt the declared window cannot hold.
 *
 * Read `./preflight.ts` for the arithmetic, the order-of-operations argument against autocompact,
 * and the bound on the estimate. Two things belong here rather than there, because they are facts
 * about this runtime and not about the decision:
 *
 * **`ctx.abort()` works from here, and this is the one place in this module where it does.** The
 * header above records that `abort()` is a no-op on the automatic compaction paths, because
 * `_runAutoCompaction()` runs between `agent.prompt()` and `agent.continue()`, by which time
 * `finishRun()` has cleared `activeRun` and `agent.abort()` has nothing to abort. A
 * `before_provider_request` handler is the opposite case: it runs *inside* the active run,
 * immediately before the HTTP call, so `activeRun.abortController.abort()` lands on the very
 * request being assembled and the doomed body never goes on the wire.
 *
 * **The refusal is a harness decision and is labelled as one.** It goes out through this module's
 * own `[pi-config] compaction:` channel and is persisted as a `context_preflight` entry — never
 * through `PROVIDER_FAILURE_MARKER`, never as a `provider_failure`. The provider did nothing here.
 * Filing a harness refusal in the channel an operator greps for provider failures is how a fleet
 * ends up debugging a gateway that was working.
 *
 * **The abort is half a recovery, so the other half is wired here too.** `./preflight.ts` has the
 * shipped-code argument for why aborting leaves the session idle rather than compacting:
 * `_handlePostAgentRun` evaluates compaction with `skipAbortedCheck` at its default `true`, and the
 * message a refusal leaves behind is `aborted`. Only `prompt()` checks compaction on an aborted
 * message, and only a new turn calls `prompt()`. So the refusal parks the facts and the
 * `agent_settled` handler below turns them into that turn.
 *
 * Three runtime facts decide the shape of that, all read off `core/agent-session.js` 0.84.0:
 *
 * - **`agent_settled`, not the refusal handler.** `_emitAgentSettled()` sets
 *   `_isAgentRunActive = false` *before* it emits, so a handler on that event is the first point
 *   where the session is idle. `prompt()` throws `"Agent is already processing"` when it is not.
 * - **`sendUserMessage`, not `sendMessage({ triggerTurn: true })`.** Both start a turn when idle,
 *   but `sendCustomMessage` calls `_runAgentPrompt(msg)` directly while `sendUserMessage` goes
 *   through `prompt()` — and the pre-run `_checkCompaction(lastAssistant, false)` lives in
 *   `prompt()`. A custom message would restart the session into the same over-window context and
 *   buy one more refusal instead of a compaction. The resume is a visible user message for that
 *   reason, and {@link selfResumeLine} says whose it is in its first six words.
 * - **`deliverAs: "nextTurn"` cannot do this at all.** It appends to `_pendingNextTurnMessages`,
 *   which is drained by the *next* `prompt()` — i.e. by a human. It is the right idiom for the
 *   pinned-block re-statement above, which wants to ride an existing turn, and the wrong one here,
 *   where the whole problem is that no next turn exists.
 *
 * The recursion the resume could obviously cause — refuse, resume, refuse — is bounded by the
 * refusal streak this same handler maintains: the resume is issued only on a `refuse` verdict, and
 * the verdict at `MAX_CONSECUTIVE_REFUSALS` is `over-but-passed`, which sends and resumes nothing.
 * Two self-resumes per streak, maximum. The subtler cycle — compaction that reduces just enough for
 * one request to fit (clearing the streak) and then goes over again — is what `loop-guard.ts` is
 * for: every resumed turn's compaction is an automatic pass, so a run of non-reducing ones trips
 * `REQ-CTX-35` and takes the run down loudly instead of grinding.
 */
function registerPreflight(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    try {
      const session = sid(ctx);
      const contextWindow = ctx.model?.contextWindow;
      const estimatedTokens = estimatePromptTokens(event.payload);
      const refusalsSoFar = preflightRefusals.get(session) ?? 0;
      const verdict = preflightVerdict({ estimatedTokens, contextWindow, refusalsSoFar });
      if (verdict === "send") {
        // The streak ends at the first request that fits — including the one that fits only
        // because the self-resume this module queued started a turn, and that turn's `prompt()`
        // compacted on the way in.
        if (refusalsSoFar > 0) preflightRefusals.delete(session);
        return;
      }

      const facts: PreflightFacts = {
        estimatedTokens,
        // `preflightVerdict` returns "send" for every unusable window, so a non-send verdict has
        // one. The `?? 0` is a type narrowing, not a fallback that can be reached.
        contextWindow: contextWindow ?? 0,
        model: ctx.model === undefined ? "(unknown model)" : `${ctx.model.provider}/${ctx.model.id}`,
      };

      if (verdict === "over-but-passed") {
        // Do NOT delete the refusal counter here: this branch IS the stand-down preflight.ts's
        // header promises, and `delete` rearmed it every single time — the next
        // `before_provider_request` read `refusalsSoFar = 0`, so the module refused twice more
        // before passing again, forever, on a session that was never going to fit. Leaving the
        // counter at `MAX_CONSECUTIVE_REFUSALS` makes `preflightVerdict` return "over-but-passed"
        // immediately on every following request in the streak — silent from here on, exactly as
        // documented — until the streak actually clears: the "send" branch above deletes it the
        // moment a request fits, and `session_start` clears it for a new session.
        //
        // Whatever this streak parked IS void: the request is going out, so the run continues and
        // has no need of a resume. Leaving it would fire one turn after a real answer.
        preflightResumes.delete(session);
        // The gauge's preflight marker tracks the same park — drop it with it.
        refreshGaugeStatus(ctx, session);
        announce(ctx, passedAnywayLine(facts), "error");
        pi.appendEntry("context_preflight", { decision: "passed-anyway", ...facts, refusals: MAX_CONSECUTIVE_REFUSALS });
        return;
      }

      preflightRefusals.set(session, refusalsSoFar + 1);
      announce(ctx, refusalLine(facts), "error");
      // Appended BEFORE the abort, for the same reason the loop guard writes before exiting: a
      // decision that is not in the session record did not happen as far as any later reader is
      // concerned, and `appendEntry` is a synchronous append.
      pi.appendEntry("context_preflight", { decision: "refused", ...facts, refusals: refusalsSoFar + 1 });
      // Parked before the abort, not after: `abort()` unwinds the run, and `agent_settled` can be
      // emitted before this handler's frame would have resumed.
      preflightResumes.set(session, { facts, refusals: refusalsSoFar + 1 });
      // Show the number that just drove this refusal next to the gauge, not only in the
      // announcement — the whole point is that nothing on screen showed it before.
      refreshGaugeStatus(ctx, session);
      ctx.abort();
    } catch (err) {
      // Fail open, always. This handler stands between every request and its provider; a bug in it
      // must cost a preflight, never the session.
      announce(ctx, `preflight failed internally and was skipped: ${describeError(err)}`, "error");
    }
  });

  // The other half of the recovery — see this function's header for why this event, this method,
  // and why the loop it could start is bounded. Sessions that never refuse never reach the send.
  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    try {
      const session = sid(ctx);
      const parked = preflightResumes.get(session);
      if (parked === undefined) return;
      // Consumed before the send, so a throw inside `sendUserMessage` costs one resume rather than
      // arming the next settle with the same one.
      preflightResumes.delete(session);
      // The deferred request is no longer deferred — drop its estimate from the gauge.
      refreshGaugeStatus(ctx, session);
      pi.appendEntry("context_preflight", {
        decision: "self-resumed",
        ...parked.facts,
        refusals: parked.refusals,
      });
      pi.sendUserMessage(selfResumeLine(parked.facts));
    } catch (err) {
      // Fail open into the old behaviour: no resume is a session waiting for a human, which is
      // exactly where this session was before the self-resume — bad, but not worse, and it says
      // so. The park is already gone: it is deleted above, before the send that can throw.
      announce(
        ctx,
        `could not resume the session after an over-window refusal (${describeError(err)}); it is ` +
          `idle and needs a message to continue.`,
        "error",
      );
    }
  });
}

export function register(pi: ExtensionAPI): void {
  registerPreflight(pi);

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    try {
      guards.set(sid(ctx), createLoopGuardState());
      preflightRefusals.delete(sid(ctx));
      preflightResumes.delete(sid(ctx));
      credentialPreflights.delete(sid(ctx));
      // Before the report, so what it reports is the number this session will actually use.
      applyUniversalThreshold(ctx);
      reportThreshold(ctx);
      announceRoute(ctx);
      // The gauge starts visible from turn 1, same as `quota`'s own forced session-start refresh.
      refreshGaugeStatus(ctx, sid(ctx));
      // Detached on purpose: resolving a credential can mean an OAuth helper, a keyring or a
      // subprocess, and `emit()` awaits every handler — a session start must not be able to hang on
      // one. Nothing here is ordered against the announcement it produces, and
      // `preflightRouteCredentials` never rejects.
      void preflightRouteCredentials(pi, ctx, "session_start");
    } catch (err) {
      announce(ctx, `session_start failed internally and was skipped: ${describeError(err)}`, "error");
    }
  });

  // The re-check that catches the credential which was alive at session start and died an hour into
  // the session. `agent_settled` is this harness's idle edge — the run is over, so a credential
  // resolution here competes with no turn — and `CREDENTIAL_RECHECK_MS` keeps a busy session from
  // making one per turn. A second handler on the event `registerPreflight` already uses, rather than
  // a call inside it: `ExtensionRunner.emit` walks every handler registered for a type, so the two
  // stay independent of each other's failures.
  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    void preflightRouteCredentials(pi, ctx, "idle");
  });

  // The gauge's steady-state cadence — same event `quota/index.ts` refreshes its own status on, so
  // `ctx` moves at least once per turn even when no preflight event fired.
  pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
    refreshGaugeStatus(ctx, sid(ctx));
  });

  pi.on(
    "session_before_compact",
    async (event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<BeforeCompactResult | undefined> => {
      const session = sid(ctx);
      let verdict;
      try {
        // The only place PI exposes the effective compaction settings to an extension.
        lastReserveTokens = event.preparation.settings.reserveTokens;
        const state = guardFor(session);
        verdict = observePass(
          state,
          {
            reason: event.reason as CompactionReason,
            tokensBefore: event.preparation.tokensBefore,
            droppedTokens: droppedTokens(event),
            entriesSinceLastCompaction: entriesSinceLastCompaction(event.branchEntries),
          },
          cfg.loopGuard,
        );

        if (verdict.trip) {
          const err = new CompactionLoopError({
            sessionId: session,
            provider: ctx.model?.provider ?? "(no model)",
            model: ctx.model?.id ?? "(no model)",
            reason: event.reason as CompactionReason,
            automaticPasses: state.automaticPasses,
            consecutiveNonReducing: state.consecutiveNonReducing,
            maxNonReducingPasses: cfg.loopGuard.maxNonReducingPasses,
            tokensBefore: event.preparation.tokensBefore,
            droppedTokens: droppedTokens(event),
            reductionRatio: verdict.reductionRatio,
            entriesSinceLastCompaction: entriesSinceLastCompaction(event.branchEntries),
            why: verdict.why,
          });
          abortOnLoop(pi, ctx, err);
          // Reached in tui/rpc, and headless with `headlessExitCode: 0`. `cancel` is the part of
          // the abort that works in every mode; the exit code is the part that does not.
          return { cancel: true };
        }
      } catch (err) {
        // The guard's own bug must not brick compaction: fail open, loudly, exactly once.
        surfaceOnce(ctx, `compaction:guard:${describeError(err).slice(0, 120)}`, () =>
          announce(ctx, `loop guard failed internally and was skipped: ${describeError(err)}`, "error"),
        );
      }

      if (!cfg.instructions.enabled) return undefined;
      try {
        return await summariseWithContract(event, ctx, pi);
      } catch (err) {
        surfaceOnce(ctx, `compaction:summarise:${describeError(err).slice(0, 120)}`, () =>
          announce(
            ctx,
            `keep/drop summarisation failed internally; PI's default compaction runs: ${describeError(err)}`,
            "error",
          ),
        );
        return undefined;
      }
    },
  );

  // REQ-CTX-37 — regenerate, then re-state. Runs after PI has appended the compaction entry, so
  // the block lands on the far side of the cut and survives it by construction.
  //
  // Two sources, two independent blocks: the instruction files, and this session's facts file.
  // Independent because they fail and are configured separately — a repo with no `AGENTS.md` must
  // still get its facts back, and a session that recorded none must still get its doctrine back.
  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    await restatePinnedSources(pi, ctx);
    await restateFacts(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    guards.delete(sid(ctx));
    // A parked resume outlives nothing: the session it would have restarted is gone.
    preflightResumes.delete(sid(ctx));
  });

  /**
   * `REQ-CTX-31`'s absolute threshold is a *stated intent*, not a lever — PI's `shouldCompact()`
   * only ever knows `contextWindow - reserveTokens` (see this module's header and `threshold.ts`).
   * So what this command does is state an intent, not move a trigger, and the report says so in
   * the same breath rather than letting the name imply otherwise.
   *
   * Two intents are available and the argument chooses between them:
   *
   * - **no argument** writes {@link UNIVERSAL_ABSOLUTE_TOKENS}, flat, on every model. This is the
   *   default and it is what `session_start` also keeps written, so the command exists mainly to
   *   put the number back after a per-model override.
   * - **`<model-id>`** writes that model's own trigger, `contextWindow - reserveTokens`, for the
   *   case where matching one model is the point. It is the only path that reads `models.json`
   *   and `compaction.reserveTokens` at all.
   */
  pi.registerCommand("autocompact", {
    description:
      "Set the compaction threshold. With no argument, the universal 200000 tokens, the same on "
      + "every model. With /autocompact <model-id>, that model's own trigger instead "
      + "(its declared context window minus compaction.reserveTokens). "
      + "Writes config/compaction.json, so it persists across sessions.",
    handler: async (args: string, ctx) => {
      try {
        const path = loaded.source;
        if (path === undefined) {
          throw new Error(
            `no config/compaction.json exists to write to (looked in ${configPaths().join(", ")}); ` +
              `this session is running on the built-in defaults.`,
          );
        }
        const requested = args.trim();
        const previous = activeThreshold.absoluteTokens;

        // No argument is the universal threshold, and nothing about the model enters into it:
        // no models.json read, no reserve, no arithmetic that could refuse. That is the point of
        // a flat number, and it is also why this branch cannot fail the way the other one can.
        if (requested === "") {
          writeAbsoluteTokens(path, UNIVERSAL_ABSOLUTE_TOKENS);
          activeThreshold = { ...activeThreshold, absoluteTokens: UNIVERSAL_ABSOLUTE_TOKENS };
          const resolved = resolveThreshold(ctx);
          announce(
            ctx,
            [
              `Compaction threshold set to ${UNIVERSAL_ABSOLUTE_TOKENS} tokens (was ${previous})`,
              `  intent     : the universal ${formatUniversal()} threshold, the same on every model`,
              `  written to : ${path} (a tracked file, so commit it to keep the change)`,
              `  verdict    : /compaction-status now reports ` +
                `${resolved ? resolved.report.verdict : "nothing, until a model is selected"}`,
            ].join("\n"),
            "info",
          );
          return;
        }

        const target = resolveTargetWindow(ctx, requested);
        // The reserve is read before anything is written: a window it swallows must refuse the
        // whole command, not leave a half-applied number behind.
        const reserve = readReserveTokens({
          observed: lastReserveTokens,
          agentDir: configDir(),
          cwd: ctx.cwd,
          configDirName: CONFIG_DIR_NAME,
        });
        const plan = absoluteTokensForWindow(target.contextWindow, reserve.value);
        if (!plan.ok) throw new Error(plan.reason);

        writeAbsoluteTokens(path, plan.absoluteTokens);
        activeThreshold = { ...activeThreshold, absoluteTokens: plan.absoluteTokens };

        // Reported, not asserted: the verdict comes out of the same function /compaction-status
        // calls, so this line cannot drift from what that command will say.
        const verdict = thresholdReport(
          target.contextWindow,
          reserve.value,
          plan.absoluteTokens,
          activeThreshold.toleranceRatio,
        ).verdict;
        announce(
          ctx,
          [
            `Compaction threshold set to ${plan.absoluteTokens} tokens ` +
              `(from ${target.model} context window; was ${previous})`,
            `  arithmetic : ${target.contextWindow} window - ${reserve.value} reserve ` +
              `[${reserve.source}] = ${plan.absoluteTokens}, PI's own trigger for this model`,
            `  read from  : ${target.source}`,
            `  written to : ${path} (a tracked file, so commit it to keep the change)`,
            `  verdict    : /compaction-status now reports ${verdict}`,
          ].join("\n"),
          "info",
        );
      } catch (err) {
        // Nothing was written on any path that throws: the file is only touched after the window
        // resolves. Reporting the failure and leaving the old number standing is the whole recovery.
        announce(ctx, `/autocompact did not change anything: ${describeError(err)}`, "error");
      }
    },
  });

  pi.registerCommand("compaction-status", {
    description: "Show the compaction loop guard, the effective threshold and the pinned sources",
    handler: async (_args: string, ctx) => {
      const state = guardFor(sid(ctx));
      const lines = [
        `[pi-config] compaction status`,
        `  loop guard : ${state.consecutiveNonReducing}/${cfg.loopGuard.maxNonReducingPasses} consecutive non-reducing, ` +
          `${state.automaticPasses} automatic pass(es), tripped=${state.tripped}`,
        `  reduction  : a pass must drop >= ${(cfg.loopGuard.minReductionRatio * 100).toFixed(1)} % of context and follow ` +
          `>= ${cfg.loopGuard.minEntriesBetweenPasses} new entries`,
        `  headless   : exit ${cfg.loopGuard.headlessExitCode} on trip (0 = cancel only)`,
        `  keep/drop  : ${cfg.instructions.enabled ? "on" : "off"}`,
        `  pinned     : ${cfg.pinned.enabled ? cfg.pinned.sources.join(", ") || "(none)" : "off"}`,
        `  facts      : ${factsLine(ctx)}`,
        `  ${thresholdLine(ctx)}`,
        `  /autocompact sets that configured absolute to the universal ${UNIVERSAL_ABSOLUTE_TOKENS}; ` +
          `/autocompact <model-id> sets it to that model's declared window minus the reserve instead`,
      ];
      announce(ctx, lines.join("\n"), "info");
    },
  });

  // The cheap call the doctrine in `SYSTEM.md` names. It is a tool rather than an instruction to
  // hand-edit a file because hand-editing is the step that gets skipped under pressure, which is
  // precisely when a fact was expensive enough to be worth keeping.
  if (cfg.pinned.facts.enabled) {
    pi.registerTool({
      name: "fact",
      label: "Record a fact",
      description:
        "Write one entry to this session's facts file, which is re-read and re-stated "
        + "after every compaction. Use it for anything that cost a paid call, a remote run, or an "
        + "operator correction: the conversation is summarised repeatedly and every summary loses "
        + "detail, so a fact not on disk is gone by the time it is needed again. Two kinds: the "
        + "default \"fact\" records something established; \"ruled_out\" records an approach you are "
        + "abandoning and what ruled it out, so a later turn does not walk back into it.",
      promptSnippet: "Record an established fact, or an approach you ruled out, so it survives compaction",
      promptGuidelines: [
        "Record a fact the moment it is established, before you act on it, not at the end of the task.",
        "An operator correction is a fact. So is a confirmed URL, a working parameter, a failed run.",
        "Abandoning an approach is a fact too: record it with kind \"ruled_out\" and the reason, at the "
          + "moment you abandon it. Before any further fix-work, read this session's ruled-out entries.",
        "Always pass provenance: the command, the file:line, the run id, or \"operator correction\". "
          + "For kind \"ruled_out\" it is the reason, and it is mandatory.",
      ],
      parameters: Type.Object({
        fact: Type.String({
          description: "The fact, in one sentence, stated so a later turn can act on it without context.",
        }),
        provenance: Type.Optional(
          Type.String({
            description:
              "How it was established: the command that proved it, a file:line, a run id, or "
              + "\"operator correction\". A fact without provenance is recorded as unverified. For "
              + "kind \"ruled_out\" this is the reason the approach was ruled out, and it is required.",
          }),
        ),
        kind: Type.Optional(
          Type.Union([Type.Literal("fact"), Type.Literal("ruled_out")], {
            description:
              "\"fact\" (default) for something established. \"ruled_out\" for an approach you tried "
              + "and abandoned; provenance then carries the reason and is mandatory.",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const path = factsPath(ctx);
        const kind = params.kind ?? "fact";
        // `index` is this entry's own position in the file, read back after the write; `total` is
        // the count. They differ exactly when another call appended in parallel, which is the case
        // a single post-hoc count, printed as if it were an identity, could not show.
        const { line, index, total } = await appendFact(path, params.fact, params.provenance, { kind });
        const label = kind === "ruled_out" ? "ruled-out approach" : "fact";
        // One extra read of a file that is 8KB by construction, to say how much of the budget is
        // left. The alternative is what the tool did before: the caps are stated only by
        // `/compaction-status`, so an agent that never thinks to ask rations against a guess.
        const usage = await readFacts(path, cfg.pinned.facts);
        const nearing = nearingCapLine(usage, cfg.pinned.facts, cfg.pinned.facts.warnRatio);
        const text =
          `recorded ${label} ${index} of ${total} in this session\n${line}\n${path}`
          + (nearing === null ? "" : `\n${nearing}`);
        return {
          content: [{ type: "text" as const, text }],
          details: { path, index, total, kind, bytes: usage.bytes, nearingCap: nearing !== null },
        };
      },
    });
  }
}

/** `/compaction-status`'s facts line: the caps, and what this session has actually recorded. */
function factsLine(ctx: ExtensionContext): string {
  if (!cfg.pinned.facts.enabled) return "off";
  const path = factsPath(ctx);
  return (
    `max ${cfg.pinned.facts.maxEntries} entries / ${cfg.pinned.facts.maxBytes} bytes re-stated, ` +
    `appended by the fact tool, in ${path}`
  );
}

/**
 * `compaction.reserveTokens` is not readable through `ExtensionAPI`; it only arrives on
 * `preparation.settings` when a compaction actually happens. Cached here so the report can use
 * the number PI *used* once one pass has been seen; before that `readReserveTokens()` reads the
 * same two settings files PI reads. The source is always carried through to the message, so a
 * default is never presented as a measurement — the previous code hard-coded 16384 and printed
 * an effective trigger that was wrong whenever `settings.json` declared anything else.
 */
let lastReserveTokens: number | undefined;

function resolveThreshold(ctx: ExtensionContext): { report: ThresholdReport; reserve: ReserveTokens } | null {
  const usage = ctx.getContextUsage();
  if (!usage || usage.contextWindow <= 0) return null;
  const reserve = readReserveTokens({
    observed: lastReserveTokens,
    agentDir: configDir(),
    cwd: ctx.cwd,
    configDirName: CONFIG_DIR_NAME,
  });
  return {
    reserve,
    report: thresholdReport(
      usage.contextWindow,
      reserve.value,
      activeThreshold.absoluteTokens,
      activeThreshold.toleranceRatio,
    ),
  };
}

function thresholdLine(ctx: ExtensionContext): string {
  const resolved = resolveThreshold(ctx);
  if (!resolved) return `threshold  : no model selected — effective trigger unknown`;
  return formatThresholdLine(resolved.report, resolved.reserve.source);
}

/** Marker proving this exact divergence has already been reported to this operator, ever. */
function noticePath(key: string): string {
  return join(stateRoot(), "compaction-threshold", `${key}.json`);
}

/**
 * True when the notice was already delivered in some earlier session.
 *
 * An unreadable or unwritable state root does **not** silence the notice — it degrades to
 * "announce every session" and says so. Fail loud beats a dedup built on a guess.
 */
function alreadyReported(key: string): boolean {
  try {
    return existsSync(noticePath(key));
  } catch {
    return false;
  }
}

function markReported(ctx: ExtensionContext, key: string, report: ThresholdReport): void {
  const path = noticePath(key);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    announce(
      ctx,
      `could not record that the REQ-CTX-31 notice was delivered (${path}: ${describeError(err)}); ` +
        `it will repeat every session until this path is writable`,
      "error",
    );
  }
}

/**
 * `REQ-CTX-31`, said at most once per distinct configuration.
 *
 * Three of the four verdicts are silent here by design:
 * - `disabled`  — the operator set `absoluteTokens: 0`.
 * - `aligned`   — the requirement is in force; there is nothing to report.
 * - `window-too-small` — a property of the model, not a setting anyone can fix. `/compaction-status`
 *   carries it; a startup warning about it would be pure noise.
 *
 * Only `trigger-too-high` is actionable, and even that is announced once ever, not once per
 * session, because the operator cannot apply the fix from inside a running session.
 */
function reportThreshold(ctx: ExtensionContext): void {
  const resolved = resolveThreshold(ctx);
  if (!resolved) return;
  const { report, reserve } = resolved;
  const provider = ctx.model?.provider ?? "(no provider)";
  const model = ctx.model?.id ?? "(no model)";
  const notice = formatThresholdNotice(provider, model, report, reserve.source);
  if (notice === null) return;

  const key = thresholdKey(provider, model, report);
  if (alreadyReported(key)) return;
  // Still deduped inside the process too: one session must not report the same tuple twice if
  // session_start fires again after a /new.
  surfaceOnce(ctx, `compaction:threshold:${key}`, () => {
    announce(ctx, notice, "warning");
    markReported(ctx, key, report);
  });
}

/**
 * EXT-11 — the compaction suite (`REQ-CTX-31`, `-32`, `-35`, `-37`).
 *
 * Four parts, in the order they matter:
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
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compact, estimateTokens } from "@earendil-works/pi-coding-agent";
import { configPaths as sharedConfigPaths } from "../dispatch/config.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { CONFIG_DIR_NAME, configDir, repoRoot, stateRoot } from "../lib/paths.ts";
import { buildProviderFailure, surfaceProviderFailure } from "../lib/provider-error.ts";
import { mergeInstructions } from "./instructions.ts";
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
  DEFAULT_PINNED_LIMITS,
  readPinned,
  renderPinned,
  resolvePinnedSources,
  type PinnedLimits,
} from "./pinned.ts";
import {
  declaredContextWindows,
  findContextWindow,
  formatThresholdLine,
  formatThresholdNotice,
  readReserveTokens,
  thresholdKey,
  thresholdReport,
  type DeclaredWindow,
  type ReserveTokens,
  type ThresholdReport,
} from "./threshold.ts";

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
  readonly pinned: PinnedLimits & { readonly enabled: boolean; readonly sources: readonly string[] };
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
  pinned: { ...DEFAULT_PINNED_LIMITS, enabled: true, sources: ["AGENTS.md", "CLAUDE.md"] },
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

/**
 * The threshold `REQ-CTX-31` is currently checked against.
 *
 * Separate from `cfg` — which is frozen at module load — because `/autocompact` changes it inside a
 * running session and `/compaction-status` must then report the new number rather than the one
 * this process happened to start with. The file is still the source of truth across sessions; this
 * is only what keeps the current session honest about what it just wrote.
 */
let activeThreshold: CompactionConfig["threshold"] = cfg.threshold;

/* ---------------------------------------------------------------------------------------------
 * `/autocompact` — sync the declared threshold to the trigger a model's declared window implies
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
 * The window `/autocompact` will write, for the model the operator named or for this session's.
 *
 * `models.json` is consulted first and is authoritative: it is the file this repo owns, the one
 * whose windows are deliberately understated to match what the endpoints actually serve, and the
 * only source that exists for a model the session is not currently running. The live session window is used only as a **named** fallback,
 * for the case where the current model is served from PI's built-in catalogue with no override of
 * ours — reporting where the number came from is what keeps that from being a silent substitution.
 *
 * An explicitly named model has no such fallback: there is no live window for a model that is not
 * running, so an undeclared one is refused rather than guessed.
 */
function resolveTargetWindow(ctx: ExtensionContext, requested: string): WindowResolution {
  const models = readModelsJson();
  const declared: readonly DeclaredWindow[] = declaredContextWindows(models.raw);
  const currentModel = ctx.model?.id;
  const modelId = requested !== "" ? requested : currentModel;

  if (modelId === undefined || modelId === "") {
    throw new Error(
      `no model is selected in this session, so there is nothing to read a context window from. ` +
        `Name one: /autocompact <model-id>.`,
    );
  }

  const lookup = findContextWindow(declared, modelId, ctx.model?.provider);
  if (lookup.ok) {
    return {
      contextWindow: lookup.window.contextWindow,
      model: modelId,
      source: `${lookup.window.provider} ${lookup.window.declaredIn} in ${models.source}`,
    };
  }

  if (requested !== "") throw new Error(lookup.reason);

  const live = ctx.getContextUsage()?.contextWindow ?? 0;
  if (live <= 0) throw new Error(lookup.reason);
  return {
    contextWindow: live,
    model: modelId,
    source: `the live session; PI's own catalogue, since ${models.source} declares no window for it`,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Per-session state
 * ------------------------------------------------------------------------------------------- */

const guards = new Map<string, LoopGuardState>();

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

/**
 * Runs PI's own `compact()` with our merged instructions and returns the result for PI to append.
 *
 * Returning `undefined` means "PI, do it yourself" — every such path announces first, so the
 * degradation is loud. It is never silent, and it never substitutes a different provider or model:
 * the call uses `ctx.model`, exactly what the session is already using.
 */
async function summariseWithContract(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<BeforeCompactResult | undefined> {
  const model = ctx.model;
  if (!model) {
    surfaceOnce(ctx, "compaction:no-model", () =>
      announce(ctx, "no active model — PI's default compaction runs without the keep/drop contract", "error"),
    );
    return undefined;
  }

  // A provider registered with its own native stream function cannot be reproduced from here:
  // `compact()` takes a `streamFn` and PI passes `agent.streamFunction`, which extensions cannot
  // read. Rather than route the summary through the wrong transport, hand the pass back to PI.
  try {
    if (ctx.modelRegistry.getRegisteredNativeProvider(model.provider)) {
      surfaceOnce(ctx, `compaction:native-provider:${model.provider}`, () =>
        announce(
          ctx,
          `provider "${model.provider}" is registered with a native stream handler; the keep/drop ` +
            `contract is not applied to compaction on it (PI's own summariser runs instead)`,
          "warning",
        ),
      );
      return undefined;
    }
  } catch (err) {
    surfaceOnce(ctx, "compaction:native-provider-probe", () =>
      announce(ctx, `could not probe native providers: ${describeError(err)}`, "warning"),
    );
  }

  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    surfaceProviderFailure(
      ctx,
      buildProviderFailure({
        provider: model.provider,
        model: model.id,
        message: `credential resolution threw while preparing a compaction summary: ${describeError(err)}`,
        cause: err,
      }),
    );
    return undefined;
  }
  if (!auth.ok) {
    surfaceProviderFailure(
      ctx,
      buildProviderFailure({
        provider: model.provider,
        model: model.id,
        message: `cannot resolve credentials for a compaction summary: ${auth.error}`,
      }),
    );
    return undefined;
  }

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
      ctx.thinkingLevel,
    );
    return { compaction: result };
  } catch (err) {
    if (event.signal.aborted) {
      // A cancelled compaction is not a failure. PI re-checks the signal immediately after us.
      return undefined;
    }
    surfaceProviderFailure(
      ctx,
      buildProviderFailure({
        provider: model.provider,
        model: model.id,
        message: `compaction summary with the keep/drop contract failed: ${describeError(err)}`,
        cause: err,
      }),
    );
    return undefined;
  }
}

/* ---------------------------------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------------------------------- */

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    try {
      guards.set(sid(ctx), createLoopGuardState());
      reportThreshold(ctx);
    } catch (err) {
      announce(ctx, `session_start failed internally and was skipped: ${describeError(err)}`, "error");
    }
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
        return await summariseWithContract(event, ctx);
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
  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
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
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    guards.delete(sid(ctx));
  });

  /**
   * `REQ-CTX-31`'s absolute threshold is a *stated intent*, not a lever — PI's `shouldCompact()`
   * only ever knows `contextWindow - reserveTokens` (see this module's header and `threshold.ts`).
   * So what this command does is state the intent that matches the model actually in use, instead
   * of leaving a number chosen for a different one standing. It moves no trigger.
   *
   * What it writes is `contextWindow - reserveTokens`, **not** the window itself. The window is
   * where the number comes from; the trigger is what the number is compared against, and writing
   * the window would state an intent that PI can never meet — `thresholdReport()` would then read
   * `effectiveTrigger < configuredAbsolute` and call it `window-too-small` on every model whose
   * window is small enough for the reserve to exceed the 20 % tolerance (a 64k model, with the
   * 16384-token default reserve, diverges by 26 %). That verdict's own remedy line says no PI
   * 0.84.0 setting closes the gap, which would be true and permanent and entirely self-inflicted.
   * Subtracting the reserve makes `effectiveTrigger === configuredAbsolute` by construction, which
   * is exactly what `aligned` is for.
   */
  pi.registerCommand("autocompact", {
    description:
      "Align the compaction threshold with a model's declared context window (window - reserve): " +
      "/autocompact [model-id], defaulting to the current model. Writes config/compaction.json, so " +
      "it persists across sessions.",
    handler: async (args: string, ctx) => {
      try {
        const path = loaded.source;
        if (path === undefined) {
          throw new Error(
            `no config/compaction.json exists to write to (looked in ${configPaths().join(", ")}); ` +
              `this session is running on the built-in defaults.`,
          );
        }
        const target = resolveTargetWindow(ctx, args.trim());
        const reserve = readReserveTokens({
          observed: lastReserveTokens,
          agentDir: configDir(),
          cwd: ctx.cwd,
          configDirName: CONFIG_DIR_NAME,
        });
        const absolute = target.contextWindow - reserve.value;
        if (absolute <= 0) {
          throw new Error(
            `${target.model} declares a ${target.contextWindow}-token window, which is at or below ` +
              `the ${reserve.value}-token reserve [${reserve.source}]; there is no threshold that ` +
              `would leave room for a turn. Nothing was written.`,
          );
        }
        const previous = activeThreshold.absoluteTokens;
        writeAbsoluteTokens(path, absolute);
        activeThreshold = { ...activeThreshold, absoluteTokens: absolute };

        announce(
          ctx,
          [
            `Compaction threshold set to ${absolute} tokens ` +
              `(${target.model}: window ${target.contextWindow} - reserve ${reserve.value} ` +
              `[${reserve.source}]; was ${previous})`,
            `  read from  : ${target.source}`,
            `  written to : ${path} (a tracked file, so commit it to keep the change)`,
            `  note       : this moves no trigger. PI already compacts above ${absolute} tokens on ` +
              `this model; what changed is that REQ-CTX-31 now states that number instead of one ` +
              `chosen for a different model, so /compaction-status reads "aligned".`,
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
        `  ${thresholdLine(ctx)}`,
        `  /autocompact [model-id] sets that configured absolute to this model's declared window minus the reserve`,
      ];
      announce(ctx, lines.join("\n"), "info");
    },
  });
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

/**
 * `EXT-05` — async-run reconciliation: making a dead background subagent visible.
 *
 * ## The defect this exists for
 *
 * `pi-subagents` acknowledges an async dispatch with a promise about the future:
 *
 *   > The async run is detached and running in the background.
 *   > Pi will wake you on completion when the run finishes or needs attention.
 *
 * The wake is the package's `result-watcher` -> `notify` path: the runner writes
 * `<tmp-root>/async-subagent-results/<runId>.json`, the watcher reads it, calls
 * `pi.sendMessage({ customType: "subagent-notify" })`, and unlinks the file **only** once
 * `sendMessage` was accepted (`node_modules/pi-subagents/src/runs/background/result-watcher.ts`
 * :251-303). When that path does not deliver, nothing at all enters the transcript, the
 * acknowledgement above is the only in-context evidence the orchestrator has, and it goes on
 * describing a run that died seconds ago as "running / awaiting result".
 *
 * That is not a hypothesis. It was measured on a real session, 2026-08-13: the result file for
 * every async run of that session was STILL on disk in `async-subagent-results/`, undeleted, with
 * `"state": "failed"` and the correct `sessionId` — i.e. written, never delivered — while the
 * session transcript contained zero `subagent-notify` entries. The orchestrator went on reporting
 * runs that had died within seconds as "awaiting a result", and only a direct question got the
 * truth out of it.
 *
 * ## What this module does about it, and what it deliberately does not
 *
 * It does **not** add a second lifecycle. The authoritative terminal state is already on disk in
 * `<asyncDir>/status.json`, written by the runner, and `subagent({action:"status", id})` reads it
 * correctly — verified in the same transcript, which returned `State: failed` with the step error
 * while the orchestrator was still calling the run active. The only thing missing is that nobody
 * reads it unless the model thinks to ask.
 *
 * So: remember where each async run of this session put its `status.json` (the package hands us
 * the path in the spawn tool result's `details.asyncDir`), re-read it at `turn_end`, and inject
 * one message for each run that has reached a terminal state and has not been reported yet. Read,
 * do not record: the state is the package's, the only thing kept here is where to look and what
 * has already been said.
 *
 * ## The mirror failure: announcing a run the model already read
 *
 * The safety net is only worth anything for a run the model was never told about. Measured
 * 2026-08-26, the other side of it: for one async run the model called `subagent_wait` (which
 * returned `done. Outcome: 1 complete`), then `subagent({action:"status"})` (`State: complete`),
 * then read the run's `output-0.log`, then closed the matching todo — and the announcement arrived
 * two minutes later telling it to "read the artifact above". Nothing in the fleet knew any of that
 * had happened, because the only suppression was `announced`, a set nothing but the fleet itself
 * writes. The announcement was not so much late as unconditional; what was missing is state, not
 * timing, and `noteAsyncConsumption` supplies it.
 *
 * Pure data in, pure data out apart from `readFileSync` — no PI imports, so it is unit-tested
 * against real files in a scratch directory, like `registry.ts`.
 */
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { reorderFailureText } from "./failure-slot.ts";

/**
 * `AsyncStatus.state`, verbatim from `node_modules/pi-subagents/src/shared/types.ts:1239`:
 * `"queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected"`.
 *
 * `paused` is NOT terminal — a paused run can be resumed and reach a real end, and announcing it
 * once here would consume its one announcement and hide the real ending. It is reported as live.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(["complete", "failed", "stopped", "rejected"]);

/** What we keep per async run: where to look, what to call it, when we first saw it. Never its state. */
export interface TrackedAsyncRun {
  readonly runId: string;
  readonly asyncDir: string;
  readonly agent?: string;
  /** `Date.now()` at the moment the spawn result was seen — the clock the `no-status` grace uses. */
  readonly firstSeenAt: number;
}

export type AsyncRunVerdict =
  /** `status.json` says the run is still queued, running or paused. Nothing to report yet. */
  | { readonly kind: "live"; readonly state: string }
  /** The run finished, one way or another. `failed` covers `failed`, `stopped` and `rejected`. */
  | {
      readonly kind: "terminal";
      readonly state: string;
      readonly failed: boolean;
      readonly agent?: string;
      readonly error?: string;
      readonly turns?: number;
      readonly durationMs?: number;
      readonly outputFile?: string;
      readonly statusFile: string;
    }
  /**
   * There is no readable `status.json` at all. This is the case the brief calls "never started":
   * the package handed back a run id and a directory, and the runner then never recorded a start.
   * It is reported separately from `terminal` precisely so the two cannot be confused.
   */
  | { readonly kind: "no-status"; readonly reason: string; readonly statusFile: string };

/** One reconciled run: what we tracked plus what the disk says. */
export interface AsyncRunReport {
  readonly run: TrackedAsyncRun;
  readonly verdict: AsyncRunVerdict;
}

/** Per-session tracker. Held by `register()`, not by `State` — see `index.ts`'s wiring. */
export interface AsyncFleet {
  readonly tracked: Map<string, TrackedAsyncRun>;
  readonly announced: Set<string>;
  /** Runs the model has already inspected itself, which therefore need no announcement. */
  readonly consumed: Set<string>;
}

export function createAsyncFleet(): AsyncFleet {
  return { tracked: new Map(), announced: new Set(), consumed: new Set() };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Agent names as the async acknowledgement states them: `Async: data-engineer [<runId>]` is its
 * first line, and for a single async spawn it is the ONLY place the name appears — the `details`
 * object carries `asyncId`/`asyncDir` but no `agent`. Without this the fleet can only name a run
 * once its `status.json` has steps, i.e. never for a run that dies before starting.
 */
const ASYNC_ACK = /^Async:\s+(\S[^[\n]*?)\s+\[([^\]\s]+)\]/gm;

function agentNamesFromText(result: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const content = record(result)?.content;
  if (!Array.isArray(content)) return names;
  for (const entry of content) {
    const text = str(record(entry)?.text);
    if (text === undefined) continue;
    for (const match of text.matchAll(ASYNC_ACK)) {
      if (match[2] !== undefined && match[1] !== undefined) names.set(match[2], match[1]);
    }
  }
  return names;
}

/**
 * Pulls every async run out of one dispatch tool result.
 *
 * The shape is the package's own, not ours: a spawned async run reports `asyncId` + `asyncDir` in
 * `details` (`pi-subagents` `Details`, seen verbatim in the transcript this module was written
 * from). A `workflowScript` or chain reports its children under `details.results[]`, so that array
 * is scanned too. Anything without BOTH an id and a directory is ignored — a control action
 * (`action: "status"`) launches nothing and must not be tracked as a run.
 */
export function trackedAsyncRuns(result: unknown, now: number = Date.now()): TrackedAsyncRun[] {
  const details = record(record(result)?.details);
  if (!details) return [];
  const names = agentNamesFromText(result);

  const found: TrackedAsyncRun[] = [];
  const take = (source: Record<string, unknown>): void => {
    const runId = str(source.asyncId) ?? str(source.runId);
    const asyncDir = str(source.asyncDir);
    if (runId === undefined || asyncDir === undefined) return;
    const agent = str(source.agent) ?? names.get(runId);
    found.push({ runId, asyncDir, firstSeenAt: now, ...(agent !== undefined ? { agent } : {}) });
  };

  take(details);
  const results = details.results;
  if (Array.isArray(results)) {
    for (const entry of results) {
      const child = record(entry);
      if (child) take(child);
    }
  }
  return found;
}

/** Adds newly seen runs to the fleet. Returns the ids that were not already tracked. */
export function noteAsyncSpawn(fleet: AsyncFleet, result: unknown, now: number = Date.now()): string[] {
  const added: string[] = [];
  for (const run of trackedAsyncRuns(result, now)) {
    if (fleet.tracked.has(run.runId)) continue;
    fleet.tracked.set(run.runId, run);
    added.push(run.runId);
  }
  return added;
}

/**
 * Reads `<asyncDir>/status.json` and classifies it. Never throws: an unreadable status file is a
 * verdict (`no-status`), because "we cannot see the run" and "the run is fine" must not look the
 * same to the caller — that conflation is the whole bug.
 */
export function readAsyncRunState(run: TrackedAsyncRun): AsyncRunVerdict {
  const statusFile = join(run.asyncDir, "status.json");
  let status: Record<string, unknown> | undefined;
  try {
    status = record(JSON.parse(readFileSync(statusFile, "utf8")) as unknown);
    if (!status) return { kind: "no-status", reason: "status.json is not an object", statusFile };
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "no status.json was ever written"
      : `status.json is unreadable: ${(err as Error).message}`;
    return { kind: "no-status", reason, statusFile };
  }

  const state = str(status.state);
  if (state === undefined) {
    return { kind: "no-status", reason: "status.json carries no `state`", statusFile };
  }
  if (!TERMINAL_STATES.has(state)) return { kind: "live", state };

  // The run-level `error` is a summary ("Step failed: data-engineer"); the step-level one is the
  // cause ("Subagent produced no output …"). Prefer the cause, fall back to the summary.
  const steps = Array.isArray(status.steps) ? status.steps.map(record) : [];
  const failedStep = steps.find((step) => step !== undefined && str(step.error) !== undefined);
  const raw = str(failedStep?.error) ?? str(status.error);
  // What that cause actually holds is the child's whole stderr tail, startup notices first (see
  // `failure-slot.ts`). Lead with the classified provider abort when there is one; the tail follows
  // in full, and `status.json` at `statusFile` keeps the untouched original either way.
  const error = raw === undefined ? undefined : (reorderFailureText(raw) ?? raw);
  const agent = str(failedStep?.agent) ?? run.agent;
  const startedAt = num(status.startedAt);
  const endedAt = num(status.endedAt);

  return {
    kind: "terminal",
    state,
    failed: state !== "complete",
    ...(agent !== undefined ? { agent } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(num(status.turnCount) !== undefined ? { turns: num(status.turnCount)! } : {}),
    ...(startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? { durationMs: endedAt - startedAt }
      : {}),
    ...(str(status.outputFile) !== undefined ? { outputFile: str(status.outputFile)! } : {}),
    statusFile,
  };
}

/**
 * Every tracked run's current verdict, read fresh from disk. Ordered by insertion, so the message
 * reads in dispatch order.
 */
export function reconcile(fleet: AsyncFleet): AsyncRunReport[] {
  return [...fleet.tracked.values()].map((run) => ({ run, verdict: readAsyncRunState(run) }));
}

/**
 * Every string this tool result put in front of the model, shallow: the text parts plus the
 * top-level string values of `details`. Both halves are needed — `subagent_wait` and
 * `subagent({action:"status"})` name the run in their text, while a read of the run's artifact
 * names it only in `details.path`.
 */
function shownStrings(result: unknown): string[] {
  const outer = record(result);
  const shown: string[] = [];
  const content = outer?.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      const text = str(record(entry)?.text);
      if (text !== undefined) shown.push(text);
    }
  }
  const details = record(outer?.details);
  if (details) {
    for (const value of Object.values(details)) {
      const text = str(value);
      if (text !== undefined) shown.push(text);
    }
  }
  return shown;
}

/**
 * Marks the runs this tool result showed the model, so they are not announced at it again.
 *
 * The announcement exists for the run nobody told the model about. Repeating it for a run the model
 * has just read is not merely noise: it lands a turn or more later and contradicts nothing, so the
 * model has to reconcile a stale instruction ("read the artifact") against work it already did. A
 * run counts as consumed when a result names its id or names a path inside its directory — a
 * `subagent_wait`, a `subagent({action:"status"})` and a read of `<asyncDir>/output-0.log` each do
 * one or the other — AND its own `status.json` is terminal at that moment. That second condition is
 * the point: polling a run that is still running says nothing about how it ends, so it must not
 * spend the run's one announcement. The result that INTRODUCED a run never consumes it — the spawn
 * acknowledgement names the id too, and it is the reason the run is tracked at all.
 */
export function noteAsyncConsumption(fleet: AsyncFleet, result: unknown, now: number = Date.now()): string[] {
  if (fleet.tracked.size === 0) return [];
  const shown = shownStrings(result);
  if (shown.length === 0) return [];
  const introduced = new Set(trackedAsyncRuns(result, now).map((run) => run.runId));

  const consumed: string[] = [];
  for (const run of fleet.tracked.values()) {
    if (introduced.has(run.runId)) continue;
    if (fleet.consumed.has(run.runId) || fleet.announced.has(run.runId)) continue;
    const shows = shown.some(
      (text) => text.includes(run.runId) || text === run.asyncDir || text.startsWith(`${run.asyncDir}${sep}`),
    );
    if (!shows) continue;
    if (readAsyncRunState(run).kind !== "terminal") continue;
    fleet.consumed.add(run.runId);
    consumed.push(run.runId);
  }
  return consumed;
}

/**
 * How long a run may exist without a readable `status.json` before that counts as "never started"
 * rather than "has not written it yet". The spawn returns before the child process has necessarily
 * touched the directory, so announcing `no-status` on the same turn would be a race, not a report.
 */
export const NO_STATUS_GRACE_MS = 5_000;

/**
 * The runs that must be announced now, marking them announced.
 *
 * A terminal verdict is announced immediately — the state file is the runner's own word and needs
 * no grace. A `no-status` verdict waits out `NO_STATUS_GRACE_MS` from `firstSeenAt`, so a run that
 * is merely slow to write its first status file is not reported as dead.
 */
export function takeAnnouncements(
  fleet: AsyncFleet,
  reports: readonly AsyncRunReport[],
  now: number = Date.now(),
  graceMs: number = NO_STATUS_GRACE_MS,
): AsyncRunReport[] {
  const due: AsyncRunReport[] = [];
  for (const report of reports) {
    if (report.verdict.kind === "live") continue;
    if (fleet.announced.has(report.run.runId) || fleet.consumed.has(report.run.runId)) continue;
    if (report.verdict.kind === "no-status" && now - report.run.firstSeenAt < graceMs) continue;
    fleet.announced.add(report.run.runId);
    due.push(report);
  }
  return due;
}

export function shortId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function formatDuration(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function line(report: AsyncRunReport): string {
  const { run, verdict } = report;
  if (verdict.kind === "no-status") {
    return (
      `  ? ${run.agent ?? "subagent"} [${shortId(run.runId)}] NEVER STARTED — ${verdict.reason}. ` +
      `Expected at ${verdict.statusFile}`
    );
  }
  if (verdict.kind === "live") return "";
  const parts = [
    `${verdict.failed ? "✗" : "✓"} ${verdict.agent ?? run.agent ?? "subagent"} [${shortId(run.runId)}] ${verdict.state}`,
  ];
  if (verdict.turns !== undefined) parts.push(`${verdict.turns} turn(s)`);
  if (verdict.durationMs !== undefined) parts.push(formatDuration(verdict.durationMs));
  const head = `  ${parts.join(" · ")}`;
  const why = verdict.error !== undefined ? `\n      error: ${verdict.error}` : "";
  const where = verdict.outputFile !== undefined ? `\n      output: ${verdict.outputFile}` : "";
  return `${head}${why}${where}`;
}

/**
 * The message injected into the session. Written for the orchestrating model, so it says the one
 * thing the broken wake let it get wrong: these runs are over, stop describing them as running.
 */
export function formatAnnouncement(reports: readonly AsyncRunReport[]): string | undefined {
  const due = reports.filter((r) => r.verdict.kind !== "live");
  if (due.length === 0) return undefined;
  const anyBad = due.some((r) => r.verdict.kind === "no-status" || (r.verdict.kind === "terminal" && r.verdict.failed));
  return [
    `Async subagent run(s) reached a terminal state (read from each run's own status.json):`,
    ...due.map(line),
    ``,
    anyBad
      ? `These runs are NOT running and will deliver nothing further. Do not report them as ` +
        `active or awaiting a result. Read the artifact above, or re-dispatch — and say plainly ` +
        `that the first attempt failed.`
      : `These runs are finished. Read the artifact above rather than waiting for them.`,
  ].join("\n");
}

/**
 * The `/agents` section: every async run this session started, with the state its own status file
 * reports right now. This is the human-facing twin of the message above — the point of both is
 * that the state is re-read, never remembered.
 */
export function renderAsyncFleet(fleet: AsyncFleet): string {
  if (fleet.tracked.size === 0) return "";
  const reports = reconcile(fleet);
  const rows = reports.map((report) => {
    const { run, verdict } = report;
    const named = verdict.kind === "terminal" ? verdict.agent : undefined;
    const label = `${named ?? run.agent ?? "subagent"} [${shortId(run.runId)}]`;
    if (verdict.kind === "live") return `  ${label}: ${verdict.state} (live)`;
    if (verdict.kind === "no-status") return `  ${label}: NEVER STARTED — ${verdict.reason}`;
    const why = verdict.error !== undefined ? ` — ${verdict.error}` : "";
    return `  ${label}: ${verdict.state}${why}`;
  });
  return ["", `async runs started by this session (${fleet.tracked.size}):`, ...rows].join("\n");
}

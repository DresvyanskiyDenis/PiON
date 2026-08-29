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
 *
 * That reasoning holds only while there is still a runner that could resume it. Once the runner has
 * provably exited, the run stays paused forever unless a person restarts it, and treating it as
 * live is what let 106 of them sit on one panel for four and a half hours. `abandonedPause` is
 * where that case is recognised; the verdict deliberately stays `live`, because the run really can
 * still be resumed from disk and calling it `terminal` would put a false ending into an
 * announcement.
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
  /**
   * When each settled run was first *seen* to be settled — the clock `retireSettledRuns` counts
   * from. Stamped lazily on the first sweep that finds a run both finished and told about, so
   * nothing else in this module has to carry a second timestamp around. Entries leave with their
   * run.
   */
  readonly settledAt: Map<string, number>;
}

export function createAsyncFleet(): AsyncFleet {
  return { tracked: new Map(), announced: new Set(), consumed: new Set(), settledAt: new Map() };
}

/**
 * Whether this run is in the ledger: announced to the model, or read by it.
 *
 * Those two sets are the "say it once" record, and they are deliberately NOT swept with the runs
 * they name — they are ids, a few dozen bytes each, and they are what stops a retired run from
 * being tracked or announced a second time. What grows without bound and costs something is
 * `tracked`, because every entry in it is a `readFileSync` on every repaint.
 */
function ledgered(fleet: AsyncFleet, runId: string): boolean {
  return fleet.announced.has(runId) || fleet.consumed.has(runId);
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
    // `ledgered` as well as `tracked`: a retired run's spawn result must not resurrect it.
    if (fleet.tracked.has(run.runId) || ledgered(fleet, run.runId)) continue;
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
    if (ledgered(fleet, run.runId)) continue;
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
    if (ledgered(fleet, report.run.runId)) continue;
    if (report.verdict.kind === "no-status" && now - report.run.firstSeenAt < graceMs) continue;
    fleet.announced.add(report.run.runId);
    due.push(report);
  }
  return due;
}

/**
 * How long a settled run stays in the fleet after it ends.
 *
 * Long enough that a run is seen to finish on a panel repainting at 1 Hz, short enough that a
 * session which dispatched fifty runs is not still reading fifty status files a second an hour
 * later. Nothing is lost at the end of it: the run directory stays on disk and `/subagents-fleet`
 * re-derives past runs from it, which is exactly why this module can afford to forget them.
 */
export const SETTLED_TTL_MS = 120_000;

/**
 * Removes runs that are over, so the fleet stops growing for the life of the session.
 *
 * ## The defects
 *
 * **Runs that reached a terminal state.** Nothing ever deleted from `tracked`. Every completed,
 * failed and never-started run stayed in it until the session ended, and three separate things are
 * a function of its size:
 *
 *   - `reconcile` does one `readFileSync` of `status.json` per tracked run, and the panel calls it
 *     once a second (`fleet-widget.ts` `POLL_MS`). Fifty finished runs is fifty synchronous reads
 *     per second, forever, of files that can no longer change.
 *   - `renderFleetPanel` returns `undefined` — the signal the widget's poll uses to stop itself —
 *     only when `tracked.size === 0`. With nothing ever removed that never happened again, so the
 *     poll's own promise that "an idle session carries no timer" was false the moment a session
 *     dispatched its first async run.
 *   - the panel shows runs in insertion order, oldest first. Past nine tracked runs it is full of
 *     history and the RUNNING children are the ones behind "… and N more" — the exact outcome its
 *     own comment calls worse than saying less about each.
 *
 * **Paused runs whose runner is gone.** `paused` is not in `TERMINAL_STATES`, so such a run is
 * classified `live` and was skipped here forever — because the only process that could have
 * changed that status is the one that exited. Observed: 106 such records on one panel, the oldest
 * 276 minutes old, every one of them rendered as a running child.
 *
 * ## The rule
 *
 * A **finished** run — `terminal` or `no-status` — is retired when it is in the ledger, i.e. the
 * model has been told about it or has read it itself, AND `SETTLED_TTL_MS` has passed since the
 * first sweep that saw both. Its id stays in `announced`/`consumed`, so it can never be re-tracked
 * or re-announced.
 *
 * An **abandoned pause** is retired on the TTL alone, and the ledger gate is deliberately skipped
 * for it. That gate exists so nothing is dropped before the model hears its ending, and such a run
 * has no ending to hear: `takeAnnouncements` returns early on every `live` verdict, so a paused run
 * is never announced, and `consumed` is only stamped for a run whose own `status.json` is terminal.
 * Requiring the ledger here would be requiring something that can never happen — the 106-record
 * panel with the gate left in place is the same 106-record panel.
 *
 * The verdicts are passed in rather than re-read: the caller has just reconciled, and re-reading
 * the same status files to decide whether to stop reading them would be its own joke. The one file
 * read here is a different one — `process-terminal.json`, which `reconcile` never opens — and only
 * for the runs `status.json` calls `paused`, which is a handful even on the panel that prompted it.
 */
export function retireSettledRuns(
  fleet: AsyncFleet,
  reports: readonly AsyncRunReport[],
  now: number = Date.now(),
  ttlMs: number = SETTLED_TTL_MS,
): string[] {
  const retired: string[] = [];
  for (const { run, verdict } of reports) {
    const abandoned = abandonedPause(run, verdict);
    if (verdict.kind === "live" && !abandoned) {
      // Not settled, and must not be treated as such later either: a run that was `no-status`
      // during its grace and has since come up is starting, not ending.
      fleet.settledAt.delete(run.runId);
      continue;
    }
    if (!abandoned && !ledgered(fleet, run.runId)) continue;
    const since = fleet.settledAt.get(run.runId);
    if (since === undefined) {
      fleet.settledAt.set(run.runId, now);
      continue;
    }
    if (now - since < ttlMs) continue;
    fleet.tracked.delete(run.runId);
    fleet.settledAt.delete(run.runId);
    retired.push(run.runId);
  }
  return retired;
}

/** The four states `process-terminal.json` may carry (`process-terminal.ts:146`). */
const PROOF_STATES: ReadonlySet<string> = new Set(["pending", "observed", "unknown", "not-started"]);

/**
 * The runner's own record of its exit: `<asyncDir>/process-terminal.json`'s `state`.
 *
 * `"observed"` is the only value that means the runner process is gone and was *seen* to go. The
 * package writes the file itself (`node_modules/pi-subagents/src/runs/background/process-terminal.ts`,
 * `processTerminalPath` at `:68`) and validates `observed` hard: it must carry a finite `observedAt`
 * and an `instances` array containing a `runner` entry whose `processInstanceId` matches the
 * proof's own (`validateProof`, `:156-161`), each instance carrying `closeObservedAt`, `exitCode`
 * and `signal` (`validProcessInstance`, `:37-44`). The other three states are `pending`, `unknown`
 * and `not-started`, and none of them is evidence of an exit.
 *
 * `undefined` when the file is absent, unparseable, or carries none of the four states — every one
 * of which means "cannot say", never "the runner is gone". This reader deliberately does not import
 * the package's own `readProcessTerminal`: that one is `src/`-only TypeScript inside `node_modules`,
 * it throws on a proof whose `runId` disagrees with the caller's, and it fabricates an `unknown`
 * proof out of a read error — three behaviours this module does not want at 1 Hz.
 */
export function readRunnerExit(run: TrackedAsyncRun): string | undefined {
  try {
    const proof = record(JSON.parse(readFileSync(join(run.asyncDir, "process-terminal.json"), "utf8")) as unknown);
    const state = proof === undefined ? undefined : str(proof.state);
    return state !== undefined && PROOF_STATES.has(state) ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `paused` run whose runner has provably exited — settled in every sense that matters to a panel,
 * and still resumable on disk.
 *
 * ## Why the exit proof and not the pid
 *
 * The obvious probe is `process.kill(pid, 0)` against the `pid` in `status.json`. It is not used
 * here, and the reason is not taste:
 *
 *   - **pid reuse makes it unsound in the wrong direction.** A pid freed hours ago is very likely
 *     reissued to an unrelated process, and the probe then reports the dead runner as alive. That
 *     is precisely the failure being fixed, made permanent and undiagnosable.
 *   - **`EPERM` reads as alive.** `kill` on a pid owned by another user throws `EPERM`, not
 *     `ESRCH`, so a reused pid outside this uid is "alive" too.
 *   - **the field is optional.** `pid` is `pid?: number` on the package's status shapes
 *     (`node_modules/pi-subagents/src/shared/types.ts:1497`, `:1548`), so an AND-condition on it
 *     cannot fire at all for a run whose status file never carried one.
 *   - **the proof is strictly better evidence.** `state: "observed"` is not an inference from a
 *     pid's absence; it is the runner's close, recorded with `closeObservedAt`, `exitCode` and
 *     `signal` at the moment it happened, by the code that owns the process. Second-guessing it
 *     with a syscall — once per tracked run per second, on the panel's poll — would add cost and
 *     subtract certainty.
 *
 * The proof carries no pid at all, which settles the question: there is nothing to AND against.
 *
 * ## What retiring does and does not do
 *
 * It removes the run from `fleet.tracked`. The directory, its `status.json`, its session file and
 * its resumability are untouched — the package's own `resumeDisposition` still calls a paused run
 * with a live session file `resumable` (`process-terminal.ts:128-131`) — and `/subagents-fleet`
 * still lists it, because that view re-derives runs from disk.
 */
export function abandonedPause(run: TrackedAsyncRun, verdict: AsyncRunVerdict): boolean {
  if (verdict.kind !== "live" || verdict.state !== "paused") return false;
  return readRunnerExit(run) === "observed";
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
 * The `/agents` section: every async run this session is still tracking, with the state its own
 * status file reports right now. This is the human-facing twin of the message above — the point of
 * both is that the state is re-read, never remembered.
 *
 * "Still tracking", not "ever started": a run that ended and was reported is retired after
 * `SETTLED_TTL_MS` (`retireSettledRuns`). The durable list of past runs is `/subagents-fleet`,
 * which re-derives it from the run directories on disk — the pointer `index.ts` already prints
 * under this section.
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
  return ["", `async runs tracked by this session (${fleet.tracked.size}):`, ...rows].join("\n");
}

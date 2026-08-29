/**
 * EXT-24 — the cross-session job directory.
 *
 * `pi-subagents` (async runs) is **session-scoped**: its state lives in the process that started
 * the work, so a job is invisible from any other session and dies with its parent. This module
 * is the part it does not have — a directory under the harness state root that any session can read,
 * that outlives the `pi` process that created it, and that a second session can poll, tail
 * and kill.
 *
 * ```
 * <state>/jobs/<id>/
 *   state.json     {schema, id, kind, cmd, cwd, pid, pgid, status, startedAt, …}
 *   cmd.sh         the command, verbatim — never re-quoted into a shell string
 *   stdout.log     appended by the child, tail-readable while running
 *   stderr.log
 *   exit           the child's real exit code, written by the wrapper on any exit path
 *   lock           the mutex (`lock.ts`, built on EXT-01's `detach.ts` lock)
 * ```
 *
 * **Not `<scratch>/jobs`.** An earlier draft writes `join(scratchDir(ctx),
 * "..", "jobs")`, which lands in `<state>/scratch/jobs` — inside the tree whose whole purpose
 * is per-session disposal. A cross-session store cannot live under the per-session scratch
 * parent, so it sits beside it at `<state>/jobs`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "../lib/paths.ts";
import { describeError } from "../lib/once.ts";
import { isProcessAlive, withJobLock } from "./lock.ts";

/** Bumped whenever the on-disk shape changes; an older reader refuses rather than guesses. */
export const JOB_SCHEMA = 2;

/** A job may not spawn a job whose parent chain exceeds this depth. */
export const MAX_DEPTH = 2;

export const JOB_ID_ENV = "PI_JOB_ID";
export const JOB_DEPTH_ENV = "PI_JOB_DEPTH";

/** Grace between SIGTERM and SIGKILL when killing a job's process group. */
export const KILL_GRACE_MS = 2_000;

/** Default retention window for `pruneJobs`, both the manual `job(action="prune")` call and the
 *  automatic sweep `index.ts` runs at every `session_start` — a store nothing owns needs a
 *  default nothing has to configure. */
export const DEFAULT_PRUNE_HOURS = 7 * 24;
export const AUTO_PRUNE_HOURS_ENV = "PI_JOBS_PRUNE_HOURS";

/**
 * The retention window `session_start`'s automatic prune uses, in hours. `PI_JOBS_PRUNE_HOURS`
 * overrides `DEFAULT_PRUNE_HOURS`; `0` prunes every terminal job on every session start
 * (a valid, if aggressive, choice) rather than being read as "unset". Throws rather than
 * silently falling back on a non-numeric or negative value — a typo'd env var should not
 * quietly disable or shorten retention.
 */
export function autoPruneRetentionHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AUTO_PRUNE_HOURS_ENV];
  if (raw === undefined) return DEFAULT_PRUNE_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${AUTO_PRUNE_HOURS_ENV} is ${JSON.stringify(raw)}, which is not a non-negative number`);
  }
  return parsed;
}

export type JobKind = "bash" | "agent";
export type JobStatus = "running" | "done" | "failed" | "killed";

export interface JobState {
  readonly schema: number;
  readonly id: string;
  readonly kind: JobKind;
  readonly cwd: string;
  readonly cmd: string;
  /** Free-text label, and for `kind: "agent"` the agent name. Reporting only. */
  readonly agent?: string;
  readonly prompt?: string;
  readonly label?: string;
  readonly pid: number;
  /** `detached: true` makes the child a process-group leader, so pgid === pid on POSIX. */
  readonly pgid: number;
  readonly status: JobStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly exitCode?: number;
  readonly parentSession: string;
  readonly parentJob?: string;
  readonly depth: number;
  /** Set when the reaper had to infer the outcome; always surfaced, never swallowed. */
  readonly note?: string;
}

/** A job directory that exists but cannot be read as schema `JOB_SCHEMA`. */
export interface JobProblem {
  readonly id: string;
  readonly reason: string;
}

export interface JobListing {
  readonly jobs: readonly JobState[];
  readonly problems: readonly JobProblem[];
}

/** `<state>/jobs`. Recomputed per call so a test can move `XDG_STATE_HOME`. */
export function jobsRoot(): string {
  return join(stateRoot(), "jobs");
}

export function jobDir(root: string, id: string): string {
  return join(root, id);
}

export async function ensureJobsRoot(root = jobsRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export function newJobId(now = Date.now()): string {
  return `${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export { isProcessAlive };

/**
 * Where this process sits in the job chain.
 *
 * Fails loud on a malformed `PI_JOB_DEPTH`: reading a garbage depth as 0 would silently
 * disarm the recursion guard, which is the fork-bomb this guard exists to prevent.
 *
 * Deviation from an earlier draft, which increments only when `PI_JOB_ID` is set — that
 * makes its own acceptance test D4 (`PI_JOB_DEPTH=2` alone) pass the guard. Either variable
 * means "inside a job".
 */
export function parseJobDepth(env: NodeJS.ProcessEnv = process.env): {
  parent?: string;
  depth: number;
} {
  const parent = env[JOB_ID_ENV];
  const raw = env[JOB_DEPTH_ENV];
  if (raw === undefined) return { parent, depth: parent === undefined ? 0 : 1 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${JOB_DEPTH_ENV} is ${JSON.stringify(raw)}, which is not a non-negative integer; ` +
        `refusing to start a job rather than disarming the recursion guard`,
    );
  }
  return { parent, depth: parsed + 1 };
}

export function assertDepthAllowed(depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new Error(
      `job: refused — depth ${depth} exceeds MAX_DEPTH=${MAX_DEPTH}; ` +
        `a background job may not spawn a chain deeper than ${MAX_DEPTH}`,
    );
  }
}

class JobSchemaError extends Error {}

function parseState(id: string, raw: string): JobState {
  const parsed = JSON.parse(raw) as Partial<JobState>;
  if (parsed.schema !== JOB_SCHEMA) {
    throw new JobSchemaError(
      `job ${id}: state.json is schema ${String(parsed.schema)}, this build reads ${JOB_SCHEMA}`,
    );
  }
  return parsed as JobState;
}

/** `undefined` when the job does not exist. Throws when it exists and cannot be read. */
export async function readState(root: string, id: string): Promise<JobState | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(root, id, "state.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`job ${id}: state.json is unreadable: ${describeError(err)}`, { cause: err });
  }
  return parseState(id, raw);
}

export function readStateSync(root: string, id: string): JobState | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(root, id, "state.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`job ${id}: state.json is unreadable: ${describeError(err)}`, { cause: err });
  }
  return parseState(id, raw);
}

/**
 * Atomic, and under the job's own lock.
 *
 * The rename is what makes a concurrent reader see either the old state or the new one and
 * never a half-written file; the lock is what stops two reapers racing a read-modify-write
 * and losing one of the updates.
 */
export async function writeState(root: string, state: JobState): Promise<void> {
  const dir = jobDir(root, state.id);
  await withJobLock(join(dir, "lock"), async () => {
    await writeStateUnlocked(dir, state);
  });
}

async function writeStateUnlocked(dir: string, state: JobState): Promise<void> {
  const tmp = join(dir, `state.json.${process.pid}.${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(dir, "state.json"));
}

interface ExitRecord {
  readonly code: number;
  /**
   * When the child actually exited, taken from the `exit` file's mtime.
   *
   * The wrapper writes and renames that file as its last act (`wrapCommand`), so its mtime is
   * the process's real exit time. Reading it is the only way a lazily reconciled store can
   * report *when* a job ended rather than when somebody happened to look.
   */
  readonly at: number;
}

function readExitRecord(dir: string): ExitRecord | undefined {
  const path = join(dir, "exit");
  let raw: string;
  let at: number;
  try {
    raw = readFileSync(path, "utf8");
    at = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const code = Number(raw.trim());
  return Number.isInteger(code) ? { code, at: Math.round(at) } : undefined;
}

/**
 * Decides a running job's real outcome, without writing.
 *
 * The `exit` file is consulted **before** pid liveness for two reasons: the pid may have been
 * recycled by an unrelated process (which would report a finished job as still running), and
 * the child may have exited in the microseconds between two checks.
 *
 * An earlier draft's `reap()` marks *every* completed job `failed` with `exitCode: -1`,
 * because nothing in that sketch ever writes a success. Here the wrapper installed by
 * `wrapCommand()` records the true code on every exit path, so a clean job reports `done`.
 *
 * `finishedAt` is the `exit` file's mtime, **not** `Date.now()`. Nothing observes the child
 * exit — this store is reconciled lazily, whenever a caller asks — so stamping the current time
 * here recorded when somebody looked and called it when the job ended, inflating every job's
 * apparent runtime by however long the store went unread. The one case with no ground truth is
 * a job whose wrapper never wrote an exit code at all; there `Date.now()` is unavoidable and the
 * `note` says so.
 */
export function judge(root: string, state: JobState): JobState {
  if (state.status !== "running") return state;
  const dir = jobDir(root, state.id);

  const exit = readExitRecord(dir);
  if (exit !== undefined) {
    return {
      ...state,
      status: exit.code === 0 ? "done" : "failed",
      exitCode: exit.code,
      finishedAt: state.finishedAt ?? exit.at,
    };
  }

  if (isProcessAlive(state.pid)) return state;

  return {
    ...state,
    status: "failed",
    exitCode: -1,
    finishedAt: state.finishedAt ?? Date.now(),
    note:
      `pid ${state.pid} is gone and no exit code was recorded — the job was killed by a ` +
      `signal that the wrapper could not survive (SIGKILL), or the machine restarted; ` +
      `finishedAt is when the loss was noticed, not when the process died`,
  };
}

/** `judge()` plus persistence of a state transition. Returns the current state either way. */
export async function reap(root: string, state: JobState): Promise<JobState> {
  const next = judge(root, state);
  if (next === state) return state;
  await writeState(root, next);
  return next;
}

function jobIds(entries: readonly string[]): string[] {
  return entries.filter((name) => !name.startsWith("."));
}

/** Every job in the store, from every session. Unreadable entries are reported, not hidden. */
export async function listJobs(root: string, options: { reap?: boolean } = {}): Promise<JobListing> {
  const entries = await readdir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw new Error(`jobs root ${root} is unreadable: ${describeError(err)}`, { cause: err });
  });

  const jobs: JobState[] = [];
  const problems: JobProblem[] = [];
  for (const id of jobIds(entries)) {
    try {
      const state = await readState(root, id);
      if (!state) continue;
      jobs.push(options.reap === false ? judge(root, state) : await reap(root, state));
    } catch (err) {
      problems.push({ id, reason: describeError(err) });
    }
  }
  jobs.sort((a, b) => b.startedAt - a.startedAt);
  return { jobs, problems };
}

/**
 * The synchronous, non-writing variant used by the `pi-subagents` provider protocols, whose
 * `listActiveWork()` / `listExternalRuns()` are synchronous by contract.
 */
export function listJobsSync(root: string): JobListing {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], problems: [] };
    throw new Error(`jobs root ${root} is unreadable: ${describeError(err)}`, { cause: err });
  }

  const jobs: JobState[] = [];
  const problems: JobProblem[] = [];
  for (const id of jobIds(entries)) {
    try {
      const state = readStateSync(root, id);
      if (state) jobs.push(judge(root, state));
    } catch (err) {
      problems.push({ id, reason: describeError(err) });
    }
  }
  jobs.sort((a, b) => b.startedAt - a.startedAt);
  return { jobs, problems };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The wrapper the job's shell actually runs.
 *
 * The user command is written to `cmd.sh` verbatim and executed from there, so no amount of
 * quoting in it can escape into the wrapper. The exit code is written through a temp file and
 * renamed, so a reader never sees a half-written `exit`.
 */
export function wrapCommand(dir: string): string {
  const script = shellQuote(join(dir, "cmd.sh"));
  const exitTmp = shellQuote(join(dir, "exit.tmp"));
  const exitFile = shellQuote(join(dir, "exit"));
  return `bash ${script}; code=$?; printf '%s' "$code" > ${exitTmp} && mv -f ${exitTmp} ${exitFile}; exit $code`;
}

export interface StartJobOptions {
  readonly root: string;
  readonly command: string;
  readonly cwd: string;
  readonly parentSession: string;
  readonly kind?: JobKind;
  readonly agent?: string;
  readonly prompt?: string;
  readonly label?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Where a late spawn failure is reported. Defaults to stderr. Never swallowed. */
  readonly onError?: (line: string) => void;
}

/**
 * Starts a detached job and returns once its `state.json` is on disk.
 *
 * `detached: true` + `unref()` is what makes the child outlive the `pi` process, and what
 * makes it a process-group leader so `kill(-pgid)` reaches the whole tree — the reason
 * `runDetached()` from `EXT-01` cannot be reused here is in `lock.ts`'s header.
 */
export async function startJob(options: StartJobOptions): Promise<JobState> {
  const { parent, depth } = parseJobDepth(options.env ?? process.env);
  assertDepthAllowed(depth);

  const root = await ensureJobsRoot(options.root);
  const id = newJobId();
  const dir = jobDir(root, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "cmd.sh"), `${options.command}\n`, { mode: 0o700 });

  const out = await open(join(dir, "stdout.log"), "a", 0o600);
  const err = await open(join(dir, "stderr.log"), "a", 0o600);
  const report = options.onError ?? ((line: string) => process.stderr.write(`${line}\n`));

  try {
    const child = spawn("bash", ["-lc", wrapCommand(dir)], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", out.fd, err.fd],
      env: {
        ...(options.env ?? process.env),
        [JOB_ID_ENV]: id,
        [JOB_DEPTH_ENV]: String(depth),
      },
    });

    if (child.pid === undefined) {
      throw new Error(`job ${id}: bash was spawned but reported no pid`);
    }

    const state: JobState = {
      schema: JOB_SCHEMA,
      id,
      kind: options.kind ?? "bash",
      cwd: options.cwd,
      cmd: options.command,
      agent: options.agent,
      prompt: options.prompt,
      label: options.label,
      pid: child.pid,
      pgid: child.pid,
      status: "running",
      startedAt: Date.now(),
      parentSession: options.parentSession,
      parentJob: parent,
      depth,
    };

    // A detached child that cannot start emits "error" asynchronously; with no listener Node
    // throws it as an unhandled event and takes the host process down (same trap as
    // `detach.ts`). The failure is recorded in the job's own state so a later session sees it.
    child.on("error", (spawnErr) => {
      const line = `[pi-config] jobs: job ${id} failed to start: ${describeError(spawnErr)}`;
      report(line);
      void writeState(root, {
        ...state,
        status: "failed",
        exitCode: -1,
        finishedAt: Date.now(),
        note: line,
      }).catch((writeErr: unknown) => {
        report(
          `[pi-config] jobs: job ${id} start-failure could not be recorded: ${describeError(writeErr)}`,
        );
      });
    });

    child.unref();
    // Written without the lock: the directory was created microseconds ago under a unique id,
    // so there is provably no other writer yet, and taking the lock here would only add a
    // failure mode to the one path that must not fail.
    await writeStateUnlocked(dir, state);
    return state;
  } finally {
    // Our copies of the descriptors; the child holds its own.
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
}

export interface KillResult {
  readonly state: JobState;
  readonly signalled: boolean;
}

/**
 * SIGTERM to the whole process group, SIGKILL after a grace period.
 *
 * The group, not the leader: `bash -lc 'sleep 300 & sleep 300'` leaves children that a
 * `kill(pid)` would orphan (acceptance D5).
 */
export async function killJob(
  root: string,
  state: JobState,
  options: { graceMs?: number } = {},
): Promise<KillResult> {
  const current = await reap(root, state);
  if (current.status !== "running") return { state: current, signalled: false };

  let signalled = false;
  try {
    process.kill(-current.pgid, "SIGTERM");
    signalled = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new Error(`job ${current.id}: SIGTERM to process group ${current.pgid} failed: ${describeError(err)}`, {
        cause: err,
      });
    }
  }

  if (signalled) {
    setTimeout(() => {
      try {
        process.kill(-current.pgid, "SIGKILL");
      } catch {
        // Already gone between the two signals — the only benign outcome here.
      }
    }, options.graceMs ?? KILL_GRACE_MS).unref();
  }

  const killed: JobState = {
    ...current,
    status: "killed",
    finishedAt: Date.now(),
    note: signalled ? undefined : `process group ${current.pgid} was already gone`,
  };
  await writeState(root, killed);
  return { state: killed, signalled };
}

export interface PruneOptions {
  /** Terminal jobs finished longer ago than this are removed. Default 7 days. */
  readonly olderThanMs?: number;
  readonly now?: number;
}

export interface PruneResult {
  readonly removed: readonly string[];
  readonly kept: number;
  readonly problems: readonly JobProblem[];
}

/**
 * Removes finished job directories. A running job is never removed.
 *
 * Not covered by an earlier draft, and needed: a store that no session owns is a store nothing
 * ever cleans up.
 */
export async function pruneJobs(root: string, options: PruneOptions = {}): Promise<PruneResult> {
  const cutoff = (options.now ?? Date.now()) - (options.olderThanMs ?? DEFAULT_PRUNE_HOURS * 60 * 60_000);
  const { jobs, problems } = await listJobs(root);
  const removed: string[] = [];
  for (const job of jobs) {
    if (job.status === "running") continue;
    if ((job.finishedAt ?? job.startedAt) > cutoff) continue;
    await rm(jobDir(root, job.id), { recursive: true, force: true });
    removed.push(job.id);
  }
  return { removed, kept: jobs.length - removed.length, problems };
}

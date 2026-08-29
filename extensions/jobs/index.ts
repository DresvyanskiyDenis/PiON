/**
 * EXT-24 — background jobs: the cross-session job directory (`REQ-CTX-45`, `REQ-EXT-52`).
 *
 * The agent face of background work is already packaged and is **not** rebuilt here:
 * `pi-subagents`' async runs — machine-readable lifecycle artifacts, `subagent_wait`, the
 * background-work registry.
 *
 * It is **session-scoped**. It does not survive the `pi` process that started the work, and it
 * is not discoverable from a different session. That gap is this module: `store.ts` owns
 * `<state>/jobs/<id>/`, this file exposes it as one `job` tool, and `registry.ts` publishes it
 * into `pi-subagents`' background-work and external-run registries so the packaged face can
 * see our jobs too.
 *
 * Auto-discovered as a standalone extension via the `extensions/<dir>/index.ts` subdirectory
 * pattern (same as `extensions/big-results/index.ts` and `extensions/tasks/index.ts`), so
 * `settings.json`'s `"extensions"` array needs no entry.
 *
 * A detached child is `unref()`d so it can outlive this process, which means nothing observes
 * its exit: the store is reconciled lazily, by whoever asks. `refresh()` used to be reached only
 * from `turn_end`, so a job that died while the session sat idle was announced at the *next* turn
 * somebody started — and never at all if nobody came back. The self-arming watcher below is the
 * missing push; see `announce()` for why delivery differs between an in-flight run and an idle
 * session.
 *
 * **Two surfaces, and they are not the same thing.** The footer carries a count — `2 bg`, via
 * `ctx.ui.setStatus` — and the fleet panel below the editor carries a *row per job*, via
 * `pi-subagents`' external-run registry (`registry.ts`). Only the second one depicts a job, and
 * for a while it depicted none: 0.57.0 moved that registry from a provider protocol to a record
 * protocol under a new symbol, so every job we published went into a global object nobody reads.
 * Both surfaces are now written wherever the store has just been read — `job(action=start)`,
 * `refresh()`, `session_start` — which is what makes a started job appear immediately instead of
 * at the next `turn_end`.
 *
 * `session_start` also auto-prunes finished jobs past `store.ts`'s retention window
 * (`PI_JOBS_PRUNE_HOURS`, default 7 days) — a cross-session store has no session responsible for
 * its own cleanup, so the sweep runs on every session rather than waiting for someone to run
 * `job(action="prune")` by hand. Kill authority is intentionally not scoped to the session that
 * started a job: `killJob` takes any job's state and signals its process group unconditionally,
 * because a job that outlives its parent session is exactly the case where a *different* session
 * is the one that needs to stop it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { openJobHistory } from "./history-view.ts";
import { publishExternalRuns, registerJobProviders, unpublishExternalRuns } from "./registry.ts";
import {
  AUTO_PRUNE_HOURS_ENV,
  autoPruneRetentionHours,
  ensureJobsRoot,
  jobDir,
  jobsRoot,
  killJob,
  listJobs,
  listJobsSync,
  pruneJobs,
  readState,
  reap,
  startJob,
  type JobState,
} from "./store.ts";

export const id = "jobs";

const DEFAULT_TAIL_LINES = 200;

/**
 * Ids this session has already nudged about.
 *
 * Module-level and per-session by construction: the nudge is a message into *this* session's
 * transcript, and a job finished before this session started is history, not news. Seeded at
 * `session_start` with everything already terminal, which is also the fix for
 * an earlier draft's nudge condition (`status !== "running" && !finishedAt`) — the reaper
 * always sets `finishedAt` on the transition, so that condition can never be true.
 */
const announced = new Set<string>();

/**
 * How often a session re-checks the store while any job is running.
 *
 * A poll is the only push available: the child is detached and `unref()`d by design, so there is
 * no exit event to subscribe to and no watcher that could survive the session anyway. Self-arming
 * — the timer exists only while `refresh()` reports a running job — so an idle session costs
 * nothing, and one `readdir` plus a handful of small reads every two seconds is cheap next to
 * reporting a dead job as `running` for a quarter of an hour.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** Overrides `DEFAULT_WATCH_INTERVAL_MS`, in milliseconds. */
export const WATCH_INTERVAL_ENV = "PI_JOBS_WATCH_INTERVAL_MS";

/**
 * The poll interval this session uses, in milliseconds.
 *
 * Env-overridable for the same reason `PI_JOBS_PRUNE_HOURS` is: two seconds is a default, not a
 * law, and a session watching a large store may reasonably want it slower. A test wants it much
 * faster — asserting that an idle session announces a finished job means waiting for the timer,
 * and a two-second wait leaves a margin that a saturated machine can eat. Malformed input throws
 * rather than being read as a default, matching `autoPruneRetentionHours`; the 10ms floor is
 * there because a zero interval is a spin, not a poll.
 */
export function watchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WATCH_INTERVAL_ENV];
  if (raw === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 10) {
    throw new Error(
      `${WATCH_INTERVAL_ENV} is ${JSON.stringify(raw)}, which is not an integer number of ` +
        `milliseconds >= 10`,
    );
  }
  return parsed;
}

/** Whether a finished-job notice may start a turn of its own when the session is idle. */
export const DEFAULT_WAKE_ON_IDLE = true;

/** Set to `0` to make the notice passive again: it still renders, but never starts a turn. */
export const WAKE_ENV = "PI_JOBS_WAKE";

/**
 * Whether this session wakes itself for a finished job.
 *
 * On by default, because without it the notice arrives somewhere nobody is looking — see
 * `announce()`. Off restores the passive behaviour: mid-run the notice parks for the next
 * prompt, idle it renders and waits for a human. Malformed input throws rather than being read
 * as a default, matching `watchIntervalMs` and `autoPruneRetentionHours` — `PI_JOBS_WAKE=off`
 * is a typo, not an opt-out, and quietly reading it as "on" would be the worst of both.
 */
export function wakeOnIdle(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[WAKE_ENV];
  if (raw === undefined) return DEFAULT_WAKE_ON_IDLE;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(
    `${WAKE_ENV} is ${JSON.stringify(raw)}, which is not one of "0", "1", "false", "true"`,
  );
}

/** Every live watcher's stop function, so the test seam can disarm registrations it replaced. */
const watchers = new Set<() => void>();

/** Test seam. */
export function __resetForTests(): void {
  announced.clear();
  for (const stop of watchers) stop();
  watchers.clear();
}

function jobLine(job: JobState): string {
  const exit = job.exitCode !== undefined ? ` exit=${job.exitCode}` : "";
  const what = job.label ?? job.agent ?? job.cmd;
  return `${job.id}  ${job.status}${exit}  ${job.kind}  pid=${job.pid}  session=${job.parentSession}  ${what}`;
}

function describeJob(job: JobState, root: string): string {
  const lines = [
    `${job.id}: ${job.status}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}`,
    `kind=${job.kind} pid=${job.pid} pgid=${job.pgid} depth=${job.depth}`,
    `started=${new Date(job.startedAt).toISOString()}${job.finishedAt ? ` finished=${new Date(job.finishedAt).toISOString()}` : ""}`,
    `session=${job.parentSession}${job.parentJob ? ` parentJob=${job.parentJob}` : ""}`,
    `cwd=${job.cwd}`,
    `command: ${job.cmd}`,
    `dir: ${jobDir(root, job.id)}`,
  ];
  if (job.note) lines.push(`note: ${job.note}`);
  return lines.join("\n");
}

async function requireJob(root: string, id: string | undefined): Promise<JobState> {
  if (!id) throw new Error(`job: this action needs an "id"`);
  const state = await readState(root, id);
  if (!state) {
    throw new Error(`job: no such job "${id}" in ${root}`);
  }
  return state;
}

async function tail(path: string, lines: number): Promise<string> {
  const raw = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw new Error(`job: ${path} is unreadable: ${describeError(err)}`, { cause: err });
  });
  if (raw.length === 0) return "";
  const truncated = truncateTail(raw, { maxLines: lines, maxBytes: DEFAULT_MAX_BYTES });
  return truncated.truncated
    ? `${truncated.content}\n\n[tail of ${truncated.totalLines} lines (${formatSize(truncated.totalBytes)}); full log: ${path}]`
    : truncated.content;
}

function report(ctx: ExtensionContext | undefined, key: string, line: string): void {
  // One channel, whichever this run mode has — see `lib/announce.ts`.
  surfaceOnce(ctx, key, () => emitNotice(ctx, line, "error"));
}

/**
 * Puts this session's running jobs on the fleet panel below the editor.
 *
 * Called from every place that has just read the store, which is what makes a job appear the
 * instant it is started rather than at the next `turn_end`: `publishExternalRuns` is idempotent
 * and removes its own stale rows, so "call it again" is always the correct thing to do and never
 * needs to know what changed. Never throws — a display registry is not worth failing a tool call
 * over, and the footer count is an independent surface that keeps working either way.
 */
function publishPanel(ctx: ExtensionContext, jobs: readonly JobState[]): void {
  try {
    // `pi-subagents` scopes the panel by `resolveCurrentSessionId`, which prefers the session
    // *file path* and falls back to the id (`src/shared/session-identity.ts:6-10`); our own
    // `parentSession` is the id. Both are needed, and they are not interchangeable.
    const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    const owned = jobs.filter((job) => job.parentSession === ctx.sessionManager.getSessionId());
    publishExternalRuns(sessionId, owned);
  } catch (err) {
    report(ctx, "jobs:publish", `[pi-config] jobs: fleet panel not updated: ${describeError(err)}`);
  }
}

/** Reaps this session's view of the store and updates the footer. Never throws. */
async function refresh(ctx: ExtensionContext): Promise<{ running: number; finished: JobState[] }> {
  const root = jobsRoot();
  const { jobs, problems } = await listJobs(root);
  for (const problem of problems) {
    report(ctx, `jobs:unreadable:${problem.id}`, `[pi-config] jobs: ${problem.reason}`);
  }
  publishPanel(ctx, jobs);

  const sessionId = ctx.sessionManager.getSessionId();
  const finished: JobState[] = [];
  let running = 0;
  for (const job of jobs) {
    if (job.status === "running") {
      running++;
      continue;
    }
    if (job.parentSession !== sessionId) continue;
    if (announced.has(job.id)) continue;
    announced.add(job.id);
    finished.push(job);
  }

  if (ctx.hasUI) ctx.ui.setStatus("jobs", running > 0 ? `${running} bg` : undefined);
  return { running, finished };
}

export function register(pi: ExtensionAPI): void {
  let disposeProviders: (() => void) | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  /** True between `agent_start` and `agent_settled` — PI's own `isStreaming` window. */
  let streaming = false;

  function stopWatch(): void {
    if (!watch) return;
    clearInterval(watch);
    watch = undefined;
  }
  watchers.add(stopWatch);

  /**
   * Announces the jobs this sweep found terminal, and — by default — wakes the agent to deal
   * with them.
   *
   * Which branch of `sendCustomMessage` runs is left to PI, which decides on its own
   * `isStreaming` rather than on anything this extension tracks:
   *
   *   - idle, `triggerTurn` runs the notice as a prompt in its own right. That is the point of
   *     the whole watcher: a job that dies while nobody is typing has no other way to be heard.
   *   - mid-run, `deliverAs: "followUp"` queues the notice behind the current turn, so the agent
   *     reads it when the turn ends and keeps going, rather than being steered off what it is
   *     doing. `triggerTurn` is ignored on that branch, which is why one option object can cover
   *     both cases and no locally-tracked flag can pick the wrong one.
   *
   * Turns cannot stack. Starting a prompt marks the run active as its first act, before it
   * awaits anything, so a second announcement racing the first finds a live run and takes the
   * `followUp` branch instead. Several jobs found in one sweep were already a single message.
   *
   * `deliverAs: "nextTurn"` was the original choice here and survives only as what
   * `PI_JOBS_WAKE=0` falls back to. It is not really a mid-run delivery: pending `nextTurn`
   * messages are injected when a *new prompt* starts, not between the turns of a run already in
   * flight. A job finishing during a run's last turn therefore stayed silent until a human typed
   * — the same silence the exit watcher exists to remove, moved one boundary along.
   *
   * The rule this replaces read "never `triggerTurn`: a finished job is news, not an
   * instruction." The tokens are not unasked-for: something started the job deliberately, and a
   * report nobody is awake to read is not a report. The cost is bounded instead — one wake per
   * job, coalesced per sweep — and the text says plainly that the agent may stop at once if
   * there is nothing to do.
   */
  function announce(finished: readonly JobState[]): void {
    if (finished.length === 0) return;
    const summary = finished
      .map((job) => `${job.id} (${job.status}${job.exitCode !== undefined ? ` exit ${job.exitCode}` : ""})`)
      .join(", ");
    pi.sendMessage(
      {
        customType: "job-done",
        content: [
          {
            type: "text",
            text:
              `Background job(s) finished: ${summary}. Read them with job(action="output") and ` +
              `carry on with what they were started for; if nothing is needed, say so and stop.`,
          },
        ],
        display: true,
      },
      wakeOnIdle()
        ? { deliverAs: "followUp" as const, triggerTurn: true }
        : streaming
          ? { deliverAs: "nextTurn" as const }
          : undefined,
    );
  }

  /** Arms the watcher while anything is running, disarms it when nothing is. */
  function arm(ctx: ExtensionContext, running: number): void {
    if (running === 0) {
      stopWatch();
      return;
    }
    if (watch) return;
    watch = setInterval(() => {
      // Mid-run `turn_end` already sweeps, on a boundary where steering is not a risk.
      if (streaming) return;
      void sweep(ctx).catch((err: unknown) => {
        stopWatch();
        report(ctx, "jobs:watch", `[pi-config] jobs: exit watcher stopped: ${describeError(err)}`);
      });
    }, watchIntervalMs());
    watch.unref();
  }

  async function sweep(ctx: ExtensionContext): Promise<void> {
    const { running, finished } = await refresh(ctx);
    announce(finished);
    arm(ctx, running);
  }

  pi.registerTool({
    name: "job",
    label: "Background job",
    description:
      "Start, poll, read, list, kill or prune a detached background job. Jobs outlive this " +
      "session's process and are visible from any other session.",
    promptSnippet: "Run long commands in the background and poll them",
    promptGuidelines: [
      "Use job with action=start for anything expected to run longer than the bash timeout, then poll it with action=status.",
      "Do not use job for quick commands — plain bash is cheaper.",
      "Use job with action=list to find work started by an earlier session before starting it again.",
    ],
    parameters: Type.Object({
      action: StringEnum(["start", "status", "output", "list", "kill", "prune"] as const, {
        description: "what to do",
      }),
      id: Type.Optional(Type.String({ description: "job id, for status/output/kill" })),
      // The name `command` is load-bearing: `EXT-03`'s catastrophic-pattern gate scans
      // `command` / `cmd` / `script` on *any* tool call, not only `bash`'s, so a background
      // job is covered by the denylist for free. Renaming it routes jobs around the guard.
      command: Type.Optional(Type.String({ description: "shell command, for action=start" })),
      kind: Type.Optional(
        StringEnum(["bash", "agent"] as const, {
          description: "reporting label for the started command; defaults to bash",
        }),
      ),
      agent: Type.Optional(Type.String({ description: "agent name, when kind=agent" })),
      prompt: Type.Optional(Type.String({ description: "prompt recorded with an agent job" })),
      label: Type.Optional(Type.String({ description: "short human label for listings" })),
      stream: Type.Optional(
        StringEnum(["stdout", "stderr", "both"] as const, { description: "which log to read" }),
      ),
      tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, default: 200 })),
      olderThanHours: Type.Optional(
        Type.Number({ minimum: 0, description: "for action=prune; defaults to 168 (7 days)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await ensureJobsRoot();

      switch (params.action) {
        case "start": {
          if (!params.command) {
            throw new Error(
              `job: action=start needs a "command". An agent job is a command too — start the ` +
                `pi invocation that runs it and pass kind="agent" with the agent name.`,
            );
          }
          const state = await startJob({
            root,
            command: params.command,
            cwd: ctx.cwd,
            parentSession: ctx.sessionManager.getSessionId(),
            kind: params.kind ?? "bash",
            agent: params.agent,
            prompt: params.prompt,
            label: params.label,
            onError: (line) => report(ctx, `jobs:start:${line.slice(0, 80)}`, line),
          });
          const { jobs } = await listJobs(root, { reap: false });
          const running = jobs.filter((job) => job.status === "running").length;
          if (ctx.hasUI) ctx.ui.setStatus("jobs", running > 0 ? `${running} bg` : undefined);
          // Both surfaces, here, before the tool returns: the footer count and the fleet panel
          // row. Waiting for the next sweep would mean the run the operator was just told about
          // is the one thing the panel does not show.
          publishPanel(ctx, jobs);
          arm(ctx, running);
          return {
            content: [
              {
                type: "text" as const,
                text: `started job ${state.id} (pid ${state.pid}, depth ${state.depth})\n${jobDir(root, state.id)}`,
              },
            ],
            details: { id: state.id, pid: state.pid, dir: jobDir(root, state.id) },
          };
        }

        case "status": {
          const state = await reap(root, await requireJob(root, params.id));
          return {
            content: [{ type: "text" as const, text: describeJob(state, root) }],
            details: state,
          };
        }

        case "output": {
          const state = await reap(root, await requireJob(root, params.id));
          const dir = jobDir(root, state.id);
          const lines = params.tailLines ?? DEFAULT_TAIL_LINES;
          const stream = params.stream ?? "stdout";
          const parts: string[] = [];
          if (stream === "stdout" || stream === "both") {
            parts.push(`--- stdout ---\n${(await tail(join(dir, "stdout.log"), lines)) || "(empty)"}`);
          }
          if (stream === "stderr" || stream === "both") {
            parts.push(`--- stderr ---\n${(await tail(join(dir, "stderr.log"), lines)) || "(empty)"}`);
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `${state.id}: ${state.status}${state.exitCode !== undefined ? ` (exit ${state.exitCode})` : ""}\n${parts.join("\n\n")}`,
              },
            ],
            details: { id: state.id, status: state.status, exitCode: state.exitCode, dir },
          };
        }

        case "list": {
          const { jobs, problems } = await listJobs(root);
          const sessionId = ctx.sessionManager.getSessionId();
          const body = jobs.length > 0 ? jobs.map(jobLine).join("\n") : "no jobs";
          const trouble =
            problems.length > 0
              ? `\n\nunreadable job directories:\n${problems.map((p) => `${p.id}: ${p.reason}`).join("\n")}`
              : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `${jobs.length} job(s) in ${root} (this session: ${sessionId})\n${body}${trouble}`,
              },
            ],
            details: { jobs, problems, root },
          };
        }

        case "kill": {
          const { state, signalled } = await killJob(root, await requireJob(root, params.id));
          return {
            content: [
              {
                type: "text" as const,
                text: signalled
                  ? `killed ${state.id} (SIGTERM to process group ${state.pgid}, SIGKILL follows if it survives)`
                  : `${state.id} was already ${state.status}${state.note ? ` — ${state.note}` : ""}`,
              },
            ],
            details: state,
          };
        }

        case "prune": {
          const hours = params.olderThanHours ?? 168;
          const result = await pruneJobs(root, { olderThanMs: hours * 3_600_000 });
          return {
            content: [
              {
                type: "text" as const,
                text: `pruned ${result.removed.length} finished job(s) older than ${hours}h; ${result.kept} kept`,
              },
            ],
            details: result,
          };
        }
      }
    },
  });

  /**
   * The operator-facing half of this extension. `job(action=…)` is a tool the *model* calls;
   * until now nothing let you look through detached jobs yourself. Read-only and silent — it
   * opens an overlay, it never sends a message or triggers a turn. See `history-view.ts`.
   */
  pi.registerCommand("jobs", {
    description: "Browse background jobs: history, status, exit code, stdout/stderr (read-only)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        await openJobHistory(ctx);
      } catch (err) {
        report(ctx, "jobs:history", `[pi-config] jobs: /jobs failed: ${describeError(err)}`);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      // A store no session owns is a store nothing else cleans up (store.ts's own header
      // comment) — so `session_start` sweeps terminal jobs older than the retention window
      // before this session gets to look at the list, the same way `job(action="prune")` does
      // it by hand.
      const root = jobsRoot();
      const hours = autoPruneRetentionHours();
      const pruned = await pruneJobs(root, { olderThanMs: hours * 3_600_000 });
      if (pruned.removed.length > 0) {
        emitNotice(
          ctx,
          `[pi-config] jobs: auto-pruned ${pruned.removed.length} finished job(s) older than ` +
            `${hours}h (set ${AUTO_PRUNE_HOURS_ENV} to change)`,
          "info",
        );
      }
      // Everything already terminal is history for this session, not news.
      const { jobs } = await listJobs(jobsRoot());
      for (const job of jobs) if (job.status !== "running") announced.add(job.id);
      const running = jobs.filter((job) => job.status === "running").length;
      if (ctx.hasUI) ctx.ui.setStatus("jobs", running > 0 ? `${running} bg` : undefined);
      // A resumed session keeps its session file, so its jobs from the previous process are
      // still ours and belong back on the panel.
      publishPanel(ctx, jobs);
      arm(ctx, running);

      disposeProviders?.();
      disposeProviders = registerJobProviders({
        snapshot: () => listJobsSync(jobsRoot()).jobs,
        onError: (line) => report(ctx, `jobs:snapshot`, line),
      });
    } catch (err) {
      report(ctx, "jobs:session_start", `[pi-config] jobs: session_start failed: ${describeError(err)}`);
    }
  });

  pi.on("agent_start", () => {
    streaming = true;
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      await sweep(ctx);
    } catch (err) {
      report(ctx, "jobs:turn_end", `[pi-config] jobs: turn_end failed: ${describeError(err)}`);
    }
  });

  // PI clears its run-active flag *before* emitting `agent_settled`, so this is the first moment
  // a notice can render immediately rather than waiting for a turn.
  pi.on("agent_settled", async (_event, ctx) => {
    streaming = false;
    try {
      await sweep(ctx);
    } catch (err) {
      report(ctx, "jobs:agent_settled", `[pi-config] jobs: agent_settled failed: ${describeError(err)}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      stopWatch();
      disposeProviders?.();
      disposeProviders = undefined;
      unpublishExternalRuns();
      if (ctx.hasUI) ctx.ui.setStatus("jobs", undefined);
    } catch (err) {
      report(ctx, "jobs:session_shutdown", `[pi-config] jobs: shutdown failed: ${describeError(err)}`);
    }
  });
}

/**
 * EXT-24 — background jobs: the cross-session job directory (`REQ-CTX-45`, `REQ-EXT-52`).
 *
 * Two faces of background work are already packaged and are **not** rebuilt here:
 * `pi-subagents`' async runs (the agent face — machine-readable lifecycle artifacts,
 * `subagent_wait`, the background-work registry) and `@99percentpeople/pi-background-tasks`
 * 2.0.0 (the bash face — start, wait, logs, stdin, signals, terminate, replay on reattach).
 *
 * Both are **session-scoped**. Neither survives the `pi` process that started the work, and
 * neither is discoverable from a different session. That gap is this module: `store.ts` owns
 * `<state>/jobs/<id>/`, this file exposes it as one `job` tool, and `registry.ts` publishes it
 * into `pi-subagents`' background-work and external-run registries so the packaged faces can
 * see our jobs too.
 *
 * Auto-discovered as a standalone extension via the `extensions/<dir>/index.ts` subdirectory
 * pattern (same as `extensions/big-results/index.ts` and `extensions/tasks/index.ts`), so
 * `settings.json`'s `"extensions"` array needs no entry.
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { registerJobProviders } from "./registry.ts";
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

/** Test seam. */
export function __resetForTests(): void {
  announced.clear();
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

/** Reaps this session's view of the store and updates the footer. Never throws. */
async function refresh(ctx: ExtensionContext): Promise<{ running: number; finished: JobState[] }> {
  const root = jobsRoot();
  const { jobs, problems } = await listJobs(root);
  for (const problem of problems) {
    report(ctx, `jobs:unreadable:${problem.id}`, `[pi-config] jobs: ${problem.reason}`);
  }

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
          if (ctx.hasUI) {
            const { jobs } = await listJobs(root, { reap: false });
            const running = jobs.filter((job) => job.status === "running").length;
            ctx.ui.setStatus("jobs", running > 0 ? `${running} bg` : undefined);
          }
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

      disposeProviders?.();
      disposeProviders = registerJobProviders({
        snapshot: () => listJobsSync(jobsRoot()).jobs,
        onError: (line) => report(ctx, `jobs:snapshot`, line),
      });
    } catch (err) {
      report(ctx, "jobs:session_start", `[pi-config] jobs: session_start failed: ${describeError(err)}`);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const { finished } = await refresh(ctx);
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
              text: `Background job(s) finished: ${summary}. Use job(action="output") to read them.`,
            },
          ],
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    } catch (err) {
      report(ctx, "jobs:turn_end", `[pi-config] jobs: turn_end failed: ${describeError(err)}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      disposeProviders?.();
      disposeProviders = undefined;
      if (ctx.hasUI) ctx.ui.setStatus("jobs", undefined);
    } catch (err) {
      report(ctx, "jobs:session_shutdown", `[pi-config] jobs: shutdown failed: ${describeError(err)}`);
    }
  });
}

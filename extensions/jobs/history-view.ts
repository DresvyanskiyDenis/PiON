/**
 * EXT-24 — `/jobs`: a navigable, scrollable history of everything in `<state>/jobs/`.
 *
 * The gap: `job(action=…)` is a tool the *model* calls. Nothing let you look through detached
 * jobs yourself — and detached jobs are precisely the ones you cannot watch as they run.
 * `/jobs` lists every job newest-first with its id, kind, status, exit code, duration and age,
 * and opens a scrollable detail pane over its `stdout.log`, `stderr.log` and `cmd.sh`. The
 * subagent half is already covered by `/subagents-fleet`, history included (`pi-subagents`
 * merges `listAsyncRuns` at `src/tui/fleet.ts:265`), so none of that is rebuilt here.
 *
 * Two properties are load-bearing, and enforced in code rather than by convention:
 *
 *   1. **Read-only.** Browsing never mutates, reaps or deletes a job. Every read goes through
 *      `listJobsSync()`, which judges a job's liveness without persisting the verdict;
 *      `listJobs()` defaults to `reap: true` and *writes*, so it is never called here. Log files
 *      are opened `"r"` and tail-read. There is deliberately no delete, prune or kill key — this
 *      is a window, and `job(action="prune")` remains the way to remove anything.
 *   2. **It never wakes the agent.** Opening a view is not a turn: no `sendMessage`, no
 *      `triggerTurn`, no tool call, so the overlay costs zero tokens. This is deliberately the
 *      opposite of what a *completion* does in `index.ts` — a finished job wakes an idle agent,
 *      because a result nobody is awake to read is not a report. You looking through history is
 *      not a result, and the agent has no reason to know you did it.
 *
 * Key handling mirrors the fleet inspector rather than inventing its own; the pure half of that,
 * and the reasoning about the `fleetKeybindings` escape hatch, is in `history.ts`.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { configDir } from "../lib/paths.ts";
import {
  bindingLabel,
  buildRows,
  clampScroll,
  clampSelection,
  dropPartialFirstLine,
  jobTitle,
  nextStream,
  normalizeBinding,
  renderRows,
  resolveJobsKeybindings,
  scrollToShow,
  statusLabel,
  streamFile,
  toDisplayLines,
  windowLines,
  type JobsKeyAction,
  type JobsPane,
  type JobsStream,
  type ResolvedJobsKeybindings,
} from "./history.ts";
import { jobDir, jobsRoot, listJobsSync, type JobState } from "./store.ts";

/** The same tail budget the fleet inspector gives a child's output (`src/tui/fleet.ts:30`). */
const OUTPUT_TAIL_BYTES = 64 * 1024;
/** Redraws only what is already on disk. It polls no process and starts none. */
const REFRESH_MS = 1000;
const REVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

type HistoryTui = {
  terminal?: { rows: number };
  requestRender(): void;
};

interface JobHistoryOptions {
  readonly root: string;
  readonly bindings: ResolvedJobsKeybindings;
}

class JobHistoryComponent implements Component {
  private jobs: readonly JobState[] = [];
  private problems: readonly { id: string; reason: string }[] = [];
  private error: string | undefined;
  private selected = 0;
  private pane: JobsPane = "list";
  private stream: JobsStream = "stdout";
  private listScroll = 0;
  private detailScroll = 0;
  private detailLines: string[] = [];
  private detailKey = "";
  private viewport = 10;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: HistoryTui;
  private readonly done: (result: undefined) => void;
  private readonly options: JobHistoryOptions;

  // Assigned field by field on purpose: Node's strip-only TypeScript loader rejects a
  // constructor parameter property outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and this tree
  // runs unbuilt `.ts` under exactly that loader.
  constructor(tui: HistoryTui, done: (result: undefined) => void, options: JobHistoryOptions) {
    this.tui = tui;
    this.done = done;
    this.options = options;
    this.reload();
    this.timer = setInterval(() => {
      this.reload();
      this.tui.requestRender();
    }, REFRESH_MS);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    this.detailKey = "";
  }

  /** Non-writing by construction — `listJobsSync` judges, it does not reap. */
  private reload(): void {
    try {
      const listing = listJobsSync(this.options.root);
      this.jobs = listing.jobs;
      this.problems = listing.problems.map((problem) => ({ id: problem.id, reason: problem.reason }));
      this.error = undefined;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.selected = clampSelection(this.selected, this.jobs.length);
  }

  private current(): JobState | undefined {
    return this.jobs[this.selected];
  }

  private loadDetail(job: JobState): void {
    const key = `${job.id}:${this.stream}:${job.status}:${job.finishedAt ?? ""}`;
    const file = join(jobDir(this.options.root, job.id), streamFile(this.stream));
    const { text, truncated } = readTail(file, OUTPUT_TAIL_BYTES);
    const lines = toDisplayLines(dropPartialFirstLine(text, truncated));
    // A running job's log keeps growing, so the cache key alone cannot justify skipping the
    // re-read — the line count has to agree too.
    if (key === this.detailKey && job.status !== "running" && this.detailLines.length === lines.length) return;
    this.detailKey = key;
    this.detailLines = truncated
      ? [`… earlier output omitted (last ${OUTPUT_TAIL_BYTES / 1024} KiB shown)`, ...lines]
      : lines;
  }

  render(width: number): string[] {
    const rows = this.tui.terminal?.rows ?? 32;
    this.viewport = Math.max(3, Math.floor(rows * 0.85) - 6);
    const job = this.current();
    const lines: string[] =
      this.pane === "detail" && job !== undefined ? this.renderDetail(job, width) : this.renderList(width);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderList(width: number): string[] {
    const now = Date.now();
    const body = renderRows(buildRows(this.jobs, now), this.selected, width);
    const [heading, ...rowLines] = body;
    this.listScroll = scrollToShow(this.listScroll, this.selected, this.viewport, rowLines.length);
    const running = this.jobs.filter((job) => job.status === "running").length;
    const unreadable = this.problems.length > 0 ? `, ${this.problems.length} unreadable` : "";
    const visible =
      this.jobs.length === 0
        ? ["  (no jobs in the store)"]
        : windowLines(rowLines, this.listScroll, this.viewport).map((line, i) =>
            this.listScroll + i === this.selected ? `${REVERSE}${line}${RESET}` : line,
          );
    const out: string[] = [
      `Jobs — ${this.jobs.length} total, ${running} running${unreadable}`,
      "",
      heading ?? "",
      ...visible,
    ];
    if (this.error !== undefined) out.push("", `  store unreadable: ${this.error}`);
    for (const problem of this.problems.slice(0, 3)) out.push(`  unreadable: ${problem.id} — ${problem.reason}`);
    out.push("", this.footer("list"));
    return out;
  }

  private renderDetail(job: JobState, width: number): string[] {
    this.loadDetail(job);
    this.detailScroll = clampScroll(this.detailScroll, this.detailLines.length, this.viewport);
    const started = new Date(job.startedAt).toLocaleString();
    const agent = job.agent !== undefined ? `  agent ${job.agent}` : "";
    const parent = job.parentJob !== undefined ? `  parent ${job.parentJob}` : "";
    const head = [
      `${job.id}  ${job.kind}  ${statusLabel(job)}  started ${started}`,
      `cwd ${job.cwd}${agent}${parent}`,
      `$ ${jobTitle(job)}`,
      "",
      `${streamFile(this.stream)} — ${this.detailLines.length} lines, from ${this.detailScroll + 1}`,
      "",
    ];
    const body =
      this.detailLines.length === 0
        ? ["  (empty)"]
        : windowLines(this.detailLines, this.detailScroll, Math.max(1, this.viewport - head.length + 2));
    void width;
    return [...head, ...body, "", this.footer("detail")];
  }

  private footer(pane: JobsPane): string {
    const b = this.options.bindings;
    const parts =
      pane === "list"
        ? [
            `${bindingLabel(b, "selectUp")}/${bindingLabel(b, "selectDown")} move`,
            `${bindingLabel(b, "open")} open`,
            `${bindingLabel(b, "refresh")} refresh`,
            `${bindingLabel(b, "close")} close`,
          ]
        : [
            `${bindingLabel(b, "scrollUp")}/${bindingLabel(b, "scrollDown")} scroll`,
            `${bindingLabel(b, "pageUp")}/${bindingLabel(b, "pageDown")} page`,
            `${bindingLabel(b, "cycleStream")} stdout/stderr/cmd`,
            `${bindingLabel(b, "back")} back`,
          ];
    return `  ${parts.join("   ")}   (read-only)`;
  }

  private matches(data: string, action: JobsKeyAction): boolean {
    return this.options.bindings[action].some((binding) =>
      matchesKey(data, normalizeBinding(binding) as Parameters<typeof matchesKey>[1]),
    );
  }

  handleInput(data: string): void {
    if (this.matches(data, "close")) {
      if (this.pane === "detail") {
        this.pane = "list";
        return;
      }
      this.done(undefined);
      return;
    }
    if (this.matches(data, "refresh")) {
      this.reload();
      this.detailKey = "";
      return;
    }
    if (this.pane === "list") this.handleListInput(data);
    else this.handleDetailInput(data);
  }

  private handleListInput(data: string): void {
    const total = this.jobs.length;
    if (this.matches(data, "selectUp")) this.selected = clampSelection(this.selected - 1, total);
    else if (this.matches(data, "selectDown")) this.selected = clampSelection(this.selected + 1, total);
    else if (this.matches(data, "pageUp")) this.selected = clampSelection(this.selected - this.viewport, total);
    else if (this.matches(data, "pageDown")) this.selected = clampSelection(this.selected + this.viewport, total);
    else if (this.matches(data, "selectFirst")) this.selected = 0;
    else if (this.matches(data, "selectLast")) this.selected = clampSelection(total - 1, total);
    else if (this.matches(data, "open") && total > 0) {
      this.pane = "detail";
      this.stream = "stdout";
      this.detailScroll = 0;
      this.detailKey = "";
    }
  }

  private handleDetailInput(data: string): void {
    const total = this.detailLines.length;
    if (this.matches(data, "back")) this.pane = "list";
    else if (this.matches(data, "cycleStream")) {
      this.stream = nextStream(this.stream);
      this.detailScroll = 0;
      this.detailKey = "";
    } else if (this.matches(data, "scrollUp") || this.matches(data, "selectUp"))
      this.detailScroll = clampScroll(this.detailScroll - 1, total, this.viewport);
    else if (this.matches(data, "scrollDown") || this.matches(data, "selectDown"))
      this.detailScroll = clampScroll(this.detailScroll + 1, total, this.viewport);
    else if (this.matches(data, "pageUp"))
      this.detailScroll = clampScroll(this.detailScroll - this.viewport, total, this.viewport);
    else if (this.matches(data, "pageDown"))
      this.detailScroll = clampScroll(this.detailScroll + this.viewport, total, this.viewport);
    else if (this.matches(data, "selectFirst")) this.detailScroll = 0;
    else if (this.matches(data, "selectLast")) this.detailScroll = clampScroll(total, total, this.viewport);
  }
}

/** The last `maxBytes` of a file, opened read-only. A missing or unreadable file renders empty. */
function readTail(file: string, maxBytes: number): { text: string; truncated: boolean } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return { text: "", truncated: false };
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), truncated: size > length };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Your escape hatch, read from the file PI actually loads for `pi-subagents` —
 * `~/.pi/agent/extensions/subagent/config.json`, which `config/subagent.json` is symlinked to.
 * One `fleetKeybindings` block therefore retunes both this view and `/subagents-fleet`. A
 * missing or malformed file falls back to the defaults instead of failing the command: a
 * keybinding is a preference, not a correctness input.
 */
export function readFleetKeybindings(): unknown {
  const file = join(configDir(), "extensions", "subagent", "config.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as { fleetKeybindings?: unknown }).fleetKeybindings
      : undefined;
  } catch {
    return undefined;
  }
}

export async function openJobHistory(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify('/jobs needs the TUI. Outside it, use job(action="list").', "warning");
    return;
  }
  const bindings = resolveJobsKeybindings(readFleetKeybindings());
  await ctx.ui.custom<undefined>(
    (tui, _theme, _keybindings, done) => new JobHistoryComponent(tui, done, { root: jobsRoot(), bindings }),
    { overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 } },
  );
}

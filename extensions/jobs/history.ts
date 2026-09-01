/**
 * EXT-24 — the pure half of the `/jobs` history browser.
 *
 * Arithmetic, column layout, selection and scroll clamping all live here, in a module that
 * **imports nothing from PI** — the same split [`context-report`](../context-report/report.ts)
 * uses. It is what lets `test/jobs/history.test.ts` assert on injected values rather than on
 * elapsed wall-clock time: every function that needs the current time takes it as an argument.
 * The terminal-facing half is `history-view.ts`.
 *
 * Nothing in this file opens, writes or reaps anything. That is not incidental: `listJobs()` in
 * `store.ts` defaults to `reap: true` and *persists* its verdict, so the browser must never use
 * it. The view reads through `listJobsSync()`, which judges liveness without writing.
 *
 * Column widths are measured over fields that are ASCII by construction (id, kind, status,
 * duration, age). The one free-form column — the command — is last on purpose, so a wide or
 * combining character in it ragged-edges only the tail of its own row and can never shift a
 * column on another row. Width-accurate truncation is the view's job (`truncateToWidth`).
 */
import type { JobState } from "./store.ts";

export type JobsPane = "list" | "detail";
export type JobsStream = "stdout" | "stderr" | "cmd";

export const JOBS_STREAMS: readonly JobsStream[] = ["stdout", "stderr", "cmd"];

/**
 * What the browser can be asked to do.
 *
 * The first ten names are spelled exactly as `pi-subagents`' `FleetKeybindingAction` — the action
 * *vocabulary*, which is `FLEET_KEYBINDING_ACTIONS` at `src/shared/types.ts:2159-2174` with the
 * alias derived from it at `:2176` (0.57.0). The *table* that binds those actions to keys is a
 * different symbol in a different file; see `JOBS_KEYBINDING_DEFAULTS` below. Sharing the
 * vocabulary is what lets a single `fleetKeybindings` block retune this view and
 * `/subagents-fleet` together. That block
 * is the escape hatch for a terminal that swallows `PgUp`/`PgDn`, and it would be useless here
 * if this view had invented its own names for the same movements.
 *
 * The last three have no fleet counterpart and are bound to bare letters deliberately: a
 * terminal may intercept a named key such as `pageUp`, but it does not intercept `o`, so these
 * stay reachable without an escape hatch of their own.
 */
export type JobsKeyAction =
  | "close"
  | "selectUp"
  | "selectDown"
  | "selectFirst"
  | "selectLast"
  | "pageUp"
  | "pageDown"
  | "scrollUp"
  | "scrollDown"
  | "refresh"
  | "open"
  | "back"
  | "cycleStream";

/** Mirrors `pi-subagents` 0.57.0 `DEFAULT_FLEET_KEYBINDINGS` (`src/tui/fleet.ts:33-48`) for every shared action. */
export const JOBS_KEYBINDING_DEFAULTS: Readonly<Record<JobsKeyAction, readonly string[]>> = {
  close: ["escape", "ctrl+c", "q"],
  selectUp: ["up", "k"],
  selectDown: ["down", "j"],
  selectFirst: ["home"],
  selectLast: ["end"],
  pageUp: ["pageUp"],
  pageDown: ["pageDown"],
  scrollUp: ["K"],
  scrollDown: ["J"],
  refresh: ["r", "R"],
  open: ["return", "right", "l"],
  back: ["left", "h"],
  cycleStream: ["o", "tab"],
};

/** The shared subset — the actions a `fleetKeybindings` override is allowed to reach. */
const FLEET_SHARED_ACTIONS: readonly JobsKeyAction[] = [
  "close",
  "selectUp",
  "selectDown",
  "selectFirst",
  "selectLast",
  "pageUp",
  "pageDown",
  "scrollUp",
  "scrollDown",
  "refresh",
];

export type ResolvedJobsKeybindings = Readonly<Record<JobsKeyAction, readonly string[]>>;

/**
 * Lays `config/subagent.json`'s `fleetKeybindings` over the defaults.
 *
 * Only the ten shared actions are overridable. An unknown or jobs-only key in that block is
 * ignored rather than rejected, because the block belongs to `pi-subagents` and this view is a
 * guest in it — rejecting a key the package adds later would break on upgrade. An entry whose
 * value is not a non-empty array of strings is ignored too: a malformed override that silently
 * unbound `close` would trap you inside the overlay with no way out.
 */
export function resolveJobsKeybindings(fleetKeybindings: unknown): ResolvedJobsKeybindings {
  const overrides = isRecord(fleetKeybindings) ? fleetKeybindings : {};
  const resolved: Record<JobsKeyAction, readonly string[]> = { ...JOBS_KEYBINDING_DEFAULTS };
  for (const action of FLEET_SHARED_ACTIONS) {
    const candidate = overrides[action];
    if (
      Array.isArray(candidate) &&
      candidate.length > 0 &&
      candidate.every((key) => typeof key === "string" && key.length > 0)
    ) {
      resolved[action] = [...(candidate as string[])];
    }
  }
  return resolved;
}

/**
 * `pi-subagents` writes a shifted letter as the bare capital (`"K"`); `matchesKey` wants
 * `shift+k`. Same mapping as `matchesFleetBinding` (`src/tui/fleet.ts:58`), which is
 * module-private over there — the package's `exports` map has no `./tui/*` entry, so this is
 * mirrored rather than imported. Do not "fix" the duplication: the import would not resolve.
 */
export function normalizeBinding(binding: string): string {
  return /^[A-Z]$/.test(binding) ? `shift+${binding.toLowerCase()}` : binding;
}

/** How a binding is spelled back to you in the footer. */
export function bindingLabel(bindings: ResolvedJobsKeybindings, action: JobsKeyAction): string {
  const pretty: Record<string, string> = {
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    escape: "Esc",
    return: "Enter",
  };
  return bindings[action].map((binding) => pretty[binding] ?? binding).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `1.2s`, `3m 04s`, `2h 11m`. Never negative: a clock skew renders `0s`, not `-4s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

/** Coarse age for the list column — precise enough to order by eye, stable enough to assert on. */
export function formatAge(startedAt: number, now: number): string {
  const ms = Math.max(0, now - startedAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `done exit 0`, `failed exit 2`, `running`, `killed`. */
export function statusLabel(job: Pick<JobState, "status" | "exitCode">): string {
  return job.exitCode === undefined ? job.status : `${job.status} exit ${job.exitCode}`;
}

/** How long the job ran, or has been running. Both clocks are given — nothing is sampled. */
export function jobElapsedMs(job: Pick<JobState, "startedAt" | "finishedAt">, now: number): number {
  return Math.max(0, (job.finishedAt ?? now) - job.startedAt);
}

/** What the row says the job *is*: its label, else its agent, else the command it runs. */
export function jobTitle(job: Pick<JobState, "label" | "agent" | "cmd">): string {
  const title = job.label ?? job.agent ?? job.cmd;
  return title.replace(/\s+/g, " ").trim();
}

export interface HistoryRow {
  readonly id: string;
  readonly age: string;
  readonly kind: string;
  readonly status: string;
  readonly duration: string;
  readonly title: string;
}

export function buildRows(jobs: readonly JobState[], now: number): readonly HistoryRow[] {
  return jobs.map((job) => ({
    id: job.id,
    age: formatAge(job.startedAt, now),
    kind: job.kind,
    status: statusLabel(job),
    duration: formatDuration(jobElapsedMs(job, now)),
    title: jobTitle(job),
  }));
}

const HEADINGS: HistoryRow = {
  id: "ID",
  age: "AGE",
  kind: "KIND",
  status: "STATUS",
  duration: "TIME",
  title: "COMMAND",
};
const GAP = "  ";

function cell(text: string, width: number): string {
  const chars = [...text];
  if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
  return text.padEnd(width, " ");
}

/**
 * The list body — heading first, then one string per row with its selection marker.
 *
 * `width` bounds only the free-form command column. The caller still truncates each line to the
 * real terminal width, because this module cannot measure a wide character.
 *
 * The marker is `›`, not `▸`. `▸`/`▾` are reserved repo-wide for a collapsible container
 * (`extensions/lib/glyphs.ts`) — "this row is the cursor" is a different fact from "this
 * container is collapsed", and the one-glyph-one-meaning law means it needs its own character
 * even though nothing else in this file's own vocabulary collides with either.
 */
export function renderRows(rows: readonly HistoryRow[], selected: number, width: number): string[] {
  const all = [HEADINGS, ...rows];
  const widths = {
    id: Math.max(...all.map((row) => row.id.length)),
    age: Math.max(...all.map((row) => row.age.length)),
    kind: Math.max(...all.map((row) => row.kind.length)),
    status: Math.max(...all.map((row) => row.status.length)),
    duration: Math.max(...all.map((row) => row.duration.length)),
  };
  const fixed =
    2 + widths.id + widths.age + widths.kind + widths.status + widths.duration + GAP.length * 5;
  const titleWidth = Math.max(8, width - fixed);
  const line = (row: HistoryRow, marker: string): string =>
    (
      marker +
      [
        cell(row.id, widths.id),
        cell(row.age, widths.age),
        cell(row.kind, widths.kind),
        cell(row.status, widths.status),
        cell(row.duration, widths.duration),
        cell(row.title, titleWidth),
      ].join(GAP)
    ).trimEnd();
  return [line(HEADINGS, "  "), ...rows.map((row, i) => line(row, i === selected ? "› " : "  "))];
}

/** Selection stays inside `[0, total)`; an empty list selects nothing and reports `0`. */
export function clampSelection(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, index), total - 1);
}

/** A scroll offset that keeps `total` lines from scrolling past the end of a `viewport`-tall pane. */
export function clampScroll(offset: number, total: number, viewport: number): number {
  return Math.min(Math.max(0, offset), Math.max(0, total - Math.max(1, viewport)));
}

/** The smallest shift that brings `selected` back into view — no recentring, no jitter. */
export function scrollToShow(offset: number, selected: number, viewport: number, total: number): number {
  const height = Math.max(1, viewport);
  let next = offset;
  if (selected < next) next = selected;
  else if (selected >= next + height) next = selected - height + 1;
  return clampScroll(next, total, height);
}

/** The visible slice, padded with nothing — a short pane simply renders short. */
export function windowLines(lines: readonly string[], offset: number, viewport: number): string[] {
  const height = Math.max(1, viewport);
  const start = clampScroll(offset, lines.length, height);
  return lines.slice(start, start + height);
}

/** `stdout → stderr → cmd → stdout`. */
export function nextStream(current: JobsStream): JobsStream {
  const index = JOBS_STREAMS.indexOf(current);
  return JOBS_STREAMS[(index + 1) % JOBS_STREAMS.length] as JobsStream;
}

/** `stdout.log` / `stderr.log` / `cmd.sh` — the on-disk names `store.ts` writes. */
export function streamFile(stream: JobsStream): string {
  return stream === "cmd" ? "cmd.sh" : `${stream}.log`;
}

/**
 * Drops the leading partial line of a byte-tail read.
 *
 * A tail read starts mid-line whenever the file is longer than the cap. Showing that fragment as
 * though it were a whole line is a small lie about what the job printed, so it goes.
 */
export function dropPartialFirstLine(text: string, truncated: boolean): string {
  if (!truncated) return text;
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
}

/** Splits output into display lines: tabs expanded, trailing empty line dropped. */
export function toDisplayLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\t/g, "    ").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

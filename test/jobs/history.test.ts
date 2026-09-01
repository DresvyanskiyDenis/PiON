import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindingLabel,
  buildRows,
  clampScroll,
  clampSelection,
  dropPartialFirstLine,
  formatAge,
  formatDuration,
  jobElapsedMs,
  jobTitle,
  JOBS_KEYBINDING_DEFAULTS,
  nextStream,
  normalizeBinding,
  renderRows,
  resolveJobsKeybindings,
  scrollToShow,
  statusLabel,
  streamFile,
  toDisplayLines,
  windowLines,
} from "../../extensions/jobs/history.ts";
import type { JobState } from "../../extensions/jobs/store.ts";

/**
 * Every clock in this file is injected. Nothing sleeps, nothing samples `Date.now()`, and no
 * assertion allows a wall-clock margin — the whole reason `history.ts` takes `now` as an
 * argument is so that a loaded machine cannot turn a timing coincidence into a red test.
 */
const T0 = 1_700_000_000_000;

function job(overrides: Partial<JobState> = {}): JobState {
  return {
    schema: 1,
    id: "abc123-0001",
    kind: "bash",
    cwd: "/repo",
    cmd: "npm test",
    pid: 4242,
    pgid: 4242,
    status: "done",
    startedAt: T0,
    finishedAt: T0 + 5_000,
    exitCode: 0,
    parentSession: "sess-1",
    depth: 0,
    ...overrides,
  } as JobState;
}

describe("jobs history — durations and ages", () => {
  it("formats sub-minute, sub-hour and multi-hour spans", () => {
    assert.equal(formatDuration(1_234), "1.2s");
    assert.equal(formatDuration(59_400), "59.4s");
    assert.equal(formatDuration(184_000), "3m 04s");
    assert.equal(formatDuration(7_860_000), "2h 11m");
  });

  it("never renders a negative span, so a clock skew cannot print `-4s`", () => {
    assert.equal(formatDuration(-4_000), "0.0s");
    assert.equal(formatAge(T0, T0 - 60_000), "0s ago");
  });

  it("coarsens the age by unit", () => {
    assert.equal(formatAge(T0, T0 + 30_000), "30s ago");
    assert.equal(formatAge(T0, T0 + 90_000), "1m ago");
    assert.equal(formatAge(T0, T0 + 3 * 3_600_000), "3h ago");
    assert.equal(formatAge(T0, T0 + 50 * 3_600_000), "2d ago");
  });

  it("measures a finished job against its own end and a running one against the injected now", () => {
    assert.equal(jobElapsedMs(job(), T0 + 999_999), 5_000);
    assert.equal(jobElapsedMs(job({ status: "running", finishedAt: undefined }), T0 + 12_000), 12_000);
  });
});

describe("jobs history — row content", () => {
  it("appends the exit code only when the job has one", () => {
    assert.equal(statusLabel(job()), "done exit 0");
    assert.equal(statusLabel(job({ status: "failed", exitCode: 2 })), "failed exit 2");
    assert.equal(statusLabel(job({ status: "running", exitCode: undefined })), "running");
  });

  it("prefers label, then agent, then the command, and collapses whitespace", () => {
    assert.equal(jobTitle(job({ label: "nightly" })), "nightly");
    assert.equal(jobTitle(job({ label: undefined, agent: "researcher" })), "researcher");
    assert.equal(jobTitle(job({ label: undefined, agent: undefined, cmd: " npm  run\n  test " })), "npm run test");
  });

  it("builds one row per job against a single injected clock", () => {
    const rows = buildRows(
      [job(), job({ id: "def456-0002", status: "running", finishedAt: undefined, exitCode: undefined })],
      T0 + 60_000,
    );
    assert.deepEqual(
      rows.map((row) => row.age),
      ["1m ago", "1m ago"],
    );
    assert.deepEqual(
      rows.map((row) => row.status),
      ["done exit 0", "running"],
    );
    assert.deepEqual(
      rows.map((row) => row.duration),
      ["5.0s", "1m 00s"],
    );
  });

  it("marks the selected row and keeps the heading unmarked", () => {
    const lines = renderRows(buildRows([job(), job({ id: "def456-0002" })], T0), 1, 100);
    assert.ok(lines[0]?.startsWith("  ID"));
    assert.ok(lines[1]?.startsWith("  abc123-0001"));
    assert.ok(lines[2]?.startsWith("› def456-0002"));
  });

  it("keeps every fixed column aligned across rows of different content", () => {
    const lines = renderRows(
      buildRows([job(), job({ id: "def456-0002", status: "failed", exitCode: 127, cmd: "x" })], T0),
      0,
      120,
    );
    assert.equal(lines[1]?.indexOf("bash"), lines[2]?.indexOf("bash"), "the KIND column starts at the same offset on both rows");
    assert.ok((lines[1]?.indexOf("done") ?? -1) > 0);
    assert.equal(lines[1]?.indexOf("done"), lines[2]?.indexOf("failed"), "and so does STATUS, whatever the verdict is called");
  });

  it("truncates the free-form command column with an ellipsis rather than wrapping", () => {
    const lines = renderRows(buildRows([job({ cmd: "y".repeat(300) })], T0), 0, 60);
    assert.ok((lines[1] ?? "").endsWith("…"));
    assert.ok([...(lines[1] ?? "")].length <= 60);
  });
});

describe("jobs history — selection and scrolling", () => {
  it("clamps selection into range and reports 0 for an empty store", () => {
    assert.equal(clampSelection(-3, 5), 0);
    assert.equal(clampSelection(9, 5), 4);
    assert.equal(clampSelection(2, 0), 0);
  });

  it("never scrolls past the end, and never below zero", () => {
    assert.equal(clampScroll(-5, 100, 10), 0);
    assert.equal(clampScroll(500, 100, 10), 90);
    assert.equal(clampScroll(3, 4, 10), 0, "a list shorter than the viewport does not scroll");
  });

  it("moves the window by the smallest amount that puts the selection back in view", () => {
    assert.equal(scrollToShow(0, 3, 10, 50), 0, "already visible — no shift");
    assert.equal(scrollToShow(0, 12, 10, 50), 3, "one line past the bottom edge");
    assert.equal(scrollToShow(20, 4, 10, 50), 4, "scrolled back above the window");
  });

  it("returns exactly the visible slice", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    assert.deepEqual(windowLines(lines, 5, 3), ["line 5", "line 6", "line 7"]);
    assert.deepEqual(windowLines(lines, 19, 3), ["line 17", "line 18", "line 19"], "the tail fills the viewport");
    assert.deepEqual(windowLines([], 0, 5), []);
  });
});

describe("jobs history — output decoding", () => {
  it("drops the partial first line of a byte-tail read, and only then", () => {
    assert.equal(dropPartialFirstLine("half a line\nwhole\n", true), "whole\n");
    assert.equal(dropPartialFirstLine("half a line\nwhole\n", false), "half a line\nwhole\n");
    assert.equal(
      dropPartialFirstLine("no newline at all", true),
      "",
      "a tail with no line break shows nothing rather than a fragment",
    );
  });

  it("normalises line endings and tabs, and drops the trailing empty line", () => {
    assert.deepEqual(toDisplayLines("a\r\nb\tc\n"), ["a", "b    c"]);
    assert.deepEqual(toDisplayLines(""), []);
  });

  it("cycles stdout → stderr → cmd and maps each to its on-disk name", () => {
    assert.equal(nextStream("stdout"), "stderr");
    assert.equal(nextStream("stderr"), "cmd");
    assert.equal(nextStream("cmd"), "stdout");
    assert.equal(streamFile("stdout"), "stdout.log");
    assert.equal(streamFile("stderr"), "stderr.log");
    assert.equal(streamFile("cmd"), "cmd.sh");
  });
});

describe("jobs history — keybindings mirror the fleet inspector", () => {
  it("defaults to pi-subagents' own table for every shared action", () => {
    const bindings = resolveJobsKeybindings(undefined);
    assert.deepEqual(bindings.close, ["escape", "ctrl+c", "q"]);
    assert.deepEqual(bindings.pageUp, ["pageUp"]);
    assert.deepEqual(bindings.scrollDown, ["J"]);
  });

  it("honours a fleetKeybindings override — the escape hatch for a terminal that eats PgUp", () => {
    const bindings = resolveJobsKeybindings({ pageUp: ["ctrl+b"], pageDown: ["ctrl+f"] });
    assert.deepEqual(bindings.pageUp, ["ctrl+b"]);
    assert.deepEqual(bindings.pageDown, ["ctrl+f"]);
    assert.deepEqual(bindings.selectUp, JOBS_KEYBINDING_DEFAULTS.selectUp, "untouched actions keep their default");
  });

  it("ignores a malformed override rather than unbinding the key it names", () => {
    for (const bad of [{ close: [] }, { close: "q" }, { close: [1, 2] }, "nonsense", null] as unknown[]) {
      assert.deepEqual(resolveJobsKeybindings(bad).close, ["escape", "ctrl+c", "q"]);
    }
  });

  it("ignores an override aimed at a jobs-only action, which belongs to no fleet schema", () => {
    assert.deepEqual(resolveJobsKeybindings({ cycleStream: ["z"] }).cycleStream, JOBS_KEYBINDING_DEFAULTS.cycleStream);
  });

  it("spells a bare capital the way matchesKey wants it", () => {
    assert.equal(normalizeBinding("J"), "shift+j");
    assert.equal(normalizeBinding("j"), "j");
    assert.equal(normalizeBinding("pageUp"), "pageUp");
    assert.equal(normalizeBinding("ctrl+c"), "ctrl+c");
  });

  it("labels a binding the way the footer shows it", () => {
    const bindings = resolveJobsKeybindings(undefined);
    assert.equal(bindingLabel(bindings, "selectUp"), "↑/k");
    assert.equal(bindingLabel(bindings, "close"), "Esc/ctrl+c/q");
  });
});

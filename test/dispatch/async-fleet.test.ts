/**
 * EXT-05 — the async-run reconciler.
 *
 * The regression these lock down is a real one, measured 2026-08-13: an async `data-engineer` run
 * failed 10 seconds after spawn, wrote `"state": "failed"` into its own `status.json`, and the
 * orchestrator went on describing it as running and awaiting a result — because nothing ever put
 * the failure into the session. The fixtures below are that run's real status shape, trimmed to
 * the fields the reconciler reads.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_STATUS_GRACE_MS,
  createAsyncFleet,
  formatAnnouncement,
  noteAsyncSpawn,
  readAsyncRunState,
  reconcile,
  renderAsyncFleet,
  takeAnnouncements,
  trackedAsyncRuns,
  type AsyncFleet,
} from "../../extensions/dispatch/async-fleet.ts";
import { scratch } from "./helpers.ts";

const FAILED_RUN = "66971211-3f09-48ca-bdea-c2be3950a845";
const COLD_START_ERROR = "Subagent produced no output (possible model cold-start or empty response).";

let root: string;

beforeEach(() => {
  root = scratch("ext05-async-");
});

/** Creates `<root>/<runId>/status.json`, the way the package's runner does. */
function writeStatus(runId: string, status: Record<string, unknown>): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(status), "utf8");
  return dir;
}

/** A run directory with no status file at all — the "never started" shape. */
function emptyRunDir(runId: string): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The tool result `pi-subagents` returns for an async spawn, in its own shape. */
function spawnResult(runId: string, asyncDir: string, agent: string): unknown {
  return {
    content: [{ type: "text", text: `Async: ${agent} [${runId}]` }],
    details: { mode: "single", runId, results: [], asyncId: runId, asyncDir, context: "fresh" },
  };
}

function failedStatus(runId: string, agent = "data-engineer"): Record<string, unknown> {
  return {
    runId,
    state: "failed",
    mode: "single",
    startedAt: 1786711729112,
    endedAt: 1786711739104,
    turnCount: 2,
    outputFile: `${runId}/output-0.log`,
    error: `Step failed: ${agent}`,
    steps: [{ agent, status: "failed", exitCode: 1, error: COLD_START_ERROR }],
  };
}

function fleetWith(runId: string, asyncDir: string, agent: string, now = 0): AsyncFleet {
  const fleet = createAsyncFleet();
  noteAsyncSpawn(fleet, spawnResult(runId, asyncDir, agent), now);
  return fleet;
}

describe("trackedAsyncRuns", () => {
  it("picks up the run id and directory the package reports on an async spawn", () => {
    const runs = trackedAsyncRuns(spawnResult(FAILED_RUN, "/runs/x", "data-engineer"), 111);
    assert.deepEqual(runs, [
      { runId: FAILED_RUN, asyncDir: "/runs/x", firstSeenAt: 111, agent: "data-engineer" },
    ]);
  });

  it("takes the agent name from the acknowledgement line, since `details` never carries one", () => {
    // Verbatim shape of a real single async spawn: `details` has asyncId/asyncDir and no `agent`.
    const result = {
      content: [{ type: "text", text: `Async: researcher [${FAILED_RUN}]\n\nThe async run is detached…` }],
      details: { mode: "single", runId: FAILED_RUN, results: [], asyncId: FAILED_RUN, asyncDir: "/runs/x" },
    };
    assert.equal(trackedAsyncRuns(result)[0]?.agent, "researcher");
  });

  it("ignores a control action, which starts nothing and has no directory", () => {
    const status = { content: [{ type: "text", text: "State: failed" }], details: { mode: "management", results: [] } };
    assert.deepEqual(trackedAsyncRuns(status), []);
    assert.deepEqual(trackedAsyncRuns(undefined), []);
    assert.deepEqual(trackedAsyncRuns({ details: { asyncId: "x" } }), []);
  });

  it("picks up every child of a fan-out, not only the top-level run", () => {
    const result = {
      details: {
        mode: "workflow",
        results: [
          { agent: "researcher", asyncId: "child-1", asyncDir: "/runs/child-1" },
          { agent: "reviewer", asyncId: "child-2", asyncDir: "/runs/child-2" },
          { agent: "skipped" },
        ],
      },
    };
    assert.deepEqual(
      trackedAsyncRuns(result, 7).map((r) => `${r.agent}:${r.runId}`),
      ["researcher:child-1", "reviewer:child-2"],
    );
  });
});

describe("readAsyncRunState — the authoritative on-disk terminal state", () => {
  it("reports a failed run as failed, with the STEP error rather than the run summary", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const verdict = readAsyncRunState({ runId: FAILED_RUN, asyncDir: dir, firstSeenAt: 0 });
    assert.equal(verdict.kind, "terminal");
    assert.partialDeepStrictEqual(verdict, {
      kind: "terminal",
      state: "failed",
      failed: true,
      agent: "data-engineer",
      error: COLD_START_ERROR,
      turns: 2,
      durationMs: 9992,
    });
  });

  it("does not call a completed run failed", () => {
    const dir = writeStatus("ok-run", { runId: "ok-run", state: "complete", startedAt: 1, endedAt: 2 });
    const verdict = readAsyncRunState({ runId: "ok-run", asyncDir: dir, firstSeenAt: 0 });
    assert.partialDeepStrictEqual(verdict, { kind: "terminal", state: "complete", failed: false });
  });

  it("counts stopped and rejected as terminal failures, and paused as still live", () => {
    for (const state of ["stopped", "rejected"]) {
      const dir = writeStatus(state, { runId: state, state, error: "gone" });
      assert.partialDeepStrictEqual(readAsyncRunState({ runId: state, asyncDir: dir, firstSeenAt: 0 }), {
        kind: "terminal",
        failed: true,
      });
    }
    for (const state of ["queued", "running", "paused"]) {
      const dir = writeStatus(state, { runId: state, state });
      assert.deepEqual(readAsyncRunState({ runId: state, asyncDir: dir, firstSeenAt: 0 }), { kind: "live", state });
    }
  });

  it("distinguishes a run that never started from one that finished", () => {
    const started = writeStatus("started", failedStatus("started"));
    const never = emptyRunDir("never");
    assert.equal(readAsyncRunState({ runId: "started", asyncDir: started, firstSeenAt: 0 }).kind, "terminal");
    const verdict = readAsyncRunState({ runId: "never", asyncDir: never, firstSeenAt: 0 });
    assert.equal(verdict.kind, "no-status");
    assert.match(verdict.kind === "no-status" ? verdict.reason : "", /was ever written/);
  });

  it("treats an unreadable status file as unknown, never as healthy", () => {
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), "{ not json", "utf8");
    assert.equal(readAsyncRunState({ runId: "broken", asyncDir: dir, firstSeenAt: 0 }).kind, "no-status");
  });

  it("leads a classified failure with the provider abort, not with the startup notice above it", () => {
    // The step error a real failed run carries is the child's whole stderr tail, startup notices
    // first — see `failure-slot.ts`. Same tail, same content, different first line.
    const tail = [
      '[pi-config] path-defaults: root * names tier "fast" (databricks/gpt-5.6-luna), but an explicit model selection is already in effect for this session — leaving it alone.',
      '[pi-config] web: backend="searxng", proxy=false, extraCa=true',
      "[pi-config] provider call failed: databricks/gpt-5.6-luna — empty-response (http 200, empty body)",
      "  provider : databricks",
      "  class    : empty-response",
      "  policy   : abort — no failover, no substitution, no retry against another provider (routing.json onProviderError.policy)",
    ].join("\n");
    const dir = writeStatus("classified", {
      runId: "classified",
      state: "failed",
      error: "Step failed: ai-engineer",
      steps: [{ agent: "ai-engineer", error: tail }],
    });
    const verdict = readAsyncRunState({ runId: "classified", asyncDir: dir, firstSeenAt: 0 });
    assert.equal(verdict.kind, "terminal");
    const error = verdict.kind === "terminal" ? (verdict.error ?? "") : "";
    assert.match(error.split("\n")[0]!, /^\[pi-config\] provider call failed: databricks\/gpt-5\.6-luna/);
    assert.doesNotMatch(error.split("\n")[0]!, /path-defaults/);
    for (const line of tail.split("\n")) assert.ok(error.includes(line), "the tail lost a line");
  });

  it("leaves an unclassified step error untouched — no classification is invented", () => {
    const dir = writeStatus("plain", {
      runId: "plain",
      state: "failed",
      steps: [{ agent: "data-engineer", error: COLD_START_ERROR }],
    });
    const verdict = readAsyncRunState({ runId: "plain", asyncDir: dir, firstSeenAt: 0 });
    assert.partialDeepStrictEqual(verdict, { kind: "terminal", error: COLD_START_ERROR });
  });
});

describe("the status surface a failed async run reaches", () => {
  it("announces a failed run, with its error, on the turn after it died", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    const due = takeAnnouncements(fleet, reconcile(fleet));
    assert.equal(due.length, 1);
    const text = formatAnnouncement(due);
    assert.ok(text !== undefined);
    assert.match(text, /✗ data-engineer \[66971211\] failed/);
    assert.ok(text.includes(COLD_START_ERROR));
    assert.match(text, /NOT running/);
  });

  it("says nothing at all while the run is still running", () => {
    const dir = writeStatus(FAILED_RUN, { runId: FAILED_RUN, state: "running", startedAt: 1 });
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), []);
    assert.equal(formatAnnouncement(reconcile(fleet)), undefined);
  });

  it("announces each run exactly once, then stays quiet even though the file is still failed", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    assert.equal(takeAnnouncements(fleet, reconcile(fleet)).length, 1);
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), []);
  });

  it("waits out the grace before calling a status-less run never started", () => {
    const dir = emptyRunDir(FAILED_RUN);
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer", 1_000);
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet), 1_000 + NO_STATUS_GRACE_MS - 1), []);
    const due = takeAnnouncements(fleet, reconcile(fleet), 1_000 + NO_STATUS_GRACE_MS);
    assert.equal(due.length, 1);
    assert.match(formatAnnouncement(due) ?? "", /NEVER STARTED/);
  });

  it("reports a run that finished cleanly without calling it a failure", () => {
    const dir = writeStatus("ok-run", { runId: "ok-run", state: "complete", startedAt: 1, endedAt: 3_000 });
    const fleet = fleetWith("ok-run", dir, "researcher");
    const text = formatAnnouncement(takeAnnouncements(fleet, reconcile(fleet)));
    assert.match(text ?? "", /✓ researcher \[ok-run\] complete/);
    assert.doesNotMatch(text ?? "", /NOT running/);
  });

  it("shows the same verdict in the /agents fleet section, re-read from disk", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    const rendered = renderAsyncFleet(fleet);
    assert.match(rendered, /async runs started by this session \(1\)/);
    assert.match(rendered, /data-engineer \[66971211\]: failed/);
    assert.ok(rendered.includes(COLD_START_ERROR));
  });

  it("renders nothing when this session started no async run", () => {
    assert.equal(renderAsyncFleet(createAsyncFleet()), "");
  });
});

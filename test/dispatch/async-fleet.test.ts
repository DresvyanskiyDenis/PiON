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
  SETTLED_TTL_MS,
  createAsyncFleet,
  formatAnnouncement,
  noteAsyncConsumption,
  noteAsyncSpawn,
  readAsyncRunState,
  reconcile,
  renderAsyncFleet,
  retireSettledRuns,
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

/**
 * The runner's exit proof, in the shape the package writes it
 * (`node_modules/pi-subagents/src/runs/background/process-terminal.ts`). `state: "observed"` is the
 * only one that means the runner was seen to close; the instance list and `runnerProcessInstanceId`
 * have to agree, because that is what the package's own validator checks and what a hand-written
 * fixture would otherwise get silently wrong.
 */
function writeExitProof(dir: string, runId: string, state: string): void {
  writeFileSync(
    join(dir, "process-terminal.json"),
    JSON.stringify({
      version: 1,
      runId,
      state,
      observedAt: 1786711739104,
      runnerProcessInstanceId: "runner-1",
      instances: [
        { processInstanceId: "runner-1", kind: "runner", closeObservedAt: 1786711739104, exitCode: 0, signal: null },
      ],
    }),
    "utf8",
  );
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
    // "tracked", not "started": a run this section lists is one the fleet still holds. Retired runs
    // are `/subagents-fleet`'s to show, from the directories on disk.
    assert.match(rendered, /async runs tracked by this session \(1\)/);
    assert.match(rendered, /data-engineer \[66971211\]: failed/);
    assert.ok(rendered.includes(COLD_START_ERROR));
  });

  it("renders nothing when this session started no async run", () => {
    assert.equal(renderAsyncFleet(createAsyncFleet()), "");
  });
});

/**
 * The mirror regression, measured 2026-08-26: run `d0ebf2c7-f055-4165-80db-fc1e70bfd69e` was waited
 * on, polled and read by the model, which then closed its todo — and two minutes later the
 * announcement told it to "read the artifact above". The three tool results below are that run's
 * real shapes, trimmed to the fields the reconciler reads.
 */
describe("noteAsyncConsumption — the run the model already read", () => {
  const RUN = "d0ebf2c7-f055-4165-80db-fc1e70bfd69e";

  const completeStatus = { runId: RUN, state: "complete", startedAt: 1, endedAt: 151_000, turnCount: 1 };

  /** `subagent_wait`: names the run in its text, and carries no `details` beyond the mode. */
  const waitResult = {
    content: [
      {
        type: "text",
        text: `Waited 2m31s for run "${RUN}"; done. Outcome: 1 complete. Completion/control events have been observed.`,
      },
    ],
    details: { mode: "management", results: [] },
  };

  /** `subagent({action:"status"})`: names the run in its text, and starts nothing. */
  const statusResult = {
    content: [{ type: "text", text: `Run: ${RUN}\nState: complete\nProcess terminal: observed` }],
    details: { mode: "single", results: [], lifecycleStatus: "complete" },
  };

  /** `ctx_read` of the artifact: names the run ONLY in `details.path`. */
  const readResult = (dir: string) => ({
    content: [{ type: "text", text: "…the agent's output…" }],
    details: { path: join(dir, "output-0.log"), source: "lean-ctx", mode: "full" },
  });

  it("suppresses the announcement once `subagent_wait` has reported the run done", () => {
    const dir = writeStatus(RUN, completeStatus);
    const fleet = fleetWith(RUN, dir, "data-engineer");
    assert.deepEqual(noteAsyncConsumption(fleet, waitResult), [RUN]);
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), []);
  });

  it("suppresses it after a status poll that returned a terminal state", () => {
    const dir = writeStatus(RUN, completeStatus);
    const fleet = fleetWith(RUN, dir, "data-engineer");
    assert.deepEqual(noteAsyncConsumption(fleet, statusResult), [RUN]);
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), []);
  });

  it("suppresses it after a read of the run's own artifact, named only in details.path", () => {
    const dir = writeStatus(RUN, completeStatus);
    const fleet = fleetWith(RUN, dir, "data-engineer");
    assert.deepEqual(noteAsyncConsumption(fleet, readResult(dir)), [RUN]);
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), []);
  });

  it("suppresses a failed run the model inspected just the same — it was told", () => {
    const dir = writeStatus(RUN, failedStatus(RUN));
    const fleet = fleetWith(RUN, dir, "data-engineer");
    assert.deepEqual(noteAsyncConsumption(fleet, statusResult), [RUN]);
    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), []);
  });

  it("does NOT count a poll of a still-running run: it says nothing about how the run ends", () => {
    const dir = writeStatus(RUN, { runId: RUN, state: "running", startedAt: 1 });
    const fleet = fleetWith(RUN, dir, "data-engineer");
    assert.deepEqual(noteAsyncConsumption(fleet, statusResult), []);
    // …and the terminal state that arrives later is still announced, exactly once.
    writeStatus(RUN, completeStatus);
    assert.equal(takeAnnouncements(fleet, reconcile(fleet)).length, 1);
  });

  it("does NOT count the spawn acknowledgement, which names the run because it created it", () => {
    const dir = writeStatus(RUN, completeStatus);
    const fleet = createAsyncFleet();
    const spawn = spawnResult(RUN, dir, "data-engineer");
    noteAsyncSpawn(fleet, spawn);
    assert.deepEqual(noteAsyncConsumption(fleet, spawn), []);
    assert.equal(takeAnnouncements(fleet, reconcile(fleet)).length, 1);
  });

  it("does NOT count a run that has never written a status file — 'never started' still gets said", () => {
    const dir = emptyRunDir(RUN);
    const fleet = fleetWith(RUN, dir, "data-engineer", 1_000);
    assert.deepEqual(noteAsyncConsumption(fleet, readResult(dir)), []);
    assert.equal(takeAnnouncements(fleet, reconcile(fleet), 1_000 + NO_STATUS_GRACE_MS).length, 1);
  });

  it("leaves a sibling run alone: only the run the result named is consumed", () => {
    const readDir = writeStatus(RUN, completeStatus);
    const otherDir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(RUN, readDir, "data-engineer");
    noteAsyncSpawn(fleet, spawnResult(FAILED_RUN, otherDir, "researcher"));
    assert.deepEqual(noteAsyncConsumption(fleet, waitResult), [RUN]);
    const due = takeAnnouncements(fleet, reconcile(fleet));
    assert.deepEqual(due.map((report) => report.run.runId), [FAILED_RUN]);
  });

  it("is inert for an unrelated tool result, and for a fleet with nothing tracked", () => {
    const dir = writeStatus(RUN, completeStatus);
    const fleet = fleetWith(RUN, dir, "data-engineer");
    const todo = { content: [{ type: "text", text: "Updated #6 (in_progress → completed)" }], details: { action: "update" } };
    assert.deepEqual(noteAsyncConsumption(fleet, todo), []);
    assert.deepEqual(noteAsyncConsumption(createAsyncFleet(), waitResult), []);
    assert.deepEqual(noteAsyncConsumption(fleet, undefined), []);
    assert.equal(takeAnnouncements(fleet, reconcile(fleet)).length, 1);
  });

  it("consumes a run only once, and never un-consumes one already announced", () => {
    const dir = writeStatus(RUN, completeStatus);
    const fleet = fleetWith(RUN, dir, "data-engineer");
    assert.equal(takeAnnouncements(fleet, reconcile(fleet)).length, 1);
    assert.deepEqual(noteAsyncConsumption(fleet, waitResult), []);
    assert.deepEqual(noteAsyncConsumption(fleet, waitResult), []);
  });
});

/**
 * The fleet never removed anything. `tracked` grew for the life of the session, and three things
 * are a function of its size: `reconcile` reads one status file per entry on every 1 Hz repaint,
 * the widget's poll stops only when the panel goes away and the panel goes away only at
 * `tracked.size === 0`, and the panel shows runs oldest-first so a pile of history pushes the
 * running children behind "… and N more". These lock the retirement rule and, more importantly,
 * the three things it must not do: retire a live run, retire a run nobody was told about, or let a
 * retired run come back.
 */
describe("retiring runs that are over and have been reported", () => {
  const OTHER_RUN = "6e77fc27-8d2b-4c1a-9f30-0b2a4f6c1e55";

  it("keeps a finished run until the ledger has it", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    const late = SETTLED_TTL_MS * 10;

    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), late), []);
    assert.equal(fleet.tracked.size, 1, "a terminal run nobody was told about must stay");

    takeAnnouncements(fleet, reconcile(fleet));
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), late), [], "the first sweep only stamps");
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), late + SETTLED_TTL_MS), [FAILED_RUN]);
    assert.equal(fleet.tracked.size, 0);
  });

  it("waits out the full TTL, so a finished run is visible on the panel that repaints at 1 Hz", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    takeAnnouncements(fleet, reconcile(fleet));

    retireSettledRuns(fleet, reconcile(fleet), 1_000);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), 1_000 + SETTLED_TTL_MS - 1), []);
    assert.equal(fleet.tracked.size, 1);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), 1_000 + SETTLED_TTL_MS), [FAILED_RUN]);
  });

  it("retires a run the model read itself, without an announcement", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    noteAsyncConsumption(fleet, { content: [{ type: "text", text: `State: failed (${FAILED_RUN})` }] });
    assert.equal(fleet.consumed.has(FAILED_RUN), true);
    assert.equal(fleet.announced.has(FAILED_RUN), false);

    retireSettledRuns(fleet, reconcile(fleet), 0);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS), [FAILED_RUN]);
  });

  it("retires a never-started run once it has been announced", () => {
    const dir = emptyRunDir(FAILED_RUN);
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    const past = NO_STATUS_GRACE_MS + 1;
    assert.equal(takeAnnouncements(fleet, reconcile(fleet), past).length, 1);

    retireSettledRuns(fleet, reconcile(fleet), past);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), past + SETTLED_TTL_MS), [FAILED_RUN]);
    assert.equal(fleet.tracked.size, 0);
  });

  it("never retires a live run, however long it runs", () => {
    const dir = writeStatus(FAILED_RUN, { runId: FAILED_RUN, state: "running", steps: [] });
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    fleet.consumed.add(FAILED_RUN);
    const late = SETTLED_TTL_MS * 100;
    retireSettledRuns(fleet, reconcile(fleet), late);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), late * 2), []);
    assert.equal(fleet.tracked.size, 1);
  });

  it("does not carry a stamp across a run that comes back to life", () => {
    const dir = emptyRunDir(FAILED_RUN);
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    const past = NO_STATUS_GRACE_MS + 1;
    takeAnnouncements(fleet, reconcile(fleet), past);
    retireSettledRuns(fleet, reconcile(fleet), past);
    assert.equal(fleet.settledAt.has(FAILED_RUN), true);

    // The run was merely slow: it writes its status and is running after all.
    writeStatus(FAILED_RUN, { runId: FAILED_RUN, state: "running", steps: [] });
    retireSettledRuns(fleet, reconcile(fleet), past + 1);
    assert.equal(fleet.settledAt.has(FAILED_RUN), false, "the stamp must not survive the run coming up");
    assert.equal(fleet.tracked.size, 1);
  });

  it("retires only the runs that are done, leaving the running one on the panel", () => {
    const doneDir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const liveDir = writeStatus(OTHER_RUN, { runId: OTHER_RUN, state: "running", steps: [] });
    const fleet = fleetWith(FAILED_RUN, doneDir, "data-engineer");
    noteAsyncSpawn(fleet, spawnResult(OTHER_RUN, liveDir, "debugger"));
    takeAnnouncements(fleet, reconcile(fleet));

    retireSettledRuns(fleet, reconcile(fleet), 0);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS), [FAILED_RUN]);
    assert.deepEqual([...fleet.tracked.keys()], [OTHER_RUN]);
  });

  it("does not let a retired run be tracked or announced again", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    takeAnnouncements(fleet, reconcile(fleet));
    retireSettledRuns(fleet, reconcile(fleet), 0);
    retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS);
    assert.equal(fleet.tracked.size, 0);

    assert.deepEqual(noteAsyncSpawn(fleet, spawnResult(FAILED_RUN, dir, "data-engineer")), []);
    assert.equal(fleet.tracked.size, 0, "the ledger, not `tracked`, is what makes this once-only");
    assert.equal(takeAnnouncements(fleet, reconcile(fleet), SETTLED_TTL_MS).length, 0);
  });

  it("empties the fleet, which is the signal the widget's poll stops on", () => {
    const dir = writeStatus(FAILED_RUN, failedStatus(FAILED_RUN));
    const fleet = fleetWith(FAILED_RUN, dir, "data-engineer");
    takeAnnouncements(fleet, reconcile(fleet));
    retireSettledRuns(fleet, reconcile(fleet), 0);
    retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS);
    assert.equal(fleet.tracked.size, 0);
    assert.equal(renderAsyncFleet(fleet), "", "/agents shows no section once nothing is tracked");
  });
});

/**
 * The 106-record panel: `status.json` said `paused`, the runner was long gone, and `paused` is not
 * in `TERMINAL_STATES` — so every sweep called these runs live and none of them was ever dropped.
 */
describe("retiring paused runs whose runner has gone", () => {
  const PAUSED_RUN = "f47de05e-8ab2-41f1-a2f5-e9a02a1e8b62";

  function pausedRun(): string {
    return writeStatus(PAUSED_RUN, { runId: PAUSED_RUN, state: "paused", pid: 99_999, steps: [] });
  }

  it("retires one whose exit proof says the runner was observed to close", () => {
    const dir = pausedRun();
    writeExitProof(dir, PAUSED_RUN, "observed");
    const fleet = fleetWith(PAUSED_RUN, dir, "data-engineer");

    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), 0), [], "retired before the TTL");
    assert.equal(fleet.settledAt.get(PAUSED_RUN), 0, "the abandoned pause was never stamped");
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS), [PAUSED_RUN]);
    assert.equal(fleet.tracked.size, 0);
    assert.equal(renderAsyncFleet(fleet), "", "/agents still lists a run nothing is watching");
  });

  it("keeps one whose runner has not been seen to exit", () => {
    const fleet = fleetWith(PAUSED_RUN, pausedRun(), "data-engineer");

    retireSettledRuns(fleet, reconcile(fleet), 0);
    assert.equal(fleet.settledAt.has(PAUSED_RUN), false, "a pause with no proof was called settled");
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS * 100), []);
    assert.equal(fleet.tracked.size, 1, "a resumable run was dropped off the panel");
  });

  it("keeps one whose proof is still pending — three of the four states are not evidence", () => {
    for (const state of ["pending", "unknown", "not-started"]) {
      const dir = pausedRun();
      writeExitProof(dir, PAUSED_RUN, state);
      const fleet = fleetWith(PAUSED_RUN, dir, "data-engineer");

      retireSettledRuns(fleet, reconcile(fleet), 0);
      assert.deepEqual(
        retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS * 100),
        [],
        `a proof in state "${state}" was read as an exit`,
      );
    }
  });

  it("retires one the model was never told about, because it never could be", () => {
    // The ledger gate is what holds a *finished* run until its ending is in the session. A paused
    // run has no ending to deliver: `takeAnnouncements` returns early on every `live` verdict, so
    // this fleet's `announced` and `consumed` are both empty and always would be. Requiring the
    // ledger here is requiring something that cannot happen, which is the defect, not the fix.
    const dir = pausedRun();
    writeExitProof(dir, PAUSED_RUN, "observed");
    const fleet = fleetWith(PAUSED_RUN, dir, "data-engineer");

    assert.deepEqual(takeAnnouncements(fleet, reconcile(fleet)), [], "a paused run was announced");
    assert.equal(fleet.announced.size + fleet.consumed.size, 0);
    retireSettledRuns(fleet, reconcile(fleet), 0);
    assert.deepEqual(retireSettledRuns(fleet, reconcile(fleet), SETTLED_TTL_MS), [PAUSED_RUN]);
  });
});

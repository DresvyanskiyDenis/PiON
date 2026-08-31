/**
 * EXT-05 — the first-party consumer for `subagents.watchdog.asyncCompletion`.
 *
 * The hole these lock down: the setting is parsed by `pi-subagents` and read by no runtime there,
 * so an async child that came back with literally no output was announced as failed and then left
 * for a person to re-dispatch by hand. `extensions/dispatch/async-resume.ts` answers it with one
 * automatic `resume` over the package's in-process RPC — and the interesting assertions below are
 * the ones about the *second* attempt, because a recovery for "the child said nothing" that can
 * fire twice is a loop that buys a model call per iteration.
 *
 * The status fixtures are the real shape the runner writes (`readAsyncRunState` parses them), not
 * hand-made verdict objects: the empty-completion sentence reaches a verdict only after the failed
 * step's error has been preferred over the run-level summary and reordered by `failure-slot.ts`,
 * and a test that skipped that path would not be testing the detector that ships.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_COMPLETION_ERROR,
  RESUME_BUDGET,
  emptyCompletion,
  followUpEmptyRuns,
  followUpMessage,
  readAsyncCompletionGate,
  resumeAttempts,
  spendResumeBudget,
  type AsyncCompletionGate,
  type ResumeBus,
} from "../../extensions/dispatch/async-resume.ts";
import {
  formatAnnouncement,
  readAsyncRunState,
  type AsyncRunReport,
  type TrackedAsyncRun,
} from "../../extensions/dispatch/async-fleet.ts";
import { scratch } from "./helpers.ts";

const EMPTY_RUN = "a1b2c3d4-0000-4000-8000-000000000001";
const RESUMED_RUN = "f9e8d7c6-0000-4000-8000-000000000002";

let root: string;
let ledgerFile: string;

beforeEach(() => {
  root = scratch("ext05-resume-");
  ledgerFile = join(root, "ledger", "async-resume.jsonl");
});

/** `<root>/<runId>/status.json`, the way the package's runner writes it. */
function writeStatus(runId: string, status: Record<string, unknown>): TrackedAsyncRun {
  const asyncDir = join(root, runId);
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify(status), "utf8");
  return { runId, asyncDir, agent: "data-engineer", firstSeenAt: 0 };
}

function reportFor(runId: string, status: Record<string, unknown>): AsyncRunReport {
  const run = writeStatus(runId, status);
  return { run, verdict: readAsyncRunState(run) };
}

/** A run that died with nothing to show for it — the case this module exists for. */
const EMPTY_STATUS = {
  state: "failed",
  error: "Step failed: data-engineer",
  steps: [{ agent: "data-engineer", error: EMPTY_COMPLETION_ERROR }],
};

const ON: AsyncCompletionGate = { enabled: true, autoFollowBlockers: true, why: "test" };

interface Sent {
  readonly channel: string;
  readonly data: unknown;
}

/** A bus that records what was published and hands back the reply channel it was subscribed on. */
function fakeBus(): {
  bus: ResumeBus;
  sent: Sent[];
  listeners: Map<string, (data: unknown) => void>;
  unsubscribed: string[];
} {
  const sent: Sent[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  const unsubscribed: string[] = [];
  const bus: ResumeBus = {
    emit: (channel, data) => void sent.push({ channel, data }),
    on: (channel, handler) => {
      listeners.set(channel, handler);
      return () => void unsubscribed.push(channel);
    },
  };
  return { bus, sent, listeners, unsubscribed };
}

describe("empty-completion detection", () => {
  it("recognises the runner's own words for a child that produced nothing", () => {
    const report = reportFor(EMPTY_RUN, EMPTY_STATUS);
    assert.equal(report.verdict.kind, "terminal");
    assert.ok(emptyCompletion(report.verdict), "the failed step's error carries the empty-completion sentence");
  });

  it("does not claim a run that failed for a reason of its own", () => {
    const report = reportFor(EMPTY_RUN, {
      state: "failed",
      steps: [{ agent: "data-engineer", error: "Tool 'bash' exited 2: no such file or directory" }],
    });
    assert.equal(emptyCompletion(report.verdict), false);
  });

  it("does not claim a run that came back empty once and then completed", () => {
    // `readAsyncRunState` prefers the first failed STEP's error whatever the run-level state says,
    // so this shape reaches the detector carrying the sentence. Resuming it would re-run work that
    // already succeeded.
    const report = reportFor(EMPTY_RUN, {
      state: "complete",
      steps: [{ agent: "data-engineer", error: EMPTY_COMPLETION_ERROR }, { agent: "data-engineer" }],
    });
    assert.equal(report.verdict.kind, "terminal");
    assert.equal(emptyCompletion(report.verdict), false);
  });

  it("does not claim a run that is still live or never wrote a status file", () => {
    assert.equal(emptyCompletion(reportFor(EMPTY_RUN, { state: "running" }).verdict), false);
    const never: TrackedAsyncRun = { runId: "gone", asyncDir: join(root, "gone"), firstSeenAt: 0 };
    assert.equal(emptyCompletion(readAsyncRunState(never)), false);
  });

  it("survives the stderr tail the failure slot reorders around it", () => {
    // The step error the runner records is the child's whole stderr tail, startup notices first.
    // `readAsyncRunState` runs it through `reorderFailureText`, so the detector matches on
    // containment rather than equality — this is the fixture that says so.
    const report = reportFor(EMPTY_RUN, {
      state: "failed",
      steps: [
        {
          agent: "data-engineer",
          error: `warning: an extension took 1.2s to load\n${EMPTY_COMPLETION_ERROR}\nexit code 0`,
        },
      ],
    });
    assert.ok(emptyCompletion(report.verdict));
  });
});

describe("the gate: subagents.watchdog.asyncCompletion", () => {
  const write = (watchdog: unknown): string => {
    const file = join(root, "settings.json");
    writeFileSync(file, JSON.stringify({ subagents: { watchdog } }), "utf8");
    return file;
  };

  it("is on only when both flags are literally true", () => {
    const gate = readAsyncCompletionGate(
      write({ enabled: true, asyncCompletion: { enabled: true, autoFollowBlockers: true } }),
    );
    assert.equal(gate.enabled, true);
    assert.equal(gate.autoFollowBlockers, true);
  });

  it("is off when the top-level watchdog flag is off, whatever asyncCompletion says", () => {
    // The package ANDs its own endpoint flags with the top-level one (`watchdog/child-status.ts`).
    // A consumer that did not would fire in a tree that turned the watchdog off.
    const gate = readAsyncCompletionGate(write({ enabled: false, asyncCompletion: { enabled: true } }));
    assert.equal(gate.enabled, false);
    assert.match(gate.why, /watchdog\.enabled is not true/);
  });

  it("is off when asyncCompletion is off, or absent, or the file is not there", () => {
    assert.equal(readAsyncCompletionGate(write({ enabled: true, asyncCompletion: { enabled: false } })).enabled, false);
    assert.equal(readAsyncCompletionGate(write({ enabled: true })).enabled, false);
    const missing = readAsyncCompletionGate(join(root, "nothing-here.json"));
    assert.equal(missing.enabled, false);
    assert.match(missing.why, /does not exist/);
  });

  it("reports an unreadable settings file rather than treating it as permission", () => {
    const file = join(root, "settings.json");
    writeFileSync(file, "{ not json", "utf8");
    const gate = readAsyncCompletionGate(file);
    assert.equal(gate.enabled, false);
    assert.match(gate.why, /unreadable/);
  });

  it("carries autoFollowBlockers without letting it decide anything", () => {
    // Documented decision: a BLOCKED child is a different recovery with a different message, and it
    // belongs to the watchdog's follow-up cycle. The flag is resolved and reported, never gating.
    const file = write({ enabled: true, asyncCompletion: { enabled: true, autoFollowBlockers: false } });
    const gate = readAsyncCompletionGate(file);
    assert.equal(gate.autoFollowBlockers, false);
    assert.equal(gate.enabled, true, "an empty completion is followed up regardless of the blockers flag");
  });

  it("sends nothing at all while the gate is off", () => {
    const { bus, sent } = fakeBus();
    const requested = followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: () => assert.fail("nothing should be delivered"),
      gate: { enabled: false, autoFollowBlockers: true, why: "off in the test" },
      ledgerFile,
    });
    assert.deepEqual(requested, []);
    assert.deepEqual(sent, []);
    assert.equal(resumeAttempts(EMPTY_RUN, ledgerFile), 0, "a gated-off sweep must not spend the budget either");
  });
});

describe("the RPC request", () => {
  it("asks pi-subagents to resume the run, by id, with a message that names the failure", () => {
    const { bus, sent, listeners } = fakeBus();
    const requested = followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: () => {},
      gate: ON,
      ledgerFile,
      newRequestId: () => "req-1",
    });

    assert.deepEqual(requested, [EMPTY_RUN]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.channel, "subagents:rpc:v1:request");
    const envelope = sent[0]!.data as Record<string, unknown>;
    assert.equal(envelope.version, 1);
    assert.equal(envelope.requestId, "req-1");
    assert.equal(envelope.method, "resume");
    const params = envelope.params as Record<string, unknown>;
    assert.equal(params.id, EMPTY_RUN, "the package resolves an async run by id against its own root");
    assert.ok(typeof params.message === "string" && params.message.includes(EMPTY_COMPLETION_ERROR));
    assert.ok(
      listeners.has("subagents:rpc:v1:reply:req-1"),
      "the reply channel is subscribed before the request goes out — the bus delivers synchronously",
    );
  });

  it("tells the child this is the only follow-up it gets", () => {
    assert.match(followUpMessage(), /one automatic follow-up and there will not be another/);
  });

  it("delivers a successful resume as one message and adopts the run it started", () => {
    const { bus, listeners } = fakeBus();
    const delivered: string[] = [];
    const adopted: unknown[] = [];
    followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: (text) => void delivered.push(text),
      adopt: (result) => void adopted.push(result),
      gate: ON,
      ledgerFile,
      newRequestId: () => "req-1",
    });

    const payload = { text: "Async: data-engineer", details: { asyncId: RESUMED_RUN, asyncDir: join(root, RESUMED_RUN) } };
    listeners.get("subagents:rpc:v1:reply:req-1")!({ version: 1, requestId: "req-1", success: true, data: payload });

    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /resumed as \[f9e8d7c6\]/);
    assert.deepEqual(adopted, [payload]);
  });

  it("says plainly that nothing was resumed when the package refuses", () => {
    const { bus, listeners } = fakeBus();
    const delivered: string[] = [];
    followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: (text) => void delivered.push(text),
      adopt: () => assert.fail("a refusal starts nothing"),
      gate: ON,
      ledgerFile,
      newRequestId: () => "req-1",
    });

    listeners.get("subagents:rpc:v1:reply:req-1")!({
      version: 1,
      requestId: "req-1",
      success: false,
      error: { code: "invalid_state", message: "Async run is not resumable." },
    });

    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /refused by pi-subagents \(invalid_state\): Async run is not resumable\./);
    assert.match(delivered[0]!, /Nothing was resumed/);
  });

  it("reports the outcome exactly once, and unsubscribes when it does", () => {
    const { bus, listeners, unsubscribed } = fakeBus();
    const delivered: string[] = [];
    followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: (text) => void delivered.push(text),
      gate: ON,
      ledgerFile,
      newRequestId: () => "req-1",
    });

    const reply = listeners.get("subagents:rpc:v1:reply:req-1")!;
    reply({ version: 1, requestId: "req-1", success: false, error: { code: "not_found", message: "gone" } });
    reply({ version: 1, requestId: "req-1", success: false, error: { code: "not_found", message: "gone" } });

    assert.equal(delivered.length, 1, "a bus that replays a reply must not replay the message");
    assert.deepEqual(unsubscribed, ["subagents:rpc:v1:reply:req-1"]);
  });

  it("does not hold the session waiting for a reply that never comes", async () => {
    const { bus } = fakeBus();
    const delivered: string[] = [];
    followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: (text) => void delivered.push(text),
      gate: ON,
      ledgerFile,
      replyTimeoutMs: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /got no reply/);
    assert.match(delivered[0]!, /RPC bridge may not be loaded/);
  });

  it("survives a bus that throws instead of publishing", () => {
    const problems: string[] = [];
    const delivered: string[] = [];
    const throwing: ResumeBus = {
      emit: () => {
        throw new Error("no subscriber");
      },
      on: () => () => {},
    };
    const requested = followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus: throwing,
      deliver: (text) => void delivered.push(text),
      onProblem: (problem) => void problems.push(problem),
      gate: ON,
      ledgerFile,
    });

    assert.deepEqual(requested, [EMPTY_RUN], "the attempt was spent, so it is reported as one");
    assert.equal(problems.length, 1);
    assert.match(delivered[0]!, /could not be sent/);
  });
});

describe("the loop guard", () => {
  it("gives a run one follow-up and then never again, across a re-read of the ledger", () => {
    const report = reportFor(EMPTY_RUN, EMPTY_STATUS);
    const first = fakeBus();
    assert.deepEqual(followUpEmptyRuns([report], { bus: first.bus, deliver: () => {}, gate: ON, ledgerFile }), [
      EMPTY_RUN,
    ]);

    // Nothing in memory is carried over: a second process, a second sweep, the same run on disk.
    const second = fakeBus();
    assert.deepEqual(followUpEmptyRuns([report], { bus: second.bus, deliver: () => {}, gate: ON, ledgerFile }), []);
    assert.deepEqual(second.sent, [], "the budget is a file, not a set held for the life of the session");
    assert.equal(resumeAttempts(EMPTY_RUN, ledgerFile), RESUME_BUDGET);
  });

  it("spends the resumed run's budget before it joins the fleet", () => {
    // Otherwise a chain of empty children walks the budget forward one run at a time and the whole
    // guard is decoration.
    const { bus, listeners } = fakeBus();
    const adopted: unknown[] = [];
    followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: () => {},
      adopt: () => {
        assert.equal(
          resumeAttempts(RESUMED_RUN, ledgerFile),
          RESUME_BUDGET,
          "the new run is already spent by the time anything can track it",
        );
        adopted.push(true);
      },
      gate: ON,
      ledgerFile,
      newRequestId: () => "req-1",
    });

    listeners.get("subagents:rpc:v1:reply:req-1")!({
      version: 1,
      requestId: "req-1",
      success: true,
      data: { details: { asyncId: RESUMED_RUN, asyncDir: join(root, RESUMED_RUN) } },
    });
    assert.equal(adopted.length, 1);

    const resumed = reportFor(RESUMED_RUN, EMPTY_STATUS);
    const next = fakeBus();
    assert.deepEqual(followUpEmptyRuns([resumed], { bus: next.bus, deliver: () => {}, gate: ON, ledgerFile }), []);
  });

  it("sends nothing when the budget cannot be recorded", () => {
    // Fails closed on purpose: an attempt nobody can record is indistinguishable from an unbounded
    // number of them.
    const unwritable = join(root, "settings.json");
    writeFileSync(unwritable, "{}", "utf8");
    const { bus, sent } = fakeBus();
    const requested = followUpEmptyRuns([reportFor(EMPTY_RUN, EMPTY_STATUS)], {
      bus,
      deliver: () => assert.fail("nothing was sent, so there is no outcome to deliver"),
      gate: ON,
      // A path whose parent is a regular file: `mkdirSync` cannot create it.
      ledgerFile: join(unwritable, "async-resume.jsonl"),
    });
    assert.deepEqual(requested, []);
    assert.deepEqual(sent, []);
  });

  it("ignores a torn ledger line rather than reading it as a spent budget", () => {
    mkdirSync(join(root, "ledger"), { recursive: true });
    writeFileSync(ledgerFile, `{"runId":"${EMPTY_RUN}"\n\n`, "utf8");
    assert.equal(resumeAttempts(EMPTY_RUN, ledgerFile), 0);
    assert.equal(spendResumeBudget(EMPTY_RUN, ledgerFile, 0), true);
    assert.equal(spendResumeBudget(EMPTY_RUN, ledgerFile, 0), false);
    assert.match(readFileSync(ledgerFile, "utf8"), /"at":"1970-01-01T00:00:00\.000Z"/);
  });
});

describe("the announcement names what it already answered for", () => {
  it("marks a followed-up run and withdraws the re-dispatch instruction for it", () => {
    const report = reportFor(EMPTY_RUN, EMPTY_STATUS);
    const text = formatAnnouncement([report], new Set([EMPTY_RUN]))!;
    assert.match(text, /↻ automatic follow-up sent/);
    assert.match(text, /already been given one automatic follow-up resume/);
    assert.match(text, /Do not re-dispatch it/);
  });

  it("is byte-identical to before when nothing was followed up", () => {
    const report = reportFor(EMPTY_RUN, EMPTY_STATUS);
    const plain = formatAnnouncement([report])!;
    assert.equal(plain, formatAnnouncement([report], new Set())!);
    assert.ok(!plain.includes("↻"));
    assert.ok(!plain.includes("automatic follow-up"));
  });
});

describe("what this module copied from pi-subagents", () => {
  // Asserted against the package's SOURCE TEXT, not by importing it: `pi-subagents` ships `.ts`
  // under `node_modules` and bare `node --test` refuses to strip types there
  // (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Same constraint, same answer, as
  // `test/dispatch/watchdog-settings.test.ts`.
  const read = (relative: string): string => readFileSync(`node_modules/pi-subagents/src/${relative}`, "utf8");

  it("still names the events the RPC bridge actually listens on", () => {
    const rpc = read("extension/rpc.ts");
    assert.match(rpc, /SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request"/);
    assert.match(rpc, /SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:"/);
    assert.match(rpc, /SUBAGENT_RPC_PROTOCOL_VERSION = 1/);
    assert.match(
      rpc,
      /SUBAGENT_RPC_METHODS = \[[^\]]*"resume"/,
      "the RPC no longer offers `resume` — async-resume.ts has nothing to call",
    );
  });

  it("still refuses a resume that names no target and no message", () => {
    // Both are asserted because `followUpEmptyRuns` sends exactly `{ id, message }` and a request
    // the bridge rejects would be a silent no-op with the budget already spent.
    const rpc = read("extension/rpc.ts");
    assert.match(rpc, /RPC resume requires a non-empty message\./);
    assert.match(rpc, /RPC resume requires id, runId, or dir\./);
  });

  it("still writes the empty-completion sentence this module matches on", () => {
    assert.ok(
      read("runs/background/subagent-runner.ts").includes(EMPTY_COMPLETION_ERROR),
      "the runner reworded an empty completion — the detector in async-resume.ts is now blind",
    );
  });
});

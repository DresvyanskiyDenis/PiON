import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  register as registerJobs,
  watchIntervalMs,
  DEFAULT_WATCH_INTERVAL_MS,
  WATCH_INTERVAL_ENV,
  wakeOnIdle,
  WAKE_ENV,
  waitTimeoutMs,
  DEFAULT_WAIT_TIMEOUT_SEC,
  MIN_WAIT_TIMEOUT_SEC,
  MAX_WAIT_TIMEOUT_SEC,
  __resetForTests,
} from "../../extensions/jobs/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import {
  EXTERNAL_RUN_REGISTRY_KEY,
  PROVIDER_NAME,
  type ExternalRunRecord,
} from "../../extensions/jobs/registry.ts";
import { ensureJobsRoot, isProcessAlive, listJobs, readState, writeState, type JobState } from "../../extensions/jobs/store.ts";

type CommandDefinition = { description: string; handler: (args: string, ctx: never) => Promise<void> };
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

interface SentMessage {
  customType: string;
  text: string;
  deliverAs?: string;
  triggerTurn?: boolean;
}

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  sent: SentMessage[];
} {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const sent: SentMessage[] = [];
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool),
    registerCommand: (name: string, command: CommandDefinition) => void commands.set(name, command),
    sendMessage: (
      message: { customType: string; content: Array<{ text?: string }> },
      options?: { deliverAs?: string; triggerTurn?: boolean },
    ) => {
      sent.push({
        customType: message.customType,
        text: message.content.map((part) => part.text ?? "").join(""),
        deliverAs: options?.deliverAs,
        triggerTurn: options?.triggerTurn,
      });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands, sent };
}

function fakeCtx(
  sessionId: string,
  opts: { hasUI?: boolean; status?: Map<string, string | undefined>; sessionFile?: string } = {},
): ExtensionContext {
  return {
    hasUI: opts.hasUI ?? false,
    cwd: process.cwd(),
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) => void opts.status?.set(key, text),
    },
    // Two identifiers, deliberately different: `getSessionId` is what this extension scopes its
    // own announcements by, `getSessionFile` is what `pi-subagents` scopes the fleet panel by
    // (`resolveCurrentSessionId` prefers the file). Making them equal in the fixture would hide
    // exactly the mismatch that kept jobs off the panel.
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => opts.sessionFile ?? `/sessions/${sessionId}.jsonl`,
    },
  } as unknown as ExtensionContext;
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  details: unknown;
}

let sandbox: string;
let counter = 0;

/**
 * What the fleet panel below the editor would render for this session.
 *
 * `pi-subagents` reads exactly this map — `snapshotExternalRuns` filters it by session id and
 * `collectFleetStatusEntries` turns each active row into an `external · <label>` line
 * (`src/tui/fleet-status.ts:432-445`). Reading the registry rather than the panel is the closest
 * a test run can get to the surface the operator is looking at.
 */
function panelRows(): ExternalRunRecord[] {
  const slot = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] as
    | { runs: Map<string, ExternalRunRecord> }
    | undefined;
  return [...(slot?.runs.values() ?? [])].filter((run) => run.source === PROVIDER_NAME);
}

function clearPanel(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => Promise<boolean> | boolean, budgetMs = 8_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${budgetMs}ms`);
    await delay(50);
  }
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-jobs-tool-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("job tool (EXT-24)", () => {
  let prevXdg: string | undefined;
  let harness: ReturnType<typeof fakePi>;
  let tool: ToolDefinition;
  let root: string;

  const call = async (params: Record<string, unknown>, ctx: ExtensionContext) =>
    (await tool.execute("tc-1", params as never, undefined, undefined, ctx)) as unknown as ToolCallResult;

  beforeEach(async () => {
    prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(sandbox, `state-${counter++}`);
    root = await ensureJobsRoot();
    resetSurfaced();
    __resetForTests();
    clearPanel();
    harness = fakePi();
    registerJobs(harness.pi);
    tool = harness.tools.get("job")!;
  });

  after(() => {
    __resetForTests();
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  });

  it("registers one tool, one operator command and the three lifecycle handlers", () => {
    assert.deepEqual([...harness.tools.keys()], ["job"]);
    assert.deepEqual([...harness.commands.keys()], ["jobs"], "/jobs is the operator-facing browser");
    assert.deepEqual(
      [...harness.handlers.keys()].sort(),
      ["agent_settled", "agent_start", "session_shutdown", "session_start", "turn_end"],
    );
    assert.ok(tool.promptSnippet, "the tool is advertised in the system prompt");
  });

  it("names the shell parameter `command`, which is what the guard inspects", () => {
    // extensions/guard/targets.ts's commandStrings() scans `command` / `cmd` / `script` on
    // ANY tool call, not just bash's. Renaming this parameter would silently route every
    // background job around the catastrophic-pattern gate (EXT-03).
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok("command" in properties);
  });

  it("start → status → output → kill, all through the tool", async () => {
    const ctx = fakeCtx("sess-1");
    const started = await call({ action: "start", command: "sleep 30" }, ctx);
    const id = (started.details as { id: string }).id;
    assert.match(started.content[0]!.text!, /^started job /);

    const status = await call({ action: "status", id }, ctx);
    assert.match(status.content[0]!.text!, new RegExp(`^${id}: running`));

    const killed = await call({ action: "kill", id }, ctx);
    assert.match(killed.content[0]!.text!, /SIGTERM to process group/);
    assert.equal((killed.details as JobState).status, "killed");
  });

  it("output tails stdout and, on request, stderr too", async () => {
    const ctx = fakeCtx("sess-1");
    const started = await call(
      { action: "start", command: "echo hello-out; echo hello-err 1>&2" },
      ctx,
    );
    const id = (started.details as { id: string }).id;
    await until(async () => {
      const { jobs } = await listJobs(root);
      return jobs.find((job) => job.id === id)?.status === "done";
    });

    const out = await call({ action: "output", id }, ctx);
    assert.match(out.content[0]!.text!, /hello-out/);
    assert.doesNotMatch(out.content[0]!.text!, /hello-err/);

    const both = await call({ action: "output", id, stream: "both" }, ctx);
    assert.match(both.content[0]!.text!, /hello-out/);
    assert.match(both.content[0]!.text!, /hello-err/);
  });

  it("list shows jobs from other sessions, which is the whole point", async () => {
    const first = fakeCtx("sess-1");
    const second = fakeCtx("sess-2");
    const started = await call({ action: "start", command: "sleep 30", label: "from-one" }, first);
    const id = (started.details as { id: string }).id;

    const listed = await call({ action: "list" }, second);
    assert.match(listed.content[0]!.text!, new RegExp(`${id}\\s+running`));
    assert.match(listed.content[0]!.text!, /session=sess-1/);

    await call({ action: "kill", id }, second);
  });

  it("fails loud on a missing id, an unknown id and a missing command", async () => {
    const ctx = fakeCtx("sess-1");
    await assert.rejects(call({ action: "status" }, ctx), /needs an "id"/);
    await assert.rejects(call({ action: "status", id: "nope" }, ctx), /no such job "nope"/);
    await assert.rejects(call({ action: "start" }, ctx), /needs a "command"/);
  });

  it("prune reports what it removed", async () => {
    const ctx = fakeCtx("sess-1");
    const started = await call({ action: "start", command: "exit 0" }, ctx);
    const id = (started.details as { id: string }).id;
    await until(async () => {
      const { jobs } = await listJobs(root);
      return jobs.find((job) => job.id === id)?.status === "done";
    });
    const pruned = await call({ action: "prune", olderThanHours: 0 }, ctx);
    assert.match(pruned.content[0]!.text!, /pruned 1 finished job/);
    assert.deepEqual((await listJobs(root)).jobs, []);
  });

  it("nudges once for a job that finished during this session, and never for older ones", async () => {
    const status = new Map<string, string | undefined>();
    const ctx = fakeCtx("sess-1", { hasUI: true, status });
    // `turn_end` fires *inside* a run, so this whole test is the mid-run case. Without it the
    // exit watcher would also be live and the assertions below would race it.
    await harness.handlers.get("agent_start")!({}, ctx);

    // A job that finished before the session started is history, not news.
    const old = await call({ action: "start", command: "exit 0" }, ctx);
    const oldId = (old.details as { id: string }).id;
    await until(async () => {
      const { jobs } = await listJobs(root);
      return jobs.find((job) => job.id === oldId)?.status === "done";
    });

    await harness.handlers.get("session_start")!({}, ctx);
    await harness.handlers.get("turn_end")!({}, ctx);
    assert.equal(harness.sent.length, 0, "nothing to announce at session start");

    const fresh = await call({ action: "start", command: "exit 0" }, ctx);
    const freshId = (fresh.details as { id: string }).id;
    assert.equal(status.get("jobs"), "1 bg");
    await until(async () => {
      const { jobs } = await listJobs(root);
      return jobs.find((job) => job.id === freshId)?.status === "done";
    });

    await harness.handlers.get("turn_end")!({}, ctx);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0]!.customType, "job-done");
    assert.equal(harness.sent[0]!.deliverAs, "followUp");
    assert.equal(harness.sent[0]!.triggerTurn, true);
    assert.match(harness.sent[0]!.text, new RegExp(`${freshId} \\(done exit 0\\)`));
    assert.equal(status.get("jobs"), undefined, "the footer clears when nothing is running");

    await harness.handlers.get("turn_end")!({}, ctx);
    assert.equal(harness.sent.length, 1, "the nudge is once, not every turn");
  });

  it("renders the notice immediately once the run has settled", async () => {
    const ctx = fakeCtx("sess-1");
    await harness.handlers.get("agent_start")!({}, ctx);
    const started = await call({ action: "start", command: "exit 0" }, ctx);
    const id = (started.details as { id: string }).id;
    await until(async () => {
      const { jobs } = await listJobs(root);
      return jobs.find((job) => job.id === id)?.status === "done";
    });

    await harness.handlers.get("agent_settled")!({}, ctx);
    assert.equal(harness.sent.length, 1);
    // Both options always go out and PI picks the branch: `triggerTurn` is what makes an idle
    // session act, `followUp` is what stops a running one from being steered.
    assert.equal(harness.sent[0]!.triggerTurn, true);
    assert.equal(harness.sent[0]!.deliverAs, "followUp");
    assert.match(harness.sent[0]!.text, /job\(action="output"\)/);
    assert.match(harness.sent[0]!.text, /say so and stop/, "the wake states its own exit");
  });

  it("stays passive when the wake is switched off", async () => {
    const prev = process.env[WAKE_ENV];
    process.env[WAKE_ENV] = "0";
    try {
      const ctx = fakeCtx("sess-1");
      await harness.handlers.get("agent_start")!({}, ctx);
      const started = await call({ action: "start", command: "exit 0" }, ctx);
      const id = (started.details as { id: string }).id;
      await until(async () => {
        const { jobs } = await listJobs(root);
        return jobs.find((job) => job.id === id)?.status === "done";
      });

      await harness.handlers.get("turn_end")!({}, ctx);
      assert.equal(harness.sent.length, 1);
      assert.equal(harness.sent[0]!.triggerTurn, undefined);
      assert.equal(harness.sent[0]!.deliverAs, "nextTurn", "mid-run, the old parking behaviour");

      await harness.handlers.get("agent_settled")!({}, ctx);
      assert.equal(harness.sent.length, 1, "and still announced only once");
    } finally {
      if (prev === undefined) delete process.env[WAKE_ENV];
      else process.env[WAKE_ENV] = prev;
    }
  });

  it("reads the wake switch from the environment, and refuses a malformed one", () => {
    assert.equal(wakeOnIdle({}), true);
    for (const on of ["1", "true"]) assert.equal(wakeOnIdle({ [WAKE_ENV]: on }), true);
    for (const off of ["0", "false"]) assert.equal(wakeOnIdle({ [WAKE_ENV]: off }), false);
    for (const bad of ["off", "no", "TRUE", "2", ""]) {
      assert.throws(
        () => wakeOnIdle({ [WAKE_ENV]: bad }),
        new RegExp(WAKE_ENV),
        `${JSON.stringify(bad)} should be refused, not read as a default`,
      );
    }
  });

  it("reads the poll interval from the environment, and refuses a malformed one", () => {
    assert.equal(watchIntervalMs({}), DEFAULT_WATCH_INTERVAL_MS);
    assert.equal(watchIntervalMs({ [WATCH_INTERVAL_ENV]: "500" }), 500);
    for (const bad of ["0", "5", "-1", "2.5", "soon", ""]) {
      assert.throws(
        () => watchIntervalMs({ [WATCH_INTERVAL_ENV]: bad }),
        new RegExp(WATCH_INTERVAL_ENV),
        `${JSON.stringify(bad)} should be refused, not read as a default`,
      );
    }
  });

  it("wakes the agent for a job that died while the session sat idle", async () => {
    // The case the watcher exists for: a detached job is started and nobody comes back. No turn
    // ends, so the only notification path never fires and the footer keeps claiming `1 bg`.
    //
    // Scoped to this test rather than set in `beforeEach`: a 20ms poll would make the watcher
    // race the sibling tests that assert on *not* being nudged. Waiting for the real 2s default
    // would work on an idle machine and is exactly the margin a saturated one eats, so the
    // interval is shortened instead of the budget being widened.
    const prev = process.env[WATCH_INTERVAL_ENV];
    process.env[WATCH_INTERVAL_ENV] = "20";
    try {
      const status = new Map<string, string | undefined>();
      const ctx = fakeCtx("sess-1", { hasUI: true, status });
      await call({ action: "start", command: "exit 3" }, ctx);
      assert.equal(status.get("jobs"), "1 bg");

      await until(() => harness.sent.length === 1);
      assert.equal(harness.sent[0]!.customType, "job-done");
      assert.equal(harness.sent[0]!.triggerTurn, true, "nobody else was going to start a turn");
      assert.match(harness.sent[0]!.text, /failed exit 3/);
      assert.equal(status.get("jobs"), undefined, "and the footer stops claiming it is running");
    } finally {
      if (prev === undefined) delete process.env[WATCH_INTERVAL_ENV];
      else process.env[WATCH_INTERVAL_ENV] = prev;
    }
  });

  it("does not nudge about another session's job", async () => {
    const mine = fakeCtx("sess-1");
    const theirs = fakeCtx("sess-2");
    const started = await call({ action: "start", command: "exit 0" }, theirs);
    const id = (started.details as { id: string }).id;
    await until(async () => {
      const { jobs } = await listJobs(root);
      return jobs.find((job) => job.id === id)?.status === "done";
    });

    await harness.handlers.get("turn_end")!({}, mine);
    assert.equal(harness.sent.length, 0);
  });

  it("session_start publishes the providers and session_shutdown withdraws them", async () => {
    const ctx = fakeCtx("sess-1", { hasUI: true, status: new Map() });
    const started = await call({ action: "start", command: "sleep 30" }, ctx);
    const id = (started.details as { id: string }).id;

    await harness.handlers.get("session_start")!({}, ctx);
    const registry = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi-subagents.background-work.v1")
    ] as { providers: Map<string, { listActiveWork: () => Array<{ id: string }> }> };
    const provider = registry.providers.get("pi-config-jobs")!;
    assert.deepEqual(
      provider.listActiveWork().map((item) => item.id),
      [id],
      "a live job is background work pi-subagents can wait on",
    );

    await harness.handlers.get("session_shutdown")!({}, ctx);
    assert.equal(registry.providers.has("pi-config-jobs"), false);

    const killed = await call({ action: "kill", id }, ctx);
    await until(() => !isProcessAlive((killed.details as JobState).pid));
  });

  it("session_start auto-prunes terminal jobs older than the retention window", async () => {
    const prevPrune: string | undefined = process.env.PI_JOBS_PRUNE_HOURS;
    process.env.PI_JOBS_PRUNE_HOURS = "1";
    try {
      const ctx = fakeCtx("sess-1", { hasUI: true, status: new Map() });
      const started = await call({ action: "start", command: "exit 0" }, ctx);
      const id = (started.details as { id: string }).id;
      await until(async () => (await listJobs(root)).jobs.find((job) => job.id === id)?.status === "done");

      const state = (await readState(root, id))!;
      await writeState(root, { ...state, finishedAt: Date.now() - 2 * 3_600_000 });

      await harness.handlers.get("session_start")!({}, ctx);
      assert.deepEqual((await listJobs(root)).jobs, [], "the backdated job is pruned before the rest of session_start runs");
    } finally {
      if (prevPrune === undefined) delete process.env.PI_JOBS_PRUNE_HOURS;
      else process.env.PI_JOBS_PRUNE_HOURS = prevPrune;
    }
  });

  it("session_start does not prune a job inside the retention window", async () => {
    const ctx = fakeCtx("sess-1", { hasUI: true, status: new Map() });
    const started = await call({ action: "start", command: "exit 0" }, ctx);
    const id = (started.details as { id: string }).id;
    await until(async () => (await listJobs(root)).jobs.find((job) => job.id === id)?.status === "done");

    await harness.handlers.get("session_start")!({}, ctx);
    assert.deepEqual(
      (await listJobs(root)).jobs.map((job) => job.id),
      [id],
      "a job that finished moments ago is well inside the default 7-day window",
    );
  });

  /**
   * The tool told the model to poll — `promptGuidelines` said "then poll it with action=status"
   * and no blocking action existed — while this same extension already detected every finish on
   * its own interval and pushed an announcement. The measured cost of the instruction it gave: 44
   * `status` calls over 10.4 minutes for one job, each one a full model request re-sending the
   * whole transcript, where one blocking call would have done.
   */
  describe("action=wait, the blocking alternative to being told to poll", () => {
    interface WaitDetails {
      finished: JobState[];
      waitingOn: string[];
      waitedMs: number;
      timeoutMs: number;
      timedOut: boolean;
      aborted: boolean;
    }

    let prevInterval: string | undefined;

    beforeEach(() => {
      // A wait sleeps on the announcement watcher's interval, so the default 2s would make every
      // assertion below wait a whole beat past the finish it is checking for. The watcher itself
      // stays inert in these tests because each one opens with `agent_start`: a tool call happens
      // mid-run by definition, and mid-run the watcher defers to `turn_end`.
      prevInterval = process.env[WATCH_INTERVAL_ENV];
      process.env[WATCH_INTERVAL_ENV] = "20";
    });
    afterEach(() => {
      if (prevInterval === undefined) delete process.env[WATCH_INTERVAL_ENV];
      else process.env[WATCH_INTERVAL_ENV] = prevInterval;
    });

    it("is offered as an action, and the guidelines send the model to it instead of to a poll loop", () => {
      const action = (tool.parameters as { properties: { action: { enum?: string[] } } }).properties.action;
      assert.ok(action.enum?.includes("wait"), "there is no blocking action to recommend");
      const guidelines = (tool.promptGuidelines ?? []).join("\n");
      assert.match(guidelines, /action=wait/);
      assert.doesNotMatch(
        guidelines,
        /poll it with action=status/,
        "the tool still prescribes the polling the wait action exists to replace",
      );
    });

    it("blocks until the job finishes, in one call, and returns what the push would have said", async () => {
      const ctx = fakeCtx("sess-1");
      await harness.handlers.get("agent_start")!({}, ctx);
      const started = await call({ action: "start", command: "sleep 0.6" }, ctx);
      const id = (started.details as { id: string }).id;

      const waited = await call({ action: "wait" }, ctx);
      const details = waited.details as WaitDetails;

      // One tool call spanning the whole run, rather than one call per check of it.
      assert.ok(details.waitedMs >= 500, `the wait returned after ${details.waitedMs}ms, before the job could end`);
      assert.equal(details.timedOut, false);
      assert.deepEqual(
        details.finished.map((job) => [job.id, job.status, job.exitCode]),
        [[id, "done", 0]],
      );
      // The same roll-call `announce()` builds, because a caller who blocked should be told
      // exactly what a caller who did not would have been.
      assert.match(waited.content[0]!.text!, new RegExp(`${id} \\(done exit 0\\)`));
      assert.match(waited.content[0]!.text!, /job\(action="output"\)/);
      assert.equal(harness.sent.length, 0, "the finish was returned, so pushing it too is a wasted wake");
    });

    it("waits for a named job, including one owned by another session", async () => {
      const mine = fakeCtx("sess-1");
      const theirs = fakeCtx("sess-2");
      await harness.handlers.get("agent_start")!({}, mine);
      const started = await call({ action: "start", command: "sleep 0.4; exit 7" }, theirs);
      const id = (started.details as { id: string }).id;

      const waited = await call({ action: "wait", id }, mine);
      const details = waited.details as WaitDetails;
      assert.equal(details.timedOut, false);
      assert.deepEqual(details.finished.map((job) => [job.id, job.status, job.exitCode]), [[id, "failed", 7]]);
      assert.equal(harness.sent.length, 0, "another session's job is not this session's news");
    });

    it("reports every job of this session that finished while it waited, not only the named one", async () => {
      const ctx = fakeCtx("sess-1");
      await harness.handlers.get("agent_start")!({}, ctx);
      const quick = await call({ action: "start", command: "exit 0" }, ctx);
      const slow = await call({ action: "start", command: "sleep 0.6" }, ctx);
      const quickId = (quick.details as { id: string }).id;
      const slowId = (slow.details as { id: string }).id;

      const waited = await call({ action: "wait", id: slowId }, ctx);
      const finished = (waited.details as WaitDetails).finished.map((job) => job.id).sort();
      // The sweep inside the wait consumed both finishes, so a wait that reported only its target
      // would be the one path in this extension that can lose a completion outright.
      assert.deepEqual(finished, [quickId, slowId].sort());
      assert.equal(harness.sent.length, 0);
    });

    it("clamps to its timeout instead of blocking forever, and says the job is still running", async () => {
      const ctx = fakeCtx("sess-1");
      await harness.handlers.get("agent_start")!({}, ctx);
      const started = await call({ action: "start", command: "sleep 30" }, ctx);
      const id = (started.details as { id: string }).id;

      const waited = await call({ action: "wait", timeoutSeconds: 1 }, ctx);
      const details = waited.details as WaitDetails;
      assert.equal(details.timedOut, true);
      assert.equal(details.timeoutMs, 1_000);
      assert.ok(details.waitedMs >= 1_000, `gave up after ${details.waitedMs}ms, short of its own deadline`);
      assert.deepEqual(details.waitingOn, [id]);
      assert.deepEqual(details.finished, []);
      assert.match(waited.content[0]!.text!, /nothing finished within/);
      assert.match(waited.content[0]!.text!, /Wait again/, "a timed-out wait names its own next step");

      const killed = await call({ action: "kill", id }, ctx);
      await until(() => !isProcessAlive((killed.details as JobState).pid));
    });

    it("returns at once when there is nothing of this session's to wait for", async () => {
      const mine = fakeCtx("sess-1");
      const theirs = fakeCtx("sess-2");
      await harness.handlers.get("agent_start")!({}, mine);
      const started = await call({ action: "start", command: "sleep 30" }, theirs);

      // Another session's running job can never be announced here, so blocking on the deadline
      // would buy a five-minute stall and no possible answer.
      const waited = await call({ action: "wait", timeoutSeconds: 30 }, mine);
      const details = waited.details as WaitDetails;
      assert.equal(details.timedOut, false);
      assert.ok(details.waitedMs < 1_000, `waited ${details.waitedMs}ms for a job it could not report`);
      assert.match(waited.content[0]!.text!, /nothing to wait for/);

      const killed = await call({ action: "kill", id: (started.details as { id: string }).id }, mine);
      await until(() => !isProcessAlive((killed.details as JobState).pid));
    });

    it("fails loud on an unknown id rather than blocking on a job that does not exist", async () => {
      const ctx = fakeCtx("sess-1");
      await assert.rejects(call({ action: "wait", id: "nope" }, ctx), /no such job "nope"/);
    });

    it("bounds the timeout: default, floor, ceiling, and a refusal for a non-number", () => {
      assert.equal(waitTimeoutMs(undefined), DEFAULT_WAIT_TIMEOUT_SEC * 1_000);
      assert.equal(waitTimeoutMs(30), 30_000);
      assert.equal(waitTimeoutMs(0), MIN_WAIT_TIMEOUT_SEC * 1_000, "a zero-second wait is a status call");
      assert.equal(waitTimeoutMs(-5), MIN_WAIT_TIMEOUT_SEC * 1_000);
      assert.equal(waitTimeoutMs(99_999), MAX_WAIT_TIMEOUT_SEC * 1_000, "a wait may not hold a call open forever");
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => waitTimeoutMs(bad), /timeoutSeconds/);
      }
    });
  });

  /**
   * The defect this locks down: "started job … (pid 52469, depth 0)" printed, and nothing on the
   * panel below the prompt while the job ran. The footer's `N bg` count was already updated at
   * start — that half was never broken — but the row that *depicts the job* comes from
   * `pi-subagents`' external-run registry, and this extension was still publishing into the `v1`
   * key nothing reads.
   */
  describe("the fleet panel below the prompt", () => {
    it("shows a job from the moment it starts, without waiting for turn_end", async () => {
      const ctx = fakeCtx("sess-1", { hasUI: true, status: new Map() });
      const started = await call({ action: "start", command: "sleep 30", label: "ingest" }, ctx);
      const id = (started.details as { id: string }).id;

      // No turn_end, no agent_settled, no watcher tick: the tool has only just returned.
      assert.deepEqual(
        panelRows().map((run) => [run.id, run.state, run.label]),
        [[id, "running", "ingest"]],
        "the job the operator was just told about is missing from the panel",
      );

      const killed = await call({ action: "kill", id }, ctx);
      await until(() => !isProcessAlive((killed.details as JobState).pid));
    });

    it("files the row under the session identity pi-subagents queries by", async () => {
      const ctx = fakeCtx("sess-1", { hasUI: true, sessionFile: "/sessions/live.jsonl" });
      const started = await call({ action: "start", command: "sleep 30" }, ctx);
      const id = (started.details as { id: string }).id;

      // `resolveCurrentSessionId` prefers `getSessionFile()`, so a row filed under the session
      // *id* is a row the panel never asks for — invisible for a different reason, same symptom.
      assert.deepEqual(panelRows().map((run) => run.sessionId), ["/sessions/live.jsonl"]);

      const killed = await call({ action: "kill", id }, ctx);
      await until(() => !isProcessAlive((killed.details as JobState).pid));
    });

    it("takes the row down once the job is over", async () => {
      const ctx = fakeCtx("sess-1", { hasUI: true, status: new Map() });
      const started = await call({ action: "start", command: "exit 0" }, ctx);
      const id = (started.details as { id: string }).id;
      assert.equal(panelRows().length, 1);

      await until(async () => {
        const { jobs } = await listJobs(root);
        return jobs.find((job) => job.id === id)?.status === "done";
      });
      await harness.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(panelRows(), [], "a finished job is history, not a live panel row");
    });

    it("advertises only this session's jobs, because only those can be rendered", async () => {
      const mine = fakeCtx("sess-1", { hasUI: true });
      const theirs = fakeCtx("sess-2", { hasUI: true });
      const a = await call({ action: "start", command: "sleep 30" }, mine);
      const b = await call({ action: "start", command: "sleep 30" }, theirs);

      // `theirs` published last, so the registry now holds sess-2's row and not sess-1's — which
      // is correct: `snapshotExternalRuns` filters by session, so a row for another session could
      // never appear on this panel and would only spend the shared 100-record budget.
      assert.deepEqual(panelRows().map((run) => run.id), [(b.details as { id: string }).id]);

      for (const details of [a.details, b.details]) {
        const killed = await call({ action: "kill", id: (details as { id: string }).id }, mine);
        await until(() => !isProcessAlive((killed.details as JobState).pid));
      }
    });

    it("withdraws its rows at session shutdown, and leaves other producers alone", async () => {
      const ctx = fakeCtx("sess-1", { hasUI: true, status: new Map() });
      const started = await call({ action: "start", command: "sleep 30" }, ctx);
      const id = (started.details as { id: string }).id;
      const slot = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] as {
        runs: Map<string, ExternalRunRecord>;
      };
      slot.runs.set("other\u0000row", {
        id: "row",
        sessionId: "other",
        source: "some-other-extension",
        label: "not ours",
        state: "running",
        startedAt: 1,
      });

      await harness.handlers.get("session_shutdown")!({}, ctx);
      assert.deepEqual(panelRows(), [], "our rows outlived the session that owns them");
      assert.equal(slot.runs.size, 1, "someone else's row was withdrawn too");

      const killed = await call({ action: "kill", id }, ctx);
      await until(() => !isProcessAlive((killed.details as JobState).pid));
    });
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { register as registerJobs, __resetForTests } from "../../extensions/jobs/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { ensureJobsRoot, isProcessAlive, listJobs, readState, writeState, type JobState } from "../../extensions/jobs/store.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

interface SentMessage {
  customType: string;
  text: string;
  deliverAs?: string;
}

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  tools: Map<string, ToolDefinition>;
  sent: SentMessage[];
} {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const sent: SentMessage[] = [];
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool),
    sendMessage: (
      message: { customType: string; content: Array<{ text?: string }> },
      options?: { deliverAs?: string },
    ) => {
      sent.push({
        customType: message.customType,
        text: message.content.map((part) => part.text ?? "").join(""),
        deliverAs: options?.deliverAs,
      });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, sent };
}

function fakeCtx(
  sessionId: string,
  opts: { hasUI?: boolean; status?: Map<string, string | undefined> } = {},
): ExtensionContext {
  return {
    hasUI: opts.hasUI ?? false,
    cwd: process.cwd(),
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) => void opts.status?.set(key, text),
    },
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  details: unknown;
}

let sandbox: string;
let counter = 0;

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
    harness = fakePi();
    registerJobs(harness.pi);
    tool = harness.tools.get("job")!;
  });

  after(() => {
    __resetForTests();
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  });

  it("registers one tool and the three lifecycle handlers", () => {
    assert.deepEqual([...harness.tools.keys()], ["job"]);
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
    assert.equal(harness.sent[0]!.deliverAs, "nextTurn");
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
    assert.equal(
      harness.sent[0]!.deliverAs,
      undefined,
      "no deliverAs takes sendCustomMessage's final branch, which renders now",
    );
  });

  it("announces a job that died while the session sat idle, with no turn at all", async () => {
    // The case the watcher exists for: a detached job is started and nobody comes back. No turn
    // ends, so the only notification path never fires and the footer keeps claiming `1 bg`.
    const status = new Map<string, string | undefined>();
    const ctx = fakeCtx("sess-1", { hasUI: true, status });
    await call({ action: "start", command: "exit 3" }, ctx);
    assert.equal(status.get("jobs"), "1 bg");

    await until(() => harness.sent.length === 1, 15_000);
    assert.equal(harness.sent[0]!.customType, "job-done");
    assert.equal(harness.sent[0]!.deliverAs, undefined);
    assert.match(harness.sent[0]!.text, /failed exit 3/);
    assert.equal(status.get("jobs"), undefined, "and the footer stops claiming it is running");
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
});

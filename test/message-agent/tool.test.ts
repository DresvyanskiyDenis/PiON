import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  NAME_ENV,
  POLL_INTERVAL_ENV,
  WAKE_ENV,
  DEFAULT_POLL_INTERVAL_MS,
  pollIntervalMs,
  preferredName,
  register as registerMessageAgent,
  wakeOnIdle,
  __resetForTests,
} from "../../extensions/message-agent/index.ts";
import { agentsRoot, listAgents } from "../../extensions/message-agent/directory.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
type CommandDefinition = { description: string; handler: (args: string, ctx: never) => Promise<void> };

interface SentMessage {
  customType: string;
  text: string;
  deliverAs?: string;
  triggerTurn?: boolean;
}

interface Session {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handlers: Map<string, Handler>;
  tool: ToolDefinition;
  commands: Map<string, CommandDefinition>;
  sent: SentMessage[];
  notices: string[];
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
}

function fakeSession(sessionId: string): Session {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const sent: SentMessage[] = [];
  const notices: string[] = [];
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

  const ctx = {
    hasUI: true,
    cwd: `/work/${sessionId}`,
    ui: { notify: (line: string) => void notices.push(line), setStatus: () => {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
    },
  } as unknown as ExtensionContext;

  registerMessageAgent(pi);
  const tool = tools.get("message_agent");
  assert.ok(tool, "message_agent must be registered");
  return { pi, ctx, handlers, tool, commands, sent, notices };
}

async function start(session: Session, name: string): Promise<void> {
  process.env[NAME_ENV] = name;
  try {
    await session.handlers.get("session_start")?.({}, session.ctx);
  } finally {
    delete process.env[NAME_ENV];
  }
}

function call(session: Session, params: Record<string, unknown>): Promise<ToolCallResult> {
  return (
    session.tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<ToolCallResult>
  )("call-1", params, undefined, undefined, session.ctx);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean, budgetMs = 8_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${budgetMs}ms`);
    await delay(20);
  }
}

let sandbox: string;
let previousState: string | undefined;
let counter = 0;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-message-agent-tool-"));
  previousState = process.env.XDG_STATE_HOME;
});
after(async () => {
  __resetForTests();
  if (previousState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousState;
  await rm(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  __resetForTests();
  resetSurfaced();
  delete process.env[POLL_INTERVAL_ENV];
  delete process.env[WAKE_ENV];
  process.env.XDG_STATE_HOME = join(sandbox, `run-${counter++}`);
});

describe("message_agent knobs (EXT-32)", () => {
  it("names a session after PI_AGENT_NAME, or after its session id", () => {
    assert.equal(preferredName("s1", { [NAME_ENV]: "Reviewer" }), "reviewer");
    assert.equal(preferredName("019a-7c31-4d", {}), "agent-019a7c314d");
  });

  it("reads the poll interval, and refuses a malformed one", () => {
    assert.equal(pollIntervalMs({}), DEFAULT_POLL_INTERVAL_MS);
    assert.equal(pollIntervalMs({ [POLL_INTERVAL_ENV]: "50" }), 50);
    assert.throws(() => pollIntervalMs({ [POLL_INTERVAL_ENV]: "fast" }), /not an integer/);
    assert.throws(() => pollIntervalMs({ [POLL_INTERVAL_ENV]: "1" }), />= 10/);
  });

  it("reads the wake switch, and refuses a typo rather than defaulting", () => {
    assert.equal(wakeOnIdle({}), true);
    assert.equal(wakeOnIdle({ [WAKE_ENV]: "0" }), false);
    assert.throws(() => wakeOnIdle({ [WAKE_ENV]: "off" }), /not one of/);
  });
});

describe("message_agent tool (EXT-32)", () => {
  it("registers this session in the directory at session_start", async () => {
    const a = fakeSession("s-a");
    await start(a, "session-a");
    const { agents } = await listAgents(agentsRoot());
    assert.deepEqual(
      agents.map((x) => x.name),
      ["session-a"],
    );
    const who = await call(a, { action: "whoami" });
    assert.equal(who.details.name, "session-a");
  });

  it("lists every reachable session, from either side", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    const listed = await call(b, { action: "list" });
    assert.deepEqual(listed.details.agents, ["session-a", "session-b"]);
    assert.match(listed.content[0]?.text ?? "", /session-a/);
    assert.match(listed.content[0]?.text ?? "", /session-b \(this session\)/);
  });

  it("delivers A -> B and confirms it to A, without waiting for a reply", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    const receipt = await call(a, { target: "session-b", message: "Hello" });
    assert.equal(receipt.details.target, "session-b");
    assert.equal(receipt.details.from, "session-a");
    assert.match(receipt.content[0]?.text ?? "", /delivered to "session-b"/);
    // Fire-and-forget: nothing was pushed into the sender's own turn loop.
    assert.deepEqual(a.sent, []);
  });

  it("wakes B with the message on its next lifecycle event", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "Hello" });
    await b.handlers.get("turn_end")?.({}, b.ctx);

    assert.equal(b.sent.length, 1);
    const [note] = b.sent;
    assert.equal(note?.customType, "agent-message");
    assert.equal(note?.deliverAs, "followUp");
    assert.equal(note?.triggerTurn, true, "an idle session must be woken, not merely notified");
    assert.match(note?.text ?? "", /message from "session-a"/);
    assert.match(note?.text ?? "", /Hello/);
    assert.match(note?.text ?? "", /message_agent\(target="session-a"/);
  });

  it("wakes an idle B from the poll alone, with no turn of its own", async () => {
    process.env[POLL_INTERVAL_ENV] = "20";
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "wake up" });
    await until(() => b.sent.length > 0);
    assert.match(b.sent[0]?.text ?? "", /wake up/);
  });

  it("delivers each message exactly once", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "only once" });
    await b.handlers.get("turn_end")?.({}, b.ctx);
    await b.handlers.get("turn_end")?.({}, b.ctx);
    assert.equal(b.sent.length, 1);
  });

  it("coalesces several pending messages into one wake", async () => {
    const a = fakeSession("s-a");
    const c = fakeSession("s-c");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(c, "session-c");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "from a" });
    await call(c, { target: "session-b", message: "from c" });
    await b.handlers.get("turn_end")?.({}, b.ctx);

    assert.equal(b.sent.length, 1);
    assert.match(b.sent[0]?.text ?? "", /from a/);
    assert.match(b.sent[0]?.text ?? "", /from c/);
  });

  it("lets B reply with the same tool pointed back at A", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "ping" });
    await b.handlers.get("turn_end")?.({}, b.ctx);
    await call(b, { target: "session-a", message: "pong" });
    await a.handlers.get("turn_end")?.({}, a.ctx);

    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0]?.text ?? "", /message from "session-b"/);
    assert.match(a.sent[0]?.text ?? "", /pong/);
  });

  it("renders the message without waking, when the wake switch is off", async () => {
    process.env[WAKE_ENV] = "0";
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "quiet" });
    await b.handlers.get("turn_end")?.({}, b.ctx);
    assert.equal(b.sent.length, 1);
    assert.equal(b.sent[0]?.triggerTurn, undefined);
  });

  it("refuses an unknown target instead of queueing into the void", async () => {
    const a = fakeSession("s-a");
    await start(a, "session-a");
    await assert.rejects(
      () => call(a, { target: "nobody", message: "hi" }),
      /no live session named "nobody"/,
    );
  });

  it("refuses a message to itself, and a send with a field missing", async () => {
    const a = fakeSession("s-a");
    await start(a, "session-a");
    await assert.rejects(() => call(a, { target: "session-a", message: "hi" }), /is this session/);
    await assert.rejects(() => call(a, { message: "hi" }), /needs a "target"/);
    await assert.rejects(() => call(a, { target: "session-a" }), /needs a "message"/);
  });

  it("announces a contested name rather than silently answering to another one", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "reviewer");
    await start(b, "reviewer");

    assert.equal((await call(b, { action: "whoami" })).details.name, "reviewer-2");
    assert.ok(
      b.notices.some((line) => /held by another live session/.test(line)),
      `expected a collision notice, got ${JSON.stringify(b.notices)}`,
    );
  });

  it("drops its registration at session_shutdown, leaving nothing to route to", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await b.handlers.get("session_shutdown")?.({}, b.ctx);
    assert.deepEqual(
      (await listAgents(agentsRoot())).agents.map((x) => x.name),
      ["session-a"],
    );
    await assert.rejects(() => call(a, { target: "session-b", message: "hi" }), /no live session/);
  });

  it("exposes the directory as /peers", async () => {
    const a = fakeSession("s-a");
    await start(a, "session-a");
    const notices: string[] = [];
    await a.commands.get("peers")?.handler("", {
      ui: { notify: (line: string) => void notices.push(line) },
    } as never);
    assert.match(notices[0] ?? "", /session-a/);
  });
});

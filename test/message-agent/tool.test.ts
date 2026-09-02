import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
import {
  agentsRoot,
  deliver,
  deliveringDir,
  drainInbox,
  listAgents,
} from "../../extensions/message-agent/directory.ts";
import {
  __resetControlHandlersForTests,
  registerControlHandler,
} from "../../extensions/message-agent/control.ts";
import { openIndexDb, resetIndexDbCache } from "../../extensions/session-index/db.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
type CommandDefinition = { description: string; handler: (args: string, ctx: never) => Promise<void> };

interface SentMessage {
  customType: string;
  text: string;
  details?: unknown;
  deliverAs?: string;
  triggerTurn?: boolean;
}

/** Only the fields `settle()` reads; enough to stand in for a `CustomMessageEntry`. */
interface FakeEntry {
  type: string;
  customType?: string;
  details?: unknown;
}

interface Session {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handlers: Map<string, Handler>;
  tool: ToolDefinition;
  commands: Map<string, CommandDefinition>;
  sent: SentMessage[];
  /** This session's transcript. `sendMessage` does *not* write here — the turn loop does. */
  entries: FakeEntry[];
  notices: string[];
  /** Sets what `ctx.sessionManager.getSessionName()` returns, i.e. this session's `--name`. */
  setDisplayName: (name: string | undefined) => void;
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
  const entries: FakeEntry[] = [];
  const notices: string[] = [];
  let displayName: string | undefined;
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool),
    registerCommand: (name: string, command: CommandDefinition) => void commands.set(name, command),
    // Deliberately does not touch `entries`: the real `sendCustomMessage` queues the payload and the
    // turn loop persists it as a `custom_message` entry only when it is actually consumed, which is
    // the whole gap this fixture exists to model. `consume()` is that later moment.
    sendMessage: (
      message: { customType: string; content: Array<{ text?: string }>; details?: unknown },
      options?: { deliverAs?: string; triggerTurn?: boolean },
    ) => {
      sent.push({
        customType: message.customType,
        text: message.content.map((part) => part.text ?? "").join(""),
        details: message.details,
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
      getEntries: () => entries,
      getSessionName: () => displayName,
    },
  } as unknown as ExtensionContext;

  registerMessageAgent(pi);
  const tool = tools.get("message_agent");
  assert.ok(tool, "message_agent must be registered");
  return {
    pi,
    ctx,
    handlers,
    tool,
    commands,
    sent,
    entries,
    notices,
    setDisplayName: (name: string | undefined) => void (displayName = name),
  };
}

/** The turn loop finally reads what was queued: every pending payload lands in the transcript. */
function consume(session: Session): void {
  for (const message of session.sent.slice(session.entries.length)) {
    session.entries.push({
      type: "custom_message",
      customType: message.customType,
      details: message.details,
    });
  }
}

/** The names of every `ok=true` audit row this session wrote, oldest first. */
function okEvents(sessionId: string): string[] {
  resetIndexDbCache();
  return openIndexDb()
    .prepare("SELECT name FROM events WHERE session_id = ? AND ok = 1 ORDER BY id")
    .all(sessionId)
    .map((row) => String(row.name));
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
let previousIndexDb: string | undefined;
let counter = 0;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-message-agent-tool-"));
  previousState = process.env.XDG_STATE_HOME;
  previousIndexDb = process.env.PI_INDEX_DB;
});
after(async () => {
  __resetForTests();
  resetIndexDbCache();
  if (previousState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousState;
  if (previousIndexDb === undefined) delete process.env.PI_INDEX_DB;
  else process.env.PI_INDEX_DB = previousIndexDb;
  await rm(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  __resetForTests();
  __resetControlHandlersForTests();
  resetSurfaced();
  delete process.env[POLL_INTERVAL_ENV];
  delete process.env[WAKE_ENV];
  const run = join(sandbox, `run-${counter++}`);
  process.env.XDG_STATE_HOME = run;
  // The audit log is the assertion target for the delivery boundary, and `logEvent` swallows every
  // error — so it is pointed at the sandbox both to be readable and to keep the real index clean.
  process.env.PI_INDEX_DB = join(run, "index.db");
  resetIndexDbCache();
});

describe("message_agent knobs (EXT-32)", () => {
  it("names a session after PI_AGENT_NAME, then its --name display name, then its session id", () => {
    // PI_AGENT_NAME wins even when a display name is also present.
    assert.equal(preferredName("s1", { [NAME_ENV]: "Reviewer" }, "Scribe"), "reviewer");
    // No PI_AGENT_NAME: the --name display name is used.
    assert.equal(preferredName("s1", {}, "Scribe"), "scribe");
    // Neither set: falls back to the session id.
    assert.equal(preferredName("019a-7c31-4d", {}), "agent-019a7c314d");
    // A blank display name is treated as absent, same as a blank PI_AGENT_NAME.
    assert.equal(preferredName("019a-7c31-4d", {}, "   "), "agent-019a7c314d");
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

  it("registers under the --name display name when PI_AGENT_NAME is unset", async () => {
    const a = fakeSession("s-name-fallback");
    a.setDisplayName("Reviewer");
    await a.handlers.get("session_start")?.({}, a.ctx);
    const who = await call(a, { action: "whoami" });
    assert.equal(who.details.name, "reviewer");
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

  it("keeps the envelope staged, and the audit silent, until the payload reaches the transcript", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "still in flight" });
    await b.handlers.get("turn_end")?.({}, b.ctx);

    // Handed to the turn loop, not yet read by it: the only copy is on disk, and the audit log
    // says "received" — never "delivered", which has not happened.
    assert.equal(b.sent.length, 1);
    assert.deepEqual(await readdir(deliveringDir(agentsRoot(), "session-b")), [
      `${String((b.sent[0]?.details as { ids?: string[] })?.ids?.[0])}.json`,
    ]);
    assert.deepEqual(okEvents("s-b"), ["message_agent.receive:session-b"]);

    // The turn loop consumes it. Only now is delivery observable, and only now is it logged.
    consume(b);
    await b.handlers.get("turn_end")?.({}, b.ctx);
    assert.deepEqual(await readdir(deliveringDir(agentsRoot(), "session-b")), []);
    assert.deepEqual(okEvents("s-b"), ["message_agent.receive:session-b", "message_agent.delivered:session-b"]);
  });

  it("redelivers a message that was still in flight when the session stopped", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", message: "survive the crash" });
    await b.handlers.get("turn_end")?.({}, b.ctx);
    assert.equal(b.sent.length, 1, "staged and handed over, but never consumed");

    // The process dies here — no session_shutdown, no confirmation, the staged file is all there is.
    __resetForTests();
    const restarted = fakeSession("s-b");
    await start(restarted, "session-b");

    assert.equal(restarted.sent.length, 1);
    assert.match(restarted.sent[0]?.text ?? "", /survive the crash/);
    assert.ok(
      restarted.notices.some((line) => /still being delivered when "session-b" last stopped/.test(line)),
      `expected a recovery notice, got ${JSON.stringify(restarted.notices)}`,
    );

    // Exactly once, not twice: confirming the redelivery clears the staged copy for good.
    consume(restarted);
    await restarted.handlers.get("turn_end")?.({}, restarted.ctx);
    assert.equal(restarted.sent.length, 1);
    assert.deepEqual(await readdir(deliveringDir(agentsRoot(), "session-b")), []);
  });

  it("recovers an envelope stranded mid-turn, without waiting for a restart", async () => {
    const b = fakeSession("s-b");
    await start(b, "session-b");

    // Something staged this envelope without going through `b`'s own `drain()` — the same on-disk
    // state a `/clear` or a branch reset leaves behind mid-session, no process restart involved, so
    // there is no `session_start` coming to run the usual recovery sweep. `b`'s `inFlight` map has
    // never heard of it.
    const root = agentsRoot();
    await deliver({ root, target: "session-b", from: "session-a", fromSessionId: "s-a", message: "orphaned" });
    await drainInbox(root, "session-b");
    assert.equal(b.sent.length, 0, "staged on disk, but not yet handed to this session's turn loop");

    // A normal settle cycle — the same `turn_end` beat every message already goes through — finds it
    // stranded, puts it back in the inbox, and `tick()`'s own drain right after picks it straight
    // back up: one cycle both recovers it and hands it to the turn loop.
    await b.handlers.get("turn_end")?.({}, b.ctx);
    assert.equal(b.sent.length, 1);
    assert.match(b.sent[0]?.text ?? "", /orphaned/);
    assert.ok(
      b.notices.some((line) => /stranded in \.delivering\//.test(line)),
      `expected a stranded-envelope notice, got ${JSON.stringify(b.notices)}`,
    );
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

describe("message_agent control lane (EXT-32)", () => {
  // A control envelope is routed to its handler by `drain()`'s own split, never appended to the
  // recipient's turn loop — the opposite of an ordinary message, which is exactly the property
  // `peer.test.ts` cannot exercise on its own since it calls `createPeerCompactHandler` directly
  // rather than going through `register()`/`drain()`.
  it("routes a registered control kind to its handler instead of the chat turn", async () => {
    const seen: unknown[] = [];
    registerControlHandler("ping", (envelope) => {
      seen.push(envelope);
      return { outcome: "ok" };
    });
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", kind: "ping", instructions: "are you there?" });
    await b.handlers.get("turn_end")?.({}, b.ctx);

    assert.equal(seen.length, 1);
    assert.equal((seen[0] as { instructions?: string }).instructions, "are you there?");
    assert.equal((seen[0] as { from?: string }).from, "session-a");
    assert.deepEqual(b.sent, [], "a control envelope must never reach the recipient's chat turn");
    assert.deepEqual(okEvents("s-b"), ["message_agent.control.ok:session-b"]);
  });

  it("clears an unhandled control kind rather than leaving it stuck or waking the turn", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", kind: "unknown-kind", instructions: "noop" });
    await b.handlers.get("turn_end")?.({}, b.ctx);

    assert.deepEqual(b.sent, []);
    assert.deepEqual(await readdir(deliveringDir(agentsRoot(), "session-b")), []);
    assert.deepEqual(okEvents("s-b"), []);
    assert.ok(
      b.notices.some((line) => /no handler registered for control kind "unknown-kind"/.test(line)),
      `expected an unhandled-kind notice, got ${JSON.stringify(b.notices)}`,
    );
  });

  it("recovers a deferred control envelope back into the inbox instead of dropping it", async () => {
    registerControlHandler("compact", () => ({ outcome: "deferred", detail: "mid-turn" }));
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    await call(a, { target: "session-b", kind: "compact" });
    await b.handlers.get("turn_end")?.({}, b.ctx);

    assert.deepEqual(b.sent, []);
    const { messages } = await drainInbox(agentsRoot(), "session-b");
    assert.equal(messages.length, 1, "a deferred envelope must land back in the inbox, not vanish");
    assert.equal(messages[0]?.kind, "compact");
  });

  it("sends a control envelope through the tool with no \"message\" field required", async () => {
    const a = fakeSession("s-a");
    const b = fakeSession("s-b");
    await start(a, "session-a");
    await start(b, "session-b");

    const receipt = await call(a, { target: "session-b", kind: "compact", instructions: "please compact" });
    assert.match(receipt.content[0]?.text ?? "", /control envelope/);
    assert.equal(receipt.details.kind, "compact");
  });

  it("still requires \"message\" when kind is the default \"message\"", async () => {
    const a = fakeSession("s-a");
    await start(a, "session-a");
    await assert.rejects(() => call(a, { target: "session-a" }), /needs a "message"/);
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { register as registerSessionIndex, logEvent } from "../../extensions/session-index/index.ts";
import { openIndexDb, resetIndexDbCache } from "../../extensions/session-index/db.ts";

/** Captures every `pi.on` / `pi.registerCommand` call the extension makes. */
function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Function>; commands: Map<string, { handler: Function }> } {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const pi = {
    on: (event: string, handler: Function) => void handlers.set(event, handler),
    registerCommand: (name: string, opts: { handler: Function }) => void commands.set(name, opts),
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands };
}

function fakeCtx(over: Partial<ExtensionContext> & { sessionId: string; sessionFile?: string }): ExtensionContext {
  const entries: SessionEntry[] = (over as { entries?: SessionEntry[] }).entries ?? [];
  return {
    cwd: "/repo",
    model: { provider: "anthropic", id: "claude-x" },
    ui: { notify: () => {} },
    sessionManager: {
      getSessionId: () => over.sessionId,
      getSessionFile: () => over.sessionFile,
      getEntries: () => entries,
      getHeader: () => null,
      getSessionName: () => undefined,
    },
    ...over,
  } as unknown as ExtensionContext;
}

let sandbox: string;
let prevIndexDb: string | undefined;
let prevParentSession: string | undefined;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "session-index-ext-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  prevIndexDb = process.env.PI_INDEX_DB;
  prevParentSession = process.env.PI_PARENT_SESSION;
  resetIndexDbCache();
});
afterEach(() => {
  if (prevIndexDb === undefined) delete process.env.PI_INDEX_DB;
  else process.env.PI_INDEX_DB = prevIndexDb;
  if (prevParentSession === undefined) delete process.env.PI_PARENT_SESSION;
  else process.env.PI_PARENT_SESSION = prevParentSession;
  resetIndexDbCache();
});

function assistantEntry(id: string, ts: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-x",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
      stopReason: "stop",
      timestamp: Date.parse(ts),
    },
  } as SessionEntry;
}

describe("session-index extension registration", () => {
  it("registers session_start, session_shutdown and the /index command", () => {
    const { pi, handlers, commands } = fakePi();
    registerSessionIndex(pi);
    assert.ok(handlers.has("session_start"));
    assert.ok(handlers.has("session_shutdown"));
    assert.ok(commands.has("index"));
  });

  it("session_shutdown writes a row with cumulative stats", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "shutdown-")), "index.db");
    process.env.PI_INDEX_DB = dbPath;

    const { pi, handlers } = fakePi();
    registerSessionIndex(pi);
    const shutdown = handlers.get("session_shutdown")!;

    const ctx = fakeCtx({
      sessionId: "s1",
      sessionFile: "/sessions/s1.jsonl",
      entries: [assistantEntry("e1", "2026-08-01T10:00:00.000Z")],
    } as never);
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    const db = openIndexDb(dbPath);
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1")!;
    assert.equal(row.file, "/sessions/s1.jsonl");
    assert.equal(row.turns, 1);
    assert.equal(row.tokens_input, 10);
    assert.equal(row.cost_known, 1);
  });

  it("an in-memory (non-persisted) session — getSessionFile() undefined — is skipped, not errored", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "inmem-")), "index.db");
    process.env.PI_INDEX_DB = dbPath;

    const { pi, handlers } = fakePi();
    registerSessionIndex(pi);
    const shutdown = handlers.get("session_shutdown")!;
    const ctx = fakeCtx({ sessionId: "s-mem", sessionFile: undefined } as never);
    await assert.doesNotReject(shutdown({ type: "session_shutdown", reason: "quit" }, ctx));

    const db = openIndexDb(dbPath);
    assert.equal(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get("s-mem"), undefined);
  });

  it("an indexing failure is caught and never propagates out of the handler", async () => {
    process.env.PI_INDEX_DB = join(sandbox, "does", "not", "exist", "index.db");
    const { pi, handlers } = fakePi();
    registerSessionIndex(pi);
    const shutdown = handlers.get("session_shutdown")!;
    // sessionManager throws instead of returning — simulates an internal PI error.
    const brokenCtx = {
      cwd: "/repo",
      model: undefined,
      sessionManager: {
        getSessionId: () => "s-broken",
        getSessionFile: () => "/sessions/s-broken.jsonl",
        getEntries: () => {
          throw new Error("boom");
        },
        getHeader: () => null,
        getSessionName: () => undefined,
      },
    } as unknown as ExtensionContext;
    await assert.doesNotReject(shutdown({ type: "session_shutdown", reason: "quit" }, brokenCtx));
  });

  it("PI_PARENT_SESSION wins over the session's own header.parentSession", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "parent-")), "index.db");
    process.env.PI_INDEX_DB = dbPath;
    process.env.PI_PARENT_SESSION = "parent-from-env";

    const { pi, handlers } = fakePi();
    registerSessionIndex(pi);
    const shutdown = handlers.get("session_shutdown")!;
    const ctx = fakeCtx({
      sessionId: "s-child",
      sessionFile: "/sessions/s-child.jsonl",
      entries: [],
    } as never);
    (ctx.sessionManager as unknown as { getHeader: () => unknown }).getHeader = () => ({
      parentSession: "/sessions/some-other-file.jsonl",
    });
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    const db = openIndexDb(dbPath);
    const row = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get("s-child")!;
    assert.equal(row.parent_id, "parent-from-env");
  });
});

describe("logEvent (REQ-PRV-91)", () => {
  it("writes an event row and never throws even against an unwritable db path", () => {
    process.env.PI_INDEX_DB = "/definitely/not/a/writable/path/index.db";
    resetIndexDbCache();
    assert.doesNotThrow(() => logEvent("s1", "guard", "DB-RM-ROOT", false, 3, { toolName: "bash" }));
  });

  it("a successful write is readable back with the JSON payload intact", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "logevent-")), "index.db");
    process.env.PI_INDEX_DB = dbPath;
    resetIndexDbCache();
    logEvent("s1", "dispatch", "researcher", true, 42, { agent: "researcher" });
    const db = openIndexDb(dbPath);
    const row = db.prepare("SELECT * FROM events WHERE session_id = ?").get("s1")!;
    assert.equal(row.kind, "dispatch");
    assert.equal(row.ok, 1);
    assert.equal(row.ms, 42);
    assert.deepEqual(JSON.parse(row.payload as string), { agent: "researcher" });
  });
});

describe("/index command", () => {
  it("calls SessionManager.listAll() and reports the indexed count through ctx.ui.notify", async () => {
    const dbPath = join(await mkdtemp(join(sandbox, "cmd-")), "index.db");
    process.env.PI_INDEX_DB = dbPath;

    const sessDir = await mkdtemp(join(sandbox, "sessions-"));
    const path = join(sessDir, "s.jsonl");
    await writeFile(
      path,
      JSON.stringify({ type: "session", version: 3, id: "sess-x", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-01T09:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-x",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
            },
            stopReason: "stop",
            timestamp: Date.parse("2026-08-01T09:00:01.000Z"),
          },
        }) +
        "\n",
    );

    const listAllMock = mock.method(SessionManager, "listAll", async () => [
      {
        path,
        id: "sess-x",
        cwd: "/repo",
        created: new Date("2026-08-01T09:00:00.000Z"),
        modified: new Date("2026-08-01T09:05:00.000Z"),
        messageCount: 1,
        firstMessage: "hi",
        allMessagesText: "hi",
      },
    ]);

    try {
      const { pi, commands } = fakePi();
      registerSessionIndex(pi);
      const notifications: string[] = [];
      const cmdCtx = { ui: { notify: (msg: string) => notifications.push(msg) } } as never;
      await commands.get("index")!.handler("", cmdCtx);

      assert.equal(listAllMock.mock.callCount(), 1);
      assert.ok(notifications.some((m) => m.includes("indexed 1 sessions")));

      const db = openIndexDb(dbPath);
      assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get("sess-x"));
    } finally {
      listAllMock.mock.restore();
    }
  });
});

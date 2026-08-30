import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { __resetForTests, __state, id, register, toRelativePath } from "../../extensions/path-rules/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

type Handler<E, R> = (event: E, ctx: ExtensionContext) => R | Promise<R>;

interface FakePi {
  pi: ExtensionAPI;
  sessionStart: Handler<SessionStartEvent, unknown>[];
  toolCall: Handler<ToolCallEvent, unknown>[];
  context: Handler<ContextEvent, unknown>[];
  /** Nothing may land here: the system prompt is the cached prefix and this module stays out of it. */
  beforeAgentStart: Handler<unknown, unknown>[];
}

function fakePi(): FakePi {
  const sessionStart: FakePi["sessionStart"] = [];
  const toolCall: FakePi["toolCall"] = [];
  const context: FakePi["context"] = [];
  const beforeAgentStart: FakePi["beforeAgentStart"] = [];
  const pi = {
    on(event: string, handler: never) {
      if (event === "session_start") sessionStart.push(handler);
      else if (event === "tool_call") toolCall.push(handler);
      else if (event === "context") context.push(handler);
      else if (event === "before_agent_start") beforeAgentStart.push(handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, sessionStart, toolCall, context, beforeAgentStart };
}

function fakeCtx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
}

function sessionStartEvent(): SessionStartEvent {
  return { type: "session_start", reason: "startup" } as SessionStartEvent;
}

function writeEvent(path: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-w", toolName: "write", input: { path, content: "" } } as ToolCallEvent;
}

function contextEvent(): ContextEvent {
  return { type: "context", messages: [] } as ContextEvent;
}

/** The text of the note `context` appended to the tail, or `undefined` when it injected nothing. */
async function injectedNote(
  handler: Handler<ContextEvent, unknown>,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const result = (await handler(contextEvent(), ctx)) as { messages: Array<{ role: string; content: unknown }> } | undefined;
  if (!result) return undefined;
  const last = result.messages.at(-1)!;
  assert.equal(last.role, "user");
  return String(last.content);
}

let sandbox: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-path-rules-index-"));
  savedEnv = process.env.PI_CONFIG_RULES_DIR;
  __resetForTests();
  resetSurfaced();
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PI_CONFIG_RULES_DIR;
  else process.env.PI_CONFIG_RULES_DIR = savedEnv;
  await rm(sandbox, { recursive: true, force: true });
});

describe("path-rules — id and wiring", () => {
  it("id is stable", () => {
    assert.equal(id, "path-rules");
  });

  it("binds exactly one handler per event it uses", () => {
    const { pi, sessionStart, toolCall, context, beforeAgentStart } = fakePi();
    register(pi);
    assert.equal(sessionStart.length, 1);
    assert.equal(toolCall.length, 1);
    assert.equal(context.length, 1);
    assert.equal(
      beforeAgentStart.length,
      0,
      "rule text must never enter the system prompt: it changes mid-session, and the system prompt " +
        "is the head of the provider's cached prefix (index.ts, 'WHY NOT before_agent_start')",
    );
  });
});

describe("path-rules — toRelativePath", () => {
  it("resolves a relative path against cwd", () => {
    assert.equal(toRelativePath("a/b.py", "/proj"), "a/b.py");
  });
  it("resolves an absolute path inside cwd", () => {
    assert.equal(toRelativePath("/proj/a/b.py", "/proj"), "a/b.py");
  });
  it("returns null for a path outside cwd", () => {
    assert.equal(toRelativePath("/elsewhere/b.py", "/proj"), null);
  });
  it("returns null for cwd itself", () => {
    assert.equal(toRelativePath("/proj", "/proj"), null);
  });
});

describe("path-rules — end to end: session_start fingerprint, tool_call detection, context injection", () => {
  it("full turn lifecycle", async () => {
    await writeFile(join(sandbox, "always.md"), "Always-on rule body.");
    await writeFile(join(sandbox, "python.md"), '---\npaths:\n  - "**/*.py"\n---\nPython rule body.');
    process.env.PI_CONFIG_RULES_DIR = sandbox;

    const project = await mkdtemp(join(tmpdir(), "pi-path-rules-project-"));
    try {
      const { pi, sessionStart, toolCall, context } = fakePi();
      register(pi);
      const ctx = fakeCtx(project);

      // session_start: no .py file exists yet — only the unconditional rule activates.
      await sessionStart[0]!(sessionStartEvent(), ctx);
      assert.ok(__state()!.durable.has("always"));
      assert.equal(__state()!.durable.has("python"), false);

      // The first LLM call of turn 1 carries only the unconditional rule.
      const call1 = await injectedNote(context[0]!, ctx);
      assert.ok(call1!.includes("Always-on rule body."));
      assert.equal(call1!.includes("Python rule body."), false);

      // Mid-turn: the model writes a new .py file. tool_call must never block.
      const blockResult = await toolCall[0]!(writeEvent("new_script.py"), ctx);
      assert.equal(blockResult, undefined);
      assert.ok(__state()!.durable.has("python"), "the write should have activated the python rule");

      // The next LLM call — still inside turn 1 — carries BOTH rules. The block is the whole
      // durable set every time, so a rule activated mid-turn needs no separate catch-up path.
      const call2 = await injectedNote(context[0]!, ctx);
      assert.ok(call2!.includes("Always-on rule body."));
      assert.ok(call2!.includes("Python rule body."));

      // And every later call carries the same bytes: a stable tail, not a growing one.
      assert.equal(await injectedNote(context[0]!, ctx), call2);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("path-rules — resilience", () => {
  it("session_start with no configured rules directory is a normal, unconfigured install", async () => {
    process.env.PI_CONFIG_RULES_DIR = join(sandbox, "does-not-exist");
    const { pi, sessionStart, context } = fakePi();
    register(pi);
    await sessionStart[0]!(sessionStartEvent(), fakeCtx(sandbox));
    assert.deepEqual(__state()!.durable, new Set());
    const result = await context[0]!(contextEvent(), fakeCtx(sandbox));
    assert.equal(result, undefined, "nothing durable means no injection and no message mutation");
  });

  it("one broken rule file does not stop the others from activating", async () => {
    await mkdir(join(sandbox), { recursive: true });
    await writeFile(join(sandbox, "broken.md"), '---\npaths:\n  - "**/[abc].py"\n---\nBroken.');
    await writeFile(join(sandbox, "healthy.md"), "Healthy, unconditional.");
    process.env.PI_CONFIG_RULES_DIR = sandbox;

    const { pi, sessionStart } = fakePi();
    register(pi);
    await sessionStart[0]!(sessionStartEvent(), fakeCtx(sandbox));
    assert.ok(__state()!.durable.has("healthy"));
    assert.equal(__state()!.rules.some((r) => r.id === "broken"), false);
  });

  it("tool_call never blocks, even when its own path resolution would throw", async () => {
    process.env.PI_CONFIG_RULES_DIR = join(sandbox, "does-not-exist");
    const { pi, sessionStart, toolCall } = fakePi();
    register(pi);
    await sessionStart[0]!(sessionStartEvent(), fakeCtx(sandbox));

    const brokenCtx = { cwd: undefined, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
    const first = await toolCall[0]!(writeEvent("x.py"), brokenCtx);
    assert.equal(first, undefined);
    const second = await toolCall[0]!(writeEvent("y.py"), brokenCtx);
    assert.equal(second, undefined, "a repeating internal error must keep returning undefined, never start blocking");
  });

  it("tool_call on an unrelated tool (bash) is a no-op", async () => {
    process.env.PI_CONFIG_RULES_DIR = join(sandbox, "does-not-exist");
    const { pi, sessionStart, toolCall } = fakePi();
    register(pi);
    await sessionStart[0]!(sessionStartEvent(), fakeCtx(sandbox));
    const event = { type: "tool_call", toolCallId: "tc-b", toolName: "bash", input: { command: "ls" } } as ToolCallEvent;
    const result = await toolCall[0]!(event, fakeCtx(sandbox));
    assert.equal(result, undefined);
  });
});

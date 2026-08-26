import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  BeforeAgentStartEvent,
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
  beforeAgentStart: Handler<BeforeAgentStartEvent, unknown>[];
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

function beforeAgentStartEvent(systemPrompt: string): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt,
    systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
  } as BeforeAgentStartEvent;
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
    assert.equal(beforeAgentStart.length, 1);
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

describe("path-rules — end to end: session_start fingerprint, tool_call detection, context/before_agent_start injection", () => {
  it("full turn lifecycle", async () => {
    await writeFile(join(sandbox, "always.md"), "Always-on rule body.");
    await writeFile(join(sandbox, "python.md"), '---\npaths:\n  - "**/*.py"\n---\nPython rule body.');
    process.env.PI_CONFIG_RULES_DIR = sandbox;

    const project = await mkdtemp(join(tmpdir(), "pi-path-rules-project-"));
    try {
      const { pi, sessionStart, toolCall, context, beforeAgentStart } = fakePi();
      register(pi);
      const ctx = fakeCtx(project);

      // session_start: no .py file exists yet — only the unconditional rule activates.
      await sessionStart[0]!(sessionStartEvent(), ctx);
      assert.ok(__state()!.durable.has("always"));
      assert.equal(__state()!.durable.has("python"), false);

      // Turn 1's before_agent_start: only the unconditional rule is in the prompt.
      const turn1 = await beforeAgentStart[0]!(beforeAgentStartEvent("base prompt"), ctx);
      assert.ok((turn1 as { systemPrompt: string }).systemPrompt.includes("Always-on rule body."));
      assert.equal((turn1 as { systemPrompt: string }).systemPrompt.includes("Python rule body."), false);

      // Mid-turn: the model writes a new .py file. tool_call must never block.
      const blockResult = await toolCall[0]!(writeEvent("new_script.py"), ctx);
      assert.equal(blockResult, undefined);
      assert.ok(__state()!.durable.has("python"), "the write should have activated the python rule");
      assert.ok(__state()!.pending.has("python"), "and it should be pending for the context fast path");

      // context (fast path): the python rule appears in the messages tail, not the already-durable one.
      const ctxResult = (await context[0]!(contextEvent(), ctx)) as { messages: Array<{ role: string; content: unknown }> };
      assert.ok(ctxResult, "context handler should inject once something is pending");
      const injected = ctxResult.messages.at(-1)!;
      assert.equal(injected.role, "user");
      assert.ok(String(injected.content).includes("Python rule body."));
      assert.equal(String(injected.content).includes("Always-on rule body."), false);

      // Turn 2's before_agent_start: both rules are now in the durable system prompt.
      const turn2 = await beforeAgentStart[0]!(beforeAgentStartEvent("base prompt"), ctx);
      const prompt2 = (turn2 as { systemPrompt: string }).systemPrompt;
      assert.ok(prompt2.includes("Always-on rule body."));
      assert.ok(prompt2.includes("Python rule body."));

      // pending is now empty: context must not re-inject what before_agent_start already sent.
      const ctxAfter = await context[0]!(contextEvent(), ctx);
      assert.equal(ctxAfter, undefined);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("path-rules — resilience", () => {
  it("session_start with no configured rules directory is a normal, unconfigured install", async () => {
    process.env.PI_CONFIG_RULES_DIR = join(sandbox, "does-not-exist");
    const { pi, sessionStart, beforeAgentStart } = fakePi();
    register(pi);
    await sessionStart[0]!(sessionStartEvent(), fakeCtx(sandbox));
    assert.deepEqual(__state()!.durable, new Set());
    const result = await beforeAgentStart[0]!(beforeAgentStartEvent("base"), fakeCtx(sandbox));
    assert.equal(result, undefined, "nothing durable means no injection and no prompt mutation");
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

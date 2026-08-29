// The composition the feature was asked for: a path rule that answers a touch by narrowing the
// tool surface for the rest of the turn instead of by injecting text. Both modules are registered
// against one fake `pi`, in the order `extensions/index.ts` composes them.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  __resetForTests as resetMasks,
  activeMask,
  register as registerToolMasks,
} from "../../extensions/tool-masks/index.ts";
import {
  __resetForTests as resetRules,
  register as registerPathRules,
} from "../../extensions/path-rules/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

const FULL = ["read", "bash", "edit", "write", "grep", "find", "ls"];

interface Seam {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  active: string[];
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
}

function seam(cwd: string): Seam {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const s = { active: [...FULL], handlers } as unknown as Seam;
  s.pi = {
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => [...s.active],
    setActiveTools: (names: string[]) => {
      s.active = [...names];
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  s.ctx = {
    cwd,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  return s;
}

const writeEvent = (path: string): ToolCallEvent =>
  ({ type: "tool_call", toolCallId: "tc-1", toolName: "write", input: { path, content: "" } }) as ToolCallEvent;

const beforeAgentStart = (): BeforeAgentStartEvent =>
  ({
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt: "BASE",
    systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
  }) as BeforeAgentStartEvent;

let sandbox: string;
let rulesDir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  resetMasks();
  resetRules();
  resetSurfaced();
  sandbox = await mkdtemp(join(tmpdir(), "pi-tool-masks-seam-"));
  rulesDir = await mkdtemp(join(tmpdir(), "pi-tool-masks-rules-"));
  savedEnv = process.env.PI_CONFIG_RULES_DIR;
  process.env.PI_CONFIG_RULES_DIR = rulesDir;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PI_CONFIG_RULES_DIR;
  else process.env.PI_CONFIG_RULES_DIR = savedEnv;
  await rm(sandbox, { recursive: true, force: true });
  await rm(rulesDir, { recursive: true, force: true });
});

async function start(s: Seam): Promise<void> {
  registerToolMasks(s.pi);
  registerPathRules(s.pi);
  for (const handler of s.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" } as SessionStartEvent, s.ctx);
  }
}

async function touch(s: Seam, path: string): Promise<unknown> {
  const handler = s.handlers.get("tool_call")![0]!;
  return handler(writeEvent(path), s.ctx);
}

describe("path-rules + tool-masks", () => {
  it("narrows the tool surface when a mask rule's path is touched, and restores it at turn_end", async () => {
    await writeFile(join(rulesDir, "secrets.md"), '---\npaths:\n  - "**/*.env"\nmask: review\n---\nSecrets.');
    const s = seam(sandbox);
    await start(s);

    assert.equal(activeMask(), null);
    await touch(s, "deploy/prod.env");

    assert.equal(activeMask(), "review");
    assert.ok(!s.active.includes("write"), "write survived a mask rule");
    assert.ok(!s.active.includes("bash"));

    for (const handler of s.handlers.get("turn_end") ?? []) handler({ type: "turn_end" }, s.ctx);
    assert.equal(activeMask(), null);
    assert.deepEqual(s.active, FULL);
  });

  it("never blocks the call it masks on: the tool_call handler still returns undefined", async () => {
    await writeFile(join(rulesDir, "secrets.md"), '---\npaths:\n  - "**/*.env"\nmask: review\n---\nSecrets.');
    const s = seam(sandbox);
    await start(s);
    assert.equal(await touch(s, "deploy/prod.env"), undefined);
  });

  it("fires again on the next turn, because a mask rule is not deduped like injected text", async () => {
    await writeFile(join(rulesDir, "secrets.md"), '---\npaths:\n  - "**/*.env"\nmask: review\n---\nSecrets.');
    const s = seam(sandbox);
    await start(s);

    await touch(s, "a.env");
    for (const handler of s.handlers.get("turn_end") ?? []) handler({ type: "turn_end" }, s.ctx);
    assert.equal(activeMask(), null);

    await touch(s, "b.env");
    assert.equal(activeMask(), "review", "the same rule did not fire a second time");
  });

  it("injects no text for a mask rule: the mask IS the response", async () => {
    await writeFile(join(rulesDir, "secrets.md"), '---\npaths:\n  - "**/*.env"\nmask: review\n---\nNEVER-INJECTED.');
    const s = seam(sandbox);
    await start(s);
    await touch(s, "a.env");

    const handler = s.handlers.get("before_agent_start")![0]!;
    const result = (await handler(beforeAgentStart(), s.ctx)) as { systemPrompt?: string } | undefined;
    assert.equal(result, undefined, "a mask rule contributed a system-prompt block");
  });

  it("leaves an ordinary text rule alone: it still injects, and masks nothing", async () => {
    await writeFile(join(rulesDir, "py.md"), '---\npaths:\n  - "**/*.py"\n---\nPYTHON-RULE.');
    const s = seam(sandbox);
    await start(s);
    await touch(s, "app/main.py");

    assert.equal(activeMask(), null);
    assert.deepEqual(s.active, FULL);
    const handler = s.handlers.get("before_agent_start")![0]!;
    const result = (await handler(beforeAgentStart(), s.ctx)) as { systemPrompt?: string } | undefined;
    assert.match(result!.systemPrompt!, /PYTHON-RULE/);
  });
});

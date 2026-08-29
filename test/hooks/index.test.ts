import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "../../extensions/lib/paths.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { hooksDegradedReason, id, register } from "../../extensions/hooks/index.ts";

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
type InputHandler = (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult>;
type SessionStartHandler = (event: { type: "session_start"; reason: string }, ctx: ExtensionContext) => Promise<void>;

interface FakePi {
  readonly pi: ExtensionAPI;
  readonly toolCall: ToolCallHandler[];
  readonly input: InputHandler[];
  readonly sessionStart: SessionStartHandler[];
  readonly entries: Array<[string, unknown]>;
}

function fakePi(): FakePi {
  const toolCall: ToolCallHandler[] = [];
  const input: InputHandler[] = [];
  const sessionStart: SessionStartHandler[] = [];
  const entries: Array<[string, unknown]> = [];
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolCall.push(handler as ToolCallHandler);
      else if (event === "input") input.push(handler as InputHandler);
      else if (event === "session_start") sessionStart.push(handler as SessionStartHandler);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push([customType, data]);
    },
  } as unknown as ExtensionAPI;
  return { pi, toolCall, input, sessionStart, entries };
}

interface FakeCtxOptions {
  readonly hasUI?: boolean;
  readonly cwd?: string;
  readonly trusted?: boolean;
  readonly confirm?: (title: string, message: string) => boolean | Promise<boolean>;
  readonly notifyThrows?: boolean;
}

interface FakeCtxHandle {
  readonly ctx: ExtensionContext;
  readonly notified: Array<[string, string | undefined]>;
  readonly confirmed: Array<[string, string]>;
  shutdownCalls: number;
}

function fakeCtx(opts: FakeCtxOptions = {}): FakeCtxHandle {
  const hasUI = opts.hasUI ?? true;
  const notified: Array<[string, string | undefined]> = [];
  const confirmed: Array<[string, string]> = [];
  const handle: FakeCtxHandle = { notified, confirmed, shutdownCalls: 0 } as FakeCtxHandle;
  const ctx = {
    hasUI,
    mode: hasUI ? "tui" : "print",
    cwd: opts.cwd ?? "/workspace/project",
    isProjectTrusted: () => opts.trusted ?? true,
    shutdown: () => {
      handle.shutdownCalls += 1;
    },
    ui: {
      notify(message: string, type?: string) {
        if (opts.notifyThrows) throw new Error("no tty");
        notified.push([message, type]);
      },
      async confirm(title: string, message: string) {
        confirmed.push([title, message]);
        return opts.confirm ? await opts.confirm(title, message) : true;
      },
    },
  } as unknown as ExtensionContext;
  (handle as { ctx: ExtensionContext }).ctx = ctx;
  return handle;
}

function bashEvent(command: string, extra: Record<string, unknown> = {}): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-1", toolName: "bash", input: { command, ...extra } } as ToolCallEvent;
}

function inputEvent(text: string): InputEvent {
  return { type: "input", text, source: "interactive" } as InputEvent;
}

let dir: string;
let globalDir: string;
let projectDir: string;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

async function writeGlobalHooks(yaml: string): Promise<void> {
  await mkdir(globalDir, { recursive: true });
  await writeFile(join(globalDir, "hooks.yaml"), yaml);
}

async function writeProjectHooks(yaml: string): Promise<void> {
  await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
  await writeFile(join(projectDir, CONFIG_DIR_NAME, "hooks.yaml"), yaml);
}

async function scriptFile(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/usr/bin/env bash\nset -u\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-hooks-index-"));
  // PI_CODING_AGENT_DIR is PI's own override for getAgentDir() (config.ts ENV_AGENT_DIR,
  // "never hardcode .pi" — see extensions/lib/paths.ts). Point it at a temp dir so the
  // "global" hooks.yaml this test writes is what configDir()/load() actually reads, without
  // touching the real $HOME.
  globalDir = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = globalDir;
  projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  resetSurfaced();
});
afterEach(async () => {
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("hooks.register — wiring", () => {
  it("binds exactly one handler each for session_start, tool_call, input", () => {
    const { pi, toolCall, input, sessionStart } = fakePi();
    register(pi);
    assert.equal(sessionStart.length, 1);
    assert.equal(toolCall.length, 1);
    assert.equal(input.length, 1);
  });

  it("id is stable", () => {
    assert.equal(id, "hooks");
  });
});

describe("hooks — tool_call: block/warn/confirm", () => {
  it("block: a matching rule blocks, a non-matching command does not", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: no-force-push
    event: tool_call
    match: { tool: bash, pattern: 'git push .*--force' }
    action: block
    reason: "no force push"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const blocked = await toolCall[0]!(bashEvent("git push --force origin main"), h.ctx);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /no force push \[hook:no-force-push\]/);

    const allowed = await toolCall[0]!(bashEvent("ls -la"), h.ctx);
    assert.equal(allowed, undefined);
  });

  it("warn: does not block and does not short-circuit — a later block rule still fires", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: nudge
    event: tool_call
    match: { tool: bash }
    action: warn
    reason: "heads up"
  - id: really-block
    event: tool_call
    match: { tool: bash, pattern: 'rm -rf' }
    action: block
    reason: "no"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("rm -rf /tmp/x"), h.ctx);
    assert.equal(result?.block, true);
    assert.ok(h.notified.some(([msg]) => msg.includes("heads up")));
  });

  it("confirm: declining blocks, accepting proceeds", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: confirm-npm
    event: tool_call
    match: { tool: bash, pattern: 'npm install' }
    action: confirm
    reason: "sure?"
`);
    const { pi, toolCall, sessionStart } = fakePi();

    register(pi);
    const decline = fakeCtx({ confirm: () => false });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, decline.ctx);
    const blocked = await toolCall[0]!(bashEvent("npm install left-pad"), decline.ctx);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /declined/);

    register(pi);
    const accept = fakeCtx({ confirm: () => true });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, accept.ctx);
    const allowed = await toolCall[0]!(bashEvent("npm install left-pad"), accept.ctx);
    assert.equal(allowed, undefined);
  });

  it("confirm: fails CLOSED with no UI, without ever calling ctx.ui.confirm", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: confirm-npm
    event: tool_call
    match: { tool: bash, pattern: 'npm install' }
    action: confirm
    reason: "sure?"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx({ hasUI: false });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("npm install left-pad"), h.ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no UI/);
    assert.equal(h.confirmed.length, 0);
  });
});

describe("hooks — the four fail-closed cases pi-yaml-hooks got backwards (docs/DENYLIST.md §4a)", () => {
  it("#4 a run rule whose script is MISSING blocks, never permits", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: external-guard
    event: tool_call
    match: { tool: bash }
    action: run
    run: { command: "${join(dir, "does-not-exist.sh")}" }
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /missing or not executable/);
  });

  it("#3 a run rule whose script TIMES OUT blocks, never permits", async () => {
    const slow = await scriptFile("slow.sh", "sleep 5");
    await writeGlobalHooks(`version: 1
rules:
  - id: external-guard
    event: tool_call
    match: { tool: bash }
    action: run
    run: { command: "${slow}", timeoutMs: 150 }
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    // `cwd` must be a real directory: `child_process.spawn` itself throws ENOENT when `cwd`
    // does not exist, which would masquerade as "script missing" and never reach the timeout
    // path this test is asserting on. `dir` (the script's own directory) is guaranteed to exist.
    const h = fakeCtx({ cwd: dir });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /exceeded 150 ms/);
  });

  it("a run rule whose script legitimately says nothing (exit 0, empty stdout) does NOT block", async () => {
    const quiet = await scriptFile("quiet.sh", "exit 0");
    await writeGlobalHooks(`version: 1
rules:
  - id: external-guard
    event: tool_call
    match: { tool: bash }
    action: run
    run: { command: "${quiet}" }
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    // Same `cwd` requirement as the TIMES OUT case above — a nonexistent `cwd` makes
    // `spawn` itself throw ENOENT before the script ever runs.
    const h = fakeCtx({ cwd: dir });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(result, undefined);
  });

  it("#1 a rule that CANNOT BE EVALUATED (input has a BigInt, JSON.stringify throws) blocks", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: pattern-rule
    event: tool_call
    match: { tool: bash, pattern: '.*' }
    action: block
    reason: "unreachable — the match step throws first"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const event = bashEvent("ls", { weight: 1n }); // BigInt: JSON.stringify throws on it
    const result = await toolCall[0]!(event, h.ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /guard unavailable \(internal error\)/);
  });

  it("#2 a rule whose ACTION THROWS (confirm dialog itself errors) blocks", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: confirm-rule
    event: tool_call
    match: { tool: bash }
    action: confirm
    reason: "sure?"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx({
      confirm: () => {
        throw new Error("dialog subsystem crashed");
      },
    });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /guard unavailable \(internal error\)/);
  });
});

describe("hooks — preflight-before-remote-job: matches a paid submit, not a read-only near-miss", () => {
  // The pattern under test is copied verbatim from config/hooks.yaml's preflight-before-remote-job
  // rule — keep the two in sync if either changes.
  const PATTERN =
    'databricks\\s+jobs\\s+run-now\\b|databricks\\s+bundle\\s+deploy\\b|gcloud\\s+\\S+\\s+jobs\\s+submit\\b|aws\\s+batch\\s+submit-job\\b|kubectl\\s+create\\s+job\\b';

  async function loadRule(): Promise<{
    toolCall: ToolCallHandler[];
    sessionStart: SessionStartHandler[];
    ctx: FakeCtxHandle;
  }> {
    await writeGlobalHooks(`version: 1
rules:
  - id: preflight-before-remote-job
    event: tool_call
    match: { tool: bash, pattern: '${PATTERN}' }
    action: confirm
    reason: "submit anyway?"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const ctx = fakeCtx({ confirm: () => true });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, ctx.ctx);
    return { toolCall, sessionStart, ctx };
  }

  const submits = [
    "databricks jobs run-now --job-id 123",
    "databricks bundle deploy -t prod",
    "gcloud ai-platform jobs submit training my_job --region=us-central1",
    "aws batch submit-job --job-name x --job-queue q --job-definition d",
    "kubectl create job my-job --image=busybox",
  ];
  const nearMisses = ["databricks jobs list", "databricks bundle validate", "kubectl get jobs"];

  for (const command of submits) {
    it(`confirms before a remote submit: ${command}`, async () => {
      const { toolCall, ctx } = await loadRule();
      const result = await toolCall[0]!(bashEvent(command), ctx.ctx);
      assert.equal(result, undefined, "accepted confirm proceeds");
      assert.equal(ctx.confirmed.length, 1);
    });
  }

  for (const command of nearMisses) {
    it(`does not fire on a read-only near-miss: ${command}`, async () => {
      const { toolCall, ctx } = await loadRule();
      const result = await toolCall[0]!(bashEvent(command), ctx.ctx);
      assert.equal(result, undefined);
      assert.equal(ctx.confirmed.length, 0, "a read-only command must never trigger the confirm dialog");
    });
  }
});

describe("hooks — a malformed hooks.yaml FILE degrades this module, it does not contain the session (docs/DENYLIST.md §4a finding #5)", () => {
  it("invalid YAML syntax degrades: no shutdown, an error-level DEGRADED announcement, tool calls proceed, input is not swallowed", async () => {
    await writeGlobalHooks("version: 1\nrules: [{id: bad, event: tool_call\n"); // unterminated flow
    const { pi, toolCall, input, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    assert.equal(h.shutdownCalls, 0);
    assert.ok(h.notified.some(([msg, type]) => type === "error" && msg.includes("DEGRADED")));
    assert.match(hooksDegradedReason() ?? "", /invalid YAML/);

    const toolResult = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(toolResult, undefined);

    const inputResult = await input[0]!(inputEvent("anything at all"), h.ctx);
    assert.deepEqual(inputResult, { action: "continue" });
  });

  it("a wrong top-level shape (bad version) degrades the same way", async () => {
    // Not "1.0": YAML's default schema parses that scalar to the JS number 1, which is
    // `=== 1` and would silently pass the version check. A quoted string is unambiguously
    // not the number 1.
    await writeGlobalHooks('version: "1"\nrules: []\n');
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    assert.equal(h.shutdownCalls, 0);
    assert.ok(hooksDegradedReason());
    const result = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(result, undefined);
  });

  it("rules: not-an-array degrades the same way", async () => {
    await writeGlobalHooks("version: 1\nrules: not-a-list\n");
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    assert.equal(h.shutdownCalls, 0);
    assert.ok(hooksDegradedReason());
    const result = await toolCall[0]!(bashEvent("ls"), h.ctx);
    assert.equal(result, undefined);
  });

  it("a repaired file on the next session clears the degraded state — it is per-load, not sticky", async () => {
    await writeGlobalHooks("version: 1\nrules: not-a-list\n");
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const broken = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, broken.ctx);
    assert.ok(hooksDegradedReason());

    await writeGlobalHooks(`version: 1
rules:
  - id: good
    event: tool_call
    match: { tool: bash, pattern: 'rm -rf' }
    action: block
    reason: "no"
`);
    const repaired = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, repaired.ctx);

    assert.equal(hooksDegradedReason(), undefined);
    const result = await toolCall[0]!(bashEvent("rm -rf /"), repaired.ctx);
    assert.equal(result?.block, true);
  });

  it("contrast: ONE bad rule in an otherwise-valid file does NOT degrade — it is named, dropped, and the rest still loads", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: bad
    event: tool_call
    action: block
    match: { pattern: "(" }
  - id: good
    event: tool_call
    match: { tool: bash, pattern: 'rm -rf' }
    action: block
    reason: "no"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    assert.equal(h.shutdownCalls, 0);
    assert.ok(h.notified.some(([msg]) => msg.includes("bad") && msg.includes("invalid regex")));

    const stillBlocks = await toolCall[0]!(bashEvent("rm -rf /"), h.ctx);
    assert.equal(stillBlocks?.block, true);
  });

  it("no hooks.yaml anywhere is normal — zero rules, no refusal, tool calls proceed", async () => {
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    assert.equal(h.shutdownCalls, 0);
    const result = await toolCall[0]!(bashEvent("rm -rf /"), h.ctx);
    assert.equal(result, undefined);
  });
});

describe("hooks — project trust gate", () => {
  it("an untrusted project's .pi/hooks.yaml is NOT loaded", async () => {
    await writeProjectHooks(`version: 1
rules:
  - id: project-only
    event: tool_call
    match: { tool: bash }
    action: block
    reason: "should never fire"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx({ cwd: projectDir, trusted: false });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("anything"), h.ctx);
    assert.equal(result, undefined);
  });

  it("a trusted project's .pi/hooks.yaml IS loaded, merged after global", async () => {
    await writeGlobalHooks("version: 1\nrules: []\n");
    await writeProjectHooks(`version: 1
rules:
  - id: project-rule
    event: tool_call
    match: { tool: bash }
    action: block
    reason: "project says no"
`);
    const { pi, toolCall, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx({ cwd: projectDir, trusted: true });
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await toolCall[0]!(bashEvent("anything"), h.ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /project says no/);
  });
});

describe("hooks — input event", () => {
  it("block swallows a matching message, non-matching text continues", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: block-secret-word
    event: input
    match: { pattern: 'sudo rm -rf' }
    action: block
`);
    const { pi, input, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    assert.deepEqual(await input[0]!(inputEvent("please sudo rm -rf everything"), h.ctx), { action: "handled" });
    assert.deepEqual(await input[0]!(inputEvent("please help me refactor"), h.ctx), { action: "continue" });
  });

  it("warn notifies and does not swallow the message", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: remind-worktree
    event: input
    match: { pattern: 'implement' } # JS RegExp has no (?i) inline-flag syntax (PCRE-only); the test text is already lowercase
    action: warn
    reason: "use a worktree"
`);
    const { pi, input, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await input[0]!(inputEvent("please implement the thing"), h.ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.ok(h.notified.some(([msg]) => msg.includes("use a worktree")));
  });

  it("an internal error in the input path fails CLOSED (swallowed), not open like PI's own emitInput", async () => {
    await writeGlobalHooks(`version: 1
rules:
  - id: remind-worktree
    event: input
    match: { pattern: 'implement' } # JS RegExp has no (?i) inline-flag syntax (PCRE-only); the test text is already lowercase
    action: warn
    reason: "use a worktree"
`);
    const { pi, input, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx({ notifyThrows: true }); // ctx.ui.notify throws inside the warn branch
    await sessionStart[0]!({ type: "session_start", reason: "startup" }, h.ctx);

    const result = await input[0]!(inputEvent("please implement the thing"), h.ctx);
    assert.deepEqual(result, { action: "handled" }, "must swallow, not fall through to {action:'continue'}");
  });
});

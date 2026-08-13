import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
  register as registerContextImports,
  __resetForTests,
  expand,
  id,
  isBelowCwd,
  maskCode,
  resolveSpec,
  MAX_DEPTH,
} from "../extensions/context-imports/index.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler>; sent: unknown[] } {
  const handlers = new Map<string, Handler>();
  const sent: unknown[] = [];
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    sendMessage: (message: unknown, options: unknown) => void sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent };
}

function fakeCtx(opts: { cwd: string; hasUI?: boolean; notify?: (msg: string, type?: string) => void }): ExtensionContext {
  return {
    cwd: opts.cwd,
    hasUI: opts.hasUI ?? false,
    ui: { notify: opts.notify ?? (() => {}) },
  } as unknown as ExtensionContext;
}

function toolResult(over: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "tc-1",
    toolName: "read",
    input: {},
    content: [{ type: "text", text: "hi" }],
    isError: false,
    details: undefined,
    ...over,
  } as ToolResultEvent;
}

function collectNotify(): { notify: (msg: string, level?: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { notify: (msg: string) => lines.push(msg), lines };
}

let sandbox: string;

beforeEach(async () => {
  __resetForTests();
  resetSurfaced();
  sandbox = await mkdtemp(join(tmpdir(), "context-imports-"));
});
after(async () => {
  // best-effort; each beforeEach makes a fresh dir so leftovers are harmless
});

// ---------------------------------------------------------------------------
// maskCode
// ---------------------------------------------------------------------------

describe("maskCode (EXT-21)", () => {
  it("blanks a fenced code block but preserves its length", () => {
    const md = "before\n```\n@secret.md\n```\nafter";
    const masked = maskCode(md);
    assert.equal(masked.length, md.length);
    assert.ok(!masked.includes("@secret.md"));
    assert.ok(masked.includes("before"));
    assert.ok(masked.includes("after"));
  });

  it("blanks a tilde-fenced code block", () => {
    const md = "~~~\n@secret.md\n~~~";
    assert.ok(!maskCode(md).includes("@secret.md"));
  });

  it("blanks inline code but leaves plain @path lines alone", () => {
    const md = "line one\n`@inline.md`\n@real.md\nline four";
    const masked = maskCode(md);
    assert.ok(!masked.includes("@inline.md"));
    assert.ok(masked.includes("@real.md"));
  });
});

// ---------------------------------------------------------------------------
// resolveSpec / isBelowCwd
// ---------------------------------------------------------------------------

describe("resolveSpec (EXT-21)", () => {
  it("resolves a relative spec against baseDir", () => {
    assert.equal(resolveSpec("a/b.md", "/x/y"), resolve("/x/y", "a/b.md"));
  });

  it("leaves an absolute spec untouched", () => {
    assert.equal(resolveSpec("/abs/path.md", "/x/y"), "/abs/path.md");
  });

  it("expands a leading ~ against $HOME", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/home/user";
    try {
      assert.equal(resolveSpec("~/notes.md", "/x/y"), "/home/user/notes.md");
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("isBelowCwd (EXT-21)", () => {
  it("is false for cwd itself", () => {
    assert.equal(isBelowCwd("/a/proj", "/a/proj"), false);
  });

  it("is true for a real subdirectory", () => {
    assert.equal(isBelowCwd("/a/proj", "/a/proj/src/api"), true);
  });

  it("is false for a sibling directory that merely shares a string prefix", () => {
    // The literal bug the spec's `dir.startsWith(ctx.cwd)` pseudocode has: "/a/proj2" starts
    // with the string "/a/proj" but is not underneath it.
    assert.equal(isBelowCwd("/a/proj", "/a/proj2"), false);
  });

  it("is false for a parent directory", () => {
    assert.equal(isBelowCwd("/a/proj/src", "/a/proj"), false);
  });
});

// ---------------------------------------------------------------------------
// expand() — REQ-CTX-07
// ---------------------------------------------------------------------------

describe("expand (EXT-21, REQ-CTX-07)", () => {
  it("resolves a depth-4 import chain and substitutes the leaf content", async () => {
    await mkdir(join(sandbox, "a", "b", "c"), { recursive: true });
    await writeFile(join(sandbox, "root.md"), "ROOT\n@a/l1.md\n");
    await writeFile(join(sandbox, "a", "l1.md"), "L1\n@b/l2.md\n");
    await writeFile(join(sandbox, "a", "b", "l2.md"), "L2\n@c/l3.md\n");
    await writeFile(join(sandbox, "a", "b", "c", "l3.md"), "L3-SENTINEL\n");

    const { notify } = collectNotify();
    const out = await expand(join(sandbox, "a", "l1.md"), 1, [], notify);
    assert.ok(out.includes("L3-SENTINEL"), out);
    // The raw, bare "@b/l2.md" import LINE is gone (it only survives inside the "@label"
    // portion of the begin/end boundary comment this module wraps substitutions in).
    assert.ok(!/^@b\/l2\.md$/m.test(out), out);
    assert.ok(out.includes("<!-- begin @b/l2.md -->"), out);
  });

  it("leaves a depth-capped file's own @imports unexpanded and warns once", async () => {
    // MAX_DEPTH levels of files, each importing the next; the last one still has a literal
    // @import inside it that must stay literal because depth ran out.
    const names = Array.from({ length: MAX_DEPTH + 2 }, (_, i) => `f${i}.md`);
    for (let i = 0; i < names.length; i++) {
      const body = i < names.length - 1 ? `LEVEL-${i}\n@${names[i + 1]}\n` : `LEVEL-${i}-DEEPEST`;
      await writeFile(join(sandbox, names[i]), body);
    }
    const { notify, lines } = collectNotify();
    const out = await expand(join(sandbox, names[0]), 1, [], notify);
    // Depths 1..MAX_DEPTH-1 resolve fully; the file read AT depth MAX_DEPTH (names[MAX_DEPTH])
    // is included but its own @import is left raw, so that literal "@f<N+1>.md" line survives
    // verbatim somewhere in the composed output.
    assert.ok(out.includes(`@${names[MAX_DEPTH]}`), out);
    assert.ok(lines.some((l) => l.includes("depth limit")), lines.join("\n"));
  });

  it("announces a missing import exactly once even when re-encountered", async () => {
    const missing = join(sandbox, "nope.md");
    const { notify, lines } = collectNotify();
    const first = await expand(missing, 1, [], notify);
    const second = await expand(missing, 1, [], notify);
    assert.ok(first.includes("@import missing"));
    assert.equal(second, first);
    assert.equal(lines.filter((l) => l.includes("not found")).length, 1);
  });

  it("distinguishes a permission-style read failure from a plain miss", async () => {
    // Simulate "unreadable" by pointing at a directory instead of a file — readFile on a
    // directory fails with EISDIR, not ENOENT.
    const dir = join(sandbox, "a-directory");
    await mkdir(dir);
    const { notify, lines } = collectNotify();
    const out = await expand(dir, 1, [], notify);
    assert.ok(out.includes("@import missing"));
    assert.ok(lines.some((l) => l.includes("unreadable")), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("not found")), lines.join("\n"));
  });

  it("detects a real cycle, terminates, and prints the chain exactly once", async () => {
    await writeFile(join(sandbox, "a.md"), "@b.md\n");
    await writeFile(join(sandbox, "b.md"), "@a.md\n");
    const { notify, lines } = collectNotify();
    const out = await expand(join(sandbox, "a.md"), 1, [], notify);
    assert.ok(out.includes("@import cycle"), out);
    const cycleLines = lines.filter((l) => l.includes("@import cycle"));
    assert.equal(cycleLines.length, 1, lines.join("\n"));
    assert.ok(cycleLines[0].includes("a.md") && cycleLines[0].includes("b.md"), cycleLines[0]);
  });

  it("does NOT flag a diamond (two branches importing the same file) as a cycle", async () => {
    await writeFile(join(sandbox, "shared.md"), "SHARED-CONTENT");
    await writeFile(join(sandbox, "left.md"), "@shared.md\n");
    await writeFile(join(sandbox, "right.md"), "@shared.md\n");
    await writeFile(join(sandbox, "root.md"), "@left.md\n@right.md\n");
    const { notify, lines } = collectNotify();
    const out = await expand(join(sandbox, "root.md"), 1, [], notify);
    assert.ok(!out.includes("@import cycle"), out);
    assert.equal(out.split("SHARED-CONTENT").length - 1, 2, "both branches should see the shared content");
    assert.ok(!lines.some((l) => l.includes("cycle")), lines.join("\n"));
  });

  it("is memoized: a second expand() of the same file does not re-read it", async () => {
    const file = join(sandbox, "once.md");
    await writeFile(file, "STABLE");
    const { notify } = collectNotify();
    const first = await expand(file, 1, [], notify);
    await writeFile(file, "CHANGED"); // if expand() re-read, the second call would see this
    const second = await expand(file, 1, [], notify);
    assert.equal(second, first);
    assert.equal(second, "STABLE");
  });
});

// ---------------------------------------------------------------------------
// default export — before_agent_start (REQ-CTX-07) and tool_result (REQ-CTX-08)
// ---------------------------------------------------------------------------

describe("register (EXT-21, wired through the default export)", () => {
  it("exposes id and registers session_start, before_agent_start, tool_result", () => {
    assert.equal(id, "context-imports");
    const { pi, handlers } = fakePi();
    registerContextImports(pi);
    assert.equal(typeof handlers.get("session_start"), "function");
    assert.equal(typeof handlers.get("before_agent_start"), "function");
    assert.equal(typeof handlers.get("tool_result"), "function");
  });

  it("before_agent_start: expands a real @import and leaves a fenced @path untouched (fence-aware)", async () => {
    await writeFile(join(sandbox, "secret.md"), "LEAKED");
    await writeFile(join(sandbox, "real.md"), "REAL-CONTENT");
    const { pi, handlers } = fakePi();
    registerContextImports(pi);
    const handler = handlers.get("before_agent_start")!;
    const ctx = fakeCtx({ cwd: sandbox });

    const systemPrompt = "You are an agent.\n@real.md\n```\n@secret.md\n```\nEnd.";
    const res = (await handler({ type: "before_agent_start", prompt: "hi", systemPrompt }, ctx)) as
      | { systemPrompt?: string }
      | undefined;

    assert.ok(res?.systemPrompt, "expected a systemPrompt patch");
    assert.ok(res!.systemPrompt!.includes("REAL-CONTENT"));
    assert.ok(!res!.systemPrompt!.includes("LEAKED"), "fenced @path must not be imported");
    assert.ok(res!.systemPrompt!.includes("```\n@secret.md\n```"), "the fence itself stays literal");
  });

  it("before_agent_start: a prompt with no @ at all is left untouched (returns undefined)", async () => {
    const { pi, handlers } = fakePi();
    registerContextImports(pi);
    const handler = handlers.get("before_agent_start")!;
    const ctx = fakeCtx({ cwd: sandbox });
    const res = await handler(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "No imports here." },
      ctx,
    );
    assert.equal(res, undefined);
  });

  it("tool_result: loads a subdirectory's AGENTS.md on first read, once per directory per session", async () => {
    await mkdir(join(sandbox, "src", "api"), { recursive: true });
    await writeFile(join(sandbox, "src", "api", "AGENTS.md"), "API DIR RULES");
    await writeFile(join(sandbox, "src", "api", "x.ts"), "// x");
    await writeFile(join(sandbox, "src", "api", "y.ts"), "// y");

    const { pi, handlers, sent } = fakePi();
    registerContextImports(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx({ cwd: sandbox });

    await handler(toolResult({ toolName: "read", input: { path: "src/api/x.ts" } }), ctx);
    await handler(toolResult({ toolName: "read", input: { path: "src/api/y.ts" } }), ctx);

    const nested = sent.filter(
      (s) => (s as { message: { customType?: string } }).message.customType === "nested-instructions",
    );
    assert.equal(nested.length, 1, JSON.stringify(sent));
    const first = nested[0] as { message: { content: { text: string }[] }; options: { deliverAs: string } };
    assert.ok(first.message.content[0].text.includes("API DIR RULES"));
    assert.equal(first.options.deliverAs, "nextTurn");
  });

  it("tool_result: a directory with neither file present is marked visited but sends nothing", async () => {
    await mkdir(join(sandbox, "empty"), { recursive: true });
    await writeFile(join(sandbox, "empty", "z.ts"), "// z");
    const { pi, handlers, sent } = fakePi();
    registerContextImports(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx({ cwd: sandbox });

    await handler(toolResult({ toolName: "read", input: { path: "empty/z.ts" } }), ctx);
    assert.equal(sent.length, 0);
  });

  it("tool_result: ignores non read/edit/write tools (e.g. bash)", async () => {
    const { pi, handlers, sent } = fakePi();
    registerContextImports(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx({ cwd: sandbox });
    await handler(toolResult({ toolName: "bash", input: { command: "ls" } }), ctx);
    assert.equal(sent.length, 0);
  });

  it("tool_result: walks every intervening directory up to (not including) cwd", async () => {
    await mkdir(join(sandbox, "src", "api"), { recursive: true });
    await writeFile(join(sandbox, "src", "AGENTS.md"), "SRC RULES");
    await writeFile(join(sandbox, "src", "api", "AGENTS.md"), "API RULES");
    await writeFile(join(sandbox, "src", "api", "x.ts"), "// x");

    const { pi, handlers, sent } = fakePi();
    registerContextImports(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx({ cwd: sandbox });
    await handler(toolResult({ toolName: "read", input: { path: "src/api/x.ts" } }), ctx);

    const nested = sent.filter(
      (s) => (s as { message: { customType?: string } }).message.customType === "nested-instructions",
    );
    assert.equal(nested.length, 2, JSON.stringify(sent));
  });

  it("session_start resets the loaded-directory registry so a new session reloads it", async () => {
    await mkdir(join(sandbox, "src"), { recursive: true });
    await writeFile(join(sandbox, "src", "AGENTS.md"), "SRC RULES");
    await writeFile(join(sandbox, "src", "x.ts"), "// x");

    const { pi, handlers, sent } = fakePi();
    registerContextImports(pi);
    const toolResultHandler = handlers.get("tool_result")!;
    const sessionStartHandler = handlers.get("session_start")!;
    const ctx = fakeCtx({ cwd: sandbox });

    await toolResultHandler(toolResult({ toolName: "read", input: { path: "src/x.ts" } }), ctx);
    await sessionStartHandler({ type: "session_start", reason: "new" }, ctx);
    await toolResultHandler(toolResult({ toolName: "read", input: { path: "src/x.ts" } }), ctx);

    const nested = sent.filter(
      (s) => (s as { message: { customType?: string } }).message.customType === "nested-instructions",
    );
    assert.equal(nested.length, 2, "should reload after session_start, not stay deduped forever");
  });
});

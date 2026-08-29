import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

import { register as registerBigResults } from "../extensions/big-results/index.ts";
import { CARD_ENTRY, PREVIEW_LINES, type ExternalisedCard } from "../extensions/big-results/card.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";
import { scratchDir } from "../extensions/lib/paths.ts";

/** Captures every `pi.on` handler, `pi.registerTool` call and appended entry the extension makes. */
function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Function>;
  tools: Map<string, ToolDefinition>;
  entries: Array<{ customType: string; data: unknown }>;
} {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, ToolDefinition>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    on: (event: string, handler: Function) => void handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => void tools.set(tool.name, tool),
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, entries };
}

function fakeCtx(sessionId: string, opts: { hasUI?: boolean; notify?: (msg: string, type?: string) => void } = {}): ExtensionContext {
  return {
    hasUI: opts.hasUI ?? false,
    ui: { notify: opts.notify ?? (() => {}) },
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function customResult(over: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "tc-1",
    toolName: "some_tool",
    input: {},
    content: [{ type: "text", text: "hi" }],
    isError: false,
    details: undefined,
    ...over,
  } as ToolResultEvent;
}

let sandbox: string;
let sessionCounter = 0;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "big-results-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("big-results (EXT-29)", () => {
  let prevXdg: string | undefined;
  let sessionId: string;

  beforeEach(() => {
    resetSurfaced();
    prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(sandbox, "xdg");
    sessionId = `s-${++sessionCounter}`;
  });

  it("registers a tool_result handler and the expand_result tool", () => {
    const { pi, handlers, tools } = fakePi();
    registerBigResults(pi);
    assert.equal(typeof handlers.get("tool_result"), "function");
    assert.ok(tools.has("expand_result"));
    const def = tools.get("expand_result")!;
    assert.equal(def.label, "Expand externalised result");
    assert.ok(def.promptGuidelines && def.promptGuidelines.length > 0);
  });

  it("a small result is left untouched (no patch, no file written)", async () => {
    const { pi, handlers } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const res = await handler(customResult({ content: [{ type: "text", text: "tiny" }] }), ctx);
    assert.equal(res, undefined);

    const err = await stat(join(scratchDir(sessionId), "results")).catch((e) => e);
    assert.equal(err.code, "ENOENT", "no results dir should be created for an under-threshold result");
  });

  it("an oversized text result is externalised: short summary, handle, file on disk", async () => {
    const { pi, handlers, entries } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`.padEnd(20, "."));
    const big = lines.join("\n");
    assert.ok(Buffer.byteLength(big, "utf8") > DEFAULT_MAX_BYTES, "fixture must exceed the 50KB threshold");

    const res = await handler(customResult({ toolCallId: "tc-big", content: [{ type: "text", text: big }] }), ctx);
    assert.ok(res, "an oversized result must be patched");
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].type, "text");

    // The patch text is small: head + tail + summary, nowhere near the original 3000 lines.
    assert.ok(res.content[0].text.length < 20_000, "the returned text must not carry the full body");
    assert.match(res.content[0].text, /line-0/);
    assert.match(res.content[0].text, /line-2999/);
    assert.match(res.content[0].text, /externalised; handle "/);
    assert.match(res.content[0].text, /expand_result\(handle=/);

    const handle = res.details.externalised.handle as string;
    assert.equal(res.details.externalised.lines, 3000);

    const written = await readFile(join(scratchDir(sessionId), "results", `${handle}.txt`), "utf8");
    assert.equal(written, big, "the full body must be recoverable byte-for-byte from disk");

    const meta = JSON.parse(await readFile(join(scratchDir(sessionId), "results", `${handle}.json`), "utf8"));
    assert.equal(meta.reusedExisting, false);
    assert.equal(meta.lines, 3000);

    // The same externalisation, once more as a display-only card for the human.
    const cards = entries.filter((e) => e.customType === CARD_ENTRY);
    assert.equal(cards.length, 1, "exactly one card per externalisation");
    const card = cards[0]!.data as ExternalisedCard;
    assert.equal(card.handle, handle);
    assert.equal(card.lines, 3000);
    assert.equal(card.toolName, "some_tool");
    assert.deepEqual(card.preview, lines.slice(0, PREVIEW_LINES));
  });

  it("existing details survive the patch (spread, not replaced)", async () => {
    const { pi, handlers } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const big = "x".repeat(DEFAULT_MAX_BYTES + 100);
    const res = await handler(
      customResult({ toolCallId: "tc-details", content: [{ type: "text", text: big }], details: { keep: "me" } }),
      ctx,
    );
    assert.equal(res.details.keep, "me");
    assert.ok(res.details.externalised);
  });

  it("a bash result reuses PI's own fullOutputPath instead of duplicating the bytes", async () => {
    const { pi, handlers } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const overflowPath = join(sandbox, `bash-overflow-${sessionId}.txt`);
    const big = Array.from({ length: 2500 }, (_, i) => `bash-line-${i}`.padEnd(25, ".")).join("\n");
    assert.ok(Buffer.byteLength(big, "utf8") > DEFAULT_MAX_BYTES, "fixture must exceed the 50KB threshold");
    await writeFile(overflowPath, big, "utf8");

    const res = await handler(
      {
        type: "tool_result",
        toolCallId: "tc-bash",
        toolName: "bash",
        input: { command: "yes line | head -200000" },
        content: [{ type: "text", text: big }],
        isError: false,
        details: { fullOutputPath: overflowPath },
      },
      ctx,
    );
    assert.ok(res);
    const handle = res.details.externalised.handle as string;
    assert.equal(res.details.externalised.path, overflowPath);

    // K3: no second copy under results/ — only the metadata sidecar, never a duplicate .txt.
    const dupExists = await stat(join(scratchDir(sessionId), "results", `${handle}.txt`))
      .then(() => true)
      .catch(() => false);
    assert.equal(dupExists, false, "must not duplicate a bash result that already has fullOutputPath");

    const meta = JSON.parse(await readFile(join(scratchDir(sessionId), "results", `${handle}.json`), "utf8"));
    assert.equal(meta.path, overflowPath);
    assert.equal(meta.reusedExisting, true);
  });

  it("a mixed text+image result is left untouched — never silently drops the image", async () => {
    const { pi, handlers } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const big = "y".repeat(DEFAULT_MAX_BYTES + 100);
    const res = await handler(
      customResult({
        toolCallId: "tc-mixed",
        content: [
          { type: "text", text: big },
          { type: "image", data: "base64...", mimeType: "image/png" } as unknown as { type: "text"; text: string },
        ],
      }),
      ctx,
    );
    assert.equal(res, undefined, "mixed content must not be patched");
  });

  it("K2 — expand_result round-trips a slice by line range", async () => {
    const { pi, handlers, tools } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const lines = Array.from({ length: 200_000 }, (_, i) => `${i + 1}`);
    const big = lines.join("\n");
    const res = await handler(customResult({ toolCallId: "tc-seq", content: [{ type: "text", text: big }] }), ctx);
    const handle = res.details.externalised.handle as string;

    const expand = tools.get("expand_result")!;
    const out = await expand.execute("tc-x", { handle, fromLine: 199990, lines: 11 }, undefined, undefined, ctx);
    const text = (out.content[0] as { text: string }).text;
    const got = text.trim().split("\n");
    assert.deepEqual(got, lines.slice(199989, 200000));
  });

  it("expand_result grep returns matches with 2 lines of context", async () => {
    const { pi, handlers, tools } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);

    const lines = Array.from({ length: 3000 }, (_, i) => (i === 1500 ? "NEEDLE" : `line-${i}`.padEnd(20, ".")));
    const big = lines.join("\n");
    assert.ok(Buffer.byteLength(big, "utf8") > DEFAULT_MAX_BYTES, "fixture must exceed the 50KB threshold");
    const res = await handler(customResult({ toolCallId: "tc-grep", content: [{ type: "text", text: big }] }), ctx);
    const handle = res.details.externalised.handle as string;

    const expand = tools.get("expand_result")!;
    const out = await expand.execute("tc-x", { handle, grep: "NEEDLE" }, undefined, undefined, ctx);
    const text = (out.content[0] as { text: string }).text;
    assert.match(text, /NEEDLE/);
    assert.match(text, /line-1499/);
    assert.match(text, /line-1501/);
  });

  it("expand_result throws on an unknown handle (signals error by throwing, not isError)", async () => {
    const { pi, tools } = fakePi();
    registerBigResults(pi);
    const ctx = fakeCtx(sessionId);
    const expand = tools.get("expand_result")!;
    await assert.rejects(
      () => expand.execute("tc-x", { handle: "does-not-exist" }, undefined, undefined, ctx),
      /no externalised result "does-not-exist"/,
    );
  });

  it("survives across the tool_result handler and a fresh expand_result call (K4 in spirit: the handle is not held in memory)", async () => {
    const { pi: pi1, handlers } = fakePi();
    registerBigResults(pi1);
    const handler = handlers.get("tool_result")!;
    const ctx = fakeCtx(sessionId);
    const lines = Array.from({ length: 4000 }, (_, i) => `z-line-${i}`.padEnd(20, "."));
    const big = lines.join("\n");
    assert.ok(Buffer.byteLength(big, "utf8") > DEFAULT_MAX_BYTES, "fixture must exceed the 50KB threshold");
    const res = await handler(customResult({ toolCallId: "tc-persist", content: [{ type: "text", text: big }] }), ctx);
    const handle = res.details.externalised.handle as string;

    // A brand-new extension instance (simulating a fresh process / session reload) must still
    // resolve the handle purely from what is on disk — nothing is cached in module state.
    const { pi: pi2, tools } = fakePi();
    registerBigResults(pi2);
    const expand = tools.get("expand_result")!;
    const out = await expand.execute("tc-x", { handle, fromLine: 1, lines: 1 }, undefined, undefined, ctx);
    assert.equal((out.content[0] as { text: string }).text, lines[0]);
  });

  it("does not crash the harness when the scratch root is unwritable — fails open, logs once", async () => {
    const { pi, handlers } = fakePi();
    registerBigResults(pi);
    const handler = handlers.get("tool_result")!;

    const blocker = join(sandbox, `blocker-${sessionId}`);
    await writeFile(blocker, "not a directory");
    process.env.XDG_STATE_HOME = blocker; // stateRoot() will try to mkdir under a file

    const notified: Array<[string, string | undefined]> = [];
    const ctx = fakeCtx(sessionId, { hasUI: true, notify: (m, t) => void notified.push([m, t]) });

    const big = "w".repeat(DEFAULT_MAX_BYTES + 100);
    const res = await handler(customResult({ toolCallId: "tc-fail", content: [{ type: "text", text: big }] }), ctx);
    assert.equal(res, undefined, "must fail open — return no patch rather than throw or corrupt the result");
    assert.equal(notified.length, 1);
    assert.equal(notified[0][1], "error");
  });

  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  });
});

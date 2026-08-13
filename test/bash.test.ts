import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  handleBashToolResult,
  loadTimeoutPolicy,
  timeoutRule,
  type TimeoutPolicy,
} from "../extensions/bash.ts";
import { guardedHandler } from "../extensions/lib/guarded-handler.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";

const POLICY: TimeoutPolicy = {
  defaultTimeoutSeconds: 120,
  ceilingSeconds: 3600,
  minTimeoutSeconds: 1,
  maxLines: 2000,
  maxBytes: 51200,
};

function bashToolCall(timeout?: number): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "tc-1",
    toolName: "bash",
    input: { command: "echo hi", ...(timeout === undefined ? {} : { timeout }) },
  } as ToolCallEvent;
}

function nonBashToolCall(): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "tc-2",
    toolName: "read",
    input: { path: "/tmp/x" },
  } as ToolCallEvent;
}

function bashToolResult(opts: {
  text?: string;
  truncated?: boolean;
  truncatedBy?: "lines" | "bytes" | null;
  fullOutputPath?: string;
  maxLines?: number;
  maxBytes?: number;
}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "tc-1",
    toolName: "bash",
    input: { command: "seq 1 50000" },
    isError: false,
    content: [{ type: "text", text: opts.text ?? "1\n2\n3\n" }],
    details:
      opts.truncated === undefined
        ? undefined
        : {
            fullOutputPath: opts.fullOutputPath,
            truncation: {
              truncated: opts.truncated,
              truncatedBy: opts.truncatedBy ?? "lines",
              maxLines: opts.maxLines ?? 2000,
              maxBytes: opts.maxBytes ?? 51200,
              content: "",
              totalLines: 50000,
              totalBytes: 500000,
              outputLines: 2000,
              outputBytes: 40000,
              lastLinePartial: false,
              firstLineExceedsLimit: false,
            },
          },
  } as unknown as ToolResultEvent;
}

function nonBashToolResult(): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "tc-3",
    toolName: "read",
    input: {},
    isError: false,
    content: [{ type: "text", text: "file contents" }],
    details: undefined,
  } as unknown as ToolResultEvent;
}

describe("loadTimeoutPolicy", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-bash-policy-"));
  });

  async function writeConfig(body: unknown): Promise<void> {
    await mkdir(join(sandbox, "config"), { recursive: true });
    await writeFile(join(sandbox, "config", "bash-timeouts.json"), JSON.stringify(body));
  }

  it("loads the real shipped config with correct units (seconds, not ms)", () => {
    const policy = loadTimeoutPolicy(process.cwd());
    assert.equal(policy.defaultTimeoutSeconds, 120, "must be 120 seconds, not 120000 ms");
    assert.equal(policy.ceilingSeconds, 3600, "must be 3600 seconds (60 min), not 3600000");
    assert.equal(policy.maxLines, 2000);
    assert.equal(policy.maxBytes, 51200);
    assert.ok(policy.ceilingSeconds >= 60 * 60, "REQ-PRV-85: ceiling must be >= 60 min");
  });

  it("throws a named error when the config file is missing", () => {
    assert.throws(() => loadTimeoutPolicy(sandbox), /cannot load timeout policy/);
  });

  it("throws a named error on malformed JSON", async () => {
    await mkdir(join(sandbox, "config"), { recursive: true });
    await writeFile(join(sandbox, "config", "bash-timeouts.json"), "{ not json");
    assert.throws(() => loadTimeoutPolicy(sandbox), /cannot load timeout policy/);
  });

  it("rejects a ceiling below REQ-PRV-85's 60 minute floor", async () => {
    await writeConfig({
      defaultTimeoutSeconds: 120,
      ceilingSeconds: 1800,
      minTimeoutSeconds: 1,
      maxLines: 2000,
      maxBytes: 51200,
    });
    assert.throws(() => loadTimeoutPolicy(sandbox), /below REQ-PRV-85's floor/);
  });

  it("rejects a default that exceeds the ceiling", async () => {
    await writeConfig({
      defaultTimeoutSeconds: 7200,
      ceilingSeconds: 3600,
      minTimeoutSeconds: 1,
      maxLines: 2000,
      maxBytes: 51200,
    });
    assert.throws(() => loadTimeoutPolicy(sandbox), /exceeds ceilingSeconds/);
  });

  it("rejects a non-positive field", async () => {
    await writeConfig({
      defaultTimeoutSeconds: 120,
      ceilingSeconds: 3600,
      minTimeoutSeconds: 1,
      maxLines: 0,
      maxBytes: 51200,
    });
    assert.throws(() => loadTimeoutPolicy(sandbox), /must be a positive finite number/);
  });
});

describe("timeoutRule", () => {
  const rule = timeoutRule(POLICY);

  it("injects the default when timeout is absent (undefined)", () => {
    const event = bashToolCall(undefined);
    rule.evaluate(event, {} as never);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 120);
  });

  it("leaves an in-range explicit timeout untouched", () => {
    const event = bashToolCall(45);
    rule.evaluate(event, {} as never);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 45);
  });

  it("clamps a huge explicit timeout to the ceiling — 3600 s, not 3_600_000", () => {
    const event = bashToolCall(99_999_999);
    rule.evaluate(event, {} as never);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 3600);
  });

  it("floors a degenerate timeout (zero)", () => {
    const event = bashToolCall(0);
    rule.evaluate(event, {} as never);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 1);
  });

  it("floors a negative timeout", () => {
    const event = bashToolCall(-5);
    rule.evaluate(event, {} as never);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 1);
  });

  it("floors a NaN timeout", () => {
    const event = bashToolCall(Number.NaN);
    rule.evaluate(event, {} as never);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 1);
  });

  it("leaves a non-bash tool_call event untouched", () => {
    const event = nonBashToolCall();
    const before = JSON.stringify(event);
    rule.evaluate(event, {} as never);
    assert.equal(JSON.stringify(event), before);
  });

  it("composes order-independently with a package that only fills an absent default", () => {
    // Simulates @mrclrchtr/supi-bash-timeout's own handler: "if undefined, set to 120".
    const packageInject = (e: ToolCallEvent) => {
      const input = (e as { input: { timeout?: number } }).input;
      if (input.timeout === undefined) input.timeout = 120;
    };

    // Order A: package runs first, our rule runs second — our default branch becomes a no-op.
    const a = bashToolCall(undefined);
    packageInject(a);
    rule.evaluate(a, {} as never);
    assert.equal((a as { input: { timeout?: number } }).input.timeout, 120);

    // Order B: our rule runs first, package runs second — the package's own guard makes IT
    // the no-op, because `timeout` is already defined by the time it looks.
    const b = bashToolCall(undefined);
    rule.evaluate(b, {} as never);
    packageInject(b);
    assert.equal((b as { input: { timeout?: number } }).input.timeout, 120);
  });
});

describe("timeoutRule via guardedHandler (fail-open contract)", () => {
  beforeEach(() => resetSurfaced());

  it("never blocks bash — mutation only, block is EXT-03's job", async () => {
    const handler = guardedHandler({ owner: "bash", rules: [timeoutRule(POLICY)] });
    const event = bashToolCall(undefined);
    const result = await handler(event, { hasUI: false } as never);
    assert.equal(result, undefined);
    assert.equal((event as { input: { timeout?: number } }).input.timeout, 120);
  });

  it("a broken rule fails OPEN — the tool call proceeds unmodified, not blocked", async () => {
    // A policy with a NaN field makes the arithmetic below throw inside evaluate().
    const brokenPolicy = { ...POLICY, ceilingSeconds: undefined } as unknown as TimeoutPolicy;
    const handler = guardedHandler({
      owner: "bash",
      rules: [
        {
          id: "BASH-TIMEOUT",
          evaluate() {
            // Force a throw the same way a real bug would: read a property of `undefined`.
            const boom = (brokenPolicy as { ceilingSeconds: { toFixed(): string } }).ceilingSeconds.toFixed();
            return boom ? undefined : undefined;
          },
        },
      ],
    });
    const event = bashToolCall(99_999_999);
    const result = await handler(event, { hasUI: false } as never);
    assert.equal(result, undefined, "REQ-EXT-16: an internal error must not block the tool call");
    assert.equal(
      (event as { input: { timeout?: number } }).input.timeout,
      99_999_999,
      "unmodified — the broken rule never got to mutate it",
    );
  });
});

describe("handleBashToolResult", () => {
  it("returns undefined for a non-bash tool_result", () => {
    assert.equal(handleBashToolResult(nonBashToolResult(), POLICY), undefined);
  });

  it("returns undefined when the result was not truncated", () => {
    const event = bashToolResult({ truncated: false });
    assert.equal(handleBashToolResult(event, POLICY), undefined);
  });

  it("returns undefined when truncated but fullOutputPath is missing", () => {
    const event = bashToolResult({ truncated: true, fullOutputPath: undefined });
    assert.equal(handleBashToolResult(event, POLICY), undefined);
  });

  it("appends a tail-retrieval hint naming the boundary and the path, using PI's own actual numbers", () => {
    const event = bashToolResult({
      truncated: true,
      truncatedBy: "lines",
      fullOutputPath: "/tmp/pi-bash-overflow-abc123.txt",
      maxLines: 2000,
      maxBytes: 51200,
    });
    const result = handleBashToolResult(event, POLICY);
    assert.ok(result, "expected a hint result");
    const text = (result!.content[0] as { text: string }).text;
    assert.match(text, /truncated at 2000 lines \/ 51200 bytes/);
    assert.match(text, /limit hit: lines/);
    assert.match(text, /\/tmp\/pi-bash-overflow-abc123\.txt/);
    assert.match(text, /tail -n 200 \/tmp\/pi-bash-overflow-abc123\.txt/);
    assert.match(text, /do NOT re-run the command/);
  });

  it("prefers the live truncation numbers over the static policy when they differ", () => {
    const event = bashToolResult({
      truncated: true,
      truncatedBy: "bytes",
      fullOutputPath: "/tmp/x.txt",
      maxLines: 500,
      maxBytes: 10240,
    });
    const result = handleBashToolResult(event, POLICY);
    const text = (result!.content[0] as { text: string }).text;
    assert.match(text, /truncated at 500 lines \/ 10240 bytes/);
    assert.doesNotMatch(text, /2000 lines/);
  });

  it("appends to the LAST text block and preserves earlier content items", () => {
    const event = bashToolResult({ truncated: true, fullOutputPath: "/tmp/x.txt" });
    (event as { content: unknown[] }).content = [
      { type: "text", text: "first block" },
      { type: "text", text: "second block" },
    ];
    const result = handleBashToolResult(event, POLICY);
    const content = result!.content as { type: string; text: string }[];
    assert.equal(content.length, 2);
    assert.equal(content[0].text, "first block");
    assert.match(content[1].text, /^second block\n\[Output was truncated/);
  });

  it("does not mutate the original event's content array (returns a copy)", () => {
    const event = bashToolResult({ truncated: true, fullOutputPath: "/tmp/x.txt" });
    const originalText = (event.content[0] as { text: string }).text;
    handleBashToolResult(event, POLICY);
    assert.equal((event.content[0] as { text: string }).text, originalText);
  });
});

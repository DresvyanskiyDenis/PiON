import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type {
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { guardedHandler, type GuardRule } from "../../extensions/lib/guarded-handler.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

interface FakeCtx {
  ctx: ExtensionContext;
  notified: Array<[string, string | undefined]>;
}

function fakeCtx(hasUI = true, notify?: () => void): FakeCtx {
  const notified: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI,
    mode: hasUI ? "tui" : "print",
    ui: {
      notify(message: string, type?: string) {
        notified.push([message, type]);
        notify?.();
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notified };
}

function bashEvent(command = "echo hi"): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-1", toolName: "bash", input: { command } } as ToolCallEvent;
}

const collect = (lines: string[]) => (line: string) => void lines.push(line);

describe("guardedHandler", () => {
  beforeEach(() => resetSurfaced());

  it("is assignable to PI's tool_call handler type", () => {
    const handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult> = guardedHandler({
      owner: "guard",
      rules: [],
    });
    assert.equal(typeof handler, "function");
  });

  it("match blocks, short-circuits, and never evaluates later rules", async () => {
    const seen: string[] = [];
    const rules: GuardRule[] = [
      { id: "R-PASS", evaluate: () => { seen.push("R-PASS"); return { block: false }; } },
      { id: "R-BLOCK", evaluate: () => { seen.push("R-BLOCK"); return { block: true, reason: "nope" }; } },
      { id: "R-NEVER", evaluate: () => { seen.push("R-NEVER"); return undefined; } },
    ];
    const lines: string[] = [];
    const { ctx } = fakeCtx();
    const res = await guardedHandler({ owner: "guard", rules, log: collect(lines) })(bashEvent(), ctx);

    assert.deepEqual(res, { block: true, reason: "nope" });
    assert.deepEqual(seen, ["R-PASS", "R-BLOCK"]);
    assert.deepEqual(lines, []);
  });

  it("a throwing rule does NOT block — the REQ-EXT-16 inversion", async () => {
    const lines: string[] = [];
    // fakeCtx() defaults to hasUI:true, so per `lib/announce.ts` the surfacing goes through
    // `ctx.ui.notify`, not the log sink — see `notified` below.
    const { ctx, notified } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      rules: [{ id: "R-BOOM", evaluate: () => { throw new Error("kaboom"); } }],
      log: collect(lines),
    })(bashEvent(), ctx);

    assert.equal(res, undefined);
    assert.equal(lines.length, 0, "hasUI:true routes through ctx.ui.notify, not the log sink");
    assert.equal(notified.length, 1);
    assert.match(notified[0][0], /guard: rule R-BOOM failed internally and was skipped/);
    assert.match(notified[0][0], /Error: kaboom/);
  });

  it("a throwing rule is skipped, and later rules still run", async () => {
    const { ctx } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      rules: [
        { id: "R-BOOM", evaluate: () => { throw new Error("kaboom"); } },
        { id: "R-BLOCK", evaluate: () => ({ block: true, reason: "second rule still works" }) },
      ],
      log: () => {},
    })(bashEvent(), ctx);

    assert.deepEqual(res, { block: true, reason: "second rule still works" });
  });

  it("surfaces the same internal error exactly once across five calls", async () => {
    const lines: string[] = [];
    const { ctx, notified } = fakeCtx(true);
    const handler = guardedHandler({
      owner: "guard",
      rules: [{ id: "R-BOOM", evaluate: () => { throw new Error("kaboom"); } }],
      log: collect(lines),
    });
    for (let i = 0; i < 5; i++) assert.equal(await handler(bashEvent(), ctx), undefined);

    assert.equal(notified.length, 1, "ctx.ui.notify must fire exactly once");
    assert.equal(notified[0][1], "error");
    assert.equal(lines.length, 0, "hasUI:true means the log sink must NOT also fire — one channel");
  });

  it("still logs when there is no UI (-p / --mode json)", async () => {
    const lines: string[] = [];
    const { ctx, notified } = fakeCtx(false);
    await guardedHandler({
      owner: "guard",
      rules: [{ id: "R-BOOM", evaluate: () => { throw new Error("kaboom"); } }],
      log: collect(lines),
    })(bashEvent(), ctx);

    assert.equal(notified.length, 0, "ctx.ui.notify is a no-op without a UI, so it is not called");
    assert.equal(lines.length, 1, "the log half of REQ-EXT-16 must still fire");
  });

  it('onInternalError "closed" turns an internal error into a refusal', async () => {
    const { ctx } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      rules: [{ id: "R-BOOM", evaluate: () => { throw new Error("kaboom"); } }],
      onInternalError: "closed",
      log: () => {},
    })(bashEvent(), ctx);

    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", /guard unavailable \(internal error\)/);
    assert.match(res?.reason ?? "", /^R-BOOM: /);
  });

  it("a notify that throws does not turn fail-open into fail-closed", async () => {
    const lines: string[] = [];
    const { ctx } = fakeCtx(true, () => { throw new Error("no tty"); });
    const res = await guardedHandler({
      owner: "guard",
      rules: [{ id: "R-BOOM", evaluate: () => { throw new Error("kaboom"); } }],
      log: collect(lines),
    })(bashEvent(), ctx);

    assert.equal(res, undefined, "a broken notifier must not block the tool");
  });

  it("audits a block with rule id, tool name and reason", async () => {
    const entries: Array<[string, unknown]> = [];
    const { ctx } = fakeCtx();
    await guardedHandler({
      owner: "guard",
      rules: [{ id: "DB-RM-ROOT", evaluate: () => ({ block: true, reason: "rm -rf /" }) }],
      audit: (customType, data) => void entries.push([customType, data]),
    })(bashEvent("rm -rf /"), ctx);

    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], "guard.block");
    const data = entries[0][1] as Record<string, unknown>;
    assert.equal(data.ruleId, "DB-RM-ROOT");
    assert.equal(data.toolName, "bash");
    assert.equal(data.toolCallId, "tc-1");
    assert.equal(data.reason, "rm -rf /");
    assert.equal(typeof data.at, "number");
  });

  it("an audit sink that throws does not un-block a matched rule", async () => {
    const lines: string[] = [];
    const { ctx, notified } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      rules: [{ id: "DB-RM-ROOT", evaluate: () => ({ block: true, reason: "rm -rf /" }) }],
      audit: () => { throw new Error("session is read-only"); },
      log: collect(lines),
    })(bashEvent("rm -rf /"), ctx);

    assert.deepEqual(res, { block: true, reason: "rm -rf /" });
    assert.equal(lines.length, 0, "hasUI:true routes the surfacing through ctx.ui.notify");
    assert.equal(notified.length, 1);
    assert.match(notified[0][0], /DB-RM-ROOT#audit/);
  });

  it("an async rejecting rule is treated exactly like a throwing one", async () => {
    const { ctx } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      rules: [{ id: "R-REJECT", evaluate: async () => { throw new Error("async boom"); } }],
      log: () => {},
    })(bashEvent(), ctx);
    assert.equal(res, undefined);
  });

  it("an empty rule set is a no-op", async () => {
    const { ctx } = fakeCtx();
    assert.equal(await guardedHandler({ owner: "guard", rules: [] })(bashEvent(), ctx), undefined);
  });

  it("F2: a rule's own onInternalError=closed wins even though the handler default is open", async () => {
    const { ctx } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      // No `onInternalError` here, so the handler-level default ("open") is in force.
      rules: [{ id: "SEC", onInternalError: "closed", evaluate: () => { throw new Error("kaboom"); } }],
      log: () => {},
    })(bashEvent(), ctx);

    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", /^SEC: guard unavailable \(internal error\)/);
  });

  it("F2: a rule without its own onInternalError still falls back to the handler default", async () => {
    const { ctx } = fakeCtx();
    const res = await guardedHandler({
      owner: "guard",
      onInternalError: "closed",
      rules: [{ id: "RTE", evaluate: () => { throw new Error("kaboom"); } }],
      log: () => {},
    })(bashEvent(), ctx);

    assert.equal(res?.block, true, "an unset per-rule onInternalError must not silently become open");
  });

  it("F2: alwaysSurfaceInternalErrors bypasses surfaceOnce's dedup across repeated calls", async () => {
    const lines: string[] = [];
    const { ctx, notified } = fakeCtx();
    const handler = guardedHandler({
      owner: "guard",
      alwaysSurfaceInternalErrors: true,
      rules: [{ id: "SEC", onInternalError: "closed", evaluate: () => { throw new Error("kaboom"); } }],
      log: collect(lines),
    });

    const first = await handler(bashEvent(), ctx);
    const second = await handler(bashEvent(), ctx);
    assert.equal(first?.block, true);
    assert.equal(second?.block, true, "the second occurrence must keep failing closed, not open");
    assert.equal(lines.length, 0, "hasUI:true routes the surfacing through ctx.ui.notify");
    assert.equal(notified.length, 2, "both occurrences must be surfaced — not deduped to one");
  });

  it("F2: without the flag, the same repeating error is still deduped to one log line", async () => {
    const lines: string[] = [];
    const { ctx, notified } = fakeCtx();
    const handler = guardedHandler({
      owner: "guard",
      rules: [{ id: "SEC", evaluate: () => { throw new Error("kaboom"); } }],
      log: collect(lines),
    });

    await handler(bashEvent(), ctx);
    await handler(bashEvent(), ctx);
    assert.equal(lines.length, 0, "hasUI:true routes the surfacing through ctx.ui.notify");
    assert.equal(notified.length, 1, "default behaviour is unchanged: dedup still applies");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatElapsed, register, TICK_MS, toolPhase, workingMessage } from "../extensions/loader-clock.ts";

type Recorded = string | undefined;

/** A fake `pi` + `ctx` pair that records every `setWorkingMessage` call, in order. */
function harness(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const calls: Recorded[] = [];
  const pi = {
    on: (event: string, handler: (e: unknown, c: ExtensionContext) => void) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      setWorkingMessage: (message?: string) => {
        calls.push(message);
      },
    },
  } as unknown as ExtensionContext;

  const fire = (event: string, payload: unknown = {}) => {
    const handler = handlers.get(event);
    assert.ok(handler, `no handler registered for ${event}`);
    handler(payload, ctx);
  };
  return { pi, ctx, calls, fire, handlers };
}

/** Counts intervals created and still open, by wrapping the globals for the duration of `body`. */
function withTimerAudit(body: () => void): { created: number; live: number } {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const open = new Set<unknown>();
  let created = 0;
  (globalThis as { setInterval: unknown }).setInterval = (...args: unknown[]) => {
    created += 1;
    const handle = (realSet as (...a: unknown[]) => unknown)(...args);
    open.add(handle);
    return handle;
  };
  (globalThis as { clearInterval: unknown }).clearInterval = (handle: unknown) => {
    open.delete(handle);
    return (realClear as (h: unknown) => unknown)(handle);
  };
  try {
    body();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    for (const handle of open) realClear(handle as ReturnType<typeof setInterval>);
  }
  return { created, live: open.size };
}

describe("loader-clock: formatting", () => {
  it("matches the worked examples the module header describes", () => {
    assert.equal(workingMessage(0, "streaming", 2 * 60_000 + 14_000), "Working… 2m14s · streaming");
    assert.equal(workingMessage(0, toolPhase("read"), 18_000), "Working… 18s · tool: read");
  });

  it("never goes negative when the clock reads before the recorded start", () => {
    assert.equal(workingMessage(10_000, "streaming", 9_000), "Working… 0s · streaming");
  });

  it("shows minutes only once there are any", () => {
    assert.equal(formatElapsed(41_000), "41s");
    assert.equal(formatElapsed(2 * 60_000 + 3_000), "2m03s");
  });

  it("ticks once a second", () => {
    assert.equal(TICK_MS, 1_000);
  });
});

describe("loader-clock: register", () => {
  it("shows the phase and elapsed time from turn_start, and updates it when a tool opens", () => {
    const { pi, calls, fire } = harness();
    register(pi);

    // `timestamp` is wall-clock, the way `TurnStartEvent` carries it — a recent `Date.now()`, not
    // an offset from zero, so the elapsed figure `paint()` computes against the real clock stays
    // at "0s" for the length of this test.
    fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    assert.match(calls[0]!, /^Working… 0s · streaming$/);

    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    assert.equal(calls.at(-1), "Working… 0s · tool: read");

    fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: false });
    assert.equal(calls.at(-1), "Working… 0s · streaming");
  });

  it("restores the default message at turn_end", () => {
    const { pi, calls, fire } = harness();
    register(pi);
    fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
    assert.equal(calls.at(-1), undefined, "the loader text outlived the turn it described");
  });

  it("ignores a tool event outside any turn — nothing to attach the phase to", () => {
    const { pi, calls, fire } = harness();
    register(pi);
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    assert.deepEqual(calls, []);
  });

  it("is a no-op outside the TUI, where there is no loader to configure", () => {
    for (const mode of ["rpc", "print", "json"] as const) {
      const { pi, calls, fire } = harness(mode);
      register(pi);
      fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
      fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
      fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      assert.deepEqual(calls, [], `${mode} mode touched the loader message`);
    }
  });

  it("hands the loader back at session_shutdown", () => {
    const { pi, calls, fire } = harness();
    register(pi);
    fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    assert.equal(calls.at(-1), undefined, "custom text outlived the module that set it");
  });

  it("starts exactly one ticker per open turn, and none while idle", () => {
    const audit = withTimerAudit(() => {
      const { pi, fire } = harness();
      register(pi);
      fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
      fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
    });
    assert.equal(audit.created, 1, "a turn did not start its own ticker");
    assert.equal(audit.live, 0, "turn_end left the ticker running");
  });

  it("stops the ticker at session_shutdown even mid-turn", () => {
    const audit = withTimerAudit(() => {
      const { pi, fire } = harness();
      register(pi);
      fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    });
    assert.equal(audit.live, 0, "the ticker outlived the session");
  });

  it("does not start a second ticker outside the TUI", () => {
    const audit = withTimerAudit(() => {
      const { pi, fire } = harness("rpc");
      register(pi);
      fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    });
    assert.equal(audit.created, 0, "rpc mode started a ticker with no loader to repaint");
  });

  it("resets stale turn state at session_start, so a replaced session starts clean", () => {
    const { pi, calls, fire } = harness();
    register(pi);
    fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    fire("session_start", { type: "session_start", reason: "resume" });
    calls.length = 0;
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    assert.deepEqual(calls, [], "a tool event from the old turn still moved the new session's loader");
  });

  it("survives a ui that throws, leaving the default loader rather than the session", () => {
    const { pi, ctx, fire } = harness();
    (ctx.ui as { setWorkingMessage: unknown }).setWorkingMessage = () => {
      throw new Error("no loader");
    };
    register(pi);
    assert.doesNotThrow(() => fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }));
    assert.doesNotThrow(() => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }));
  });
});

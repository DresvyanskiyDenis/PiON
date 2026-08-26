import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { injectContext, MARK_OPEN } from "../../extensions/path-rules/context.ts";

type Message = ContextEvent["messages"][number];

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: 0 } as Message;
}

function assistantMsg(): Message {
  return {
    role: "assistant",
    content: [],
    api: "messages",
    provider: "anthropic",
    model: "test",
    usage: {},
    stopReason: "stop",
    timestamp: 0,
  } as unknown as Message;
}

function countMarked(messages: readonly Message[]): number {
  return messages.filter((m) => m.role === "user" && String((m as { content: unknown }).content).includes(MARK_OPEN)).length;
}

describe("injectContext — tail-append only", () => {
  it("appends exactly one new message at the very end", () => {
    const base = [userMsg("hello"), assistantMsg()];
    const out = injectContext(base, "rule text");
    assert.equal(out.length, 3);
    assert.deepEqual(out.slice(0, 2), base);
    assert.equal(out[2]!.role, "user");
    assert.ok(String((out[2] as { content: unknown }).content).includes("rule text"));
  });

  it("never inserts mid-array — the base messages are untouched, not just unchanged in content", () => {
    const base = [userMsg("a"), assistantMsg(), userMsg("b")];
    const out = injectContext(base, "note");
    assert.deepEqual(out.slice(0, base.length), base);
  });
});

describe("injectContext — idempotency across N firings within one turn", () => {
  it("N calls against the SAME base messages each produce exactly one copy of the block", () => {
    const base = [userMsg("hello"), assistantMsg()];
    for (let i = 0; i < 5; i++) {
      const out = injectContext(base, "rule text");
      assert.equal(countMarked(out), 1);
    }
  });

  it("chaining outputs (as if a harness DID persist the injection) still yields exactly one copy", () => {
    let messages = [userMsg("hello")];
    for (let i = 0; i < 4; i++) {
      messages = injectContext(messages, `rule text v${i}`);
    }
    assert.equal(countMarked(messages), 1);
    assert.ok(String((messages.at(-1) as { content: unknown }).content).includes("rule text v3"));
    assert.equal(String((messages.at(-1) as { content: unknown }).content).includes("rule text v0"), false);
  });
});

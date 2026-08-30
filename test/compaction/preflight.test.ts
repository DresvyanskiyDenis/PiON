// EXT-14 — the context-window preflight (`extensions/compaction/preflight.ts` + its wiring).
//
// The incident it exists for (2026-08-30): a request billed ~273 000 tokens against a model whose
// window this harness declares as 200 000. The provider did not refuse it — it answered 200 with an
// empty body, which is the `empty-response` class, which killed the turn. Every number needed to
// stop that was in this process before the request was assembled.
//
// Two things are asserted here and they are different in kind:
//   * the verdict function is arithmetic, so it is tested as arithmetic — including the boundary,
//     where a false refusal costs a turn that would have worked;
//   * the wiring is the claim that matters — an over-window payload must abort instead of being
//     sent, must not be filed as a `provider_failure`, and must never fire in the band where PI's
//     own autocompact is already responsible.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __resetForTests, register } from "../../extensions/compaction/index.ts";
import {
  CHARS_PER_TOKEN,
  estimatePromptTokens,
  MAX_CONSECUTIVE_REFUSALS,
  OVER_WINDOW_TOLERANCE,
  overWindowBar,
  passedAnywayLine,
  preflightVerdict,
  refusalLine,
} from "../../extensions/compaction/preflight.ts";

const WINDOW = 200_000;
const BAR = Math.round(WINDOW * OVER_WINDOW_TOLERANCE);

describe("estimatePromptTokens", () => {
  it("counts the string leaves and nothing else", () => {
    // Not `JSON.stringify(payload).length`: keys, braces, quotes and escapes are structure the
    // tokenizer upstream never sees, and on a body of thousands of small message objects that
    // overhead alone is tens of thousands of phantom tokens.
    const text = "x".repeat(700);
    assert.equal(estimatePromptTokens({ messages: [{ role: "user", content: [{ type: "text", text }] }] }),
      Math.round((700 + "user".length + "text".length) / CHARS_PER_TOKEN));
  });

  it("survives every payload shape it might be handed", () => {
    // `BeforeProviderRequestEvent.payload` is `unknown` and its shape differs per API. A preflight
    // that threw on an unfamiliar body would break every request instead of the over-window ones.
    const cyclic: Record<string, unknown> = { a: "abcd" };
    cyclic.self = cyclic;
    assert.equal(estimatePromptTokens(cyclic), Math.round(4 / CHARS_PER_TOKEN)); // keys are not values
    for (const payload of [undefined, null, 42, true, [], {}, [[["a"]]]]) {
      assert.equal(typeof estimatePromptTokens(payload), "number");
    }
  });
});

describe("preflightVerdict", () => {
  it("sends anything at or below the bar — including a prompt that fills the window", () => {
    // The band between `contextWindow` and the bar belongs to PI's own autocompact, which triggers
    // at `contextTokens > contextWindow - reserveTokens`, i.e. strictly BELOW the window. Refusing
    // here would pre-empt a compaction that was already going to happen and spend a turn for it.
    for (const estimatedTokens of [0, WINDOW - 20_000, WINDOW, BAR]) {
      assert.equal(preflightVerdict({ estimatedTokens, contextWindow: WINDOW, refusalsSoFar: 0 }), "send");
    }
    assert.equal(preflightVerdict({ estimatedTokens: BAR + 1, contextWindow: WINDOW, refusalsSoFar: 0 }), "refuse");
  });

  it("refuses the observed incident with room to spare", () => {
    assert.equal(preflightVerdict({ estimatedTokens: 273_110, contextWindow: WINDOW, refusalsSoFar: 0 }), "refuse");
  });

  it("sends when the harness has no window to compare against", () => {
    // Refusing on a number this harness does not have would be the same silent substitution the
    // repo refuses everywhere else, with the harness playing the provider's part.
    for (const contextWindow of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(preflightVerdict({ estimatedTokens: 10_000_000, contextWindow, refusalsSoFar: 0 }), "send");
      assert.equal(overWindowBar(contextWindow), undefined);
    }
  });

  it("stands down after two refusals rather than looping in silence", () => {
    const over = { estimatedTokens: 400_000, contextWindow: WINDOW };
    assert.equal(preflightVerdict({ ...over, refusalsSoFar: MAX_CONSECUTIVE_REFUSALS - 1 }), "refuse");
    assert.equal(preflightVerdict({ ...over, refusalsSoFar: MAX_CONSECUTIVE_REFUSALS }), "over-but-passed");
  });
});

describe("what the operator is told", () => {
  const facts = { estimatedTokens: 273_110, contextWindow: WINDOW, model: "litellm/gpt-5.6-luna" };

  it("names the harness's own estimate as an estimate, and says what happens next", () => {
    const line = refusalLine(facts);
    assert.match(line, /refused/);
    assert.match(line, /273110/);
    assert.match(line, /200000-token window/);
    assert.match(line, /37% over/);
    assert.match(line, /estimate is chars\/3\.5/);
    assert.match(line, /Nothing was sent/);
    assert.match(line, /Compaction runs next/);
  });

  it("says why it gave up refusing, and what the operator has to do instead", () => {
    const line = passedAnywayLine(facts);
    assert.match(line, /after 2 refusals/);
    assert.match(line, /\/compact/);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * The wiring: an over-window request must not reach the provider
 * ------------------------------------------------------------------------------------------- */

type Handler = (event: any, ctx: any) => unknown;

function harness() {
  __resetForTests();
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ customType: string; data: any }> = [];
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType: string, data: any) => void entries.push({ customType, data }),
    sendMessage: () => {},
    registerCommand: () => {},
    registerTool: () => {},
  };
  register(pi as any);
  const aborts: number[] = [];
  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (text: string, level: string) => void notices.push({ text, level }), setStatus: () => {} },
    sessionManager: { getSessionId: () => "session-1" },
    model: { provider: "litellm", id: "gpt-5.6-luna", contextWindow: WINDOW },
    abort: () => void aborts.push(1),
  };
  const request = (tokens: number, over: Partial<typeof ctx> = {}) =>
    (handlers.get("before_provider_request") ?? []).map((h) =>
      h({ payload: { messages: [{ text: "x".repeat(Math.round(tokens * CHARS_PER_TOKEN)) }] } }, { ...ctx, ...over }));
  return { entries, aborts, notices, request };
}

describe("before_provider_request", () => {
  it("aborts an over-window request instead of sending it, and records the decision first", () => {
    const h = harness();
    h.request(300_000);
    assert.equal(h.aborts.length, 1, "the request must not be issued");
    assert.deepEqual(h.entries.map((e) => e.customType), ["context_preflight"]);
    assert.equal(h.entries[0]?.data.decision, "refused");
    assert.equal(h.entries[0]?.data.model, "litellm/gpt-5.6-luna");
    assert.match(h.notices[0]?.text ?? "", /^\[pi-config] compaction: refused a request/);
  });

  it("files the refusal as a harness decision, never as a provider failure", () => {
    // H9's whole complaint is that the `provider_failure` channel filled with events no provider
    // caused. A refusal that landed there would be the same bug from the other end — and worse,
    // it would be a `provider_failure` for a request that was never made.
    const h = harness();
    h.request(300_000);
    assert.equal(h.entries.some((e) => e.customType.startsWith("provider_")), false);
    assert.equal((h.notices[0]?.text ?? "").includes("provider call failed"), false);
  });

  it("leaves a request that merely fills the window entirely alone", () => {
    const h = harness();
    h.request(WINDOW);
    assert.deepEqual(h.aborts, []);
    assert.deepEqual(h.entries, []);
    assert.deepEqual(h.notices, []);
  });

  it("gives up after two refusals and lets the third through, loudly", () => {
    const h = harness();
    h.request(300_000);
    h.request(300_000);
    assert.equal(h.aborts.length, 2);
    h.request(300_000);
    assert.equal(h.aborts.length, 2, "the third is sent");
    assert.equal(h.entries.at(-1)?.data.decision, "passed-anyway");
    assert.equal(h.notices.at(-1)?.level, "error");
  });

  it("clears the streak on the first request that fits", () => {
    const h = harness();
    h.request(300_000);
    h.request(WINDOW);
    h.request(300_000);
    h.request(300_000);
    assert.equal(h.aborts.length, 3, "a compacted context restores the full budget");
  });

  it("fails open — a broken preflight costs a preflight, not the session", () => {
    const h = harness();
    h.request(300_000, { model: { get contextWindow(): number { throw new Error("boom"); } } as any });
    assert.deepEqual(h.aborts, []);
    assert.match(h.notices[0]?.text ?? "", /preflight failed internally and was skipped: .*boom/);
  });
});

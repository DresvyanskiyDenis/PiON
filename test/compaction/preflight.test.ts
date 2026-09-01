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
  IMAGE_TOKEN_ESTIMATE,
  MAX_CONSECUTIVE_REFUSALS,
  OVER_WINDOW_TOLERANCE,
  overWindowBar,
  passedAnywayLine,
  preflightVerdict,
  refusalLine,
  SELF_RESUME_MARKER,
  selfResumeLine,
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

  // A 1045558-character base64 PNG estimated at ~757474 tokens against a request the provider
  // actually billed at 113874 — a 6.8x error entirely attributable to charging the image's base64
  // payload at chars/CHARS_PER_TOKEN like prose.
  it("charges an Anthropic-shaped image block at the flat estimate, not its base64 length", () => {
    const megabyteOfBase64 = "A".repeat(1_045_558);
    const payload = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: megabyteOfBase64 } }],
        },
      ],
    };
    // The image block is skipped entirely (not even its own "type"/"source" text is walked); only
    // the sibling "role": "user" text outside the block still counts.
    assert.equal(estimatePromptTokens(payload), Math.round("user".length / CHARS_PER_TOKEN) + IMAGE_TOKEN_ESTIMATE);
  });

  it("charges an OpenAI-shaped image_url block at the flat estimate, not its data-URL length", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(1_045_558)}`;
    const payload = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }] };
    assert.equal(estimatePromptTokens(payload), Math.round("user".length / CHARS_PER_TOKEN) + IMAGE_TOKEN_ESTIMATE);
  });

  it("counts every image block in a payload, each at the flat estimate", () => {
    // Three distinct objects, not the same reference three times: the walk's cycle guard dedupes
    // by object identity, so reusing one reference would silently undercount to 1.
    const image = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(9999) } });
    const payload = { messages: [{ content: [image(), image(), image()] }] };
    assert.equal(estimatePromptTokens(payload), 3 * IMAGE_TOKEN_ESTIMATE);
  });

  it('does not mistake an unrelated object that merely has type: "image" for a real block', () => {
    // Structural check, not just the tag: a future or unfamiliar shape reusing the name must fall
    // through to the ordinary text walk rather than silently swallowing real content.
    const payload = { type: "image", caption: "a photo, not pi-ai's wire shape" };
    assert.equal(estimatePromptTokens(payload), Math.round(("image".length + "a photo, not pi-ai's wire shape".length) / CHARS_PER_TOKEN));
  });

  it("excludes the preflight's own self-resume message from the count", () => {
    const resumeText = `${SELF_RESUME_MARKER} Continue the work exactly where it stopped.`;
    const payload = { messages: [{ role: "user", content: resumeText }] };
    // The resume text starts with the marker and contributes 0 chars; only "role": "user" counts.
    assert.equal(estimatePromptTokens(payload), Math.round("user".length / CHARS_PER_TOKEN));
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
    // It used to promise "compaction runs next and the turn continues", which no code did. The
    // promise it makes now is one this module keeps itself, and the operator's cue that the
    // session is not waiting for them is the last four words.
    assert.match(line, /resumes the session itself/);
    assert.match(line, /No keystroke needed\./);
  });

  it("marks the self-resume as the harness talking, and says the turn it interrupts was aborted", () => {
    // The model reads this as a user message, because only the user-message path compacts first.
    // If it read as the operator, it would read as the operator changing their mind mid-task.
    const line = selfResumeLine(facts);
    assert.match(line, /^\[pi-config] Automatic resume, not a human message\./);
    assert.match(line, /never reached the provider/);
    assert.match(line, /no assistant reply/);
    assert.match(line, /Continue the work exactly where it stopped/);
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

function harness(options: { resumeThrows?: boolean } = {}) {
  __resetForTests();
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ customType: string; data: any }> = [];
  const userMessages: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType: string, data: any) => void entries.push({ customType, data }),
    sendMessage: () => {},
    sendUserMessage: (content: string) => {
      if (options.resumeThrows) throw new Error("no session to prompt");
      userMessages.push(content);
    },
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
  // What PI does at the end of every run, refused or not: `_emitAgentSettled()` drops
  // `_isAgentRunActive` and then emits, which is why a handler on it may prompt.
  const settle = (over: Partial<typeof ctx> = {}) =>
    (handlers.get("agent_settled") ?? []).map((h) => h({}, { ...ctx, ...over }));
  return { entries, aborts, notices, userMessages, request, settle };
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

  it("stays stood down: passed-anyway does not rearm the counter", () => {
    // The bug: the `passed-anyway` branch used to `delete` the refusal counter, so the very next
    // over-window request read a fresh streak and paid the full two-refusal toll again — forever,
    // on a session that was never going to fit. The counter must stay latched at the cap until a
    // request actually fits or the session restarts.
    const h = harness();
    h.request(300_000);
    h.request(300_000);
    assert.equal(h.aborts.length, 2);
    h.request(300_000); // 3rd — stands down
    assert.equal(h.aborts.length, 2);
    assert.equal(h.entries.at(-1)?.data.decision, "passed-anyway");
    h.request(300_000); // 4th — must stay stood down, not refuse again
    assert.equal(h.aborts.length, 2, "no new abort: the streak must not reset");
    assert.equal(h.entries.at(-1)?.data.decision, "passed-anyway");
    h.request(300_000); // 5th — same
    assert.equal(h.aborts.length, 2, "no new abort: the streak must not reset");
    assert.equal(h.entries.at(-1)?.data.decision, "passed-anyway");
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

/* ------------------------------------------------------------------------------------------- *
 * The refusal must not leave the session waiting for a keystroke
 * ------------------------------------------------------------------------------------------- */

describe("self-resume after a refusal", () => {
  it("starts the next turn itself, once the aborted run has settled", () => {
    // The bug: every refusal left the session idle for an open-ended stretch, ended by a human
    // typing. `ctx.abort()` stops the doomed request (asserted above) and then stops everything —
    // `_handlePostAgentRun` skips compaction on an aborted message, so nothing follows it.
    const h = harness();
    h.request(300_000);
    assert.deepEqual(h.userMessages, [], "not while the run it aborted is still unwinding");
    h.settle();
    assert.equal(h.userMessages.length, 1, "the session resumes without a human");
    // A user message, not a custom one: only `prompt()` runs the pre-turn compaction check that
    // makes the resumed turn fit. `sendMessage({ triggerTurn: true })` would buy a second refusal.
    assert.match(h.userMessages[0] ?? "", /^\[pi-config] Automatic resume, not a human message\./);
    assert.equal(h.entries.at(-1)?.data.decision, "self-resumed");
    assert.equal(h.entries.at(-1)?.data.refusals, 1);
    assert.equal(h.entries.at(-1)?.data.estimatedTokens, h.entries[0]?.data.estimatedTokens);
  });

  it("resumes once per refusal, not once per settle", () => {
    const h = harness();
    h.request(300_000);
    h.settle();
    h.settle();
    h.settle();
    assert.equal(h.userMessages.length, 1, "a consumed resume is gone");
  });

  it("leaves a run that was never refused alone", () => {
    const h = harness();
    h.request(WINDOW);
    h.settle();
    assert.deepEqual(h.userMessages, []);
    assert.deepEqual(h.entries, []);
  });

  it("converges — the refusal streak bounds the resumes, so the cycle cannot run forever", () => {
    // refuse -> resume -> refuse is a loop unless something ends it. What ends it is the streak
    // this module already kept and could never advance before: the third verdict is
    // `over-but-passed`, which sends, and a sent request needs no resume.
    const h = harness();
    for (let turn = 0; turn < MAX_CONSECUTIVE_REFUSALS; turn += 1) {
      h.request(300_000);
      h.settle();
    }
    assert.equal(h.aborts.length, MAX_CONSECUTIVE_REFUSALS);
    assert.equal(h.userMessages.length, MAX_CONSECUTIVE_REFUSALS);
    h.request(300_000);
    assert.equal(h.aborts.length, MAX_CONSECUTIVE_REFUSALS, "the next one is sent, not refused");
    h.settle();
    assert.equal(h.userMessages.length, MAX_CONSECUTIVE_REFUSALS, "and it queues no further resume");
    assert.equal(h.entries.at(-1)?.data.decision, "passed-anyway");
  });

  it("drops a parked resume when the escape hatch lets a request through", () => {
    // The settles are omitted on purpose: this is the ordering where a refusal parked a resume and
    // the run kept going anyway. Firing it would restart a session that is already answering.
    const h = harness();
    h.request(300_000);
    h.request(300_000);
    h.request(300_000);
    h.settle();
    assert.deepEqual(h.userMessages, []);
  });

  it("fails open into the old behaviour, and says the session is idle", () => {
    // No resume is exactly where this session was before the self-resume — bad, but not worse, and
    // unlike before it is announced instead of looking like the agent thinking.
    const h = harness({ resumeThrows: true });
    h.request(300_000);
    h.settle();
    assert.match(h.notices.at(-1)?.text ?? "", /could not resume the session after an over-window refusal/);
    assert.match(h.notices.at(-1)?.text ?? "", /needs a message to continue/);
    h.settle();
    assert.equal(h.notices.filter((n) => n.text.includes("could not resume")).length, 1, "said once, not per settle");
  });
});

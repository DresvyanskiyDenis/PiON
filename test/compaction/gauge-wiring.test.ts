// Wiring: `register()`'s handlers in `extensions/compaction/index.ts` keep the `ctx-gauge`
// extension status current and attach the parked preflight estimate while one is deferred.
// `gauge.test.ts` covers the pure formatting this reads from; this file covers only which events
// publish it and when.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __resetForTests, register } from "../../extensions/compaction/index.ts";
import { CHARS_PER_TOKEN } from "../../extensions/compaction/preflight.ts";
import { renderGaugeBar } from "../../extensions/compaction/gauge.ts";

const WINDOW = 200_000;
const GAUGE_STATUS_KEY = "ctx-gauge";

type Handler = (event: any, ctx: any) => unknown;

function harness(options: { noModel?: boolean } = {}) {
  __resetForTests();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerCommand: () => {},
    registerTool: () => {},
  };
  register(pi as any);

  const status = new Map<string, string | undefined>();
  let percent: number | null = 0;
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) => void status.set(key, text),
    },
    sessionManager: { getSessionId: () => "session-1" },
    model: { provider: "litellm", id: "gpt-5.6-luna", contextWindow: WINDOW },
    cwd: process.cwd(),
    abort: () => {},
    getContextUsage: () =>
      options.noModel
        ? undefined
        : { tokens: percent === null ? null : Math.round((percent / 100) * WINDOW), contextWindow: WINDOW, percent },
  };

  const fire = (event: string) => (handlers.get(event) ?? []).map((h) => h({}, ctx));
  return {
    status,
    setPercent: (p: number | null) => void (percent = p),
    request: (tokens: number) =>
      (handlers.get("before_provider_request") ?? []).map((h) =>
        h({ payload: { messages: [{ text: "x".repeat(Math.round(tokens * CHARS_PER_TOKEN)) }] } }, ctx)),
    settle: () => fire("agent_settled"),
    turnEnd: () => fire("turn_end"),
    sessionStart: () => fire("session_start"),
  };
}

describe("ctx-gauge status", () => {
  it("is published at session start, same as quota's own forced refresh", () => {
    const h = harness();
    h.setPercent(42);
    h.sessionStart();
    assert.equal(h.status.get(GAUGE_STATUS_KEY), `ctx ${renderGaugeBar(42)} 42%`);
  });

  it("refreshes on turn_end", () => {
    const h = harness();
    h.setPercent(72);
    h.turnEnd();
    assert.equal(h.status.get(GAUGE_STATUS_KEY), `ctx ${renderGaugeBar(72)} 72%`);
  });

  it("shows the preflight estimate next to the gauge the moment a request is refused", () => {
    const h = harness();
    h.setPercent(97);
    h.request(300_000);
    assert.match(
      h.status.get(GAUGE_STATUS_KEY) ?? "",
      new RegExp(`^ctx ${renderGaugeBar(97)} 97%  \\(preflight est\\. \\d+k ⚠\\)$`),
    );
  });

  it("drops the estimate once the session self-resumes — no longer deferred", () => {
    const h = harness();
    h.setPercent(97);
    h.request(300_000);
    h.settle();
    assert.equal(h.status.get(GAUGE_STATUS_KEY), `ctx ${renderGaugeBar(97)} 97%`);
  });

  it("drops the estimate once the escape hatch lets an over-window request through anyway", () => {
    const h = harness();
    h.setPercent(97);
    h.request(300_000);
    h.request(300_000);
    h.request(300_000); // third: MAX_CONSECUTIVE_REFUSALS reached, verdict is "over-but-passed"
    assert.equal(h.status.get(GAUGE_STATUS_KEY), `ctx ${renderGaugeBar(97)} 97%`);
  });

  it("clears the cell instead of rendering a bar when no model is selected yet", () => {
    const h = harness({ noModel: true });
    h.status.set(GAUGE_STATUS_KEY, "stale"); // pretend a stale value survived a model switch
    h.turnEnd();
    assert.equal(h.status.get(GAUGE_STATUS_KEY), undefined);
  });
});

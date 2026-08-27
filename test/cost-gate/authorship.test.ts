/**
 * The gate that ends a session when a model bills tokens nobody priced.
 *
 * Every case here is an injected value: a literal `models.json` object, a literal usage counter,
 * and sinks that record instead of aborting. Nothing reads the real config, nothing touches a
 * provider, and no assertion depends on elapsed time.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  billedTokens,
  classifyModelCost,
  formatCostSubstitution,
  summariseCostSubstitution,
} from "../../extensions/cost-gate/authorship.ts";
import { judgeResponse } from "../../extensions/cost-gate/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

const PRICED = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 };

function modelsJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    providers: {
      gateway: {
        models: [
          { id: "priced-model", cost: PRICED },
          { id: "unpriced-model" },
          { id: "zeroed-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: "half-priced-model", cost: { input: 2 } },
        ],
      },
      builtin: { modelOverrides: { "some-model": { contextWindow: 200000 } } },
      ...overrides,
    },
  };
}

describe("classifyModelCost", () => {
  it("a complete rate table is authored", () => {
    assert.deepEqual(classifyModelCost(modelsJson(), "gateway", "priced-model"), { verdict: "authored" });
  });

  it("an explicit all-zero table is authored — a deliberate zero is not the defect", () => {
    assert.deepEqual(classifyModelCost(modelsJson(), "gateway", "zeroed-model"), { verdict: "authored" });
  });

  it("a missing cost object is substituted, naming all four rates", () => {
    assert.deepEqual(classifyModelCost(modelsJson(), "gateway", "unpriced-model"), {
      verdict: "substituted",
      missing: ["input", "output", "cacheRead", "cacheWrite"],
    });
  });

  it("a partial cost object is substituted, naming only what is missing", () => {
    assert.deepEqual(classifyModelCost(modelsJson(), "gateway", "half-priced-model"), {
      verdict: "substituted",
      missing: ["output", "cacheRead", "cacheWrite"],
    });
  });

  it("a non-numeric rate does not count as declared", () => {
    const raw = { providers: { gateway: { models: [{ id: "m", cost: { input: "2", output: 12, cacheRead: 0.2, cacheWrite: 2 } }] } } };
    assert.deepEqual(classifyModelCost(raw, "gateway", "m"), { verdict: "substituted", missing: ["input"] });
  });

  it("a NaN rate does not count as declared", () => {
    const raw = { providers: { gateway: { models: [{ id: "m", cost: { ...PRICED, output: Number.NaN } }] } } };
    assert.deepEqual(classifyModelCost(raw, "gateway", "m"), { verdict: "substituted", missing: ["output"] });
  });

  for (const [label, raw, provider, model] of [
    ["unparseable config", undefined, "gateway", "unpriced-model"],
    ["a config that is not an object", "{}", "gateway", "unpriced-model"],
    ["a config with no providers", { nope: 1 }, "gateway", "unpriced-model"],
    ["a provider this install never declared", modelsJson(), "anthropic", "claude-opus-5"],
    ["a modelOverrides provider, where cost is not overridable", modelsJson(), "builtin", "some-model"],
    ["a model absent from the declared catalogue", modelsJson(), "gateway", "typo-model"],
  ] as const) {
    it(`has no opinion about ${label}`, () => {
      const verdict = classifyModelCost(raw, provider, model);
      assert.equal(verdict.verdict, "no-opinion");
      assert.ok(verdict.verdict === "no-opinion" && verdict.reason.length > 0, "the reason must say why");
    });
  }
});

describe("billedTokens", () => {
  it("counts the four token buckets", () => {
    assert.equal(billedTokens({ input: 3, output: 5, cacheRead: 7, cacheWrite: 11 }), 26);
  });

  it("is zero for a response that billed nothing", () => {
    assert.equal(billedTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
  });

  it("ignores usage.cost entirely — it is zero by construction in exactly the case being caught", () => {
    assert.equal(billedTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 99 } }), 0);
    assert.equal(billedTokens({ input: 4, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }), 4);
  });

  it("survives a missing or malformed usage object", () => {
    assert.equal(billedTokens(undefined), 0);
    assert.equal(billedTokens(null), 0);
    assert.equal(billedTokens({ input: "many" }), 0);
  });
});

describe("the report", () => {
  const report = {
    provider: "gateway",
    model: "unpriced-model",
    source: "/somewhere/models.json",
    missing: ["input", "output", "cacheRead", "cacheWrite"],
    tokens: 7685,
  } as const;

  it("names provider, model, the file to fix, and the units", () => {
    const block = formatCostSubstitution(report);
    assert.match(block, /provider : gateway/);
    assert.match(block, /model {4}: unpriced-model/);
    assert.match(block, /source {3}: \/somewhere\/models\.json/);
    assert.match(block, /DOLLARS PER MILLION TOKENS/);
  });

  it("says the zeros were substituted rather than authored, in those words", () => {
    // The one conclusion a reader must not draw is that somebody decided this model is free.
    assert.match(formatCostSubstitution(report), /substituted zeros/);
  });

  it("summarises in one line for a UI that has no room for the block", () => {
    const line = summariseCostSubstitution(report);
    assert.ok(!line.includes("\n"));
    assert.match(line, /gateway\/unpriced-model/);
  });
});

describe("judgeResponse", () => {
  beforeEach(() => resetSurfaced());

  interface Recorded {
    readonly logs: string[];
    readonly notices: string[];
    readonly exitCodes: number[];
    aborted: number;
  }

  function harness(hasUI: boolean) {
    const rec: Recorded = { logs: [], notices: [], exitCodes: [], aborted: 0 };
    const ctx = {
      hasUI,
      ui: { notify: (m: string) => void rec.notices.push(m) },
      abort: () => void (rec.aborted += 1),
    } as unknown as Parameters<typeof judgeResponse>[1];
    const sinks = {
      log: (line: string) => void rec.logs.push(line),
      setExitCode: (code: number) => void rec.exitCodes.push(code),
      readModels: () => ({ raw: modelsJson(), source: "/somewhere/models.json" }),
    };
    return { rec, ctx, sinks };
  }

  function response(model: string, usage: unknown, role = "assistant") {
    return { type: "message_end", message: { role, provider: "gateway", model, usage } } as unknown as Parameters<
      typeof judgeResponse
    >[0];
  }

  const billed = { input: 3, output: 5, cacheRead: 0, cacheWrite: 7682 };

  it("fires on the first billed response from an unpriced model", () => {
    const { rec, ctx, sinks } = harness(true);
    assert.equal(judgeResponse(response("unpriced-model", billed), ctx, sinks), true);
    assert.equal(rec.logs.length, 1);
    assert.equal(rec.notices.length, 1);
    assert.equal(rec.aborted, 1);
    assert.match(rec.logs[0] ?? "", /7690 token\(s\)/);
  });

  it("fires once per provider/model, not once per response", () => {
    const { rec, ctx, sinks } = harness(true);
    judgeResponse(response("unpriced-model", billed), ctx, sinks);
    judgeResponse(response("unpriced-model", billed), ctx, sinks);
    assert.equal(rec.aborted, 1);
  });

  it("fires again for a second unpriced model — that is a second undeclared price", () => {
    const { rec, ctx, sinks } = harness(true);
    judgeResponse(response("unpriced-model", billed), ctx, sinks);
    judgeResponse(response("half-priced-model", billed), ctx, sinks);
    assert.equal(rec.aborted, 2);
  });

  it("stays silent for a priced model", () => {
    const { rec, ctx, sinks } = harness(true);
    assert.equal(judgeResponse(response("priced-model", billed), ctx, sinks), false);
    assert.deepEqual(rec.logs, []);
    assert.equal(rec.aborted, 0);
  });

  it("stays silent for a deliberately zeroed model, forever", () => {
    const { rec, ctx, sinks } = harness(true);
    judgeResponse(response("zeroed-model", billed), ctx, sinks);
    judgeResponse(response("zeroed-model", billed), ctx, sinks);
    assert.deepEqual(rec.logs, []);
    assert.equal(rec.aborted, 0);
  });

  it("stays silent when the response billed nothing — no evidence, no abort", () => {
    const { rec, ctx, sinks } = harness(true);
    const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    assert.equal(judgeResponse(response("unpriced-model", empty), ctx, sinks), false);
    assert.equal(rec.aborted, 0);
  });

  it("ignores non-assistant messages", () => {
    const { rec, ctx, sinks } = harness(true);
    assert.equal(judgeResponse(response("unpriced-model", billed, "user"), ctx, sinks), false);
    assert.equal(rec.aborted, 0);
  });

  it("stays silent when models.json cannot be read", () => {
    const { rec, ctx, sinks } = harness(true);
    const blind = { ...sinks, readModels: () => undefined };
    assert.equal(judgeResponse(response("unpriced-model", billed), ctx, blind), false);
    assert.equal(rec.aborted, 0);
  });

  it("sets a non-zero exit code headless, where there is no UI to read the notice", () => {
    const { rec, ctx, sinks } = harness(false);
    judgeResponse(response("unpriced-model", billed), ctx, sinks);
    assert.deepEqual(rec.exitCodes, [1]);
    assert.deepEqual(rec.notices, []);
    assert.equal(rec.aborted, 1);
  });
});

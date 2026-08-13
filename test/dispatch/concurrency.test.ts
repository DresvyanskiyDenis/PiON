import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capFor, clampConcurrency, isFanoutCall } from "../../extensions/dispatch/concurrency.ts";
import { CONFIG, ROUTING } from "./helpers.ts";

describe("capFor", () => {
  it("takes the per-provider cap from routing.json", () => {
    assert.equal(capFor(ROUTING, "local", CONFIG), 1, "the local lane is serialised by hardware");
    assert.equal(capFor(ROUTING, "databricks", CONFIG), 4);
    assert.equal(capFor(ROUTING, "github-copilot", CONFIG), 4);
  });

  it("falls back to the configured default for an unlisted provider or an absent routing.json", () => {
    assert.equal(capFor(ROUTING, "unknown-provider", CONFIG), CONFIG.concurrencyDefault);
    assert.equal(capFor(undefined, "databricks", CONFIG), CONFIG.concurrencyDefault);
  });

  it("replaces a nonsense cap with the default rather than honouring 0", () => {
    const bad = { ...ROUTING, concurrency: { ...ROUTING.concurrency, databricks: 0 } };
    assert.equal(capFor(bad, "databricks", CONFIG), CONFIG.concurrencyDefault);
  });
});

describe("isFanoutCall", () => {
  it("is true only when the call carries a fanout argument", () => {
    assert.equal(isFanoutCall({ agent: "scout", prompt: "x" }), false);
    assert.equal(isFanoutCall({ tasks: [] }), true);
    assert.equal(isFanoutCall({ parallel: true }), true);
    assert.equal(isFanoutCall({ chain: [1] }), true);
    assert.equal(isFanoutCall({ expand: "..." }), true);
  });
});

describe("clampConcurrency", () => {
  it("does nothing for a single-child call - one child is inside any cap", () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(clampConcurrency(input, 1, CONFIG), undefined);
    assert.equal(input.concurrency, undefined);
  });

  it("lowers an over-wide fanout to the provider cap", () => {
    const input: Record<string, unknown> = { tasks: [1, 2, 3, 4, 5], concurrency: 5 };
    const out = clampConcurrency(input, 1, CONFIG);
    assert.equal(out?.changed, true);
    assert.equal(out?.requested, 5);
    assert.equal(out?.applied, 1);
    assert.equal(input.concurrency, 1, "the package now queues the other four itself");
    assert.match(out?.reason ?? "", /requested 5, lowered to the provider cap 1/);
  });

  it("NEVER raises a width the caller asked for", () => {
    const input: Record<string, unknown> = { tasks: [1, 2], concurrency: 2 };
    const out = clampConcurrency(input, 6, CONFIG);
    assert.equal(out?.changed, false);
    assert.equal(input.concurrency, 2, "a cap is a ceiling, not a target");
  });

  it("writes an explicit width when the call gave none and the cap is below the package default", () => {
    const input: Record<string, unknown> = { tasks: [1, 2, 3] };
    const out = clampConcurrency(input, 1, CONFIG);
    assert.equal(out?.changed, true);
    assert.equal(out?.requested, CONFIG.packageDefaultConcurrency);
    assert.equal(input.concurrency, 1);
    assert.match(out?.reason ?? "", /the package would default to 4, lowered to the provider cap 1/);
  });

  it("leaves the argument absent when the cap cannot bite", () => {
    const input: Record<string, unknown> = { tasks: [1, 2, 3] };
    const out = clampConcurrency(input, 6, CONFIG);
    assert.equal(out?.changed, false);
    assert.equal(input.concurrency, undefined, "no need to write an argument the package already satisfies");
  });

  it("replaces a nonsense concurrency argument instead of passing it through", () => {
    for (const raw of [0, -3, Number.NaN, "many"]) {
      const input: Record<string, unknown> = { tasks: [1, 2], concurrency: raw };
      const out = clampConcurrency(input, 1, CONFIG);
      assert.equal(out?.changed, true, `raw=${String(raw)}`);
      assert.equal(input.concurrency, 1);
    }
  });

  it("floors a fractional width", () => {
    const input: Record<string, unknown> = { tasks: [1, 2], concurrency: 2.9 };
    const out = clampConcurrency(input, 6, CONFIG);
    assert.equal(out?.requested, 2);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DispatchError,
  assertEgressContainment,
  egressOf,
  resolveModelSpec,
  resolveSessionEgress,
} from "../../extensions/dispatch/tiers.ts";
import { makeCatalogue } from "../../extensions/dispatch/catalogue.ts";
import { CATALOGUE, ROUTING, grab } from "./helpers.ts";

describe("resolveModelSpec", () => {
  it("resolves tier:<name>", () => {
    const t = resolveModelSpec(ROUTING, "tier:cheap", "fast");
    assert.equal(t.model, "databricks/databricks-claude-haiku-4-5");
    assert.equal(t.provider, "databricks");
    assert.equal(t.tier, "cheap");
    assert.equal(t.egress, "confidential");
  });

  it("resolves a bare tier name, because plan 4.5 writes `model: strong`", () => {
    const t = resolveModelSpec(ROUTING, "strong", "fast");
    assert.equal(t.model, "github-copilot/claude-opus-5");
    assert.equal(t.tier, "strong");
    assert.equal(t.egress, "public");
  });

  it("resolves a literal provider/id", () => {
    const t = resolveModelSpec(ROUTING, "databricks/databricks-claude-sonnet-4-5", "fast");
    assert.equal(t.provider, "databricks");
    assert.equal(t.egress, "confidential");
    assert.equal(t.tier, undefined);
  });

  it("falls back to the default tier for an empty spec", () => {
    assert.equal(resolveModelSpec(ROUTING, "   ", "cheap").tier, "cheap");
  });

  it("carries the optional flag so an absent local lane is a runtime fact, not a file error", () => {
    assert.equal(resolveModelSpec(ROUTING, "local", "fast").optional, true);
    assert.equal(resolveModelSpec(ROUTING, "cheap", "fast").optional, false);
  });

  it("refuses a bare model id rather than guessing a provider", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "gpt-5.4", "fast")) as DispatchError;
    assert.equal(err.kind, "unknown_tier");
    assert.match(err.message, /neither a known tier/);
    assert.match(err.message, /strong, fast, cheap/);
  });

  it("names the known tiers when a tier is unknown", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "tier:deep", "fast")) as DispatchError;
    assert.equal(err.kind, "unknown_tier");
    assert.match(err.message, /unknown tier "deep"/);
  });

  it("refuses a provider with no declared egress class", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "anthropic/claude", "fast")) as DispatchError;
    assert.equal(err.kind, "config");
    assert.match(err.message, /no declared egress class/);
    assert.match(err.message, /read as a provider-qualified model id/, "say how the value was read");
    assert.match(err.message, /classed providers: github-copilot, openai, databricks, local/);
  });
});

/**
 * The existence check. It only runs when a catalogue is supplied, because `ctx.modelRegistry` can
 * legitimately be unavailable and "we cannot see the models" must not be reported as "the model
 * does not exist".
 */
describe("resolveModelSpec against the model registry", () => {
  it("accepts a concrete provider/id that is in the registry", () => {
    const t = resolveModelSpec(ROUTING, "github-copilot/gpt-5.4-mini", "fast", CATALOGUE);
    assert.equal(t.model, "github-copilot/gpt-5.4-mini");
    assert.equal(t.provider, "github-copilot");
    assert.equal(t.tier, undefined, "a concrete id is not a tier and must not claim to be one");
  });

  it("refuses one that is not, naming the value, the reading and the closest real ids", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "github-copilot/gpt-5.1", "fast", CATALOGUE)) as DispatchError;
    assert.equal(err.kind, "unknown_model");
    assert.match(err.message, /model "github-copilot\/gpt-5\.1"/);
    assert.match(err.message, /read as a provider-qualified model id \(it contains "\/"\)/);
    assert.match(err.message, /9 model\(s\) available/);
    assert.match(err.message, /Closest available: github-copilot\/gpt-5\.4/);
    assert.match(err.message, /Or name a tier: strong, fast, cheap, confidential, local/);
  });

  it("does not check existence at all when no catalogue is supplied", () => {
    assert.equal(resolveModelSpec(ROUTING, "github-copilot/gpt-5.1", "fast").model, "github-copilot/gpt-5.1");
  });

  it("reports a tier whose target vanished as a routing.json error, not as a bad call", () => {
    const thin = makeCatalogue(["databricks/databricks-claude-haiku-4-5"]);
    const err = grab(() => resolveModelSpec(ROUTING, "strong", "fast", thin)) as DispatchError;
    assert.equal(err.kind, "unknown_model");
    assert.match(err.message, /tier "strong" resolves to github-copilot\/claude-opus-5 \(routing\.json\)/);
    assert.match(err.message, /fix the tier rather than working around it/);
  });

  it("exempts an `optional` tier: llama-swap being down is a runtime fact, not a config error", () => {
    // `local` is optional and its model is deliberately absent from CATALOGUE.
    assert.equal(resolveModelSpec(ROUTING, "local", "fast", CATALOGUE).model, "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF");
  });

  it("offers ids when a bare word looks like a model rather than a tier", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "gpt-5.4", "fast", CATALOGUE)) as DispatchError;
    assert.equal(err.kind, "unknown_tier");
    assert.match(err.message, /read as a TIER NAME because it contains no "\/"/);
    assert.match(err.message, /Did you mean one of these ids\? .*gpt-5\.4/);
    assert.match(err.message, /write it provider-qualified/);
  });

  it("still refuses a bare word with no lookalike, without inventing a suggestion", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "galaxy", "fast", CATALOGUE)) as DispatchError;
    assert.equal(err.kind, "unknown_tier");
    assert.match(err.message, /neither a known tier \(strong, fast, cheap, confidential, local\)/);
    assert.doesNotMatch(err.message, /Did you mean/);
  });
});

describe("egressOf", () => {
  it("never guesses", () => {
    assert.equal(egressOf(ROUTING, "local"), "confidential");
    assert.throws(() => egressOf(ROUTING, "nope"), DispatchError);
  });
});

describe("assertEgressContainment", () => {
  const target = (spec: string) => resolveModelSpec(ROUTING, spec, "fast");

  it("refuses a confidential session dispatching onto a public provider", () => {
    const err = grab(() => assertEgressContainment(target("strong"), "confidential", 'agent "x"')) as DispatchError;
    assert.equal(err.kind, "egress");
    assert.match(err.message, /the session is confidential/);
    assert.match(err.message, /github-copilot\/claude-opus-5/);
  });

  it("refuses a confidential session dispatching onto an internal provider", () => {
    // No shipped provider is `internal` any more (litellm, the one that was, is deleted) — this
    // ModelTarget is a deliberate synthetic literal, not resolved through ROUTING, so the
    // `internal`-class containment path stays exercised.
    const internalTarget: ReturnType<typeof target> = { ...target("confidential"), egress: "internal" };
    assert.throws(() => assertEgressContainment(internalTarget, "confidential", "x"), DispatchError);
  });

  it("allows movement to a stricter class", () => {
    assert.doesNotThrow(() => assertEgressContainment(target("confidential"), "public", "x"));
    assert.doesNotThrow(() => assertEgressContainment(target("cheap"), "public", "x"));
    assert.doesNotThrow(() => assertEgressContainment(target("confidential"), "internal", "x"));
    assert.doesNotThrow(() => assertEgressContainment(target("local"), "confidential", "x"));
  });

  it("refuses an internal session dispatching onto a public provider", () => {
    assert.throws(() => assertEgressContainment(target("fast"), "internal", "x"), DispatchError);
  });
});

describe("resolveSessionEgress", () => {
  it("prefers an explicit declaration", () => {
    const r = resolveSessionEgress(ROUTING, { declared: "confidential", activeProvider: "github-copilot", defaultEgress: "internal" });
    assert.deepEqual(r, { egress: "confidential", source: "declared" });
  });

  it("derives from the session's own active model when nothing is declared", () => {
    const r = resolveSessionEgress(ROUTING, { activeProvider: "databricks", defaultEgress: "internal" });
    assert.equal(r.egress, "confidential");
    assert.equal(r.source, "active-model");
  });

  it("announces a bogus PI_ROUTING_EGRESS instead of silently accepting it", () => {
    const r = resolveSessionEgress(ROUTING, { declared: "top-secret", defaultEgress: "internal" });
    assert.equal(r.egress, "internal");
    assert.match(r.note ?? "", /PI_ROUTING_EGRESS="top-secret"/);
  });

  it("announces an active provider with no egress class", () => {
    const r = resolveSessionEgress(ROUTING, { activeProvider: "anthropic", defaultEgress: "internal" });
    assert.equal(r.egress, "internal");
    assert.match(r.note ?? "", /no egress class/);
  });

  it("falls back to the configured default", () => {
    assert.deepEqual(resolveSessionEgress(ROUTING, { defaultEgress: "internal" }), {
      egress: "internal",
      source: "default",
    });
  });
});

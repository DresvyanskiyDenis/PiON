import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as tiers from "../../extensions/dispatch/tiers.ts";
import {
  DispatchError,
  egressOf,
  resolveModelSpec,
  resolveSessionEgress,
} from "../../extensions/dispatch/tiers.ts";
import { makeCatalogue } from "../../extensions/dispatch/catalogue.ts";
import { CATALOGUE, ROUTING, grab } from "./helpers.ts";

describe("resolveModelSpec", () => {
  // 2026-08-13: ROUTING's `cheap` tier declares `thinkingLevel: "low"`, and `resolveTier`
  // (`tiers.ts`) makes that real by appending `:low` to the model string — the only place PI reads
  // a child's reasoning effort from. This used to assert the bare id.
  it("resolves tier:<name>", () => {
    const t = resolveModelSpec(ROUTING, "tier:cheap", "fast");
    assert.equal(t.model, "databricks/databricks-claude-haiku-4-5:low");
    assert.equal(t.provider, "databricks");
    assert.equal(t.tier, "cheap");
    assert.equal(t.egress, "confidential");
  });

  // 2026-08-13: `strong` declares `thinkingLevel: "high"`; same suffix-append as above. Used to
  // assert the bare id.
  it("resolves a bare tier name, because plan 4.5 writes `model: strong`", () => {
    const t = resolveModelSpec(ROUTING, "strong", "fast");
    assert.equal(t.model, "github-copilot/claude-opus-5:high");
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

  /**
   * WITHDRAWN 2026-08-13. This used to be `refuses a provider with no declared egress class`,
   * asserting `kind:"config"` and a message about there being "no defensible answer" to whether the
   * session's data may go there. That refusal was the withdrawn egress-containment rule in another
   * costume — a provider the config forgot to label became a provider nobody could use — so it went
   * with the rest of it. An unclassed provider is now UNLABELLED: it resolves, and carries no class.
   */
  it("resolves a provider with no declared egress class, leaving the label empty", () => {
    const t = resolveModelSpec(ROUTING, "anthropic/claude", "fast");
    assert.equal(t.model, "anthropic/claude");
    assert.equal(t.provider, "anthropic");
    assert.equal(t.egress, undefined, "no class is not the same as a forbidden class");
    assert.equal(t.tier, undefined);
  });

  it("still refuses an empty provider — that is a malformed id, not an unclassed one", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "/claude", "fast")) as DispatchError;
    assert.equal(err.kind, "config");
    assert.match(err.message, /empty provider/);
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

  // 2026-08-13: the refusal message names `target.model`, which by now carries `strong`'s `:high`
  // suffix — the suffix is applied before the existence check runs, so it survives into the error
  // text. Used to assert the bare id.
  it("reports a tier whose target vanished as a routing.json error, not as a bad call", () => {
    const thin = makeCatalogue(["databricks/databricks-claude-haiku-4-5"]);
    const err = grab(() => resolveModelSpec(ROUTING, "strong", "fast", thin)) as DispatchError;
    assert.equal(err.kind, "unknown_model");
    assert.match(err.message, /tier "strong" resolves to github-copilot\/claude-opus-5:high \(routing\.json\)/);
    assert.match(err.message, /fix the tier rather than working around it/);
  });

  // 2026-08-13: `local` declares `thinkingLevel: "medium"`. The suffix is applied regardless of
  // the `optional` flag — `optional` only skips the existence check, not thinking-level resolution.
  // Used to assert the bare id.
  it("exempts an `optional` tier: llama-swap being down is a runtime fact, not a config error", () => {
    // `local` is optional and its model is deliberately absent from CATALOGUE.
    assert.equal(
      resolveModelSpec(ROUTING, "local", "fast", CATALOGUE).model,
      "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF:medium",
    );
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

/**
 * PI carries a child's reasoning effort in the model string — `provider/id:max` — and the launch
 * path reads it there (`pi-subagents/src/runs/foreground/subagent-executor.ts:2146`), where it
 * outranks both the agent file's `thinking:` and any override. The catalogue, however, is keyed by
 * bare `provider/id`. Before `splitThinkingSuffix` existed, every suffixed spec died on the
 * existence check with `unknown_model`, which is why this harness spent months believing PI could
 * not set effort per dispatch at all.
 */
describe("resolveModelSpec with a thinking-level suffix", () => {
  it("accepts a suffixed id and passes the suffix through to the wire", () => {
    const t = resolveModelSpec(ROUTING, "github-copilot/gpt-5.4-mini:max", "fast", CATALOGUE);
    assert.equal(t.model, "github-copilot/gpt-5.4-mini:max", "the suffix must survive — it IS the effort");
    assert.equal(t.provider, "github-copilot");
  });

  it("accepts every level pi-subagents knows", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const t = resolveModelSpec(ROUTING, `github-copilot/gpt-5.4-mini:${level}`, "fast", CATALOGUE);
      assert.equal(t.model, `github-copilot/gpt-5.4-mini:${level}`);
    }
  });

  it("refuses an UNKNOWN level rather than reading it as part of the id", () => {
    // The whole risk of suffix-splitting is silently swallowing a typo: `:maxx` must not quietly
    // become effort `max`, nor be accepted as a model id nobody serves.
    const err = grab(() =>
      resolveModelSpec(ROUTING, "github-copilot/gpt-5.4-mini:maxx", "fast", CATALOGUE),
    ) as DispatchError;
    assert.equal(err.kind, "unknown_model");
    assert.match(err.message, /gpt-5\.4-mini:maxx/);
  });

  it("still refuses a suffixed id whose base model does not exist", () => {
    const err = grab(() => resolveModelSpec(ROUTING, "github-copilot/gpt-5.1:high", "fast", CATALOGUE)) as DispatchError;
    assert.equal(err.kind, "unknown_model");
    // The suggestion is computed from the BASE id: "closest to gpt-5.1:high" would rank nothing.
    assert.match(err.message, /Closest available: github-copilot\/gpt-5\.4/);
  });

  it("resolves a tier whose routing.json model carries a suffix", () => {
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4:max", purpose: "t" } },
    };
    const t = resolveModelSpec(routing, "cheap", "fast", CATALOGUE);
    assert.equal(t.model, "github-copilot/gpt-5.4:max");
    assert.equal(t.tier, "cheap");
  });
});

/**
 * `applyTierThinkingLevel` (`tiers.ts`) is private — it is only reachable through `resolveTier`,
 * which `resolveModelSpec` calls for every tier name. These exercise its four cases directly,
 * on top of the general suffix-handling covered above.
 */
describe("applyTierThinkingLevel (via resolveModelSpec)", () => {
  it("a tier with thinkingLevel resolves to model:level", () => {
    const t = resolveModelSpec(ROUTING, "cheap", "fast");
    assert.equal(t.model, "databricks/databricks-claude-haiku-4-5:low", "cheap declares thinkingLevel: low");
  });

  it("a tier whose model already ends in a known suffix keeps its own — explicit wins", () => {
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4:max", thinkingLevel: "low" } },
    };
    const t = resolveModelSpec(routing, "cheap", "fast");
    assert.equal(t.model, "github-copilot/gpt-5.4:max", "the id's own :max must not be overwritten by the field's low");
  });

  it("a tier with no thinkingLevel resolves to a bare model", () => {
    const routing = { ...ROUTING, tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4" } } };
    const t = resolveModelSpec(routing, "cheap", "fast");
    assert.equal(t.model, "github-copilot/gpt-5.4");
    assert.equal(t.thinkingLevel, undefined);
  });

  it("a tier declaring an UNKNOWN level throws DispatchError(config), naming the tier and the legal levels", () => {
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4", thinkingLevel: "supreme" } },
    };
    const err = grab(() => resolveModelSpec(routing, "cheap", "fast")) as DispatchError;
    assert.equal(err.kind, "config");
    assert.match(err.message, /tier "cheap" declares thinkingLevel "supreme"/);
    assert.match(err.message, /off\|minimal\|low\|medium\|high\|xhigh\|max/);
  });
});

describe("egressOf", () => {
  it("reports a declared class", () => {
    assert.equal(egressOf(ROUTING, "local"), "confidential");
    assert.equal(egressOf(ROUTING, "github-copilot"), "public");
  });

  it("reports an undeclared one as undefined instead of throwing", () => {
    assert.equal(egressOf(ROUTING, "nope"), undefined);
  });
});

/**
 * WITHDRAWN 2026-08-13. `assertEgressContainment()` used to enforce "work may move to a stricter
 * egress class, never a looser one", and four tests here asserted its refusals. Nobody had asked
 * for that rule; its real effect was that most agents became undispatchable from a session classed
 * anything but the loosest. The classes are reporting labels now, and this block is the guard that
 * the assertion does not come back: every configured model must stay dispatchable from every
 * session, whatever the two labels say.
 */
describe("egress containment (withdrawn)", () => {
  it("exports no containment assertion", () => {
    const surface = tiers as unknown as Record<string, unknown>;
    assert.equal(surface.assertEgressContainment, undefined);
  });

  it("every tier resolves whatever the session's class, and keeps its own label", () => {
    for (const [tier, expected] of [
      ["strong", "public"],
      ["cheap", "confidential"],
      ["confidential", "confidential"],
      ["local", "confidential"],
    ] as const) {
      const t = resolveModelSpec(ROUTING, tier, "fast");
      assert.equal(t.tier, tier);
      assert.equal(t.egress, expected, `${tier} keeps its reported class`);
    }
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

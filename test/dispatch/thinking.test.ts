import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LEVELS,
  clampThinkingLevel,
  discloseThinking,
  requestedLevel,
  isThinkingLevel,
  splitThinkingSuffix,
  supportedThinkingLevels,
  type ThinkingCapability,
} from "../../extensions/dispatch/thinking.ts";

/**
 * The enum shape an OpenAI-family reasoning model reports through a gateway: `low`/`medium`/`high`
 * only. This is the fixture the whole disclosure feature exists for.
 */
const ENUM_SHAPED: ThinkingCapability = {
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
};

/** Token-budget shaped: PI declares the whole ladder, so nothing clamps. */
const ANTHROPIC_SHAPED: ThinkingCapability = {
  reasoning: true,
  thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

describe("isThinkingLevel", () => {
  it("accepts exactly the seven levels PI's `resolveEffectiveThinking` knows", () => {
    for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true, level);
  });

  it("rejects anything else, including a near-miss", () => {
    assert.equal(isThinkingLevel("maxx"), false);
    assert.equal(isThinkingLevel(""), false);
    assert.equal(isThinkingLevel("MAX"), false, "case must not be folded — the wire value is exact");
  });
});

describe("splitThinkingSuffix", () => {
  it("splits a local id, which keeps its own internal slash", () => {
    assert.deepEqual(splitThinkingSuffix("local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF:max"), {
      baseModel: "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
      thinkingSuffix: ":max",
    });
  });

  it("splits a plain provider/id:level", () => {
    assert.deepEqual(splitThinkingSuffix("github-copilot/gpt-5.4:low"), {
      baseModel: "github-copilot/gpt-5.4",
      thinkingSuffix: ":low",
    });
  });

  it("leaves a model with no colon untouched", () => {
    assert.deepEqual(splitThinkingSuffix("github-copilot/gpt-5.4"), {
      baseModel: "github-copilot/gpt-5.4",
      thinkingSuffix: "",
    });
  });

  /**
   * The one case this whole module exists to get right: a typo in the level must not be silently
   * read as part of the id (which would then fail existence for the wrong reason), and must
   * certainly not be silently read as a level. `:maxx` keeps its colon and stays part of the id.
   */
  it("does NOT split an unknown suffix — a typo'd level stays part of the id", () => {
    assert.deepEqual(splitThinkingSuffix("github-copilot/gpt-5.4-mini:maxx"), {
      baseModel: "github-copilot/gpt-5.4-mini:maxx",
      thinkingSuffix: "",
    });
  });

  it("splits on the LAST colon, so a level after a genuinely colon-bearing id still resolves", () => {
    assert.deepEqual(splitThinkingSuffix("provider/weird:id:high"), {
      baseModel: "provider/weird:id",
      thinkingSuffix: ":high",
    });
  });
});

describe("requestedLevel", () => {
  it("reports the level a suffixed model asks to run at", () => {
    assert.equal(requestedLevel("github-copilot/gpt-5.4:high"), "high");
  });

  it("reports undefined for a bare model — the provider's own default applies", () => {
    assert.equal(requestedLevel("github-copilot/gpt-5.4"), undefined);
  });

  it("reports undefined for a typo'd level, same as splitThinkingSuffix would", () => {
    assert.equal(requestedLevel("github-copilot/gpt-5.4:maxx"), undefined);
  });

  it("reports what was ASKED, not what will ship — the distinction the clamp makes real", () => {
    assert.equal(requestedLevel("github-copilot/gpt-5.4:max"), "max");
    assert.equal(clampThinkingLevel(ENUM_SHAPED, "max"), "high", "…and this is what the wire carries");
  });
});

describe("supportedThinkingLevels", () => {
  it("drops every level the map nulls", () => {
    assert.deepEqual(supportedThinkingLevels(ENUM_SHAPED), ["low", "medium", "high"]);
  });

  it("treats a model with no reasoning as serving `off` and nothing else", () => {
    assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  });

  /**
   * The asymmetry in `pi-ai`'s filter, asserted so a future simplification cannot quietly remove it:
   * an ABSENT key means "supported" for the first five levels and "unsupported" for `xhigh`/`max`.
   */
  it("assumes the lower five when the map says nothing, but never xhigh or max", () => {
    assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  });

  /**
   * `off` is absent from this map rather than nulled, and absence means SUPPORTED for the lower
   * five — so the ladder comes back complete even though the fixture never mentions `off`.
   */
  it("keeps the whole ladder for a model that declares it", () => {
    assert.deepEqual(supportedThinkingLevels(ANTHROPIC_SHAPED), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("clampThinkingLevel", () => {
  it("is the identity for a level the model serves", () => {
    for (const level of ["low", "medium", "high"] as const) {
      assert.equal(clampThinkingLevel(ENUM_SHAPED, level), level);
    }
  });

  /** The incident: a model string reading `:max` advertised `max` and shipped `high` all afternoon. */
  it("clamps max DOWN to high on an enum-shaped vocabulary", () => {
    assert.equal(clampThinkingLevel(ENUM_SHAPED, "max"), "high");
    assert.equal(clampThinkingLevel(ENUM_SHAPED, "xhigh"), "high");
  });

  /**
   * NOT "round down". `pi-ai` searches UP from the requested level first, so a request for LESS
   * thinking than the model serves yields MORE. Reproduced deliberately — a disclosure that
   * disagrees with the wire would be worse than none.
   */
  it("clamps off and minimal UP to low, because the package searches upward first", () => {
    assert.equal(clampThinkingLevel(ENUM_SHAPED, "off"), "low");
    assert.equal(clampThinkingLevel(ENUM_SHAPED, "minimal"), "low");
  });

  it("collapses every level to off for a non-reasoning model", () => {
    assert.equal(clampThinkingLevel({ reasoning: false }, "max"), "off");
    assert.equal(clampThinkingLevel({ reasoning: false }, "low"), "off");
  });

  it("leaves the full ladder alone where the provider serves it", () => {
    assert.equal(clampThinkingLevel(ANTHROPIC_SHAPED, "max"), "max");
  });
});

describe("discloseThinking", () => {
  it("names both levels and the model string that belongs on the wire", () => {
    assert.deepEqual(discloseThinking("github-copilot/gpt-5.4:max", ENUM_SHAPED), {
      requested: "max",
      effective: "high",
      clamped: true,
      supported: ["low", "medium", "high"],
      effectiveModel: "github-copilot/gpt-5.4:high",
    });
  });

  it("reports clamped:false — and still both levels — when nothing was lowered", () => {
    const d = discloseThinking("github-copilot/gpt-5.4:medium", ENUM_SHAPED);
    assert.equal(d?.clamped, false);
    assert.equal(d?.requested, "medium");
    assert.equal(d?.effective, "medium");
    assert.equal(d?.effectiveModel, "github-copilot/gpt-5.4:medium");
  });

  it("says nothing about a model string that names no level", () => {
    assert.equal(discloseThinking("github-copilot/gpt-5.4", ENUM_SHAPED), undefined);
  });

  /** "We cannot see the vocabulary" must never render as "nothing will be clamped". */
  it("says nothing when the model's capability is unknown", () => {
    assert.equal(discloseThinking("github-copilot/gpt-5.4:max", undefined), undefined);
  });

  it("says nothing for a typo'd level — that is an unknown model, not an effort", () => {
    assert.equal(discloseThinking("github-copilot/gpt-5.4:maxx", ENUM_SHAPED), undefined);
  });
});

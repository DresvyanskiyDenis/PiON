import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LEVELS,
  effectiveLevel,
  isThinkingLevel,
  splitThinkingSuffix,
} from "../../extensions/dispatch/thinking.ts";

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

describe("effectiveLevel", () => {
  it("reports the level a suffixed model will actually run at", () => {
    assert.equal(effectiveLevel("github-copilot/gpt-5.4:high"), "high");
  });

  it("reports undefined for a bare model — the provider's own default applies", () => {
    assert.equal(effectiveLevel("github-copilot/gpt-5.4"), undefined);
  });

  it("reports undefined for a typo'd level, same as splitThinkingSuffix would", () => {
    assert.equal(effectiveLevel("github-copilot/gpt-5.4:maxx"), undefined);
  });
});

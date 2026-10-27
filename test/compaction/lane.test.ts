import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactionCandidates } from "../../extensions/compaction/index.ts";
import { laneThreshold, overLaneThreshold } from "../../extensions/compaction/lane.ts";
import { thresholdReport, UNIVERSAL_ABSOLUTE_TOKENS } from "../../extensions/compaction/threshold.ts";
import { localProviders } from "../../extensions/lib/routing-file.ts";
import type { RouteTarget } from "../../extensions/compaction/route.ts";

const LOCAL_ID = "example-org/local-model-GGUF";
const WINDOW = 131072;

const CLOUD_TARGET: RouteTarget = {
  spec: "tier:light",
  tier: "light",
  provider: "databricks",
  modelId: "gpt-5.6-luna",
  egress: "internal",
};
const ROUTE = { targets: [CLOUD_TARGET], localProviders: new Set(["local"]) };

const ctxOn = (provider: string, id: string) =>
  ({ model: { provider, id, contextWindow: WINDOW } }) as unknown as ExtensionContext;

describe("local lane compaction route", () => {
  it("is the session's own local model only, ignoring the configured cloud route", () => {
    const candidates = compactionCandidates(ctxOn("local", LOCAL_ID), ROUTE);
    assert.equal(candidates.length, 1, "one candidate means there is nothing to fail over to");
    assert.equal(candidates[0]?.target.provider, "local");
    assert.equal(candidates[0]?.target.modelId, LOCAL_ID);
    assert.equal(candidates[0]?.model?.id, LOCAL_ID);
  });

  it("off the lane, the configured route is used unchanged", () => {
    const candidates = compactionCandidates(ctxOn("github-copilot", "claude-opus-5"), ROUTE);
    assert.deepEqual(
      candidates.map((c) => c.target),
      [CLOUD_TARGET],
    );
  });

  it("with no model at all there is no candidate on the lane check either way", () => {
    assert.deepEqual(compactionCandidates({} as unknown as ExtensionContext, { targets: [], localProviders: new Set(["local"]) }), []);
  });

  it("the shipped routing.json classes the `local` provider as the lane", () => {
    const routing = { raw: { egress: { databricks: "internal", local: "local" } }, source: "<test>" };
    assert.deepEqual([...localProviders(routing)], ["local"]);
    assert.deepEqual([...localProviders({ raw: undefined, source: "<test>" })], []);
  });
});

describe("local lane compaction threshold", () => {
  it("is min(absoluteTokens, 0.75 x contextWindow): 98 304 on the local model", () => {
    assert.equal(laneThreshold(UNIVERSAL_ABSOLUTE_TOKENS, WINDOW), 98304);
  });

  it("keeps the absolute when the window is large enough that it is the smaller number", () => {
    assert.equal(laneThreshold(UNIVERSAL_ABSOLUTE_TOKENS, 1_000_000), UNIVERSAL_ABSOLUTE_TOKENS);
  });

  it("keeps the operator's opt-out (absoluteTokens 0)", () => {
    assert.equal(laneThreshold(0, WINDOW), 0);
    assert.equal(overLaneThreshold(WINDOW, 0, WINDOW), false);
  });

  it("fires past the cap, not at or below it, and never on an unknown count", () => {
    assert.equal(overLaneThreshold(98305, UNIVERSAL_ABSOLUTE_TOKENS, WINDOW), true);
    assert.equal(overLaneThreshold(98304, UNIVERSAL_ABSOLUTE_TOKENS, WINDOW), false);
    assert.equal(overLaneThreshold(null, UNIVERSAL_ABSOLUTE_TOKENS, WINDOW), false);
  });

  it("makes /compaction-status honest on the local model: uncapped it is diverged, capped it is aligned", () => {
    const reserve = 20000;
    const uncapped = thresholdReport(WINDOW, reserve, UNIVERSAL_ABSOLUTE_TOKENS, 0.2);
    assert.equal(uncapped.verdict, "window-too-small");
    const capped = thresholdReport(WINDOW, reserve, laneThreshold(UNIVERSAL_ABSOLUTE_TOKENS, WINDOW), 0.2);
    assert.equal(capped.verdict, "aligned");
  });
});

describe("the cap is lane-only because it would move cloud compaction", () => {
  it("a 200K cloud window would compact at 150K instead of 200K if the cap were generic", () => {
    assert.equal(laneThreshold(UNIVERSAL_ABSOLUTE_TOKENS, 200000), 150000);
    // Which is why `resolveThreshold` and the settle trigger call it only when `onLane(ctx)`.
    assert.equal(thresholdReport(200000, 20000, UNIVERSAL_ABSOLUTE_TOKENS, 0.2).verdict, "aligned");
  });
});

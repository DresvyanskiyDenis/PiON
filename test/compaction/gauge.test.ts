// The `ctx` threshold gauge (`extensions/compaction/gauge.ts`).
//
// Pure formatting only; the wiring (when it is published, and with what parked estimate) is
// `registerPreflight`'s own responsibility in `extensions/compaction/index.ts` and is exercised
// end-to-end by `gauge-wiring.test.ts`, not here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatCtxGaugeStatus,
  formatShortCount,
  GAUGE_AMBER_THRESHOLD,
  GAUGE_CELLS,
  GAUGE_RED_THRESHOLD,
  gaugeLevel,
  renderGaugeBar,
} from "../../extensions/compaction/gauge.ts";

describe("renderGaugeBar", () => {
  it("is always GAUGE_CELLS characters wide", () => {
    for (const percent of [0, 1, 50, 72, 91, 97, 100]) {
      assert.equal(renderGaugeBar(percent).length, GAUGE_CELLS);
    }
  });

  it("rounds rather than floors, so 91%/97% never look emptier than they are", () => {
    assert.equal(renderGaugeBar(91), "███████████░");
    assert.equal(renderGaugeBar(97), "████████████");
  });

  it("clamps out-of-range percentages instead of over/under-filling", () => {
    assert.equal(renderGaugeBar(-5), "░".repeat(GAUGE_CELLS));
    assert.equal(renderGaugeBar(150), "█".repeat(GAUGE_CELLS));
  });

  it("0% is empty, 100% is full", () => {
    assert.equal(renderGaugeBar(0), "░".repeat(GAUGE_CELLS));
    assert.equal(renderGaugeBar(100), "█".repeat(GAUGE_CELLS));
  });
});

describe("gaugeLevel", () => {
  it("is default under the amber threshold", () => {
    assert.equal(gaugeLevel(0), "default");
    assert.equal(gaugeLevel(GAUGE_AMBER_THRESHOLD - 1), "default");
  });

  it("is amber from 80% up to and including 92%", () => {
    assert.equal(gaugeLevel(GAUGE_AMBER_THRESHOLD), "amber");
    assert.equal(gaugeLevel(91), "amber");
    assert.equal(gaugeLevel(GAUGE_RED_THRESHOLD), "amber");
  });

  it("is red only above 92%", () => {
    assert.equal(gaugeLevel(GAUGE_RED_THRESHOLD + 1), "red");
    assert.equal(gaugeLevel(97), "red");
    assert.equal(gaugeLevel(100), "red");
  });
});

describe("formatShortCount", () => {
  it("renders a six-figure estimate compactly", () => {
    assert.equal(formatShortCount(781_501), "781k");
  });

  it("stays plain under 1000", () => {
    assert.equal(formatShortCount(42), "42");
  });

  it("truncates rather than rounds, so 999 tokens under a boundary never crosses it", () => {
    assert.equal(formatShortCount(781_999), "781k");
    assert.equal(formatShortCount(1_999_999), "1m");
  });
});

describe("formatCtxGaugeStatus", () => {
  it("shapes the plain form as \"ctx <bar> <percent>%\"", () => {
    assert.equal(formatCtxGaugeStatus({ percent: 72 }), `ctx ${renderGaugeBar(72)} 72%`);
  });

  it("renders the 91% boundary verbatim", () => {
    assert.equal(formatCtxGaugeStatus({ percent: 91 }), "ctx ███████████░ 91%");
  });

  it("appends the preflight estimate, with the warning marker, when one is parked", () => {
    assert.equal(
      formatCtxGaugeStatus({ percent: 72 }, { estimatedTokens: 781_501 }),
      `ctx ${renderGaugeBar(72)} 72%  (preflight est. 781k ⚠)`,
    );
  });

  it("renders an unknown percentage the same way the native context segment does", () => {
    // `@narumitw/pi-statusline`'s own `context` case renders `"?"` for a null percent; this mirrors
    // it rather than inventing a different unknown state.
    assert.equal(formatCtxGaugeStatus({ percent: null }), `ctx ${"░".repeat(GAUGE_CELLS)} ?`);
  });
});

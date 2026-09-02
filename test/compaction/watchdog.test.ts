// REQ-CTX-35's context watchdog (`extensions/compaction/watchdog.ts`).
//
// Pure decision function only; `bin/pi-compact-watchdog` owns reading the session index and
// writing the control envelope, and is exercised by hand (see its own header) rather than here —
// same split `gauge.test.ts` documents between formatting and wiring.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_WATCHDOG_COOLDOWN_MS,
  DEFAULT_WATCHDOG_THRESHOLD,
  readThreshold,
  shouldTriggerCompact,
  WATCHDOG_THRESHOLD_ENV,
} from "../../extensions/compaction/watchdog.ts";
import { GAUGE_AMBER_THRESHOLD } from "../../extensions/compaction/gauge.ts";

function signal(overrides: Partial<Parameters<typeof shouldTriggerCompact>[0]> = {}) {
  return {
    sessionId: "s-1",
    at: 1_000_000,
    percent: 85,
    lastCompactedAt: null,
    ...overrides,
  };
}

describe("DEFAULT_WATCHDOG_THRESHOLD", () => {
  it("reuses the gauge's own amber line rather than restating it", () => {
    assert.equal(DEFAULT_WATCHDOG_THRESHOLD, GAUGE_AMBER_THRESHOLD);
  });
});

describe("shouldTriggerCompact", () => {
  it("triggers a live, over-threshold, never-compacted session", () => {
    assert.equal(shouldTriggerCompact(signal(), 1_000_000), true);
  });

  it("does not trigger under threshold", () => {
    assert.equal(shouldTriggerCompact(signal({ percent: 79 }), 1_000_000, 80), false);
  });

  it("does not trigger on an unknown percentage — REQ-PRV-91 forbids guessing", () => {
    assert.equal(shouldTriggerCompact(signal({ percent: null }), 1_000_000), false);
  });

  it("does not trigger when a compact already landed after this sample was taken", () => {
    assert.equal(
      shouldTriggerCompact(signal({ at: 1_000_000, lastCompactedAt: 1_000_500 }), 1_000_600),
      false,
    );
  });

  it("still triggers when the last compact predates this usage sample", () => {
    assert.equal(
      shouldTriggerCompact(signal({ at: 1_000_000, lastCompactedAt: 500_000 }), 1_000_100),
      true,
    );
  });

  it("does not trigger on a stale signal — the session has gone idle or exited", () => {
    const now = 1_000_000 + DEFAULT_WATCHDOG_COOLDOWN_MS + 1;
    assert.equal(shouldTriggerCompact(signal({ at: 1_000_000 }), now), false);
  });

  it("a custom threshold and cooldown override the defaults", () => {
    assert.equal(shouldTriggerCompact(signal({ percent: 60 }), 1_000_000, 50), true);
    assert.equal(shouldTriggerCompact(signal({ at: 0 }), 100, 80, 50), false);
  });
});

describe("readThreshold", () => {
  it("defaults to DEFAULT_WATCHDOG_THRESHOLD with no flag or env", () => {
    assert.equal(readThreshold([], {}), DEFAULT_WATCHDOG_THRESHOLD);
  });

  it("reads the env override", () => {
    assert.equal(readThreshold([], { [WATCHDOG_THRESHOLD_ENV]: "70" }), 70);
  });

  it("a --threshold flag wins over the env", () => {
    assert.equal(readThreshold(["--threshold", "65"], { [WATCHDOG_THRESHOLD_ENV]: "70" }), 65);
  });

  it("refuses a threshold that is not a number between 0 and 100", () => {
    assert.throws(() => readThreshold(["--threshold", "not-a-number"], {}), /not a number/);
    assert.throws(() => readThreshold(["--threshold", "150"], {}), /not a number/);
  });
});

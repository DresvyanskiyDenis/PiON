/**
 * EXT-11 — loop guard. `REQ-CTX-35` is the whole reason this item exists, so these are the
 * tests that matter: N consecutive non-reducing passes trip, a reducing pass resets, and a
 * manual `/compact` never trips.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompactionLoopError,
  createLoopGuardState,
  DEFAULT_LOOP_GUARD,
  formatLoopFailure,
  observePass,
  reductionRatio,
  type LoopGuardConfig,
  type PassObservation,
} from "../../extensions/compaction/loop-guard.ts";

const CFG: LoopGuardConfig = {
  maxNonReducingPasses: 3,
  minReductionRatio: 0.15,
  minEntriesBetweenPasses: 2,
};

function pass(over: Partial<PassObservation> = {}): PassObservation {
  return {
    reason: "threshold",
    tokensBefore: 100_000,
    droppedTokens: 60_000,
    entriesSinceLastCompaction: 40,
    ...over,
  };
}

test("a healthy pass is reducing and never trips", () => {
  const state = createLoopGuardState();
  for (let i = 0; i < 10; i++) {
    const verdict = observePass(state, pass(), CFG);
    assert.equal(verdict.reducing, true);
    assert.equal(verdict.trip, false);
    assert.equal(verdict.consecutiveNonReducing, 0);
  }
  assert.equal(state.automaticPasses, 10);
  assert.equal(state.tripped, false);
});

test("a slice too small to buy room is non-reducing", () => {
  const state = createLoopGuardState();
  const verdict = observePass(state, pass({ droppedTokens: 5_000 }), CFG);
  assert.equal(verdict.reducing, false);
  assert.match(verdict.why, /5000 of 100000 context tokens/);
  assert.match(verdict.why, /5\.0 % < the 15\.0 % floor/);
});

test("a compaction following fewer than minEntriesBetweenPasses entries is non-reducing", () => {
  const state = createLoopGuardState();
  const verdict = observePass(state, pass({ entriesSinceLastCompaction: 1 }), CFG);
  assert.equal(verdict.reducing, false);
  assert.match(verdict.why, /only 1 session entry was appended/);
});

test("the first compaction of a session cannot trip on the entry-count signal", () => {
  const state = createLoopGuardState();
  const verdict = observePass(state, pass({ entriesSinceLastCompaction: -1 }), CFG);
  assert.equal(verdict.reducing, true);
});

test("N consecutive non-reducing passes trip the guard, and only the Nth", () => {
  const state = createLoopGuardState();
  const first = observePass(state, pass({ droppedTokens: 1_000 }), CFG);
  assert.equal(first.trip, false);
  const second = observePass(state, pass({ droppedTokens: 1_000 }), CFG);
  assert.equal(second.trip, false);
  const third = observePass(state, pass({ droppedTokens: 1_000 }), CFG);
  assert.equal(third.trip, true);
  assert.equal(third.consecutiveNonReducing, 3);
  assert.equal(state.tripped, true);
});

test("one reducing pass resets the counter — the guard is about a loop, not a bad pass", () => {
  const state = createLoopGuardState();
  observePass(state, pass({ droppedTokens: 1_000 }), CFG);
  observePass(state, pass({ droppedTokens: 1_000 }), CFG);
  const healthy = observePass(state, pass(), CFG);
  assert.equal(healthy.consecutiveNonReducing, 0);
  const next = observePass(state, pass({ droppedTokens: 1_000 }), CFG);
  assert.equal(next.trip, false);
  assert.equal(next.consecutiveNonReducing, 1);
});

test("a manual /compact is observed but never counted and never trips", () => {
  const state = createLoopGuardState();
  for (let i = 0; i < 20; i++) {
    const verdict = observePass(state, pass({ reason: "manual", droppedTokens: 0 }), CFG);
    assert.equal(verdict.counted, false);
    assert.equal(verdict.trip, false);
  }
  assert.equal(state.automaticPasses, 0);
  assert.equal(state.consecutiveNonReducing, 0);
});

test("overflow-recovery ping-pong trips: big slice, no new entries", () => {
  const state = createLoopGuardState();
  const obs = pass({ reason: "overflow", droppedTokens: 90_000, entriesSinceLastCompaction: 0 });
  observePass(state, obs, CFG);
  observePass(state, obs, CFG);
  const third = observePass(state, obs, CFG);
  assert.equal(third.trip, true);
});

test("once tripped, later passes keep reporting the trip", () => {
  const state = createLoopGuardState();
  for (let i = 0; i < 3; i++) observePass(state, pass({ droppedTokens: 0 }), CFG);
  const later = observePass(state, pass({ droppedTokens: 0 }), CFG);
  assert.equal(later.trip, true);
  assert.equal(later.consecutiveNonReducing, 4);
});

test("reductionRatio never divides by zero", () => {
  assert.equal(reductionRatio({ reason: "threshold", tokensBefore: 0, droppedTokens: 0, entriesSinceLastCompaction: 0 }), 0);
});

test("DEFAULT_LOOP_GUARD is the shape config/compaction.json ships", () => {
  assert.equal(DEFAULT_LOOP_GUARD.maxNonReducingPasses, 3);
  assert.equal(DEFAULT_LOOP_GUARD.minReductionRatio, 0.15);
  assert.equal(DEFAULT_LOOP_GUARD.minEntriesBetweenPasses, 2);
});

test("CompactionLoopError is a typed Error with a code and a preserved cause", () => {
  const cause = new Error("underlying");
  const err = new CompactionLoopError(
    {
      sessionId: "s1",
      provider: "github-copilot",
      model: "claude-opus-5",
      reason: "threshold",
      automaticPasses: 4,
      consecutiveNonReducing: 3,
      maxNonReducingPasses: 3,
      tokensBefore: 100_000,
      droppedTokens: 1_000,
      reductionRatio: 0.01,
      entriesSinceLastCompaction: 1,
      why: "pass would drop ~1000 of 100000 context tokens",
    },
    { cause },
  );
  assert.ok(err instanceof Error);
  assert.equal(err.name, "CompactionLoopError");
  assert.equal(err.code, "compaction_loop");
  assert.equal(err.cause, cause);
  assert.match(err.message, /3 consecutive non-reducing pass\(es\) \(limit 3\)/);
});

test("the rendered block names provider, model, code and counts", () => {
  const err = new CompactionLoopError({
    sessionId: "s1",
    provider: "github-copilot",
    model: "claude-opus-5",
    reason: "overflow",
    automaticPasses: 4,
    consecutiveNonReducing: 3,
    maxNonReducingPasses: 3,
    tokensBefore: 100_000,
    droppedTokens: 1_000,
    reductionRatio: 0.01,
    entriesSinceLastCompaction: 1,
    why: "no room bought",
  });
  const block = formatLoopFailure(err);
  assert.match(block, /compaction_loop/);
  assert.match(block, /context_overflow/); // REQ-CTX-35's acceptance greps for this on overflow
  assert.match(block, /provider : github-copilot/);
  assert.match(block, /model {4}: claude-opus-5/);
  assert.match(block, /passes {3}: 4 automatic, 3 consecutive non-reducing \(limit 3\)/);
});

test("a threshold trip does not claim context_overflow", () => {
  const err = new CompactionLoopError({
    sessionId: "s1",
    provider: "p",
    model: "m",
    reason: "threshold",
    automaticPasses: 3,
    consecutiveNonReducing: 3,
    maxNonReducingPasses: 3,
    tokensBefore: 1,
    droppedTokens: 0,
    reductionRatio: 0,
    entriesSinceLastCompaction: 0,
    why: "w",
  });
  assert.doesNotMatch(formatLoopFailure(err), /context_overflow/);
});

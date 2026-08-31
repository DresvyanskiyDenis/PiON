import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNudgeState, evaluateNudge, type NudgeConfig } from "../../extensions/tasks/nudge.ts";
import type { Task } from "../../extensions/tasks/replay.ts";

const CFG: NudgeConfig = { nudgeEveryTurns: 6, staleAfterTurns: 12 };

function task(id: number, subject: string, status: Task["status"]): Task {
  return { id, subject, status };
}

describe("evaluateNudge", () => {
  it("no tasks -> no nudge", () => {
    const state = createNudgeState();
    assert.equal(evaluateNudge(state, [], 3, CFG), undefined);
  });

  it("fires the generic due-nudge the first time tasks exist (lastNudgeTurn starts at -Infinity)", () => {
    const state = createNudgeState();
    const result = evaluateNudge(state, [task(1, "alpha", "pending")], 0, CFG);
    assert.ok(result);
    assert.equal(result.stale, false);
    assert.match(result.text, /todo tool/);
  });

  it("does not re-nudge before nudgeEveryTurns has elapsed", () => {
    const state = createNudgeState();
    evaluateNudge(state, [task(1, "alpha", "pending")], 0, CFG); // primes lastNudgeTurn = 0
    const result = evaluateNudge(state, [task(1, "alpha", "pending")], 3, CFG);
    assert.equal(result, undefined);
  });

  it("re-nudges once nudgeEveryTurns has elapsed", () => {
    const state = createNudgeState();
    evaluateNudge(state, [task(1, "alpha", "pending")], 0, CFG);
    const result = evaluateNudge(state, [task(1, "alpha", "pending")], 6, CFG);
    assert.ok(result);
    assert.equal(result.stale, false);
  });

  it("does not flag a fresh in_progress task as stale before the threshold", () => {
    const state = createNudgeState();
    // turn 0: primes inProgressSince(1) = 0, and also fires the first-ever due-nudge.
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 0, CFG);
    // turn 3: not due (nudgeEveryTurns=6), not yet stale (staleAfterTurns=12) -> no nudge.
    assert.equal(evaluateNudge(state, [task(1, "alpha", "in_progress")], 3, CFG), undefined);
  });

  it("staleness sharpens the text of a due nudge, it does not add one", () => {
    const state = createNudgeState();
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 0, CFG); // fires (first-ever), lastNudgeTurn=0
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 6, CFG); // due again at 6, lastNudgeTurn=6
    // turn 11: not due (11-6=5 < 6). Stale would not have triggered here either (11-0=11 < 12),
    // so this only pins the gate.
    assert.equal(evaluateNudge(state, [task(1, "alpha", "in_progress")], 11, CFG), undefined);
    // turn 12: due (12-6=6) AND stale (12-0=12 >= staleAfterTurns) -> the due nudge carries the
    // stale wording instead of the generic one.
    const result = evaluateNudge(state, [task(1, "alpha", "in_progress")], 12, CFG);
    assert.ok(result);
    assert.equal(result.stale, true);
    assert.match(result.text, /alpha/);
    assert.match(result.text, /in_progress for 12\+ turns/);
  });

  it("a task stale on every turn still only nudges on the cadence", () => {
    // Regression: staleness used to bypass the frequency gate. Because a stale task stays stale on
    // every following turn, and every such turn also re-stamped lastNudgeTurn, the nudge fired on
    // every single turn for the rest of the session.
    const state = createNudgeState();
    const tasks = [task(1, "alpha", "in_progress")];
    evaluateNudge(state, tasks, 0, CFG); // primes lastNudgeTurn=0 and inProgressSince(1)=0

    const firedOn: number[] = [];
    const staleOn: number[] = [];
    for (let turn = 1; turn <= 30; turn++) {
      const result = evaluateNudge(state, tasks, turn, CFG);
      if (!result) continue;
      firedOn.push(turn);
      if (result.stale) staleOn.push(turn);
    }

    assert.deepEqual(firedOn, [6, 12, 18, 24, 30]);
    // Stale from turn 12 on (12-0 >= staleAfterTurns), but only ever reported on a due turn.
    assert.deepEqual(staleOn, [12, 18, 24, 30]);
  });

  it("a task that leaves in_progress stops being tracked as stale", () => {
    const state = createNudgeState();
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 0, CFG); // fires, lastNudgeTurn=0
    // Closed at turn 1: not due (1-0<6), and stale is [] because nothing is in_progress -> no nudge.
    assert.equal(evaluateNudge(state, [task(1, "alpha", "completed")], 1, CFG), undefined);
    // Turn 13 is due again on the generic cadence (13-0>=6), but the closed task must never be
    // reported as stale, since it is no longer tracked.
    const result = evaluateNudge(state, [task(1, "alpha", "completed")], 13, CFG);
    assert.ok(result);
    assert.equal(result.stale, false);
  });

  it("re-opening a task after it closed restarts its stale clock", () => {
    const state = createNudgeState();
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 0, CFG); // fires, lastNudgeTurn=0
    evaluateNudge(state, [task(1, "alpha", "completed")], 1, CFG); // closes it, no nudge
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 20, CFG); // re-opened; due (20-0>=6), lastNudgeTurn=20
    // At turn 25: not due (25-20=5<6) and only 5 turns back in_progress (25-20=5<12) -> no nudge.
    assert.equal(evaluateNudge(state, [task(1, "alpha", "in_progress")], 25, CFG), undefined);
    // At turn 32 (20+staleAfterTurns) it is stale again, counting from the re-open, not turn 0.
    const late = evaluateNudge(state, [task(1, "alpha", "in_progress")], 32, CFG);
    assert.ok(late);
    assert.equal(late.stale, true);
  });

  it("clearing all tasks resets stale tracking", () => {
    const state = createNudgeState();
    evaluateNudge(state, [task(1, "alpha", "in_progress")], 0, CFG);
    evaluateNudge(state, [], 1, CFG); // list emptied
    assert.equal(state.inProgressSince.size, 0);
  });

  it("picks the first stale task deterministically when several are stale", () => {
    const state = createNudgeState();
    evaluateNudge(
      state,
      [task(1, "alpha", "in_progress"), task(2, "beta", "in_progress")],
      0,
      CFG,
    );
    const result = evaluateNudge(
      state,
      [task(1, "alpha", "in_progress"), task(2, "beta", "in_progress")],
      12,
      CFG,
    );
    assert.ok(result);
    assert.match(result.text, /alpha/);
  });
});

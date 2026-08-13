import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_REMINDERS } from "../../extensions/teammates/contract.ts";
import { DeliveryObligation, describeOutcome } from "../../extensions/teammates/obligation.ts";

describe("DeliveryObligation", () => {
  it("starts awaiting and is not terminal", () => {
    const ob = new DeliveryObligation("reviewer");
    assert.equal(ob.phase, "awaiting");
    assert.equal(ob.terminal, false);
    assert.equal(ob.discharged, false);
    assert.equal(ob.reminders, 0);
  });

  it("a delivery before the first idle check discharges immediately, with no reminder", () => {
    const ob = new DeliveryObligation("reviewer");
    ob.record("the full report");
    const step = ob.onIdle();
    assert.equal(step.action, "done");
    assert.equal(ob.phase, "delivered");
    assert.equal(ob.reminders, 0);
    assert.equal(ob.discharged, true);
  });

  it('a "blocked" delivery is still a delivery', () => {
    const ob = new DeliveryObligation("reviewer");
    ob.record("cannot reach the repo", "blocked");
    assert.equal(ob.onIdle().action, "done");
    assert.equal(ob.phase, "blocked");
    assert.equal(ob.discharged, true);
  });

  it("THE BOUND: exactly MAX_REMINDERS reminders, then release, forever - no loop", () => {
    const ob = new DeliveryObligation("reviewer");
    const actions: string[] = [];
    // Ten idle checks against a teammate that never delivers. The old harness's failure mode was a
    // hook that could not be allowed to block forever; this is the same guarantee, in the type.
    for (let i = 0; i < 10; i += 1) actions.push(ob.onIdle().action);
    assert.deepEqual(actions.slice(0, MAX_REMINDERS), Array(MAX_REMINDERS).fill("remind"));
    assert.ok(
      actions.slice(MAX_REMINDERS).every((a) => a === "release"),
      `expected only "release" after ${MAX_REMINDERS} reminders, got ${actions.join(",")}`,
    );
    assert.equal(ob.reminders, MAX_REMINDERS);
    assert.equal(ob.phase, "abandoned");
    assert.equal(ob.discharged, false);
    assert.equal(ob.terminal, true);
  });

  it("reminder steps are numbered 1..max so the child can be told where it stands", () => {
    const ob = new DeliveryObligation("reviewer", 3);
    const attempts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const step = ob.onIdle();
      if (step.action === "remind") attempts.push(step.attempt);
    }
    assert.deepEqual(attempts, [1, 2, 3]);
  });

  it("a delivery after one reminder still discharges, and the reminder count is kept", () => {
    const ob = new DeliveryObligation("reviewer");
    assert.equal(ob.onIdle().action, "remind");
    ob.record("late but real");
    const step = ob.onIdle();
    assert.equal(step.action, "done");
    assert.equal(ob.phase, "delivered");
    assert.equal(ob.reminders, 1);
  });

  it("maxReminders: 0 abandons on the first idle without ever reminding", () => {
    const ob = new DeliveryObligation("reviewer", 0);
    const step = ob.onIdle();
    assert.equal(step.action, "release");
    assert.equal(ob.reminders, 0);
    assert.equal(ob.phase, "abandoned");
  });

  it("a reply that arrives after release is kept as a LATE delivery, not as the result", () => {
    const ob = new DeliveryObligation("reviewer", 0);
    ob.onIdle();
    assert.equal(ob.phase, "abandoned");
    ob.record("I was finished all along");
    assert.equal(ob.delivery, undefined);
    assert.equal(ob.lateDelivery?.report, "I was finished all along");
    assert.equal(ob.phase, "abandoned", "a late reply must not resurrect the obligation");
    assert.match(describeOutcome(ob.outcome()), /a late reply arrived after release/);
  });

  it("the last of several deliveries wins and every one is counted", () => {
    const ob = new DeliveryObligation("reviewer");
    ob.record("draft");
    ob.record("final");
    assert.equal(ob.deliveryCount, 2);
    assert.equal(ob.delivery?.report, "final");
  });

  it("abort is terminal, carries its reason, and is never reported as a delivery", () => {
    const ob = new DeliveryObligation("reviewer");
    ob.abort("the lead's turn was aborted");
    assert.equal(ob.phase, "aborted");
    assert.equal(ob.terminal, true);
    assert.equal(ob.discharged, false);
    assert.equal(ob.onIdle().action, "release");
    assert.equal(ob.outcome().reason, "the lead's turn was aborted");
    assert.match(describeOutcome(ob.outcome()), /without delivery/);
  });

  it("abort after a discharge does not overwrite the delivery", () => {
    const ob = new DeliveryObligation("reviewer");
    ob.record("done");
    ob.onIdle();
    ob.abort("too late");
    assert.equal(ob.phase, "delivered");
  });

  it("rejects a nonsensical reminder budget instead of guessing one", () => {
    assert.throws(() => new DeliveryObligation("reviewer", -1), /non-negative integer/);
    assert.throws(() => new DeliveryObligation("reviewer", 1.5), /non-negative integer/);
  });

  it("describeOutcome names an undelivered exchange in words that cannot be misread", () => {
    const ob = new DeliveryObligation("reviewer");
    for (let i = 0; i <= MAX_REMINDERS; i += 1) ob.onIdle();
    assert.match(describeOutcome(ob.outcome()), /UNDELIVERED after 2 reminder\(s\)/);
  });
});

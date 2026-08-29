/**
 * EXT-05 — the child transcript that rides into the session file on a detached run.
 *
 * Three properties, and the second is the one easiest to lose in a later "simplification":
 *
 *   1. a detached child's `messages` array is dropped while the child still names its transcript;
 *   2. it is KEPT when nothing on the child says where else to find it. A run that died with no
 *      `transcriptPath` and no `sessionFile` has exactly one copy of what it did, and this module
 *      must never be the thing that deletes it;
 *   3. everything else survives untouched, `asyncId`/`asyncDir` included, because `async-fleet.ts`
 *      reads those off the same object this handler patches.
 *
 * The fixtures carry the package's own shape: `Details.results[]` of `SingleResult`
 * (`pi-subagents` 0.57.0, `src/shared/types.ts` — `messages` at `:1020`, `sessionFile` at `:1037`,
 * `transcriptPath` at `:1066`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSCRIPT_FIELD,
  TRANSCRIPT_POINTERS,
  carriesDroppableTranscript,
  slimDispatchDetails,
} from "../../extensions/dispatch/result-slim.ts";

/** A message array of the size that makes the drop worth doing at all. */
const MESSAGES = Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 === 0 ? "assistant" : "toolResult",
  content: [{ type: "text", text: `turn ${i}: ${"x".repeat(400)}` }],
}));

/** A child as `subagent-executor.ts:3876` hands one back: still `running`, so never compacted. */
function detachedChild(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    agent: "debugger",
    task: "find the leak",
    exitCode: 0,
    detached: true,
    progress: { status: "running", recentTools: [], recentOutput: [] },
    messages: MESSAGES,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 },
    transcriptPath: "/tmp/pi-subagents-uid-1000/artifacts/8a005b51_debugger_0_transcript.jsonl",
    sessionFile: "/home/pi/.pi/agent/sessions/child.jsonl",
    finalOutput: "the transcript is in details.results[].messages",
    ...extra,
  };
}

describe("slimDispatchDetails", () => {
  it("drops the message transcript of a detached child that still names it", () => {
    const slimmed = slimDispatchDetails({ mode: "single", runId: "r1", results: [detachedChild()] });
    assert.ok(slimmed, "a droppable transcript must produce a patch");
    const child = (slimmed.results as Record<string, unknown>[])[0]!;
    assert.equal(TRANSCRIPT_FIELD in child, false);
  });

  it("keeps the final output, the transcript pointers and the run's own verdict", () => {
    const slimmed = slimDispatchDetails({ mode: "single", runId: "r1", results: [detachedChild()] })!;
    const child = (slimmed.results as Record<string, unknown>[])[0]!;
    const original = detachedChild();
    for (const key of Object.keys(original)) {
      if (key === TRANSCRIPT_FIELD) continue;
      assert.deepEqual(child[key], original[key], `${key} must survive untouched`);
    }
    assert.equal(slimmed.mode, "single");
    assert.equal(slimmed.runId, "r1");
  });

  it("keeps asyncId and asyncDir, which async-fleet reads off this same object", () => {
    const asyncDir = "/tmp/pi-subagents-uid-1000/async-subagent-runs/6e77fc27";
    const slimmed = slimDispatchDetails({
      mode: "single",
      asyncId: "6e77fc27-0000-4000-8000-000000000000",
      asyncDir,
      results: [detachedChild({ asyncDir })],
    })!;
    assert.equal(slimmed.asyncId, "6e77fc27-0000-4000-8000-000000000000");
    assert.equal(slimmed.asyncDir, asyncDir);
    assert.equal((slimmed.results as Record<string, unknown>[])[0]!.asyncDir, asyncDir);
  });

  it("keeps the transcript when the child names no place to read it from", () => {
    const orphan = detachedChild();
    for (const pointer of TRANSCRIPT_POINTERS) delete orphan[pointer];
    assert.equal(carriesDroppableTranscript(orphan), false);
    assert.equal(slimDispatchDetails({ mode: "single", results: [orphan] }), undefined);
  });

  it("treats a blank pointer as no pointer", () => {
    assert.equal(carriesDroppableTranscript(detachedChild({ transcriptPath: "   ", sessionFile: "" })), false);
  });

  it("drops only the children that can spare it, in a mixed run", () => {
    const orphan = detachedChild({ index: 1 });
    for (const pointer of TRANSCRIPT_POINTERS) delete orphan[pointer];
    const slimmed = slimDispatchDetails({ mode: "single", results: [detachedChild(), orphan] })!;
    const [first, second] = slimmed.results as Record<string, unknown>[];
    assert.equal(TRANSCRIPT_FIELD in first!, false);
    assert.deepEqual(second![TRANSCRIPT_FIELD], MESSAGES);
  });

  it("returns undefined for a run the package already compacted", () => {
    const compacted = detachedChild();
    delete compacted[TRANSCRIPT_FIELD];
    assert.equal(slimDispatchDetails({ mode: "single", results: [compacted] }), undefined);
  });

  it("returns undefined for details it does not recognise", () => {
    assert.equal(slimDispatchDetails(undefined), undefined);
    assert.equal(slimDispatchDetails(null), undefined);
    assert.equal(slimDispatchDetails("done"), undefined);
    assert.equal(slimDispatchDetails([detachedChild()]), undefined);
    assert.equal(slimDispatchDetails({ mode: "management" }), undefined);
    assert.equal(slimDispatchDetails({ mode: "management", results: "none" }), undefined);
    assert.equal(slimDispatchDetails({ mode: "management", results: [] }), undefined);
    assert.equal(slimDispatchDetails({ mode: "single", results: [null, 7, "child"] }), undefined);
  });

  it("does not mutate the details it was given", () => {
    const details = { mode: "single", results: [detachedChild()] };
    slimDispatchDetails(details);
    assert.deepEqual((details.results[0] as Record<string, unknown>)[TRANSCRIPT_FIELD], MESSAGES);
  });

  it("removes exactly one field, so the list cannot grow unnoticed", () => {
    assert.equal(TRANSCRIPT_FIELD, "messages");
    const original = detachedChild();
    const slimmed = slimDispatchDetails({ mode: "single", results: [original] })!;
    const child = (slimmed.results as Record<string, unknown>[])[0]!;
    assert.deepEqual(
      Object.keys(original).filter((key) => !(key in child)),
      [TRANSCRIPT_FIELD],
    );
  });
});

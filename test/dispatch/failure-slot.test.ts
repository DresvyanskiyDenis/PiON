/**
 * EXT-05 — what the operator reads first when a dispatched run dies.
 *
 * The regression is real and dated, 2026-08-14: a subagent aborted on `empty-response` from
 * `litellm/gpt-5.6-luna`, and the failure the operator was shown began with a `path-defaults`
 * startup notice about a tier it had deliberately NOT applied. The cause was three lines further
 * down, under two more startup notices. He lost time to it twice.
 *
 * `REAL_ERROR` below is a run's `error` field, structurally verbatim — the whole child stderr tail
 * that `pi-subagents` turns into the run's error text. Nothing in these tests may assert that any of
 * it disappeared; the fix is ordering, not suppression, and the assertions say so explicitly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FULL_OUTPUT_SEPARATOR,
  classifiedHeadline,
  reorderFailureText,
  reorderResultContent,
  splitClassifiedFailure,
} from "../../extensions/dispatch/failure-slot.ts";

/**
 * Structurally verbatim to a real run's `error` field — same lines, same order, same two-space
 * field indent. The `message` field intentionally does NOT carry the refuted "the request did not
 * reach the model" sentence: that claim was corrected in `lib/provider-error.ts` on 2026-08-14 and
 * this module's tests are about ordering and block extraction, not about that correction, so the
 * fixture should not read like a claim that has to be re-refuted here.
 */
const REAL_ERROR = [
  '[pi-config] path-defaults: root * names tier "fast" (litellm/gpt-5.6-luna), but an explicit model selection is already in effect for this session — leaving it alone. session egress internal; web allow, mcp allow, public models allow (declarative — enforced only where EXT-07/EXT-14 consult it)',
  '[pi-config] web: backend="searxng", proxy=false, extraCa=true',
  "[pi-config] hooks: 3 rule(s) loaded",
  "[pi-config] provider call failed: litellm/gpt-5.6-luna — empty-response (http 200, empty body)",
  "  provider : litellm",
  "  model    : gpt-5.6-luna",
  "  class    : empty-response",
  "  http     : 200 (a complete, well-formed response whose body carried no completion — the status is not the error)",
  "  message  : the provider returned an empty completion: 0 content parts (no text, no thinking, no tool call), stopReason=stop, finish_reason=stop, reasoning effort=high, responseId=chatcmpl-64b99365-2066-4a7f-951a-71caf95be6a8, usage 0 prompt / 0 completion token(s). The turn produced no answer.",
  "  rawStop  : stop",
  "  policy   : abort — no failover, no substitution, no retry against another provider (routing.json onProviderError.policy)",
].join("\n");

/** The startup lines that must never lead a failure. */
const STARTUP_LINES = ["path-defaults", "web:", "hooks:"];

describe("EXT-05 failure slot — the classified abort leads", () => {
  it("leads with the provider abort, not the path-defaults startup line", () => {
    const out = reorderFailureText(REAL_ERROR);
    assert.ok(out !== undefined, "the real tail carries a classified block and must be reordered");
    const first = out.split("\n")[0]!;
    assert.match(first, /^\[pi-config\] provider call failed: litellm\/gpt-5\.6-luna — empty-response/);
    assert.doesNotMatch(first, /path-defaults/);
  });

  it("keeps the whole classified block together, policy line included", () => {
    const head = classifiedHeadline(REAL_ERROR);
    assert.ok(head !== undefined);
    for (const field of ["provider : litellm", "class    : empty-response", "rawStop  : stop"]) {
      assert.ok(head.includes(field), `the block lost \`${field}\``);
    }
    assert.match(head, /policy {3}: abort — no failover/);
  });

  it("drops nothing — every original line survives, in its original order below the separator", () => {
    const out = reorderFailureText(REAL_ERROR);
    assert.ok(out !== undefined);
    for (const line of REAL_ERROR.split("\n")) {
      assert.ok(out.includes(line), `reordering lost a line: ${line.slice(0, 60)}…`);
    }
    const rest = out.slice(out.indexOf(FULL_OUTPUT_SEPARATOR));
    const startupOrder = STARTUP_LINES.map((needle) => rest.indexOf(needle));
    assert.deepEqual(
      [...startupOrder].sort((a, b) => a - b),
      startupOrder,
      "the startup notices were reordered among themselves; only the classified block may move",
    );
    for (const index of startupOrder) assert.ok(index > 0, "a startup notice was dropped, not demoted");
  });

  it("says the remainder is complete, so nothing reads as truncated", () => {
    const out = reorderFailureText(REAL_ERROR)!;
    assert.ok(out.includes(FULL_OUTPUT_SEPARATOR));
    assert.match(FULL_OUTPUT_SEPARATOR, /unchanged/);
  });

  it("splits the tail into exactly the block and the rest", () => {
    const split = splitClassifiedFailure(REAL_ERROR);
    assert.ok(split !== undefined);
    assert.equal(split.classified.split("\n").length, 8, "marker line plus its seven indented fields");
    assert.equal(split.rest.split("\n").length, 3, "the three startup notices");
    assert.doesNotMatch(split.rest, /provider call failed/);
  });
});

describe("EXT-05 failure slot — no classification, no invention", () => {
  it("leaves an unclassified crash exactly as it found it", () => {
    const crash = [
      "[pi-config] hooks: 3 rule(s) loaded",
      "node:internal/process/promises:288",
      "            triggerUncaughtException(err, true /* fromPromise */);",
      "Error: spawn ENOMEM",
    ].join("\n");
    assert.equal(reorderFailureText(crash), undefined);
    assert.equal(classifiedHeadline(crash), undefined);
    assert.equal(splitClassifiedFailure(crash), undefined);
  });

  it("does not read a classification out of prose that merely resembles one", () => {
    // The exact sentence `pi-subagents` writes when a child produced nothing. It is a guess about a
    // cause, and a guess is precisely what must not be promoted as a classified failure.
    const guess = "Subagent produced no output (possible model cold-start or empty response).";
    assert.equal(reorderFailureText(guess), undefined);
  });

  it("ignores the marker when it is quoted mid-sentence rather than heading a block", () => {
    const quoted = "the run logged [pi-config] provider call failed: earlier in the turn";
    assert.equal(splitClassifiedFailure(quoted), undefined);
  });

  it("leaves a tail that is nothing but the block alone", () => {
    const only = REAL_ERROR.split("\n").slice(3).join("\n");
    assert.equal(reorderFailureText(only), undefined, "already correct; a separator would only add noise");
    assert.ok(classifiedHeadline(only) !== undefined, "it is still a recognised block");
  });
});

describe("EXT-05 failure slot — the tool_result rewrite", () => {
  /** The real parent-side result shape: one text part carrying the tail, then the run's footer. */
  const realContent = [
    {
      type: "text",
      text: `${REAL_ERROR}\n\nOutput artifact: /artifacts/8a005b51_ai-engineer_0.md\nMission: ai-engineer (failed)`,
    },
  ];

  it("rewrites the failing text part so the abort is the first thing read", () => {
    const out = reorderResultContent(realContent);
    assert.ok(out !== undefined);
    assert.equal(out.length, 1);
    assert.match(out[0]!.text!, /^\[pi-config\] provider call failed:/);
    assert.ok(out[0]!.text!.includes("Output artifact: /artifacts/8a005b51_ai-engineer_0.md"));
    assert.ok(out[0]!.text!.includes("Mission: ai-engineer (failed)"));
  });

  it("does not mutate the event's own content array", () => {
    const before = realContent[0]!.text;
    reorderResultContent(realContent);
    assert.equal(realContent[0]!.text, before);
  });

  it("returns undefined for a successful result, so PI keeps it untouched", () => {
    const ok = [{ type: "text", text: "Output artifact: /artifacts/ok.md\nMission: researcher (complete)" }];
    assert.equal(reorderResultContent(ok), undefined);
  });

  it("passes non-text parts through by identity", () => {
    const image = { type: "image", data: "…" };
    const out = reorderResultContent([image, { type: "text", text: REAL_ERROR }]);
    assert.ok(out !== undefined);
    assert.equal(out[0], image);
  });
});

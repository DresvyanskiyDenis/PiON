/**
 * EXT-05 — what the operator reads first when a dispatched run dies.
 *
 * The regression is real and dated, 2026-08-14: a subagent aborted on `empty-response` from
 * `litellm/gpt-5.6-luna`, and the failure the operator was shown began with a `path-defaults`
 * startup notice about a tier it had deliberately NOT applied. The cause was three lines further
 * down, under two more startup notices. He lost time to it twice.
 *
 * `REAL_ERROR` below is a run's `error` field, structurally verbatim — the whole child stderr tail
 * that `pi-subagents` turns into the run's error text.
 *
 * The paragraph that stood here said nothing in these tests may assert that any of that tail
 * disappeared, because the fix was ordering and not suppression. That holds for the classified
 * block and no longer holds for the tail: the same text is the tool result's `content`, the parent
 * is billed for it on every later turn, and since the bound landed it is elided down to a stated
 * number of lines with the file that still holds the rest named beside them. The tests are split
 * along that line — the ordering suites below still call the unbounded form and still assert that
 * nothing vanished, and the suites after them assert what may vanish, what may not, and that an
 * elision always says where the rest can be read.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FAILURE_OUTPUT_LIMITS,
  FULL_OUTPUT_SEPARATOR,
  LINE_CUT_SUFFIX,
  UNBOUNDED_FAILURE_OUTPUT,
  classifiedHeadline,
  elideFailureRest,
  reorderFailureText,
  reorderResultContent,
  resolveFullOutputPointer,
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

/**
 * EXT-05 failure slot — the remainder is bounded, the diagnosis is not.
 *
 * The defect: a failed dispatch put the child's WHOLE captured output into the tool result's
 * `content`, the part of a result the provider serialisers actually send, so the parent paid for
 * every startup notice the child emitted on every later turn of the session. What follows asserts
 * the bound, and asserts the three things the bound must never do.
 */
const NOISE = Array.from({ length: 60 }, (_v, i) => `[pi-config] startup notice ${i}`);
const NOISY_ERROR = [...NOISE, ...REAL_ERROR.split("\n").slice(3)].join("\n");
const POINTER = { label: "full output", path: "/runs/run-1/output-0.log" } as const;

describe("EXT-05 failure slot — the remainder is bounded", () => {
  it("keeps the classified block whole and elides only what follows it", () => {
    const out = reorderFailureText(NOISY_ERROR, DEFAULT_FAILURE_OUTPUT_LIMITS, POINTER);
    assert.ok(out !== undefined);
    // Every field of the diagnosis survives, the long `message` line — which is most of the
    // character budget on its own — included. The budget bounds the remainder, never the cause.
    for (const field of ["provider :", "model    :", "class    :", "http     :", "message  :", "policy   :"]) {
      assert.ok(out.includes(field), `the classified block lost "${field}"`);
    }
    assert.match(out.split("\n")[0]!, /^\[pi-config\] provider call failed:/);
  });

  it("keeps the configured number of lines and states how many went", () => {
    const out = reorderFailureText(NOISY_ERROR, { maxLines: 20, maxChars: 0 }, POINTER)!;
    const kept = NOISE.filter((line) => out.includes(line));
    assert.equal(kept.length, 20, "the line bound was not applied");
    assert.ok(out.includes("startup notice 0"), "the elision kept the tail instead of the top");
    assert.ok(!out.includes("startup notice 20"), "line 21 survived a 20-line bound");
    assert.match(out, /\.\.\. \(40 more line\(s\) elided/);
  });

  it("names the file the elided text can still be read from, and what that file holds", () => {
    const out = reorderFailureText(NOISY_ERROR, DEFAULT_FAILURE_OUTPUT_LIMITS, POINTER)!;
    assert.ok(out.includes(POINTER.path), "text was dropped without saying where it went");
    assert.ok(out.includes(POINTER.label), "the pointer did not say what the file holds");
  });

  it("keeps the remainder whole when the result named no file at all", () => {
    // A cut nobody can undo is suppression, not a reference. With no pointer the module is back to
    // its unbounded behaviour, however small the budget it was handed.
    const out = reorderFailureText(NOISY_ERROR, { maxLines: 1, maxChars: 1 }, undefined)!;
    assert.ok(out.includes(FULL_OUTPUT_SEPARATOR));
    for (const line of NOISE) assert.ok(out.includes(line), `"${line}" went with nowhere to read it`);
  });

  it("leaves a remainder that already fits exactly as it was", () => {
    assert.equal(elideFailureRest("one\ntwo", DEFAULT_FAILURE_OUTPUT_LIMITS, POINTER), undefined);
    const out = reorderFailureText(REAL_ERROR, DEFAULT_FAILURE_OUTPUT_LIMITS, POINTER)!;
    assert.ok(out.includes(FULL_OUTPUT_SEPARATOR), "a three-line remainder was elided");
    for (const line of STARTUP_LINES) assert.ok(out.includes(line));
  });

  it("cuts on a line boundary when the character budget binds first", () => {
    const out = elideFailureRest(NOISE.join("\n"), { maxLines: 0, maxChars: 120 }, POINTER)!;
    const body = out.split("\n").slice(1, -1);
    assert.ok(body.length >= 1 && body.length < 20, `expected a char-bound cut, got ${body.length} lines`);
    for (const line of body) assert.ok(NOISE.includes(line), `"${line}" was cut mid-line`);
  });

  it("keeps one marked line rather than none when a single line exceeds the whole budget", () => {
    const huge = `${"x".repeat(500)}\nsecond`;
    const out = elideFailureRest(huge, { maxLines: 20, maxChars: 100 }, POINTER)!;
    assert.ok(out.includes(LINE_CUT_SUFFIX), "a line longer than the budget produced no output at all");
    assert.match(out, /\.\.\. \(1 more line\(s\) elided/);
  });

  it("forwards the tail whole again when both bounds are zero", () => {
    const out = reorderFailureText(NOISY_ERROR, UNBOUNDED_FAILURE_OUTPUT, POINTER)!;
    assert.ok(out.includes(FULL_OUTPUT_SEPARATOR));
    for (const line of NOISE) assert.ok(out.includes(line));
  });
});

describe("EXT-05 failure slot — which file the pointer names", () => {
  it("prefers the metadata artifact, whose error field is this very text", () => {
    const details = {
      results: [{ artifactPaths: { metadataPath: "/artifacts/run-1_0_meta.json" }, transcriptPath: "/a/t.md" }],
      asyncDir: "/runs/run-1",
    };
    assert.deepEqual(resolveFullOutputPointer(details), {
      label: "full failure text",
      path: "/artifacts/run-1_0_meta.json",
    });
  });

  it("names the async run's own step log when there is one child", () => {
    assert.deepEqual(resolveFullOutputPointer({ asyncDir: "/runs/run-1", results: [{ status: "failed" }] }), {
      label: "full output",
      path: "/runs/run-1/output-0.log",
    });
  });

  it("names the run directory rather than guessing a step index, with several children", () => {
    // `output-0.log` is the FIRST step's log. With several results the failing step's index is not
    // derivable from `details`, and a confidently wrong path is worse than a directory.
    assert.deepEqual(resolveFullOutputPointer({ asyncDir: "/runs/x", results: [{}, {}] }), {
      label: "full output",
      path: "/runs/x",
    });
  });

  it("falls back to the child's transcript, and labels it as one", () => {
    const out = resolveFullOutputPointer({ results: [{ sessionFile: "" }, { transcriptPath: "/t/child.md" }] });
    assert.deepEqual(out, { label: "child transcript", path: "/t/child.md" });
  });

  it("treats a blank path as no path", () => {
    assert.equal(resolveFullOutputPointer({ asyncDir: "   ", results: [{ transcriptPath: "" }] }), undefined);
  });

  it("returns undefined for details it does not recognise", () => {
    for (const details of [undefined, null, "text", 42, [], {}, { results: "no" }]) {
      assert.equal(resolveFullOutputPointer(details), undefined, `recognised ${JSON.stringify(details)}`);
    }
  });
});

describe("EXT-05 failure slot — the bounded tool_result rewrite", () => {
  const content = [{ type: "text", text: NOISY_ERROR }];

  it("bounds the failing text part and points at the file from the same result", () => {
    const out = reorderResultContent(content, DEFAULT_FAILURE_OUTPUT_LIMITS, {
      label: "full output",
      path: "/runs/x/output-0.log",
    })!;
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text!.length < NOISY_ERROR.length, "the rewrite did not shrink anything");
    assert.ok(out[0]!.text!.includes("/runs/x/output-0.log"));
    assert.match(out[0]!.text!, /^\[pi-config\] provider call failed:/);
  });

  it("does not mutate the event's own content array", () => {
    const before = content[0]!.text;
    reorderResultContent(content, DEFAULT_FAILURE_OUTPUT_LIMITS, POINTER);
    assert.equal(content[0]!.text, before);
  });

  it("still leaves a successful result untouched, whatever the budget", () => {
    const ok = [{ type: "text", text: "Output artifact: /artifacts/ok.md\nMission: researcher (complete)" }];
    assert.equal(reorderResultContent(ok, { maxLines: 1, maxChars: 1 }, POINTER), undefined);
  });
});

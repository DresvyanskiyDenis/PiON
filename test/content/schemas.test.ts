/**
 * W2-CONTENT: the 4 `returns: object` typebox schemas actually compile, actually accept a well-formed
 * report, and actually reject a malformed one — the two directions `EXT-05`'s "re-ask once on a schema
 * failure" behavior (REQ-CTX-43) depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { DebugReport } from "../../config/schemas/debug-report.ts";
import { CodeReviewReport } from "../../config/schemas/code-review-report.ts";
import { ArchitectReviewReport } from "../../config/schemas/architect-review-report.ts";
import { SecurityReviewReport } from "../../config/schemas/security-review-report.ts";

describe("W2-CONTENT returns: object schemas", () => {
  it("DebugReport accepts a well-formed report and rejects a missing field", () => {
    const good = {
      failure: "TypeError: x is undefined at foo.ts:12; repro: `node foo.js`",
      rootCause: "caller passed an unvalidated optional field straight into a required parameter",
      fix: { file: "src/foo.ts", line: 12, change: "added a null check before dereferencing x" },
      regressionTest: { file: "test/foo.test.ts", test: "foo() rejects a missing x", asserts: "throws a typed error, not a crash" },
      verification: [{ command: "node --test test/foo.test.ts", result: "1 pass" }],
      residualRisk: "none identified",
    };
    assert.equal(Value.Check(DebugReport, good), true);
    const { failure, ...missingFailure } = good;
    assert.equal(Value.Check(DebugReport, missingFailure), false);
  });

  it("CodeReviewReport accepts a well-formed report and rejects a bad verdict enum", () => {
    const good = {
      scope: "3 files, +120/-40",
      verdict: "approve_with_changes",
      blockers: [],
      major: [{ file: "src/x.ts", line: 5, issue: "unbounded loop", why: "O(n^2) on the hot path", fix: "hoist the lookup" }],
      minor: [],
      nits: [],
      praise: [{ file: "src/x.ts", line: 1, note: "clean module boundary" }],
      testCoverageGaps: ["no test for the empty-input case"],
      recommendedTests: ["x() with an empty array"],
    };
    assert.equal(Value.Check(CodeReviewReport, good), true);
    assert.equal(Value.Check(CodeReviewReport, { ...good, verdict: "looks-fine-i-guess" }), false);
  });

  it("ArchitectReviewReport accepts a well-formed report and rejects a bad impact enum", () => {
    const good = {
      changeScope: "auth module -> session module",
      architecturalImpact: "high",
      impactJustification: "inverts the existing dependency direction",
      verdict: "proceed_with_adjustments",
      findings: [
        {
          name: "auth reaching into session internals",
          severity: "high",
          boundary: "auth -> session",
          issue: "auth imports session's private state directly",
          consequence: "the two modules can no longer evolve independently",
          refactorSketch: "expose a narrow SessionReader interface; auth depends on that instead",
          files: ["src/auth/login.ts", "src/session/store.ts"],
        },
      ],
      praise: ["clear separation everywhere else in the module"],
      decisionRecord: "accepted the coupling for this release; tracked as follow-up",
    };
    assert.equal(Value.Check(ArchitectReviewReport, good), true);
    assert.equal(Value.Check(ArchitectReviewReport, { ...good, architecturalImpact: "catastrophic" }), false);
  });

  it("SecurityReviewReport accepts a well-formed report and rejects a bad severity enum", () => {
    const good = {
      findings: [
        {
          severity: "critical",
          title: "SQL built via f-string",
          location: "src/db/query.py:41",
          whyItMatters: "direct injection vector on an authenticated-but-untrusted input",
          fixSketch: "parameterize the query",
        },
      ],
      toolsRun: [{ tool: "bandit", summary: "1 high finding, matches above" }],
      skipped: [{ item: "trivy fs scan", why: "not installed in this environment" }],
      nextActions: ["fix the SQL injection before merge"],
      deployApproved: false,
    };
    assert.equal(Value.Check(SecurityReviewReport, good), true);
    assert.equal(
      Value.Check(SecurityReviewReport, { ...good, findings: [{ ...good.findings[0], severity: "apocalyptic" }] }),
      false,
    );
  });
});

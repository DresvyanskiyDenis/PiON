/**
 * Structured return schema for the `code-reviewer` agent (`content/agents/code-reviewer.md`,
 * `returns: object`). Modeled directly on the agent's own "Report format" section — the severity
 * buckets (Blocker/Major/Minor/Nit/Praise) and the Tests section are that agent's pre-existing report
 * contract, made enforceable per `REQ-CTX-43` rather than invented fresh.
 *
 * Integration placement: belongs at `config/schemas/code-review-report.ts` (written under `content/`
 * per this item's placement instruction — see `content/schemas/debug-report.ts` for why).
 */
import { Type, type Static } from "typebox";

const Finding = Type.Object({
  file: Type.String(),
  line: Type.Number(),
  issue: Type.String(),
  why: Type.String(),
  fix: Type.String(),
});

export const CodeReviewReport = Type.Object({
  scope: Type.String({ description: "files changed, lines added/removed" }),
  verdict: Type.Union([
    Type.Literal("approve"),
    Type.Literal("approve_with_changes"),
    Type.Literal("request_changes"),
  ]),
  blockers: Type.Array(Finding),
  major: Type.Array(Finding),
  minor: Type.Array(Finding),
  nits: Type.Array(
    Type.Object({
      file: Type.String(),
      line: Type.Number(),
      issue: Type.String(),
    }),
  ),
  praise: Type.Array(
    Type.Object({
      file: Type.String(),
      line: Type.Number(),
      note: Type.String(),
    }),
  ),
  testCoverageGaps: Type.Array(Type.String()),
  recommendedTests: Type.Array(Type.String()),
});
export type CodeReviewReport = Static<typeof CodeReviewReport>;

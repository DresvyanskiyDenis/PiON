/**
 * Structured return schema for the `security-reviewer` agent (`content/agents/security-reviewer.md`,
 * `returns: object`). Modeled on that agent's own "Report format" (a severity-ranked findings table,
 * tools run, items skipped, prioritized next actions).
 *
 * `deployApproved` is derived, not free-text: the agent's own Gotchas say "do not approve a deploy with
 * any Critical or High open" — encoding it as a boolean the caller can branch on, instead of a sentence
 * a caller would have to re-parse, is the whole point of `returns: object` over `returns: text`.
 *
 * Integration placement: belongs at `config/schemas/security-review-report.ts` (written under
 * `content/` per this item's placement instruction).
 */
import { Type, type Static } from "typebox";

export const SecurityReviewReport = Type.Object({
  findings: Type.Array(
    Type.Object({
      severity: Type.Union([
        Type.Literal("critical"),
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
        Type.Literal("info"),
      ]),
      title: Type.String(),
      location: Type.String({ description: "file:line" }),
      whyItMatters: Type.String(),
      fixSketch: Type.String(),
    }),
  ),
  toolsRun: Type.Array(
    Type.Object({
      tool: Type.String(),
      summary: Type.String(),
    }),
  ),
  skipped: Type.Array(
    Type.Object({
      item: Type.String(),
      why: Type.String(),
    }),
  ),
  nextActions: Type.Array(Type.String({ description: "priority order" })),
  deployApproved: Type.Boolean({ description: "false if any Critical or High finding is open" }),
});
export type SecurityReviewReport = Static<typeof SecurityReviewReport>;

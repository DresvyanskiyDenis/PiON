/**
 * Structured return schema for the `architect-reviewer` agent (`content/agents/architect-reviewer.md`,
 * `returns: object`). Modeled on that agent's own "Report format" fenced block (change scope,
 * architectural impact + verdict, findings with a refactor sketch, praise, decision record).
 *
 * Integration placement: belongs at `config/schemas/architect-review-report.ts` (written under
 * `content/` per this item's placement instruction).
 */
import { Type, type Static } from "typebox";

const Impact = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);

export const ArchitectReviewReport = Type.Object({
  changeScope: Type.String({ description: "modules/services touched" }),
  architecturalImpact: Impact,
  impactJustification: Type.String({ description: "one sentence" }),
  verdict: Type.Union([
    Type.Literal("proceed"),
    Type.Literal("proceed_with_adjustments"),
    Type.Literal("redesign_needed"),
  ]),
  findings: Type.Array(
    Type.Object({
      name: Type.String(),
      severity: Impact,
      boundary: Type.String({ description: "e.g. 'module A -> module B'" }),
      issue: Type.String(),
      consequence: Type.String({ description: "over 6-12 months" }),
      refactorSketch: Type.String({ description: "2-4 lines, not a full implementation" }),
      files: Type.Array(Type.String()),
    }),
  ),
  praise: Type.Array(Type.String()),
  decisionRecord: Type.Optional(
    Type.String({ description: "2-3 lines suitable for an ADR, only when this is a deliberate tradeoff" }),
  ),
});
export type ArchitectReviewReport = Static<typeof ArchitectReviewReport>;

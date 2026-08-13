/**
 * Structured return schema for the `debugger` agent (`content/agents/debugger.md`, `returns: object`).
 * Verbatim from the content-port spec's worked example, with the import path corrected: that spec's
 * own prose uses `@sinclair/typebox`, but every extension actually built in this repo imports the bare
 * `typebox` package (confirmed against `extensions/dispatch/registry.ts`, `extensions/teammates/*.ts`,
 * `extensions/big-results/index.ts`, `extensions/jobs/index.ts` — all five agree). This file follows the
 * repo's real convention, not the doc's.
 *
 * Integration placement: this file is written under `content/schemas/` per this item's instruction not to
 * place anything at the repo root. It belongs at `config/schemas/debug-report.ts` — the path every agent
 * body in `content/agents/` already cites in its "Report format" section.
 */
import { Type, type Static } from "typebox";

export const DebugReport = Type.Object({
  failure: Type.String({ description: "exact error + the command that reproduces it" }),
  rootCause: Type.String({ description: "one sentence: the invariant that was violated" }),
  fix: Type.Object({
    file: Type.String(),
    line: Type.Number(),
    change: Type.String(),
  }),
  regressionTest: Type.Object({
    file: Type.String(),
    test: Type.String(),
    asserts: Type.String(),
  }),
  verification: Type.Array(
    Type.Object({
      command: Type.String(),
      result: Type.String(),
    }),
  ),
  residualRisk: Type.String(),
});
export type DebugReport = Static<typeof DebugReport>;

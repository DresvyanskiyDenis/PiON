import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  denyWithEscapeHatch,
  extractJustification,
  JUSTIFY_TOKEN,
  stripJustification,
} from "../../extensions/lib/escape-hatch.ts";

/**
 * Mirrors what a gate actually does: deny, hand the reason to the model, and re-parse the
 * command the model sends back. The reason string is the only channel, so if the emitted
 * instructions do not produce something the extractor accepts, the hatch does not exist.
 */
function reissueFromReason(reason: string, command: string, why: string): string {
  const m = /"(# PI-JUSTIFY\([^)]+\)): <[^>]+>"/.exec(reason);
  assert.ok(m, `the reason must spell the exact syntax; got: ${reason}`);
  return `${m[1]}: ${why}\n${command}`;
}

describe("escape hatch", () => {
  it("round trip: the emitted reason produces something the extractor accepts", () => {
    const denial = denyWithEscapeHatch({
      gateId: "DB-RM-ROOT",
      what: "recursive force-remove of a path outside the project",
      overridable: true,
    });
    assert.equal(denial.block, true);

    const command = "rm -rf /Users/x/scratch/old-build";
    const reissued = reissueFromReason(
      denial.reason,
      command,
      "clearing a stale scratch build tree that a failed installer left behind",
    );

    const j = extractJustification(reissued, "DB-RM-ROOT");
    assert.ok(j, "the extractor must accept a justification written to the emitted syntax");
    assert.equal(j.gateId, "DB-RM-ROOT");
    assert.match(j.text, /stale scratch build tree/);
    assert.equal(stripJustification(reissued, "DB-RM-ROOT"), `${command}`);
  });

  it("legitimateUse is included when given", () => {
    // A fictional gate id on purpose. This exercises the message formatter, not any real gate, and
    // a real id here would read as documentation: `SEC-ENV` used to sit in this slot and implied
    // that SEC refuses with an escape hatch — which was never true, and since 2026-08-15 SEC does
    // not refuse at all.
    const { reason } = denyWithEscapeHatch({
      gateId: "XX-EXAMPLE",
      what: "an example refusal",
      legitimateUse: "This is the legitimate-use sentence.",
      overridable: true,
    });
    assert.match(reason, /This is the legitimate-use sentence\./);
    assert.match(reason, new RegExp(JUSTIFY_TOKEN));
  });

  it("hard gate: no override is offered and no syntax is spelled", () => {
    const { reason } = denyWithEscapeHatch({
      gateId: "DB-RM-SLASH",
      what: "rm -rf /",
      overridable: false,
    });
    assert.match(reason, /This gate has no override\. Do not retry; change the approach\./);
    assert.equal(reason.includes(JUSTIFY_TOKEN), false);
    assert.equal(extractJustification(reason, "DB-RM-SLASH"), null);
  });

  it("degenerate: a justification that restates the command is rejected", () => {
    const raw = "# PI-JUSTIFY(DB-RM-ROOT): rm -rf /Users/x/scratch/old-build\nrm -rf /Users/x/scratch/old-build";
    assert.equal(extractJustification(raw, "DB-RM-ROOT"), null);
  });

  it("degenerate: a justification that merely wraps the command is rejected", () => {
    const raw = "# PI-JUSTIFY(G): I need to run rm -rf ./build right now please\nrm -rf ./build";
    assert.equal(extractJustification(raw, "G"), null);
  });

  it("too short is rejected", () => {
    const raw = "# PI-JUSTIFY(G): because\nrm -rf ./build";
    assert.equal(extractJustification(raw, "G"), null);
  });

  it("a justification for a different gate id does not unlock this gate", () => {
    const raw =
      "# PI-JUSTIFY(OTHER-GATE): a perfectly good and sufficiently long explanation here\nrm -rf ./build";
    assert.equal(extractJustification(raw, "DB-RM-ROOT"), null);
  });

  it("gate ids containing regex metacharacters are matched literally", () => {
    const raw = "# PI-JUSTIFY(A.B+C): removing the vendored copy that the new lockfile replaced\ncmd";
    assert.ok(extractJustification(raw, "A.B+C"));
    assert.equal(extractJustification(raw, "AXBBC"), null);
  });

  it("is case-insensitive on the token and tolerant of spacing", () => {
    const raw = "   #   pi-justify(G)  :   removing the vendored copy the new lockfile replaced\ncmd";
    const j = extractJustification(raw, "G");
    assert.ok(j);
    assert.equal(j.text, "removing the vendored copy the new lockfile replaced");
  });

  it("stripJustification leaves an unjustified command untouched", () => {
    assert.equal(stripJustification("rm -rf ./build", "G"), "rm -rf ./build");
  });

  it("stripJustification removes only the matching gate's line", () => {
    const raw = "# PI-JUSTIFY(A): reason one that is comfortably long\n# PI-JUSTIFY(B): reason two that is comfortably long\ncmd";
    assert.equal(
      stripJustification(raw, "A"),
      "# PI-JUSTIFY(B): reason two that is comfortably long\ncmd",
    );
  });

  it("the justification may sit anywhere in a multi-line command", () => {
    const raw = "set -e\n# PI-JUSTIFY(G): rotating the expired signing key on the build host\nrm -rf ./build";
    const j = extractJustification(raw, "G");
    assert.ok(j);
    assert.equal(stripJustification(raw, "G"), "set -e\nrm -rf ./build");
  });
});

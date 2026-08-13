/**
 * `EXT-10` × `EXT-30` — who owns the terminal response when a guardrail did not load.
 *
 * Before the EXT-30 hand-off the same condition produced two answers: `trust.ts`'s deadman blocked
 * bash/write/edit/multiedit and pinned `GUARD OFF`, and a moment later `doctor.ts`'s D-06 called
 * `ctx.shutdown()` and killed the session anyway. `deadmanOwns` is the deferral: D-06 keeps
 * shouting, the deadman keeps the session. This file pins the *conditions* of that deferral,
 * because a blanket "D-06 never shuts down" would be a real loss of safety.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { deadmanOwns } from "../../extensions/doctor.ts";
import type { Finding } from "../../extensions/doctor/types.ts";
import { DEADMAN_BLOCKED_TOOLS } from "../../extensions/trust.ts";
import {
  DECLARED_MODULES,
  declareModule,
  manifestReport,
  moduleStatus,
  recordLoad,
  recordLoadFailure,
  resetManifest,
} from "../../extensions/lib/manifest.ts";

afterEach(resetManifest);

/** Every declared module loads except the ones named; `trust` also reaches `session_start`. */
function loadAllExcept(...skip: string[]): void {
  resetManifest();
  for (const moduleId of DECLARED_MODULES) {
    if (!skip.includes(moduleId)) recordLoad(moduleId);
  }
  if (!skip.includes("trust")) {
    declareModule({ id: "trust", version: "1.0.0", events: ["session_start"], apis: ["on"] });
  }
}

function guardMissing(subject = "guard"): Finding {
  return {
    check: "D-06",
    severity: "error",
    subject,
    message: `${subject} did not load`,
    action: "run /doctor",
  };
}

describe("deadmanOwns — the deferral", () => {
  it("defers when guard is absent and the deadman armed for it", () => {
    loadAllExcept("guard");
    const line = deadmanOwns([guardMissing()]);
    assert.ok(line, "D-06 must defer to the armed deadman");
    assert.match(line!, /trust deadman owns the response/);
    assert.match(line!, /GUARD OFF/);
    for (const tool of DEADMAN_BLOCKED_TOOLS) assert.match(line!, new RegExp(tool));
  });

  it("defers when hooks is absent — the widened guardrail set is honoured too", () => {
    loadAllExcept("hooks");
    assert.ok(deadmanOwns([guardMissing("hooks")]));
  });

  it("says why a shutdown would be wrong, not merely that it was skipped", () => {
    // Reason 1 of the three in `deadmanOwns`'s docstring: every remediation this module prints
    // ends in "run /doctor", and shutting down at session_start is what makes that impossible.
    loadAllExcept("guard");
    assert.match(deadmanOwns([guardMissing()])!, /kill the session before you could run \/doctor/);
  });

  it("does NOT defer when trust itself is absent — nothing armed, so D-06 must shut down", () => {
    loadAllExcept("guard", "trust");
    assert.equal(moduleStatus("trust").state, "absent");
    assert.equal(deadmanOwns([guardMissing()]), undefined);
  });

  it("does NOT defer when trust loaded but never reached session_start", () => {
    // The heartbeat is the proof that `armDeadman` ran to completion. Without it, `trust.register`
    // returning tells us nothing about whether the tools are actually blocked.
    resetManifest();
    for (const moduleId of DECLARED_MODULES) if (moduleId !== "guard") recordLoad(moduleId);
    assert.equal(moduleStatus("trust").state, "loaded");
    assert.equal(moduleStatus("trust").heartbeat, false);
    assert.equal(deadmanOwns([guardMissing()]), undefined);
  });

  it("does NOT defer when trust's own register() threw", () => {
    loadAllExcept("guard", "trust");
    recordLoadFailure("trust", new TypeError("boom"));
    assert.equal(deadmanOwns([guardMissing()]), undefined);
  });

  it("does NOT defer for a subverted-but-loaded guard — the deadman's blind spot", () => {
    // `checkGuard()` raises subject "guard/patterns.ts" when matchDangerous no longer matches
    // DB-RM-ROOT. The module loaded, so the deadman is disarmed by construction: nothing is
    // blocked, nothing says GUARD OFF, and shutting down is the only honest response.
    loadAllExcept();
    const patternsBroken: Finding = {
      check: "D-06",
      severity: "error",
      subject: "guard/patterns.ts",
      message: "DB-RM-ROOT no longer matches rm -rf /",
      action: "fix extensions/guard/patterns.ts",
    };
    assert.equal(deadmanOwns([patternsBroken]), undefined);
  });

  it("does NOT defer when only SOME of the D-06 errors are covered by the verdict", () => {
    loadAllExcept("guard");
    const patternsBroken: Finding = {
      check: "D-06",
      severity: "error",
      subject: "guard/patterns.ts",
      message: "DB-RM-ROOT no longer matches rm -rf /",
      action: "fix extensions/guard/patterns.ts",
    };
    assert.equal(deadmanOwns([guardMissing(), patternsBroken]), undefined);
  });

  it("returns undefined for an empty finding list — no condition, no deferral", () => {
    loadAllExcept("guard");
    assert.equal(deadmanOwns([]), undefined);
  });

  it("accepts an explicit report and trust status, so the rule is testable in isolation", () => {
    loadAllExcept("guard");
    const report = manifestReport();
    assert.ok(deadmanOwns([guardMissing()], report, moduleStatus("trust")));
    assert.equal(
      deadmanOwns([guardMissing()], report, { ...moduleStatus("trust"), heartbeat: false }),
      undefined,
    );
  });
});

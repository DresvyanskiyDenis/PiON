/**
 * `REQ-EXT-15`'s deliverable: the ported harness, driven through the REAL composed gates rather
 * than through the regexes alone. A pattern that matches but sits behind a gate that never runs
 * is not a guardrail, and only end-to-end evaluation catches that.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MUST_BLOCK,
  MUST_BLOCK_EXTRA,
  MUST_PASS,
  MUST_PASS_EXTRA,
} from "../../extensions/guard/__tests__/patterns.table.ts";
import {
  DANGER_PATTERNS,
  matchDangerous,
  normalizeFlagRuns,
} from "../../extensions/guard/patterns.ts";
import { bashEvent, fakeCtx, recorder, runRules, safetyRules, testPolicy } from "./helpers.ts";

async function verdict(command: string) {
  const rec = recorder();
  const rules = safetyRules(testPolicy(), rec.services);
  return runRules(rules, bashEvent(command), fakeCtx({}, rec), rec.services);
}

describe("the ported table — REQ-EXT-15", () => {
  it("blocks all 21 MUST_BLOCK commands, each with the expected gate id", async () => {
    const failures: string[] = [];
    for (const [command, gateId] of MUST_BLOCK) {
      const result = await verdict(command);
      if (!result.blocked) failures.push(`NOT BLOCKED: ${command}`);
      else if (result.gateId !== gateId) {
        failures.push(`${command}: expected ${gateId}, got ${result.gateId}`);
      }
    }
    assert.deepEqual(failures, []);
    assert.equal(MUST_BLOCK.length, 21);
  });

  it("passes all 10 MUST_PASS commands — the design rule", async () => {
    const failures: string[] = [];
    for (const command of MUST_PASS) {
      const result = await verdict(command);
      if (result.blocked) failures.push(`BLOCKED by ${result.gateId}: ${command}`);
    }
    assert.deepEqual(failures, []);
    assert.equal(MUST_PASS.length, 10);
  });

  it("blocks the added cases (PRV-*, tokeniser, the two SEC patterns §6.4 omitted)", async () => {
    const failures: string[] = [];
    for (const [command, gateId] of MUST_BLOCK_EXTRA) {
      const result = await verdict(command);
      if (!result.blocked) failures.push(`NOT BLOCKED: ${command}`);
      else if (result.gateId !== gateId) {
        failures.push(`${command}: expected ${gateId}, got ${result.gateId}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("passes the added ordinary-work cases", async () => {
    const failures: string[] = [];
    for (const command of MUST_PASS_EXTRA) {
      const result = await verdict(command);
      if (result.blocked) failures.push(`BLOCKED by ${result.gateId}: ${command}`);
    }
    assert.deepEqual(failures, []);
  });

  it("every blocked command names its gate in a reason the model can read", async () => {
    for (const [command, gateId] of MUST_BLOCK) {
      const result = await verdict(command);
      assert.match(result.reason ?? "", new RegExp(`^Blocked by gate ${gateId}:`), command);
      assert.ok((result.reason ?? "").length > 40, command);
    }
  });
});

describe("patterns.ts", () => {
  it("carries all eight ported patterns, mkfs restored", () => {
    assert.equal(DANGER_PATTERNS.length, 8);
    assert.ok(DANGER_PATTERNS.some((p) => p.id === "DB-MKFS"));
  });

  it("the rm matcher is flag-order agnostic in both directions — the historic escape", () => {
    for (const command of ["rm -rf /", "rm -fr /", "rm -Rf /", "rm -fR /", "rm -rvf /"]) {
      assert.ok(matchDangerous(command), command);
    }
  });

  it("only DB-SHUTDOWN is program-scoped; the other seven match raw text", () => {
    const programScoped = DANGER_PATTERNS.filter((p) => p.scope === "program").map((p) => p.id);
    assert.deepEqual(programScoped, ["DB-SHUTDOWN"]);
  });

  it("exactly two danger patterns are overridable", () => {
    assert.deepEqual(
      DANGER_PATTERNS.filter((p) => p.overridable).map((p) => p.id),
      ["DB-CURL-SH", "DB-SHUTDOWN"],
    );
  });
});

describe("normalizeFlagRuns — the backtracking bound", () => {
  it("collapses a repeated single-dash cluster and leaves everything else alone", () => {
    assert.equal(normalizeFlagRuns("rm -rrrfff /"), "rm -rf /");
    assert.equal(normalizeFlagRuns("rm --recursive --force /"), "rm --recursive --force /");
    assert.equal(normalizeFlagRuns("git push --force-with-lease"), "git push --force-with-lease");
    assert.equal(normalizeFlagRuns("wget -qO- http://x"), "wget -qO- http://x");
    assert.equal(normalizeFlagRuns("src/file-name.txt"), "src/file-name.txt");
  });

  it("a padded flag cluster is still caught — the evasion the bound must not open", () => {
    assert.equal(matchDangerous("rm -rrrrrrffffff /")?.id, "DB-RM-ROOT");
    assert.equal(matchDangerous("rm -" + "r".repeat(400) + "f".repeat(400) + " ~")?.id, "DB-RM-ROOT");
  });

  it("a pathological flag run resolves in milliseconds, not seconds", () => {
    const input = `rm -${"r".repeat(20000)}${"f".repeat(20000)}`;
    const started = performance.now();
    matchDangerous(input);
    const elapsed = performance.now() - started;
    // Measured at 2093 ms for 1400+1400 before the fix; 1.5 ms for 20000+20000 after it.
    assert.ok(elapsed < 250, `took ${elapsed.toFixed(1)}ms`);
  });
});

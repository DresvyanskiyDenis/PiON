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
  MUST_OBSERVE,
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
  const result = await runRules(rules, bashEvent(command), fakeCtx({}, rec), rec.services);
  return { ...result, rec };
}

describe("the ported table — REQ-EXT-15", () => {
  it("blocks all 18 MUST_BLOCK commands, each with the expected gate id", async () => {
    const failures: string[] = [];
    for (const [command, gateId] of MUST_BLOCK) {
      const result = await verdict(command);
      if (!result.blocked) failures.push(`NOT BLOCKED: ${command}`);
      else if (result.gateId !== gateId) {
        failures.push(`${command}: expected ${gateId}, got ${result.gateId}`);
      }
    }
    assert.deepEqual(failures, []);
    // 21 until 2026-08-14: `git reset --hard HEAD~5` moved to MUST_PASS.
    // 20 until 2026-08-15: the two `SEC-*` rows moved to MUST_OBSERVE with the rest of that gate.
    assert.equal(MUST_BLOCK.length, 18);
  });

  it("passes all 11 MUST_PASS commands — the design rule", async () => {
    const failures: string[] = [];
    for (const command of MUST_PASS) {
      const result = await verdict(command);
      if (result.blocked) failures.push(`BLOCKED by ${result.gateId}: ${command}`);
    }
    assert.deepEqual(failures, []);
    assert.equal(MUST_PASS.length, 11);
  });

  it("permits and RECORDS every MUST_OBSERVE command — audit-only is still a verdict", async () => {
    const failures: string[] = [];
    for (const [command, gateId] of MUST_OBSERVE) {
      const result = await verdict(command);
      if (result.blocked) {
        failures.push(`BLOCKED by ${result.gateId}: ${command}`);
        continue;
      }
      const observed = result.rec.audit
        .filter(([type]) => type === "guard.observed")
        .map(([, data]) => (data as { gateId: string }).gateId);
      if (observed.length !== 1 || observed[0] !== gateId) {
        failures.push(`${command}: expected one ${gateId}, got ${JSON.stringify(observed)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("every MUST_OBSERVE record carries the tool call it came from", async () => {
    // A record with no `toolCallId` cannot be tied back to anything in the transcript, which makes
    // it decoration rather than observability.
    const { rec } = await verdict("sudo apt-get install nmap");
    const entry = rec.audit.find(([type]) => type === "guard.observed")?.[1] as {
      toolCallId: string;
      toolName: string;
      what: string;
      at: number;
    };
    assert.equal(entry.toolCallId, "tc-1");
    assert.equal(entry.toolName, "bash");
    assert.ok(entry.what.length > 10);
    assert.ok(entry.at > 0);
  });

  it("blocks the added cases (tokeniser, shutdown, git history rewrites)", async () => {
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

  it("ordinary work is not recorded either — a log that records everything records nothing", async () => {
    const failures: string[] = [];
    for (const command of [...MUST_PASS, ...MUST_PASS_EXTRA]) {
      const { rec } = await verdict(command);
      const observed = rec.audit.filter(([type]) => type === "guard.observed");
      if (observed.length > 0) failures.push(`${command}: ${JSON.stringify(observed[0])}`);
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

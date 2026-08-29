import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkGuidelines,
  EXPECTED_GUARD_SELF_TEST_PATTERN_ID,
  type DoctorInputs,
} from "../../extensions/doctor/checks.ts";
import { ACKNOWLEDGED_GUIDELINES, type GuidelineDisposition } from "../../extensions/doctor/guidelines.ts";

const DISPOSITIONS: readonly GuidelineDisposition[] = ["system-prompt", "tool-contract", "elsewhere", "dropped"];

function inputsFor(tool: string, guidelines: readonly string[]): DoctorInputs {
  return {
    systemPrompt: "",
    liveToolNames: [],
    declaredToolNames: [],
    declaredSkillIds: [],
    liveSkillIds: [],
    agents: { rootExists: false, ids: [] },
    routingTiers: [],
    availableModels: [],
    manifest: { declared: [], loaded: [], failed: [], absent: [] },
    guard: { moduleLoaded: true, handshakeObserved: false, selfTestPatternId: EXPECTED_GUARD_SELF_TEST_PATTERN_ID },
    declaredServerNames: [],
    packages: [],
    hooksDegradedReason: undefined,
    toolGuidelines: [{ tool, guidelines }],
  };
}

function splitKey(key: string): { tool: string; index: number } {
  const sep = key.lastIndexOf(":");
  return { tool: key.slice(0, sep), index: Number(key.slice(sep + 1)) };
}

describe("D-10 ledger shape", () => {
  it("every key is <tool>:<index> with a non-negative integer index", () => {
    for (const key of Object.keys(ACKNOWLEDGED_GUIDELINES)) {
      assert.match(key, /^[a-z_][a-z0-9_]*:\d+$/, `malformed ledger key: ${key}`);
    }
  });

  it("every row carries a known disposition and a marker long enough to detect a reword", () => {
    for (const [key, [disposition, marker]] of Object.entries(ACKNOWLEDGED_GUIDELINES)) {
      assert.ok(DISPOSITIONS.includes(disposition), `${key}: unknown disposition "${disposition}"`);
      // A marker of one or two characters would survive almost any rewording, which defeats the
      // drift half of the check: the row would keep claiming a disposition the text no longer earns.
      assert.ok(marker.trim().length >= 8, `${key}: marker "${marker}" is too short to detect drift`);
    }
  });

  it("each tool's indices run 0..n-1 — a gap means a row was written against the wrong index", () => {
    const byTool = new Map<string, number[]>();
    for (const key of Object.keys(ACKNOWLEDGED_GUIDELINES)) {
      const { tool, index } = splitKey(key);
      byTool.set(tool, [...(byTool.get(tool) ?? []), index]);
    }
    for (const [tool, indices] of byTool) {
      const sorted = [...indices].sort((a, b) => a - b);
      assert.deepEqual(sorted, [...sorted.keys()], `${tool}: ledger indices are not 0..n-1`);
    }
  });

  it("every row matches itself: replaying its own marker as the live text produces no finding", () => {
    // The marker is by definition a substring of the text it was taken from, so a guideline made
    // only of the marker has to pass. A mistyped marker fails here rather than at runtime.
    const byTool = new Map<string, string[]>();
    for (const [key, [, marker]] of Object.entries(ACKNOWLEDGED_GUIDELINES)) {
      const { tool, index } = splitKey(key);
      const list = byTool.get(tool) ?? [];
      list[index] = marker;
      byTool.set(tool, list);
    }
    for (const [tool, guidelines] of byTool) {
      assert.deepEqual(checkGuidelines(inputsFor(tool, guidelines)), [], `${tool}: ledger row does not match itself`);
    }
  });
});

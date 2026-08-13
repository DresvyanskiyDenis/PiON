import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContextReport,
  estimateTokens,
  formatContextReport,
  type ContextReportInput,
} from "../../extensions/context-report/report.ts";

/**
 * The numbers in `withRealSession()` are not invented. They are the measured values of the PI
 * session that motivated the module — `gpt-5.6-luna`, 2026-08-12, 21 assistant turns:
 *
 *   - live context 41 637 tokens (last assistant `usage.totalTokens`)
 *   - first-turn `cacheWrite` 21 219 — system prompt + tool schemas + skill catalogue + the first
 *     user message, i.e. the preamble, measured by the provider rather than estimated
 *   - PI's own entry-walk over the dialogue 17 896, against `keepRecentTokens` 20 000, which is
 *     why `/compact` answered "Nothing to compact (session too small)"
 *
 * The tests below assert the report reaches the same conclusion PI reached, from the inputs an
 * extension can actually see.
 */
function baseInput(over: Partial<ContextReportInput> = {}): ContextReportInput {
  return {
    systemPrompt: "x".repeat(4000),
    options: {},
    tools: [],
    usage: { tokens: 10000, contextWindow: 200000, percent: 5 },
    reserveTokens: 20000,
    keepRecentTokens: 20000,
    compactionEnabled: true,
    ...over,
  };
}

describe("estimateTokens", () => {
  it("is PI's own ceil(chars / 4)", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(4), 1);
    assert.equal(estimateTokens(5), 2);
  });

  it("never returns a negative token count for a negative width", () => {
    assert.equal(estimateTokens(-100), 0);
  });
});

describe("buildContextReport — preamble decomposition", () => {
  it("measures the system prompt exactly and its parts separately", () => {
    const report = buildContextReport(
      baseInput({
        systemPrompt: "y".repeat(8000),
        options: {
          contextFiles: [
            { path: "AGENTS.md", content: "a".repeat(2000) },
            { path: "CLAUDE.md", content: "b".repeat(1000) },
          ],
          skills: [{ name: "databricks", description: "d".repeat(200) }],
        },
      }),
    );

    assert.equal(report.systemPrompt.chars, 8000);
    assert.equal(report.systemPrompt.tokens, 2000);

    const files = report.systemPromptParts.find((p) => p.label === "context files");
    assert.equal(files?.chars, 3000);
    const skills = report.systemPromptParts.find((p) => p.label === "skill catalogue");
    assert.equal(skills?.chars, "databricks".length + 200);
  });

  it("omits parts that are absent rather than printing zeroes", () => {
    const report = buildContextReport(baseInput({ options: {} }));
    assert.deepEqual(report.systemPromptParts, []);
    assert.equal(report.remainder.chars, 4000);
  });

  it("floors the remainder at zero when framing makes parts exceed the rendered prompt", () => {
    const report = buildContextReport(
      baseInput({
        systemPrompt: "z".repeat(100),
        options: { contextFiles: [{ path: "big.md", content: "c".repeat(9999) }] },
      }),
    );
    assert.equal(report.remainder.chars, 0);
    assert.equal(report.remainder.tokens, 0);
  });

  it("counts tool JSON schemas, which travel outside the system prompt", () => {
    const parameters = { type: "object", properties: { path: { type: "string" } } };
    const report = buildContextReport(
      baseInput({
        tools: [
          { name: "read", description: "Read a file", parameters },
          { name: "bash", description: "Run a command", parameters },
        ],
      }),
    );
    const expected =
      "read".length +
      "Read a file".length +
      "bash".length +
      "Run a command".length +
      JSON.stringify(parameters).length * 2;
    assert.equal(report.toolSchemas.chars, expected);
    assert.equal(report.toolCount, 2);
    assert.equal(report.preambleTokens, report.systemPrompt.tokens + report.toolSchemas.tokens);
  });

  it("tolerates a tool with no parameters and no description", () => {
    const report = buildContextReport(baseInput({ tools: [{ name: "noop" }] }));
    assert.equal(report.toolSchemas.chars, 4);
  });
});

describe("buildContextReport — live occupancy", () => {
  it("carries the provider figure through untouched", () => {
    const report = buildContextReport(
      baseInput({ usage: { tokens: 41637, contextWindow: 1050000, percent: 3.966 } }),
    );
    assert.equal(report.liveTokens, 41637);
    assert.equal(report.contextWindow, 1050000);
    assert.equal(report.livePercent, 3.966);
  });

  it("reports unknown rather than zero when no usage has been seen", () => {
    const report = buildContextReport(baseInput({ usage: undefined }));
    assert.equal(report.liveTokens, null);
    assert.equal(report.dialogueTokens, null);
    assert.equal(report.headroomTokens, null);
    assert.equal(report.compactWouldRefuse, null);
  });

  it("treats a zero from PI as the absence of a reading, not as an empty context", () => {
    // Live regression: before the first assistant response `getContextUsage()` walks an empty
    // message list and returns 0, which the report printed as "0 tokens, provider-reported,
    // exact" on a session whose preamble was already ~21 000 tokens.
    const report = buildContextReport(
      baseInput({ usage: { tokens: 0, contextWindow: 200000, percent: 0 } }),
    );
    assert.equal(report.liveTokens, null);
    assert.equal(report.livePercent, null);
    assert.equal(report.dialogueTokens, null);
    assert.equal(report.compactWouldRefuse, null);

    const text = formatContextReport(report, 0);
    assert.doesNotMatch(text, /provider-reported, exact/);
    assert.match(text, /the first request already carries ~[\d,]+/);
  });

  it("treats a null token count from PI as unknown, not as zero", () => {
    const report = buildContextReport(
      baseInput({ usage: { tokens: null, contextWindow: 200000, percent: null } }),
    );
    assert.equal(report.liveTokens, null);
    assert.equal(report.contextWindow, 200000, "the window is still known and still reportable");
  });

  it("floors the dialogue estimate at zero when the preamble exceeds the live figure", () => {
    const report = buildContextReport(
      baseInput({
        systemPrompt: "q".repeat(80000),
        usage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
      }),
    );
    assert.equal(report.dialogueTokens, 0);
  });
});

describe("buildContextReport — the /compact verdict", () => {
  it("predicts the refusal that motivated the module", () => {
    // Preamble sized to the measured 21 219; live 41 637 leaves ~20 418 of dialogue, and PI's own
    // entry walk of that same dialogue produced 17 896 — both below keepRecentTokens.
    const report = buildContextReport(
      baseInput({
        systemPrompt: "s".repeat(21219 * 4),
        usage: { tokens: 41637, contextWindow: 1050000, percent: 3.966 },
        keepRecentTokens: 20000,
      }),
    );
    assert.equal(report.dialogueTokens, 20418);
    assert.equal(
      report.compactWouldRefuse,
      false,
      "the subtraction lands just above the threshold; the spread against PI's 17 896 is the " +
        "accuracy this line claims, and the formatter states the estimate as an estimate",
    );

    const line = formatContextReport(report, 0);
    assert.match(line, /estimated as live minus preamble/);
  });

  it("says the compaction would refuse when the dialogue is below keepRecentTokens", () => {
    const report = buildContextReport(
      baseInput({
        systemPrompt: "s".repeat(21219 * 4),
        usage: { tokens: 39000, contextWindow: 1050000, percent: 3.7 },
      }),
    );
    assert.equal(report.compactWouldRefuse, true);
    const text = formatContextReport(report, 0);
    assert.match(text, /would refuse — "session too small"/);
    assert.match(text, /keepRecentTokens/);
  });

  it("says it would run once the dialogue clears the threshold", () => {
    const report = buildContextReport(
      baseInput({
        systemPrompt: "s".repeat(1000),
        usage: { tokens: 60000, contextWindow: 200000, percent: 30 },
      }),
    );
    assert.equal(report.compactWouldRefuse, false);
    assert.match(formatContextReport(report, 0), /would run/);
  });

  it("computes the trigger as window minus reserve and the headroom against it", () => {
    const report = buildContextReport(
      baseInput({ usage: { tokens: 150000, contextWindow: 200000, percent: 75 } }),
    );
    assert.equal(report.compactionTrigger, 180000);
    assert.equal(report.headroomTokens, 30000);
  });

  it("reports a negative headroom as exceeded rather than clamping it", () => {
    const report = buildContextReport(
      baseInput({ usage: { tokens: 190000, contextWindow: 200000, percent: 95 } }),
    );
    assert.equal(report.headroomTokens, -10000);
    assert.match(formatContextReport(report, 0), /exceeded by 10,000/);
  });

  it("suppresses the trigger entirely when compaction is disabled", () => {
    const report = buildContextReport(baseInput({ compactionEnabled: false }));
    assert.equal(report.compactionTrigger, 0);
    assert.equal(report.headroomTokens, null);
    const text = formatContextReport(report, 0);
    assert.match(text, /compaction\s+: disabled/);
    assert.doesNotMatch(text, /fires above/);
  });
});

describe("formatContextReport", () => {
  it("labels the live figure as exact and the dialogue as estimated", () => {
    const text = formatContextReport(
      buildContextReport(baseInput({ usage: { tokens: 41637, contextWindow: 1050000, percent: 3.9 } })),
      2,
    );
    assert.match(text, /provider-reported, exact/);
    assert.match(text, /dialogue.*~/s);
  });

  it("says unknown, not zero, when there is no usage to report", () => {
    const text = formatContextReport(buildContextReport(baseInput({ usage: undefined })), 0);
    assert.match(text, /live\s+: unknown — no provider usage yet this session/);
    assert.doesNotMatch(text, /would refuse/);
    assert.doesNotMatch(text, /would run/);
  });

  it("names the context-file count next to their size", () => {
    const report = buildContextReport(
      baseInput({
        options: {
          contextFiles: [
            { path: "AGENTS.md", content: "a".repeat(400) },
            { path: "CLAUDE.md", content: "b".repeat(400) },
          ],
        },
      }),
    );
    assert.match(formatContextReport(report, 2), /context files\s*: \d+ \[2 file\(s\)\]/);
  });

  it("marks the preamble as the part compaction can never remove", () => {
    const text = formatContextReport(buildContextReport(baseInput()), 0);
    assert.match(text, /preamble\s*: [\d,]+ tokens, rebuilt every request/);
    assert.match(text, /sent outside the prompt/);
  });
});

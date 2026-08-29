/**
 * EXT-11 — the pure helpers in `extensions/compaction/index.ts`, plus the shipped config file.
 *
 * The event handlers themselves need a live PI session and are covered by V-08 elsewhere;
 * what is unit-testable here is the config parser, the
 * entry-distance measurement the loop guard is fed, and the `REQ-CTX-31` threshold arithmetic.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  entriesSinceLastCompaction,
  parseConfig,
  thresholdReport,
} from "../../extensions/compaction/index.ts";
import {
  formatThresholdNotice,
  PI_DEFAULT_RESERVE_TOKENS,
  readReserveTokens,
  thresholdKey,
  UNIVERSAL_ABSOLUTE_TOKENS,
} from "../../extensions/compaction/threshold.ts";

const CONFIG_PATH = fileURLToPath(new URL("../../config/compaction.json", import.meta.url));

function entry(type: string): SessionEntry {
  return { type } as unknown as SessionEntry;
}

test("config/compaction.json parses and carries the shipped loop-guard values", () => {
  const parsed = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  assert.equal(parsed.loopGuard.maxNonReducingPasses, 3);
  assert.equal(parsed.loopGuard.minReductionRatio, 0.15);
  assert.equal(parsed.loopGuard.minEntriesBetweenPasses, 2);
  assert.equal(parsed.loopGuard.headlessExitCode, 91);
  assert.equal(parsed.instructions.enabled, true);
  assert.equal(parsed.pinned.enabled, true);
  assert.deepEqual([...parsed.pinned.sources], ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual({ ...parsed.pinned.facts }, { enabled: true, maxEntries: 40, maxBytes: 8000 });
});

test("no Soul-shaped source may be configured in the shipped config", () => {
  const parsed = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  for (const source of parsed.pinned.sources) {
    assert.doesNotMatch(source, /soul/i);
  }
});

test("parseConfig falls back to defaults on an empty or malformed object", () => {
  for (const raw of [null, {}, { compaction: {} }, { compaction: { loopGuard: "nonsense" } }]) {
    const parsed = parseConfig(raw);
    assert.equal(parsed.loopGuard.maxNonReducingPasses, 3);
    assert.equal(parsed.loopGuard.headlessExitCode, 91);
  }
});

test("parseConfig clamps maxNonReducingPasses to at least 1 — a 0 would trip instantly", () => {
  const parsed = parseConfig({ compaction: { loopGuard: { maxNonReducingPasses: 0 } } });
  assert.equal(parsed.loopGuard.maxNonReducingPasses, 1);
});

test("parseConfig keeps an explicit headlessExitCode of 0 (cancel without exiting)", () => {
  const parsed = parseConfig({ compaction: { loopGuard: { headlessExitCode: 0 } } });
  assert.equal(parsed.loopGuard.headlessExitCode, 0);
});

test("parseConfig drops non-string pinned sources instead of injecting them", () => {
  const parsed = parseConfig({ compaction: { pinned: { sources: ["AGENTS.md", 7, null] } } });
  assert.deepEqual([...parsed.pinned.sources], ["AGENTS.md"]);
});

test("entriesSinceLastCompaction returns -1 when the branch holds no compaction", () => {
  assert.equal(entriesSinceLastCompaction([]), -1);
  assert.equal(entriesSinceLastCompaction([entry("message"), entry("message")]), -1);
});

test("entriesSinceLastCompaction counts entries appended after the last compaction", () => {
  const branch = [entry("message"), entry("compaction"), entry("message"), entry("message")];
  assert.equal(entriesSinceLastCompaction(branch), 2);
});

test("a compaction as the newest entry counts as zero entries since", () => {
  assert.equal(entriesSinceLastCompaction([entry("message"), entry("compaction")]), 0);
});

test("only the most recent compaction is measured from", () => {
  const branch = [entry("compaction"), entry("message"), entry("compaction"), entry("message")];
  assert.equal(entriesSinceLastCompaction(branch), 1);
});

test("REQ-CTX-31: the effective trigger is contextWindow - reserveTokens", () => {
  const report = thresholdReport(200_000, 16_384, 0, 0.2);
  assert.equal(report.effectiveTrigger, 183_616);
  assert.equal(report.diverged, false); // absoluteTokens 0 disables the check
  assert.equal(report.verdict, "disabled");
});

test("a configured absolute close to the effective trigger does not warn", () => {
  const report = thresholdReport(200_000, 16_384, 180_000, 0.2);
  assert.equal(report.diverged, false);
  assert.ok(report.divergenceRatio < 0.05);
  assert.equal(report.verdict, "aligned");
});

test("a small-window model diverges hard from the configured absolute and says so", () => {
  const report = thresholdReport(64_000, 16_384, 180_000, 0.2);
  assert.equal(report.effectiveTrigger, 47_616);
  assert.equal(report.diverged, true);
  assert.ok(report.divergenceRatio > 0.7);
  assert.equal(report.verdict, "window-too-small");
});

test("a window that lands exactly on the configured absolute has nothing to say", () => {
  // databricks/databricks-claude-haiku-4-5 declares contextWindow 200000 in config/models.json
  // (litellm, which used to declare 150000 here, is deleted). At reserveTokens 20000 that puts
  // the effective trigger at exactly the configured absolute — zero divergence, verdict
  // "aligned" rather than the old "window-too-small" — so formatThresholdNotice is still null,
  // just for a different reason than before; this is the computed answer, not the old one forced.
  const report = thresholdReport(200_000, 20_000, 180_000, 0.2);
  assert.equal(report.verdict, "aligned");
  assert.equal(report.diverged, false);
  assert.equal(
    formatThresholdNotice("databricks", "databricks-claude-haiku-4-5", report, "global-settings"),
    null,
  );
});

test("the configuration this module was built for: 1M window + reserve 20000 compacts ~5.4x too late", () => {
  // 1000000 is what PI's bundled Copilot catalogue declares, and what this repo shipped until
  // 2026-08-12, when config/models.json gained modelOverrides capping every Copilot id at an
  // observed max_prompt_tokens. The unfixed case is kept as the
  // regression subject: it is exactly what a fresh install or a new catalogue id looks like.
  const report = thresholdReport(1_000_000, 20_000, 180_000, 0.2);
  assert.equal(report.effectiveTrigger, 980_000);
  assert.equal(report.verdict, "trigger-too-high");
  assert.equal(report.suggestedContextWindow, 200_000); // 180000 + 20000, exactly
});

test("the suggestion is a per-model contextWindow, never a global reserveTokens", () => {
  const report = thresholdReport(1_000_000, 20_000, 180_000, 0.2);
  const notice = formatThresholdNotice("github-copilot", "claude-opus-5", report, "global-settings");
  assert.ok(notice);
  assert.match(notice, /modelOverrides\["claude-opus-5"\]\.contextWindow = 200000/);
  // The old advice (compaction.reserveTokens = 820000) is destructive: the key is global, so it
  // makes contextWindow - reserveTokens negative for every smaller model in models.json.
  assert.doesNotMatch(notice, /setting compaction\.reserveTokens to/);
  assert.match(notice, /single global\s+scalar/);
  assert.match(notice, /REQ-PRV-04/); // the collision is stated, not hidden
});

test("a report that is already aligned or disabled produces no notice at all", () => {
  for (const report of [
    thresholdReport(200_000, 20_000, 180_000, 0.2), // exactly aligned
    thresholdReport(1_000_000, 20_000, 0, 0.2), // check disabled
  ]) {
    assert.equal(formatThresholdNotice("github-copilot", "claude-opus-5", report, "global-settings"), null);
  }
});

test("thresholdKey is stable, filesystem-safe and separates models", () => {
  const report = thresholdReport(1_000_000, 20_000, 180_000, 0.2);
  const opus = thresholdKey("github-copilot", "claude-opus-5", report);
  assert.equal(opus, thresholdKey("github-copilot", "claude-opus-5", report));
  assert.notEqual(opus, thresholdKey("github-copilot", "claude-sonnet-5", report));
  assert.doesNotMatch(opus, /[^A-Za-z0-9._-]/);
});

test("readReserveTokens prefers an observed pass, then project, then global, then PI's default", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-threshold-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });

  const ask = (observed?: number) =>
    readReserveTokens({ observed, agentDir, cwd, configDirName: ".pi" });

  assert.deepEqual(ask(), { value: PI_DEFAULT_RESERVE_TOKENS, source: "pi-default" });

  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 20_000 } }));
  assert.deepEqual(ask(), { value: 20_000, source: "global-settings" });

  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 8_192 } }));
  assert.deepEqual(ask(), { value: 8_192, source: "project-settings" });

  assert.deepEqual(ask(31_337), { value: 31_337, source: "compaction-event" });

  rmSync(dir, { recursive: true, force: true });
});

test("readReserveTokens falls through malformed settings rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-threshold-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: "20000" } }));

  assert.deepEqual(readReserveTokens({ agentDir, cwd, configDirName: ".pi" }), {
    value: PI_DEFAULT_RESERVE_TOKENS,
    source: "pi-default",
  });

  rmSync(dir, { recursive: true, force: true });
});

test("the shipped absolute threshold is the flat one, so session_start writes nothing", () => {
  const parsed = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  // A flat 200 000 on every model, not 180 000 — which was the trigger of the one model this file
  // used to be written for. The session_start hook writes only when the value differs, so a
  // shipped value that drifts off this makes every session start rewrite a tracked file.
  assert.equal(parsed.threshold.absoluteTokens, UNIVERSAL_ABSOLUTE_TOKENS);
  assert.equal(parsed.threshold.toleranceRatio, 0.2);
});

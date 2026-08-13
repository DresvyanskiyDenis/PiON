/**
 * EXT-11 — the keep/drop contract (`REQ-CTX-32`).
 *
 * The augment-never-replace half is asserted against PI's own shipped summariser, not against a
 * belief about it: `generateSummaryWithUsage` appends `\n\nAdditional focus: ${customInstructions}`
 * to its base prompt, and there is no replace flag on the compaction surface.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { KEEP_DROP_INSTRUCTIONS, mergeInstructions } from "../../extensions/compaction/instructions.ts";

/**
 * `@earendil-works/pi-coding-agent` does not expose `./package.json` in its `exports` map, so
 * `require.resolve` cannot be used to locate the install. The path is derived from the repo layout
 * instead, and a missing file fails loudly rather than skipping the assertion.
 */
function piDist(relative: string): string {
  const path = fileURLToPath(
    new URL(`../../node_modules/@earendil-works/pi-coding-agent/${relative}`, import.meta.url),
  );
  if (!existsSync(path)) throw new Error(`pi dist file not found: ${path}`);
  return path;
}

test("the contract names every keep item REQ-CTX-32 lists", () => {
  const text = KEEP_DROP_INSTRUCTIONS.toLowerCase();
  for (const needle of ["file", "intent", "todo", "error", "decision", "sub-agent", "constraint"]) {
    assert.ok(text.includes(needle), `keep list is missing "${needle}"`);
  }
});

test("the contract names every drop item REQ-CTX-32 lists", () => {
  const text = KEEP_DROP_INSTRUCTIONS.toLowerCase();
  for (const needle of ["tool trace", "search", "read again", "dead end"]) {
    assert.ok(text.includes(needle), `drop list is missing "${needle}"`);
  }
});

test("with no user instructions the contract is used verbatim", () => {
  assert.equal(mergeInstructions(undefined), KEEP_DROP_INSTRUCTIONS);
  assert.equal(mergeInstructions("   "), KEEP_DROP_INSTRUCTIONS);
});

test("the user's own /compact instructions come first and are never dropped", () => {
  const merged = mergeInstructions("focus on the parser rewrite");
  assert.ok(merged.startsWith("focus on the parser rewrite"));
  assert.ok(merged.includes(KEEP_DROP_INSTRUCTIONS));
});

test("merging is idempotent — a re-entrant call cannot stack the contract", () => {
  const once = mergeInstructions("focus on the parser");
  assert.equal(mergeInstructions(once), once);
});

test("PI 0.84.0 APPENDS customInstructions to its own template — it never replaces it", () => {
  const src = readFileSync(piDist("dist/core/compaction/compaction.js"), "utf8");
  assert.match(src, /basePrompt = `\$\{basePrompt\}\\n\\nAdditional focus: \$\{customInstructions\}`/);
});

test("PI's compaction surface has no replaceInstructions flag (only branch summaries do)", () => {
  const types = readFileSync(piDist("dist/core/extensions/types.d.ts"), "utf8");
  const compactOptions = types.slice(
    types.indexOf("export interface CompactOptions"),
    types.indexOf("export interface CompactOptions") + 300,
  );
  assert.doesNotMatch(compactOptions, /replaceInstructions/);
  // The flag does exist one surface over, which is exactly why this test is worth having.
  assert.match(types, /SessionBeforeTreeResult[\s\S]{0,400}replaceInstructions/);
});

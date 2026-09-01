// EXT-12a — statusline segment layout for @narumitw/pi-statusline 0.49.5.
//
// This module does not import the package's internals directly: Node refuses type-stripping
// for .ts files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, verified against
// this exact package during development), so the valid segment vocabulary below is a literal copy
// of node_modules/@narumitw/pi-statusline/src/types.ts's `SEGMENT_NAMES` (hand-verified against
// that file, not invented) rather than an import. Re-verify this list on any pi-statusline bump.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CONFIG_PATH = fileURLToPath(new URL("../config/pi-statusline.json", import.meta.url));

// node_modules/@narumitw/pi-statusline/src/types.ts — SEGMENT_NAMES
const VALID_SEGMENT_NAMES = [
  "brand",
  "provider",
  "model",
  "thinking",
  "cwd",
  "branch",
  "tools",
  "context",
  "tokens",
  "cache",
  "cost",
  "time",
  "turn",
] as const;

// The per-frame powerline is narrowed to the segments that actually MOVE turn to turn: context
// percentage, session cost, cwd, and branch + dirty count. Dirty count is not a segment of its
// own — it renders inside `branch`
// (node_modules/@narumitw/pi-statusline/src/render.ts:131-136 pulls `runtime.gitStatus` into the
// same case), which is what closes VP-13 and voids the old EXT-12 -> EXT-23 dependency.
// Session-invariant provider/model/thinking moved out of the per-frame powerline; they are still
// available at session start and via `/status` (that layout is upstream `@earendil-works/pi-tui`,
// out of this repo's scope). The quota segment (EXT-12b) is deliberately absent from this list —
// not this item's job.
const EXPECTED_SEGMENTS = ["context", "cost", "cwd", "branch"];

function loadConfig(): Record<string, unknown> {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

describe("config/pi-statusline.json", () => {
  it("is valid, parseable JSON", () => {
    assert.doesNotThrow(() => loadConfig());
  });

  it("declares only `segments` plus EXT-12b's icon map — everything else stays package default", () => {
    // Two keys and no more: the segment layout this item owns, and the extension status icon map
    // (EXT-12b, asserted in detail by test/ext-12b-quota-status-icon.test.ts). Any third key here
    // means something started overriding a pi-statusline default that was meant to stay default.
    const doc = loadConfig();
    assert.deepEqual(Object.keys(doc), ["segments", "extensionStatusIcons"]);
  });

  it("segments is a non-empty array", () => {
    const doc = loadConfig();
    assert.ok(Array.isArray(doc.segments));
    assert.ok((doc.segments as unknown[]).length > 0);
  });

  it("every configured segment is a name the installed package recognizes", () => {
    const doc = loadConfig();
    for (const segment of doc.segments as string[]) {
      assert.ok(
        (VALID_SEGMENT_NAMES as readonly string[]).includes(segment),
        `"${segment}" is not in @narumitw/pi-statusline's SEGMENT_NAMES`,
      );
    }
  });

  it("has no duplicate segments", () => {
    const doc = loadConfig();
    const segments = doc.segments as string[];
    assert.equal(new Set(segments).size, segments.length);
  });

  it("matches exactly the four moving segments left in the per-frame powerline, in order", () => {
    const doc = loadConfig();
    assert.deepEqual(doc.segments, EXPECTED_SEGMENTS);
  });

  it("does not include `quota` as a powerline SEGMENT — it renders as an extension status", () => {
    // EXT-12b is a `ctx.ui.setStatus` key rendered in the below-powerline extension-status row,
    // not a segment. The segment list must stay free of it; the icon map must carry it.
    const doc = loadConfig();
    assert.ok(!(doc.segments as string[]).includes("quota"));
  });

  it("carries EXT-12b's icon map as a plain object of string values", () => {
    const doc = loadConfig();
    const icons = doc.extensionStatusIcons as Record<string, unknown>;
    assert.ok(icons !== null && typeof icons === "object" && !Array.isArray(icons));
    assert.ok(Object.keys(icons).length > 0);
    for (const [key, value] of Object.entries(icons)) {
      assert.equal(typeof value, "string", `icon for "${key}" must be a string`);
      assert.ok((value as string).length > 0, `icon for "${key}" must not be empty`);
    }
  });

  it("does not include segments outside EXT-12a's named scope (tools/tokens/cache/time/turn/brand)", () => {
    const doc = loadConfig();
    const outOfScope = ["brand", "tools", "tokens", "cache", "time", "turn"];
    for (const segment of doc.segments as string[]) {
      assert.ok(!outOfScope.includes(segment), `"${segment}" is out of EXT-12a's scope`);
    }
  });
});

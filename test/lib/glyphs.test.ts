/**
 * `GLYPH`: one glyph, one meaning, and the set stays exactly the six named states.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GLYPH } from "../../extensions/lib/glyphs.ts";

describe("GLYPH", () => {
  it("has exactly the six named states, no more and no fewer", () => {
    assert.deepEqual(Object.keys(GLYPH).sort(), [
      "blocked",
      "collapse",
      "done",
      "expand",
      "failed",
      "pending",
      "running",
    ]);
  });

  it("matches the law's own vocabulary exactly", () => {
    assert.equal(GLYPH.expand, "▸");
    assert.equal(GLYPH.collapse, "▾");
    assert.equal(GLYPH.running, "●");
    assert.equal(GLYPH.done, "✓");
    assert.equal(GLYPH.pending, "○");
    assert.equal(GLYPH.failed, "✗");
    assert.equal(GLYPH.blocked, "⏸");
  });

  it("every value is unique — one glyph, one meaning means no two names may share a character", () => {
    const values = Object.values(GLYPH);
    assert.equal(new Set(values).size, values.length);
  });
});

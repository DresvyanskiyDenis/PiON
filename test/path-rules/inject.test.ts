import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { injectOnce, MARK_CLOSE, MARK_OPEN, stripBlock } from "../../extensions/path-rules/inject.ts";

describe("injectOnce / stripBlock", () => {
  it("appends the block wrapped in markers", () => {
    const out = injectOnce("base prompt", "rule text");
    assert.match(out, /base prompt/);
    assert.ok(out.includes(MARK_OPEN));
    assert.ok(out.includes(MARK_CLOSE));
    assert.ok(out.includes("rule text"));
  });

  it("is idempotent: injecting twice leaves exactly one block", () => {
    const once = injectOnce("base prompt", "rule text v1");
    const twice = injectOnce(once, "rule text v2");
    assert.equal(countOccurrences(twice, MARK_OPEN), 1);
    assert.equal(countOccurrences(twice, MARK_CLOSE), 1);
    assert.equal(twice.includes("rule text v1"), false, "the stale block must be gone, not appended twice");
    assert.ok(twice.includes("rule text v2"));
  });

  it("stripBlock removes a stacked (duplicated) marker pair entirely", () => {
    const stacked = `${MARK_OPEN}\nfirst\n${MARK_CLOSE}\n\n${MARK_OPEN}\nsecond\n${MARK_CLOSE}\n`;
    const stripped = stripBlock(`prefix\n\n${stacked}`);
    assert.equal(stripped.includes(MARK_OPEN), false);
    assert.equal(stripped.includes("first"), false);
    assert.equal(stripped.includes("second"), false);
    assert.match(stripped, /prefix/);
  });

  it("stripBlock is a no-op on a prompt with no injected block", () => {
    assert.equal(stripBlock("plain prompt"), "plain prompt");
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

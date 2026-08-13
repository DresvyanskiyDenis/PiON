import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { describeError, resetSurfaced, surfaceAlways, surfaceOnce } from "../../extensions/lib/once.ts";

describe("surfaceOnce", () => {
  beforeEach(() => resetSurfaced());

  it("emits on the first call and never again for the same key", () => {
    let n = 0;
    for (let i = 0; i < 10; i++) surfaceOnce(undefined, "k", () => n++);
    assert.equal(n, 1);
  });

  it("distinct keys are independent", () => {
    let n = 0;
    surfaceOnce(undefined, "a", () => n++);
    surfaceOnce(undefined, "b", () => n++);
    assert.equal(n, 2);
  });

  it("reports whether it emitted", () => {
    assert.equal(surfaceOnce(undefined, "k", () => {}), true);
    assert.equal(surfaceOnce(undefined, "k", () => {}), false);
  });

  it("an emitter that throws does not propagate — the fail-open paths depend on it", () => {
    assert.doesNotThrow(() =>
      surfaceOnce(undefined, "k", () => {
        throw new Error("no tty");
      }),
    );
  });

  it("a key that threw is still consumed, so a broken emitter cannot loop", () => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      surfaceOnce(undefined, "k", () => {
        n++;
        throw new Error("no tty");
      });
    }
    assert.equal(n, 1);
  });
});

describe("surfaceAlways — F2", () => {
  it("emits on every call for the same effective key, unlike surfaceOnce", () => {
    let n = 0;
    for (let i = 0; i < 10; i++) surfaceAlways(undefined, () => n++);
    assert.equal(n, 10);
  });

  it("an emitter that throws does not propagate", () => {
    assert.doesNotThrow(() =>
      surfaceAlways(undefined, () => {
        throw new Error("no tty");
      }),
    );
  });
});

describe("describeError", () => {
  it("names the error class and message", () => {
    assert.equal(describeError(new TypeError("nope")), "TypeError: nope");
  });

  it("includes an errno code, which is what actually identifies a spawn failure", () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    assert.equal(describeError(err), "Error[ENOENT]: spawn ENOENT");
  });

  it("preserves the whole cause chain (REQ-PRV-32)", () => {
    const root = new Error("connection refused");
    const middle = new Error("token fetch failed", { cause: root });
    const top = new Error("provider request failed", { cause: middle });
    assert.equal(
      describeError(top),
      "Error: provider request failed <- caused by Error: token fetch failed <- caused by Error: connection refused",
    );
  });

  it("does not loop forever on a self-referencing cause", () => {
    const err = new Error("loop");
    (err as { cause?: unknown }).cause = err;
    const out = describeError(err, 3);
    assert.equal(out.split(" <- caused by ").length, 3);
  });

  it("handles non-Error throws", () => {
    assert.equal(describeError("just a string"), "just a string");
    assert.equal(describeError({ a: 1 }), '{"a":1}');
    assert.equal(describeError(undefined), "undefined");
  });
});

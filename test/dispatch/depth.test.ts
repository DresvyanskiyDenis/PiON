import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEPTH_ENV,
  MAX_DEPTH_ENV,
  applyMaxDepthEnv,
  currentDepth,
  evaluateDepth,
} from "../../extensions/dispatch/depth.ts";

describe("currentDepth", () => {
  it("reads the package's own variable", () => {
    assert.equal(DEPTH_ENV, "PI_SUBAGENT_DEPTH");
    assert.equal(currentDepth({ PI_SUBAGENT_DEPTH: "2" }), 2);
  });

  it("treats an absent or empty depth as top level", () => {
    assert.equal(currentDepth({}), 0);
    assert.equal(currentDepth({ PI_SUBAGENT_DEPTH: "" }), 0);
  });

  it("treats a malformed depth as ALREADY DEEP, never as zero", () => {
    // Reading a mangled env as 0 would hand an unbounded nesting budget to the child that lost it.
    for (const raw of ["nope", "-1", "NaN", "1e999x"]) {
      assert.equal(currentDepth({ PI_SUBAGENT_DEPTH: raw }), Number.POSITIVE_INFINITY, `raw=${raw}`);
    }
  });

  it("floors a fractional depth", () => {
    assert.equal(currentDepth({ PI_SUBAGENT_DEPTH: "1.9" }), 1);
  });
});

describe("evaluateDepth", () => {
  it("permits below the cap", () => {
    assert.deepEqual(evaluateDepth(0, 2), { blocked: false, depth: 0, maxDepth: 2 });
    assert.deepEqual(evaluateDepth(1, 2), { blocked: false, depth: 1, maxDepth: 2 });
  });

  it("blocks AT the cap and names both numbers", () => {
    const v = evaluateDepth(2, 2);
    assert.equal(v.blocked, true);
    assert.match(v.reason ?? "", /depth 2 \(max 2\)/);
    assert.match(v.reason ?? "", /complete this task directly/);
  });

  it("blocks an unreadable depth and says so, rather than printing Infinity", () => {
    const v = evaluateDepth(Number.POSITIVE_INFINITY, 2);
    assert.equal(v.blocked, true);
    assert.match(v.reason ?? "", /unreadable \(PI_SUBAGENT_DEPTH was malformed\)/);
  });

  it("maxDepth 0 disables dispatch entirely", () => {
    assert.equal(evaluateDepth(0, 0).blocked, true);
  });
});

describe("applyMaxDepthEnv", () => {
  it("stamps OUR number so the package's check uses it, and reports what it replaced", () => {
    assert.equal(MAX_DEPTH_ENV, "PI_SUBAGENT_MAX_DEPTH");
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyMaxDepthEnv(2, env), {});
    assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "2");

    const replaced = applyMaxDepthEnv(3, env);
    assert.deepEqual(replaced, { previous: "2" });
    assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "3");
  });

  it("is idempotent", () => {
    const env: NodeJS.ProcessEnv = { PI_SUBAGENT_MAX_DEPTH: "2" };
    applyMaxDepthEnv(2, env);
    applyMaxDepthEnv(2, env);
    assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "2");
  });
});

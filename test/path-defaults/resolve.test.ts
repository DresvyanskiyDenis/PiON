import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explicitModelRequested, statusFlag } from "../../extensions/path-defaults/resolve.ts";

describe("explicitModelRequested", () => {
  it("is true for --model", () => {
    assert.equal(explicitModelRequested(["node", "pi", "--model", "databricks/databricks-claude-haiku-4-5"]), true);
  });

  it("is true for --models", () => {
    assert.equal(explicitModelRequested(["node", "pi", "--models", "strong"]), true);
  });

  it("is true for --provider", () => {
    assert.equal(explicitModelRequested(["node", "pi", "--provider", "databricks"]), true);
  });

  it("is false with no model-selecting flag", () => {
    assert.equal(explicitModelRequested(["node", "pi", "-p", "hello"]), false);
  });

  it("is false for an empty argv", () => {
    assert.equal(explicitModelRequested([]), false);
  });
});

describe("statusFlag", () => {
  it("clears the status bar for a public session", () => {
    assert.equal(statusFlag("public"), undefined);
  });

  it("flags an internal session", () => {
    assert.equal(statusFlag("internal"), "⚑ internal");
  });

  it("flags a confidential session", () => {
    assert.equal(statusFlag("confidential"), "⚑ confidential");
  });
});

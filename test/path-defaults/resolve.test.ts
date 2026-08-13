import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RootDef } from "../../extensions/path-defaults/config.ts";
import { explicitModelRequested, rootFor, statusFlag } from "../../extensions/path-defaults/resolve.ts";

const EGRESS = { web: "allow" as const, mcp: "allow" as const, publicModels: "allow" as const };

function root(path: string, tier: string): RootDef {
  return { path, tier, egress: EGRESS };
}

const HOME = "/home/user";

describe("rootFor — longest-prefix matching", () => {
  it("matches an exact-prefix root", () => {
    const roots = [root("~/work/acme", "confidential"), root("*", "fast")];
    const r = rootFor("/home/user/work/acme/some-repo", roots, HOME);
    assert.equal(r?.tier, "confidential");
  });

  it("falls back to the wildcard when nothing else matches", () => {
    const roots = [root("~/work/acme", "confidential"), root("*", "fast")];
    const r = rootFor("/home/user/Downloads", roots, HOME);
    assert.equal(r?.tier, "fast");
  });

  it("prefers the longer of two matching prefixes, not the first listed", () => {
    const roots = [root("~/work", "fast"), root("~/work/acme", "confidential"), root("*", "cheap")];
    const r = rootFor("/home/user/work/acme/repo", roots, HOME);
    assert.equal(r?.tier, "confidential", "the more specific root must win regardless of list order");
  });

  it("prefers the longer prefix even when the shorter one is listed second", () => {
    const roots = [root("~/work/acme", "confidential"), root("~/work", "fast"), root("*", "cheap")];
    const r = rootFor("/home/user/work/acme/repo", roots, HOME);
    assert.equal(r?.tier, "confidential");
  });

  it("is boundary-safe: a sibling directory with a matching prefix string does not match", () => {
    const roots = [root("~/work/acme", "confidential"), root("*", "fast")];
    const r = rootFor("/home/user/work/acme-other-client", roots, HOME);
    assert.equal(r?.tier, "fast", "must fall through to the wildcard, not the acme root");
  });

  it("matches the root directory itself, not only its children", () => {
    const roots = [root("~/work/acme", "confidential"), root("*", "fast")];
    const r = rootFor("/home/user/work/acme", roots, HOME);
    assert.equal(r?.tier, "confidential");
  });

  it("returns undefined when nothing matches and there is no wildcard", () => {
    const roots = [root("~/work/acme", "confidential")];
    const r = rootFor("/home/user/Downloads", roots, HOME);
    assert.equal(r, undefined);
  });

  it("returns undefined for an empty root list", () => {
    assert.equal(rootFor("/home/user/anything", [], HOME), undefined);
  });
});

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

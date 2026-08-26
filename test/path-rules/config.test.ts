import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadRules, parseRuleFile, PathRuleShapeError } from "../../extensions/path-rules/config.ts";

function grab(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

describe("parseRuleFile — unconditional rules", () => {
  it("a file with no frontmatter is unconditional", () => {
    const rule = parseRuleFile("Always say hi.", "/rules/greet.md");
    assert.equal(rule.id, "greet");
    assert.equal(rule.matchers, null);
    assert.equal(rule.body, "Always say hi.");
  });

  it("frontmatter without a paths: key is unconditional", () => {
    const text = "---\nversion: 1\n---\nBody text.";
    const rule = parseRuleFile(text, "/rules/generic.md");
    assert.equal(rule.matchers, null);
    assert.equal(rule.body, "Body text.");
  });
});

describe("parseRuleFile — conditional rules", () => {
  it("compiles paths: into matchers", () => {
    const text = '---\npaths:\n  - "**/*.py"\n  - "**/pyproject.toml"\n---\nUse uv, not pip.';
    const rule = parseRuleFile(text, "/rules/python.md");
    assert.ok(rule.matchers);
    assert.equal(rule.matchers!.length, 2);
    assert.equal(rule.body, "Use uv, not pip.");
  });
});

describe("parseRuleFile — shape errors, each naming the source file", () => {
  it("throws on an unterminated frontmatter block", () => {
    const err = grab(() => parseRuleFile("---\npaths: [a]\nno closing delimiter", "/rules/bad.md"));
    assert.ok(err instanceof PathRuleShapeError);
    assert.match(err.message, /^\/rules\/bad\.md:/);
    assert.match(err.message, /unterminated/);
  });

  it("throws on invalid YAML in the frontmatter", () => {
    const err = grab(() => parseRuleFile("---\npaths: [a, b\n---\nBody.", "/rules/bad-yaml.md"));
    assert.match(err.message, /^\/rules\/bad-yaml\.md:/);
    assert.match(err.message, /not valid YAML/);
  });

  it("throws when paths: is not a list", () => {
    const err = grab(() => parseRuleFile("---\npaths: not-a-list\n---\nBody.", "/rules/bad-paths.md"));
    assert.match(err.message, /"paths" must be a non-empty list/);
  });

  it("throws when a paths: entry is not a string", () => {
    const err = grab(() => parseRuleFile("---\npaths:\n  - 5\n---\nBody.", "/rules/bad-entry.md"));
    assert.match(err.message, /paths\[0\]/);
  });

  it("throws on an unsupported glob pattern, naming the pattern", () => {
    const err = grab(() => parseRuleFile('---\npaths:\n  - "**/[abc].py"\n---\nBody.', "/rules/bad-glob.md"));
    assert.ok(err instanceof PathRuleShapeError);
    assert.match(err.message, /\[abc\]\.py/);
  });

  it("throws on an empty body", () => {
    const err = grab(() => parseRuleFile("---\npaths:\n  - a\n---\n\n", "/rules/empty.md"));
    assert.match(err.message, /body is empty/);
  });

  it("throws when frontmatter is not a mapping", () => {
    const err = grab(() => parseRuleFile("---\n- a\n- b\n---\nBody.", "/rules/list-frontmatter.md"));
    assert.match(err.message, /must be a YAML mapping/);
  });
});

describe("loadRules — directory I/O and per-file isolation", () => {
  let sandbox: string;
  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-path-rules-config-"));
  });
  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("a missing directory is a normal, unconfigured install — not an error", () => {
    const { rules, warnings } = loadRules(join(sandbox, "does-not-exist"));
    assert.deepEqual(rules, []);
    assert.deepEqual(warnings, []);
  });

  it("loads every well-formed *.md file, in filename order, ignoring non-.md files", async () => {
    await writeFile(join(sandbox, "b-rule.md"), "Second.");
    await writeFile(join(sandbox, "a-rule.md"), "First.");
    await writeFile(join(sandbox, "notes.txt"), "not a rule");
    const { rules, warnings } = loadRules(sandbox);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      rules.map((r) => r.id),
      ["a-rule", "b-rule"],
    );
  });

  it("one rule file with an unsupported glob does not stop a sibling file from loading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-path-rules-isolation-"));
    try {
      await writeFile(join(dir, "broken.md"), '---\npaths:\n  - "**/[abc].py"\n---\nBroken.');
      await writeFile(join(dir, "healthy.md"), '---\npaths:\n  - "**/*.py"\n---\nHealthy rule body.');
      const { rules, warnings } = loadRules(dir);
      assert.deepEqual(
        rules.map((r) => r.id),
        ["healthy"],
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /broken\.md/);
      assert.match(warnings[0]!, /\[abc\]\.py/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

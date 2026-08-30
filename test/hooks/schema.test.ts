import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { compileHooksFile, HooksFileError } from "../../extensions/hooks/schema.ts";

const SRC = "<test>/hooks.yaml";

describe("compileHooksFile — file-level shape (throws, never silently drops)", () => {
  it("rejects a non-mapping document", () => {
    assert.throws(() => compileHooksFile([1, 2, 3], SRC), HooksFileError);
    assert.throws(() => compileHooksFile("just a string", SRC), HooksFileError);
    assert.throws(() => compileHooksFile(null, SRC), HooksFileError);
  });

  it("rejects a missing or wrong version", () => {
    assert.throws(() => compileHooksFile({ rules: [] }, SRC), /unsupported or missing "version"/);
    assert.throws(() => compileHooksFile({ version: 2, rules: [] }, SRC), HooksFileError);
  });

  it("rejects rules that is not an array", () => {
    assert.throws(() => compileHooksFile({ version: 1, rules: "nope" }, SRC), /"rules" must be an array/);
  });

  it("accepts an empty, well-shaped file", () => {
    const { rules, warnings } = compileHooksFile({ version: 1, rules: [] }, SRC);
    assert.deepEqual(rules, []);
    assert.deepEqual(warnings, []);
  });

  it("the thrown error carries the source file for a session-refusal message", () => {
    try {
      compileHooksFile({ version: 1, rules: "nope" }, SRC);
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(err instanceof HooksFileError);
      assert.equal(err.source, SRC);
      assert.match(err.message, new RegExp(SRC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});

describe("compileHooksFile — per-rule validation (named and dropped, never thrown)", () => {
  it("compiles a valid block rule with tool + pattern", () => {
    const { rules, warnings } = compileHooksFile(
      {
        version: 1,
        rules: [
          {
            id: "no-force-push",
            event: "tool_call",
            match: { tool: "bash", pattern: "git\\s+push\\b.*--force" },
            action: "block",
            reason: "no",
          },
        ],
      },
      SRC,
    );
    assert.equal(warnings.length, 0);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, "no-force-push");
    assert.equal(rules[0]!.tool, "bash");
    assert.ok(rules[0]!.pattern instanceof RegExp);
    assert.equal(rules[0]!.action, "block");
  });

  it("a rule missing id is named and dropped, sibling rules still compile", () => {
    const { rules, warnings } = compileHooksFile(
      {
        version: 1,
        rules: [
          { event: "tool_call", action: "block" },
          { id: "ok", event: "tool_call", action: "block" },
        ],
      },
      SRC,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, "ok");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /missing a non-empty "id"/);
  });

  it("an unsupported event is named and dropped", () => {
    const { rules, warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "tool_result", action: "block" }] },
      SRC,
    );
    assert.equal(rules.length, 0);
    assert.match(warnings[0]!, /unsupported "event"/);
  });

  it('"run" is not offered on the "input" event — named and dropped', () => {
    const { rules, warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "input", action: "run", run: { command: "/bin/true" } }] },
      SRC,
    );
    assert.equal(rules.length, 0);
    assert.match(warnings[0]!, /unsupported "action" for event "input"/);
  });

  it('"confirm" is not offered on the "input" event — named and dropped', () => {
    const { warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "input", action: "confirm" }] },
      SRC,
    );
    assert.match(warnings[0]!, /unsupported "action" for event "input"/);
  });

  it("a broken regex is named (with the rule id) and dropped — the H2 acceptance case, sibling rules unaffected", () => {
    const { rules, warnings } = compileHooksFile(
      {
        version: 1,
        rules: [
          { id: "bad", event: "tool_call", action: "block", match: { pattern: "(" } },
          { id: "good", event: "tool_call", action: "block" },
        ],
      },
      SRC,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, "good");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /bad.*invalid regex/);
  });

  it('"allow" is not a verb here — an unsupported action is named and dropped, never weakens the guard', () => {
    const { rules, warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "sneaky", event: "tool_call", action: "allow" }] },
      SRC,
    );
    assert.equal(rules.length, 0);
    assert.match(warnings[0]!, /sneaky.*unsupported "action"/);
  });

  it("match.tool on an input rule is named and dropped — tools do not apply there", () => {
    const { rules, warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "input", action: "block", match: { tool: "bash" } }] },
      SRC,
    );
    assert.equal(rules.length, 0);
    assert.match(warnings[0]!, /match\.tool.*event is "input"/);
  });

  it('action "run" without a run block is named and dropped', () => {
    const { warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "tool_call", action: "run" }] },
      SRC,
    );
    assert.match(warnings[0]!, /no "run" block/);
  });

  it("a leading ~/ in run.command is expanded to the home directory", () => {
    // The only portable way to name a script in a version-controlled hooks.yaml: `run.ts` does
    // `access(command, X_OK)` on the string verbatim and spawns it with the PROJECT as cwd, so a
    // bare name is not found on PATH and a relative path means a different file per repository.
    const { rules, warnings } = compileHooksFile(
      {
        version: 1,
        rules: [{ id: "x", event: "tool_call", action: "run", run: { command: "~/bin/pi-constraints-hook" } }],
      },
      SRC,
    );
    assert.deepEqual(warnings, []);
    assert.equal(rules[0]!.run!.command, join(homedir(), "bin", "pi-constraints-hook"));
  });

  it("leaves an absolute or relative run.command untouched — no other substitution exists", () => {
    const { rules } = compileHooksFile(
      {
        version: 1,
        rules: [
          { id: "abs", event: "tool_call", action: "run", run: { command: "/bin/true" } },
          { id: "rel", event: "tool_call", action: "run", run: { command: "./scripts/guard.sh" } },
          { id: "tilde-mid", event: "tool_call", action: "run", run: { command: "/opt/~/nope" } },
        ],
      },
      SRC,
    );
    assert.equal(rules[0]!.run!.command, "/bin/true");
    assert.equal(rules[1]!.run!.command, "./scripts/guard.sh");
    assert.equal(rules[2]!.run!.command, "/opt/~/nope");
  });

  it("run.command missing or empty is named and dropped", () => {
    const { warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "tool_call", action: "run", run: { command: "  " } }] },
      SRC,
    );
    assert.match(warnings[0]!, /"run\.command"/);
  });

  it("run.args must be an array of strings", () => {
    const { warnings } = compileHooksFile(
      {
        version: 1,
        rules: [{ id: "x", event: "tool_call", action: "run", run: { command: "/bin/true", args: [1, 2] } }],
      },
      SRC,
    );
    assert.match(warnings[0]!, /"run\.args"/);
  });

  it("run.timeoutMs must be a positive number", () => {
    const { warnings } = compileHooksFile(
      {
        version: 1,
        rules: [{ id: "x", event: "tool_call", action: "run", run: { command: "/bin/true", timeoutMs: -5 } }],
      },
      SRC,
    );
    assert.match(warnings[0]!, /"run\.timeoutMs"/);
  });

  it("a run block on a non-run action is named and dropped", () => {
    const { warnings } = compileHooksFile(
      { version: 1, rules: [{ id: "x", event: "tool_call", action: "block", run: { command: "/bin/true" } }] },
      SRC,
    );
    assert.match(warnings[0]!, /"run" block but action is "block"/);
  });

  it("compiles a full run rule with args and timeout", () => {
    const { rules, warnings } = compileHooksFile(
      {
        version: 1,
        rules: [
          {
            id: "x",
            event: "tool_call",
            action: "run",
            run: { command: "/bin/echo", args: ["hi"], timeoutMs: 1000 },
          },
        ],
      },
      SRC,
    );
    assert.equal(warnings.length, 0);
    assert.deepEqual(rules[0]!.run, { command: "/bin/echo", args: ["hi"], timeoutMs: 1000 });
  });
});

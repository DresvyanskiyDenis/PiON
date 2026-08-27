/**
 * `bin/lib/user-strings.mjs` — the scanner PC-26 counts with.
 *
 * PC-26 reports a number, and a number is trusted differently from a list. Nobody re-derives
 * "53 user-facing em dashes" by hand, so if the scanner miscounts, the gate is confidently
 * wrong in a way no reviewer will catch by reading the finding. That is what these tests are
 * for: every case below is one way a hand-rolled scanner silently miscounts, written as a
 * source snippet rather than as a claim about the implementation.
 *
 * The four that actually bite, and why each is here:
 *
 *   - Comments. This repo's docstrings are dense prose. A scanner that counted them would
 *     report 1351 hits over `extensions/` instead of 23, and the whole rule would be noise.
 *   - Regex literals. `bin/rules/` is full of them, and a `/` misread as division sends the
 *     scanner into a string that never ends, swallowing the rest of the file. That failure is
 *     silent: the count goes DOWN, and a gate that under-reports looks like a passing gate.
 *   - Template interpolation. `${...}` hands control back to code and then back to text. Get
 *     the return leg wrong and the template's closing backtick opens a phantom literal that
 *     runs to the next backtick in the file, re-attributing everything in between.
 *   - Attribution. `ui.notify("…")` and `readFileSync("…")` are the same shape of token on the
 *     same shape of line. If the callee is wrong, the sink filter is wrong, and the count is
 *     measuring the wrong population entirely.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { scanStrings, isUserFacing } from "../../bin/lib/user-strings.mjs";

const SINKS = ["notify", "setStatus", "Error"];
const KEYS = ["message", "description"];

/** Values of every literal the scanner found, in source order. */
function values(source: string): string[] {
  return scanStrings(source).map((s) => s.value);
}

/** How many literals reach a human, by PC-26's definition. */
function facing(source: string): number {
  return scanStrings(source).filter((s) => isUserFacing(s, SINKS, KEYS)).length;
}

describe("scanStrings: what is and is not a string", () => {
  it("finds single-quoted, double-quoted and template literals alike", () => {
    assert.deepEqual(values(`const a = 'one'; const b = "two"; const c = \`three\`;`), ["one", "two", "three"]);
  });

  it("ignores line comments, which is the difference between 23 findings and 1351", () => {
    assert.deepEqual(values(`// a comment with "quotes" in it\nconst a = "real";`), ["real"]);
  });

  it("ignores block comments, including the JSDoc that opens every module here", () => {
    assert.deepEqual(values(`/** doc with "quotes" and a 'apostrophe' */\nconst a = "real";`), ["real"]);
  });

  it("ignores a regex literal, and does not mistake its slashes for the start of a string", () => {
    assert.deepEqual(values(`const re = /"not a string"/g;\nconst a = "real";`), ["real"]);
  });

  it("ignores a regex whose character class contains an unescaped slash", () => {
    assert.deepEqual(values(`const re = /[/"]+/;\nconst a = "real";`), ["real"]);
  });

  it("treats a slash after an identifier or a closing paren as division, not a regex", () => {
    // If `a / b` opened a regex here, the scanner would run past the closing quote of "real".
    assert.deepEqual(values(`const q = a / b / c;\nconst a = "real";`), ["real"]);
    assert.deepEqual(values(`const q = f(1) / 2;\nconst a = "real";`), ["real"]);
  });

  it("keeps an escaped quote inside a literal instead of ending it early", () => {
    assert.deepEqual(values(`const a = "he said \\"no\\" twice"; const b = "after";`), [
      'he said \\"no\\" twice',
      "after",
    ]);
  });

  it("does not let an unterminated quote swallow the rest of the file", () => {
    const found = values(`const broken = "no closing quote\nconst a = "real";`);
    assert.ok(found.includes("real"), `expected the later literal to survive, got ${JSON.stringify(found)}`);
  });
});

describe("scanStrings: templates hand control back and forth", () => {
  it("splits a template around its interpolation and keeps the tail as text", () => {
    assert.deepEqual(values("const a = `head ${x} tail`;"), ["head ", " tail"]);
  });

  it("reads a string INSIDE an interpolation as code, not as template text", () => {
    assert.deepEqual(values('const a = `a ${f("inner")} b`;'), ["a ", "inner", " b"]);
  });

  it("does not let a template's closing backtick open a phantom literal", () => {
    // The phantom would start after the first template's final backtick and run to the
    // second's, hiding "second" and inventing a literal that spans the assignment.
    assert.deepEqual(values("const a = `x ${y} z`;\nconst b = `second`;"), ["x ", " z", "second"]);
  });

  it("handles an object literal inside an interpolation, whose brace is not the template's", () => {
    assert.deepEqual(values("const a = `n=${JSON.stringify({ k: 1 })} done`;"), ["n=", " done"]);
  });
});

describe("scanStrings: attribution", () => {
  it("names the innermost enclosing call, dotted", () => {
    const [s] = scanStrings('ctx.ui.notify("hello");');
    assert.equal(s.callee, "ctx.ui.notify");
    assert.equal(s.argIndex, 0);
  });

  it("counts argument position, and is not fooled by a comma inside an object argument", () => {
    const found = scanStrings('f("zero", { a: 1, b: 2 }, "two");');
    assert.deepEqual(
      found.map((s) => [s.value, s.argIndex]),
      [
        ["zero", 0],
        ["two", 2],
      ],
    );
  });

  it("attributes a nested call to the inner callee, then restores the outer one", () => {
    const found = scanStrings('outer("a", inner("b"), "c");');
    assert.deepEqual(
      found.map((s) => [s.value, s.callee]),
      [
        ["a", "outer"],
        ["b", "inner"],
        ["c", "outer"],
      ],
    );
  });

  it("records the object key a literal is the value of, quoted or bare", () => {
    // A quoted KEY is itself a string literal and is reported as one, with no key of its own.
    // That is the right answer rather than an oversight: the scanner's job is to enumerate
    // literals, and suppressing a whole class of them would hide anything written in one.
    const found = scanStrings('const o = { message: "m", "description": "d", other: "o" };');
    assert.deepEqual(
      found.map((s) => [s.key, s.value]),
      [
        ["message", "m"],
        ["", "description"],
        ["description", "d"],
        ["other", "o"],
      ],
    );
  });

  it("leaves callee empty for a literal that is in no call at all", () => {
    const [s] = scanStrings('const a = "loose";');
    assert.equal(s.callee, "");
    assert.equal(s.argIndex, -1);
  });
});

describe("isUserFacing: which strings a person actually reads", () => {
  it("accepts an output call regardless of how the sink was reached", () => {
    assert.equal(facing('ui.notify("x");'), 1);
    assert.equal(facing('ctx.ui.notify("x");'), 1);
    assert.equal(facing('pi.ui.setStatus("x");'), 1);
  });

  it("accepts a thrown Error message, because fail-loud makes it the last thing said", () => {
    assert.equal(facing('throw new Error("aborting");'), 1);
  });

  it("accepts a prose-shaped property even with no call around it", () => {
    assert.equal(facing('const finding = { rule: "PC-01", message: "explanation" };'), 1);
  });

  it("rejects a path, an id, and any other string handed to a non-sink", () => {
    assert.equal(facing('readFileSync("/etc/hosts", "utf8");'), 0);
    assert.equal(facing('const id = "PC-26";'), 0);
    assert.equal(facing('const o = { rule: "PC-26", file: "a.ts" };'), 0);
  });

  it("does not see a message reached through a variable, which is why the count is a floor", () => {
    // Documented limitation, pinned so a future AST-backed scanner shows up as a test change
    // rather than as an unexplained jump in the recorded budget.
    assert.equal(facing('const msg = "indirect"; ui.notify(msg);'), 0);
  });
});

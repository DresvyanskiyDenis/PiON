import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { program, programs, tokenize } from "../../extensions/guard/shell.ts";

describe("tokenize — REQ-PRV-39", () => {
  it("the spec's own assertion: env A=1 sudo -E rm -rf / → program rm, wrappers env+sudo", () => {
    const [seg] = tokenize("env A=1 sudo -E rm -rf /");
    assert.ok(seg);
    assert.equal(program(seg), "rm");
    assert.deepEqual(seg.wrappers, ["env", "sudo"]);
    assert.deepEqual(seg.argv, ["rm", "-rf", "/"]);
  });

  it("a && b | c is three segments, each carrying the operator that terminated it", () => {
    const segs = tokenize("a && b | c");
    assert.equal(segs.length, 3);
    assert.deepEqual(
      segs.map((s) => [program(s), s.op]),
      [
        ["a", "&&"],
        ["b", "|"],
        ["c", null],
      ],
    );
  });

  it("$( ) makes a segment opaque", () => {
    const [seg] = tokenize("$(rm -rf /)");
    assert.ok(seg);
    assert.equal(seg.opaque, true);
  });

  it("backticks and process substitution are opaque too", () => {
    assert.equal(tokenize("echo `whoami`")[0]?.opaque, true);
    assert.equal(tokenize("diff <(ls a) <(ls b)")[0]?.opaque, true);
  });

  it("a bare eval is opaque even without a substitution", () => {
    const [seg] = tokenize("eval do_something");
    assert.ok(seg);
    assert.equal(seg.opaque, true);
  });

  it("peels every wrapper form the denylist could not express", () => {
    const cases: Array<[string, string, string[]]> = [
      ["sudo rm -rf /", "rm", ["sudo"]],
      ["xargs rm -rf", "rm", ["xargs"]],
      ["timeout 30 npm test", "npm", ["timeout"]],
      ["nice -n 10 make build", "make", ["nice"]],
      ["nohup node server.js", "node", ["nohup"]],
      ["env FOO=1 BAR=2 python x.py", "python", ["env"]],
      ["FOO=1 python x.py", "python", []],
      ["command -v git", "git", ["command"]],
    ];
    for (const [command, expected, wrappers] of cases) {
      const [seg] = tokenize(command);
      assert.ok(seg, command);
      assert.equal(program(seg), expected, command);
      assert.deepEqual(seg.wrappers, wrappers, command);
    }
  });

  it("resolves an absolute program to its basename", () => {
    assert.deepEqual(programs("/usr/bin/git status"), ["git"]);
    assert.deepEqual(programs("/sbin/shutdown -h now"), ["shutdown"]);
  });

  it("removes quotes without splitting the quoted text", () => {
    const [seg] = tokenize(`git commit -m "fix: rm -rf the docs"`);
    assert.ok(seg);
    assert.deepEqual(seg.argv, ["git", "commit", "-m", "fix: rm -rf the docs"]);
  });

  it("keeps ${HOME} as one word — the brace must not split it", () => {
    const [seg] = tokenize("rm -rf ${HOME}");
    assert.ok(seg);
    assert.deepEqual(seg.argv, ["rm", "-rf", "${HOME}"]);
  });

  it("collects redirect targets and drops the file descriptor", () => {
    const [seg] = tokenize("echo x 2> /dev/null > out.txt");
    assert.ok(seg);
    assert.deepEqual(seg.argv, ["echo", "x"]);
    assert.deepEqual(seg.redirects, ["/dev/null", "out.txt"]);
  });

  it("a comment line is not a command", () => {
    const segs = tokenize("# PI-JUSTIFY(GIT-FORCE): rebasing a personal branch\ngit push --force");
    assert.equal(segs.length, 1);
    assert.equal(program(segs[0]!), "git");
  });

  it("a trailing comment does not swallow the command", () => {
    const [seg] = tokenize("ls -la   # list everything");
    assert.ok(seg);
    assert.deepEqual(seg.argv, ["ls", "-la"]);
  });

  it("newline separates segments", () => {
    const segs = tokenize("cd /tmp\nls\n");
    assert.deepEqual(
      segs.map((s) => program(s)),
      ["cd", "ls"],
    );
  });

  it("a line continuation joins two physical lines into one segment", () => {
    const segs = tokenize("npm run build \\\n  --silent");
    assert.equal(segs.length, 1);
    assert.deepEqual(segs[0]!.argv, ["npm", "run", "build", "--silent"]);
  });

  it("an unterminated quote does not hang or throw", () => {
    const [seg] = tokenize(`echo "unterminated`);
    assert.ok(seg);
    assert.deepEqual(seg.argv, ["echo", "unterminated"]);
  });

  it("keeps the pre-peel words, so a wrapped path is still harvestable", () => {
    const [seg] = tokenize("sudo cat ~/.ssh/id_rsa");
    assert.ok(seg);
    assert.deepEqual(seg.words, ["sudo", "cat", "~/.ssh/id_rsa"]);
    assert.deepEqual(seg.argv, ["cat", "~/.ssh/id_rsa"]);
  });

  it("program() is undefined for an empty segment", () => {
    assert.equal(tokenize("").length, 0);
    assert.equal(tokenize("   ").length, 0);
  });
});

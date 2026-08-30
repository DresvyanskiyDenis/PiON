// test/pi-gate.suite.mjs — end-to-end acceptance tests for bin/pi-gate.
//
// `test/bin/structural-gates.test.ts` covers the four detectors as pure functions. This file
// covers the half that file cannot: real `git log` output parsed into commits, a real diff turned
// into "new paths", the severity/exit-code contract, and the honesty of `--help`. Two synthetic
// repositories are built in a scratch directory — one healthy, one carrying all four defects at
// once — and the gate is run against both.
//
// The healthy repository is the load-bearing one. A structural gate that fires on ordinary work
// is worse than no gate, because the first false positive is the last time anyone reads its
// output; "silent on a normal tree" is therefore asserted with the same weight as "catches the
// violation".
//
// Named `.suite.mjs` rather than `.test.mjs` for the reason test/pi-check.suite.mjs records: it
// drives a CLI with node:test's own runner and must not be picked up by a vitest include glob.
// `npm test` globs both `test/**/*.test.ts` and `test/**/*.suite.mjs`, so it runs here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const PI_GATE = join(REPO_ROOT, "bin", "pi-gate");

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gate test",
      GIT_AUTHOR_EMAIL: "gate@example.invalid",
      GIT_COMMITTER_NAME: "gate test",
      GIT_COMMITTER_EMAIL: "gate@example.invalid",
    },
  });
}

/** @param {string} root @param {string} rel @param {string} text */
function write(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** @param {string} root @param {string} message */
function commit(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

/** A repository with a `main` and a feature branch checked out. @returns {string} */
function newRepo() {
  const root = mkdtempSync(join(tmpdir(), "pi-gate-"));
  git(root, ["init", "-q", "-b", "main"]);
  write(root, "README.md", "# fixture\n");
  write(root, "src/pipeline.py", "def run(limit=None):\n    return limit\n");
  commit(root, "feat: initial tree");
  git(root, ["checkout", "-q", "-b", "feature/work"]);
  return root;
}

/** @param {string[]} args @param {Record<string,string>} [env] */
function runGate(args, env = {}) {
  const res = spawnSync(process.execPath, [PI_GATE, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_GATE_BLOCK: "", PI_GATE_SIGNOFF: "", ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** @param {string[]} args */
function runGateJson(args) {
  const res = runGate([...args, "--json"]);
  assert.notEqual(res.stdout.trim(), "", `no stdout; stderr was: ${res.stderr}`);
  return { ...res, report: JSON.parse(res.stdout) };
}

describe("pi-gate on a healthy branch", () => {
  test("reports nothing and exits 0", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    write(root, "src/reader.py", "def read(path, limit=None):\n    return path\n");
    commit(root, "feat: a reader");
    write(root, "src/pipeline.py", "def run(limit=None):\n    return limit or 1\n");
    commit(root, "fix: honour the default limit");

    const { status, report } = runGateJson(["--repo", root]);
    assert.deepEqual(report.findings, [], "a normal branch must be silent");
    assert.equal(status, 0);
  });

  test("stays silent under --block too", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, "src/reader.py", "def read(path, limit=None):\n    return path\n");
    commit(root, "feat: a reader");

    const { status, report } = runGateJson(["--repo", root, "--block"]);
    assert.deepEqual(report.findings, []);
    assert.equal(status, 0);
  });
});

describe("pi-gate on a branch carrying all four defects", () => {
  /** @param {string} root */
  function makeDefects(root) {
    // SG-01: two consecutive fix: commits on one file.
    write(root, "src/pipeline.py", "def run(limit=None):\n    return 1\n");
    commit(root, "fix: first attempt at the schema");
    write(root, "src/pipeline.py", "def run(limit=None):\n    return 2\n");
    commit(root, "fix: second attempt at the schema");

    // SG-02: a new file that differs from an existing one by a generic variant token.
    write(root, "src/pipeline_v2.py", "def run(limit=None):\n    return 3\n");

    // SG-03: five new top-level modules in one diff (pipeline_v2.py is the fifth).
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      write(root, `src/${name}.py`, "value = 1\n");
    }

    // SG-04: a job that can only be run at full scale.
    write(root, "jobs/aggregation_job.py", "def main(source):\n    return process_everything(source)\n");
  }

  test("warns on all four and still exits 0 by default", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeDefects(root);

    const { status, report } = runGateJson(["--repo", root]);
    const gates = new Set(report.findings.map((f) => f.gate));
    assert.deepEqual([...gates].sort(), ["SG-01", "SG-02", "SG-03", "SG-04"]);
    assert.ok(report.findings.every((f) => f.severity === "warn"));
    assert.equal(report.summary.errorCount, 0);
    assert.equal(status, 0, "warn is the shipped default: it reports, it does not block");
  });

  test("blocks with --block, and with PI_GATE_BLOCK=1", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeDefects(root);

    const flag = runGateJson(["--repo", root, "--block"]);
    assert.equal(flag.status, 1);
    assert.ok(flag.report.findings.every((f) => f.severity === "error"));

    const env = runGate(["--repo", root], { PI_GATE_BLOCK: "1" });
    assert.equal(env.status, 1);
  });

  test("runs only the gates named on the command line", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeDefects(root);

    const { report } = runGateJson(["--repo", root, "SG-01"]);
    assert.deepEqual(report.gatesRun, ["SG-01"]);
    assert.ok(report.findings.length > 0);
    assert.ok(report.findings.every((f) => f.gate === "SG-01"));
  });

  test("a sign-off clears SG-03 and stays in the record as a note", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeDefects(root);

    const { report, status } = runGateJson([
      "--repo",
      root,
      "SG-03",
      "--block",
      "--signoff",
      "one module per source format, agreed with the lead",
    ]);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].severity, "ok", "a sign-off is recorded, not erased");
    assert.match(report.findings[0].message, /agreed with the lead/);
    assert.equal(status, 0, "a signed-off budget does not block even under --block");
  });

  test("an empty sign-off is not a sign-off", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeDefects(root);

    const { report, status } = runGateJson(["--repo", root, "SG-03", "--block", "--signoff", "   "]);
    assert.equal(report.findings[0].severity, "error");
    assert.equal(status, 1);
  });

  test("SG-01 is reset by a commit that states a root cause and an alternative", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, "src/pipeline.py", "def run(limit=None):\n    return 1\n");
    commit(root, "fix: first attempt");
    write(root, "src/pipeline.py", "def run(limit=None):\n    return 2\n");
    commit(
      root,
      "fix: second attempt\n\nRoot-cause: the page count is asserted against production, not the request.\nAlternative: pass the requested scope down and compare against that.",
    );

    const { report } = runGateJson(["--repo", root, "SG-01"]);
    assert.deepEqual(report.findings, []);
  });
});

describe("pi-gate interface contract", () => {
  test("--help states what SG-04 does NOT catch, in the same breath as what it does", () => {
    const { status, stdout } = runGate(["--help"]);
    assert.equal(status, 0);
    for (const gate of ["SG-01", "SG-02", "SG-03", "SG-04"]) {
      assert.ok(stdout.includes(gate), `--help must describe ${gate}`);
    }
    // The bounded-run check is weak on purpose; the help text is where that must not be hidden.
    assert.match(stdout, /WEAK BY CONSTRUCTION/);
    assert.match(stdout, /It never means "every job has been shown to run on a subset"\./);
    assert.equal((stdout.match(/MISSES/g) ?? []).length, 4, "every gate states its blind spot");
  });

  test("an unknown gate id is a usage error, not a silent no-op", () => {
    const { status, stderr } = runGate(["SG-99"]);
    assert.equal(status, 2);
    assert.match(stderr, /unknown gate id/);
  });

  test("a bad --base is a usage error rather than a guess", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { status, stderr } = runGate(["--repo", root, "--base", "no/such/ref"]);
    assert.equal(status, 2);
    assert.match(stderr, /does not resolve/);
  });

  test("a directory that is not a git work tree reports nothing instead of crashing", (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-gate-plain-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, "src/pipeline.py", "x = 1\n");

    const { status, report } = runGateJson(["--repo", root]);
    assert.equal(status, 0);
    assert.equal(report.base, null);
    assert.deepEqual(report.findings, []);
  });

  test("a broken config file fails loudly instead of running a gate that checks nothing", (t) => {
    const root = newRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, "config/structural-gates.json", '{ "gates": { "SG-01": { "streek": 9 } } }');

    const { status, stderr } = runGate(["--repo", root]);
    assert.equal(status, 2);
    assert.match(stderr, /unknown key/);
  });

  test("this repo's own config turns every gate on as a warning", (t) => {
    const { report, status } = runGateJson([]);
    assert.deepEqual(report.gatesRun, ["SG-01", "SG-02", "SG-03", "SG-04"]);
    assert.equal(status, 0);
  });
});

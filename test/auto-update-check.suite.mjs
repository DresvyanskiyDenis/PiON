// test/auto-update-check.suite.mjs — `scripts/auto-update-check.sh` behaviour tests.
//
// Design, inherited from test/update-script.suite.mjs: a bare upstream plus a clone, because every
// statement this script makes is about the relationship between the two — behind by n, or not
// behind. A single repository cannot express either.
//
// The fixture SYMLINKS the real script rather than copying it, so these tests exercise the
// committed logic; the script derives REPO_DIR from `dirname $BASH_SOURCE`, which is the path it
// was invoked through, so the symlink lands it in the fixture repo exactly as a real clone would.
//
// `env` is built explicitly per call, never spread from `process.env`: a developer's exported
// PI_CODING_AGENT_DIR would point the script at their real `~/.pi/agent` while the assertions
// describe the fixture, and the failing assertion would be the least of it — the flag file would
// be written into their live install.
//
// Every path in this script exits 0 by contract (cron mails a failing job), so an exit code proves
// nothing here. What is asserted throughout is the effect: the flag file, its contents, its
// absence, and the log line the failure paths leave behind.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const REAL_CHECK = join(REPO_ROOT, "scripts", "auto-update-check.sh");
const NODE_DIR = dirname(process.execPath);

const GIT_ID = [
  "-c", "user.email=fixture@example.invalid",
  "-c", "user.name=fixture",
  "-c", "commit.gpgsign=false",
];

function git(cwd, ...args) {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/** A bare upstream, a clone with the real script symlinked in, and an enabled preference. */
function makeFixture({ enabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pion-autoupdate-test-"));
  const home = join(dir, "home");
  const agentDir = join(dir, "agent");
  const state = join(dir, "state");
  const upstream = join(dir, "up.git");
  const repo = join(dir, "work");
  const seed = join(dir, "seed");

  mkdirSync(home);
  mkdirSync(agentDir);
  mkdirSync(seed);
  git(dir, "init", "--quiet", "--initial-branch=main", seed);
  mkdirSync(join(seed, "config"));
  mkdirSync(join(seed, "scripts"));
  writeFileSync(join(seed, "config", "alpha.json"), '{"alpha":true}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");

  git(dir, "clone", "--quiet", "--bare", seed, upstream);
  git(dir, "clone", "--quiet", upstream, repo);
  // git does not track empty directories, so the clone has no scripts/ to link into.
  mkdirSync(join(repo, "scripts"), { recursive: true });
  symlinkSync(REAL_CHECK, join(repo, "scripts", "auto-update-check.sh"));
  writeConfig({ repo }, { enabled });

  return { dir, home, agentDir, state, upstream, repo, flag: join(agentDir, "update-pending") };
}

function writeConfig(fx, body) {
  writeFileSync(join(fx.repo, "config", "auto-update.json"), `${JSON.stringify({ autoUpdate: body }, null, 2)}\n`);
}

function check(fx, ...args) {
  return spawnSync("bash", [join(fx.repo, "scripts", "auto-update-check.sh"), ...args], {
    cwd: fx.dir,
    encoding: "utf8",
    env: {
      PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: fx.home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      XDG_STATE_HOME: fx.state,
      PI_CODING_AGENT_DIR: fx.agentDir,
      NO_COLOR: "1",
      LANG: "C",
    },
  });
}

/** Commit upstream without touching the clone, so the clone falls behind by one. */
function pushUpstream(fx, message = "upstream change") {
  const staging = join(fx.dir, `push-${Math.random().toString(36).slice(2, 8)}`);
  git(fx.dir, "clone", "--quiet", fx.upstream, staging);
  writeFileSync(join(staging, "config", "alpha.json"), `{"alpha":"${message}"}\n`);
  git(staging, "add", "-A");
  git(staging, "commit", "--quiet", "-m", message);
  git(staging, "push", "--quiet", "origin", "main");
  rmSync(staging, { recursive: true, force: true });
}

/** The flag file parsed the way extensions/auto-update parses it: key=value, comments dropped. */
function readFlag(fx) {
  const out = {};
  for (const line of readFileSync(fx.flag, "utf8").split("\n")) {
    const m = /^([A-Za-z][\w.-]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const logOf = (fx) => {
  const p = join(fx.state, "pi-config", "auto-update-check.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

describe("scripts/auto-update-check.sh", () => {
  test("--help prints the header and stops at the code", () => {
    const fx = makeFixture();
    try {
      const r = check(fx, "--help");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Usage:/);
      assert.match(r.stdout, /--force/);
      assert.doesNotMatch(r.stdout, /set -uo pipefail/, "--help printed past the header block");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("behind upstream: writes the flag with the range and the count", () => {
    const fx = makeFixture();
    try {
      const local = git(fx.repo, "rev-parse", "HEAD");
      pushUpstream(fx);
      pushUpstream(fx, "second");
      const remote = git(fx.upstream, "rev-parse", "main");

      const r = check(fx, "--verbose");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /2 commit\(s\) waiting on origin\/main/);

      const flag = readFlag(fx);
      assert.equal(flag.range, `${local}..${remote}`);
      assert.equal(flag.commits, "2");
      assert.match(flag.checked, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(readFileSync(fx.flag, "utf8"), /Delete this file to dismiss/);

      // The check notices; it never applies. HEAD is exactly where it was.
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), local, "the check moved HEAD");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("up to date: writes no flag", () => {
    const fx = makeFixture();
    try {
      const r = check(fx, "--verbose");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /up to date/);
      assert.equal(existsSync(fx.flag), false, "a flag was written for a converged checkout");
      assert.equal(logOf(fx), "", "a healthy run left a failure in the log");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a flag that is no longer true is removed", () => {
    // The user pulled by hand, or on another machine sharing the tree. Nothing else will clear it:
    // update.sh only clears the updates it applied itself.
    const fx = makeFixture();
    try {
      pushUpstream(fx);
      check(fx);
      assert.equal(existsSync(fx.flag), true, "setup failed — no flag to go stale");

      git(fx.repo, "pull", "--quiet", "--ff-only");
      const r = check(fx, "--verbose");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /removed the stale/);
      assert.equal(existsSync(fx.flag), false, "the stale flag survived");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a branch ahead of main is not 'behind' — counts, not equals", () => {
    // The reason this script counts instead of comparing shas. On any feature branch HEAD differs
    // from origin/main forever, and a comparison would report an update that does not exist.
    const fx = makeFixture();
    try {
      git(fx.repo, "checkout", "--quiet", "-b", "feature/local");
      writeFileSync(join(fx.repo, "config", "alpha.json"), '{"alpha":"local work"}\n');
      git(fx.repo, "commit", "--quiet", "-am", "local work");

      const r = check(fx, "--verbose");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /up to date/);
      assert.equal(existsSync(fx.flag), false, "a feature branch was reported as behind");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("disabled: touches nothing, and --force overrides it", () => {
    const fx = makeFixture({ enabled: false });
    try {
      pushUpstream(fx);
      const off = check(fx, "--verbose");
      assert.equal(off.status, 0, off.stderr);
      assert.match(off.stdout, /disabled/);
      assert.equal(existsSync(fx.flag), false, "a disabled config still wrote the flag");

      const forced = check(fx, "--verbose", "--force");
      assert.equal(forced.status, 0, forced.stderr);
      assert.equal(existsSync(fx.flag), true, "--force did not override the preference");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an unreadable config is a logged failure, not a silent 'disabled'", () => {
    // Reporting "off" for a broken file hides the breakage behind the feature's own off switch.
    const fx = makeFixture();
    try {
      pushUpstream(fx);
      writeFileSync(join(fx.repo, "config", "auto-update.json"), "{ not json\n");
      const r = check(fx);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(fx.flag), false);
      assert.match(logOf(fx), /could not be read/);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a fetch that fails is written down, not swallowed", () => {
    // "My auto-update stopped working" has to be answerable. An expired credential, a proxy and a
    // laptop on a plane all look identical from the outside; the log is the only difference.
    const fx = makeFixture();
    try {
      git(fx.repo, "remote", "set-url", "origin", join(fx.dir, "does-not-exist.git"));
      const r = check(fx, "--verbose");
      assert.equal(r.status, 0, "a failed fetch must not fail the cron job");
      assert.match(logOf(fx), /git fetch origin main failed/);
      assert.equal(existsSync(fx.flag), false);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

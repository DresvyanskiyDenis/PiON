// test/pi-check-doctor.suite.mjs — acceptance tests for `bin/pi-check --doctor`.
//
// Every other mode of pi-check answers a question about the repository TREE, and the existing
// suite can therefore hand it a checked-in fixture directory. This mode answers a question about
// the MACHINE — "is what config/hooks.yaml declares actually installed under $HOME, and pointing
// at this checkout?" — so a fixture on disk cannot express any of its cases. Each test below
// builds a throwaway $HOME and a throwaway checkout, wires exactly one of them wrong, and reads
// the finding back. Nothing is checked in, and nothing outside the scratch directories is touched.
//
// `--doctor` reads `$HOME` through `installPaths()`, so pointing HOME at a temp dir is the whole
// isolation mechanism. That is also how install.sh and update.sh invoke it under `--prefix`.
//
// Named `.suite.mjs` for the reason test/pi-check.suite.mjs's header gives.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const PI_CHECK = join(REPO_ROOT, "bin", "pi-check");

const SCRATCH = [];
process.on("exit", () => {
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return dir;
}

/** A hooks.yaml carrying `count` `action: run` rules, all pointing at `command`. */
function hooksYaml(command, { count = 1, ruleId = "constraints-edit" } = {}) {
  const rules = [];
  for (let i = 0; i < count; i++) {
    rules.push(
      `  - id: ${ruleId}${i === 0 ? "" : `-${i}`}`,
      `    event: tool_call`,
      `    match:`,
      `      tool: edit`,
      `    action: run`,
      `    run:`,
      `      command: "${command}"`,
    );
  }
  return `hooks:\n${rules.join("\n")}\n`;
}

/**
 * A throwaway machine: a checkout with a hooks.yaml and (optionally) a config/bin script, plus a
 * $HOME with a ~/pi-config symlink pointing at that checkout — the exact shape install.sh writes.
 *
 * `link` says what ends up at ~/bin/<script>: "correct" the link install.sh would write, "missing"
 * nothing at all, "file" a real file in the symlink's place, "stale" a link into a different
 * checkout, "dangling" a link to a path that does not exist, "unexecutable" a correct link whose
 * target has no +x bit.
 *
 * `hooksLink` says the same for ~/.pi/agent/hooks.yaml, which the mode reports but never judges:
 * "none" nothing there, "active" the `link_one required config/hooks.yaml` row install.sh writes,
 * "off" the documented off-switch, "file" a real file in the symlink's place.
 */
function machine({
  yaml,
  ships = "pi-constraints-hook",
  script = "pi-constraints-hook",
  link = "correct",
  hooksLink = "none",
}) {
  const home = scratch("pi-doctor-home-");
  const repo = scratch("pi-doctor-repo-");

  mkdirSync(join(repo, "config", "bin"), { recursive: true });
  writeFileSync(join(repo, "config", "hooks.yaml"), yaml);
  writeFileSync(join(repo, "config", "hooks-off.yaml"), "version: 1\nrules: []\n");
  if (ships !== null) {
    const target = join(repo, "config", "bin", ships);
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);
  }

  symlinkSync(repo, join(home, "pi-config"));
  mkdirSync(join(home, "bin"), { recursive: true });

  const installed = join(home, "bin", script);
  const want = join(home, "pi-config", "config", "bin", script);
  if (link === "correct") symlinkSync(want, installed);
  else if (link === "file") writeFileSync(installed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  else if (link === "stale") symlinkSync(join(home, "elsewhere", "config", "bin", script), installed);
  else if (link === "dangling") symlinkSync(join(home, "pi-config", "config", "bin", "gone"), installed);
  else if (link === "unexecutable") {
    chmodSync(join(repo, "config", "bin", script), 0o644);
    symlinkSync(want, installed);
  }

  if (hooksLink !== "none") {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const installedHooks = join(home, ".pi", "agent", "hooks.yaml");
    if (hooksLink === "active") symlinkSync(join(home, "pi-config", "config", "hooks.yaml"), installedHooks);
    else if (hooksLink === "off") symlinkSync(join(home, "pi-config", "config", "hooks-off.yaml"), installedHooks);
    else if (hooksLink === "file") writeFileSync(installedHooks, "version: 1\nrules: []\n");
  }

  return { home, repo };
}

/** Runs `bin/pi-check --doctor` against a throwaway machine. Never throws on a non-zero exit. */
function doctor({ home, repo }, extraArgs = []) {
  const result = spawnSync(process.execPath, [PI_CHECK, "--doctor", "--repo", repo, ...extraArgs], {
    encoding: "utf8",
    // PI_CODING_AGENT_DIR outranks $HOME in installPaths(), exactly as it does in install.sh. An
    // operator who exports it would otherwise aim these tests at their live agent directory.
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: undefined },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The leading count from the mode's summary line, so a test asserts on a number, not on prose. */
function findingCount(stdout) {
  const match = /^(\d+) finding\(s\)/m.exec(stdout);
  assert.ok(match, `no summary line in:\n${stdout}`);
  return Number(match[1]);
}

describe("pi-check --doctor: an install that is correct", () => {
  test("a hook whose script is linked the way install.sh links it reports nothing", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook") });
    const r = doctor(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(findingCount(r.stdout), 0);
  });

  test("the clean run still names the two paths it inspected", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook") });
    const r = doctor(m);
    // A green run under the wrong HOME is the reassurance this mode exists to stop giving, so
    // "0 finding(s)" on its own is not an acceptable output even when it is true.
    assert.match(r.stdout, new RegExp(join(m.home, "bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(r.stdout, new RegExp(join(m.home, "pi-config").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("a checkout with no hooks.yaml has nothing to say", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook") });
    rmSync(join(m.repo, "config", "hooks.yaml"));
    const r = doctor(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(findingCount(r.stdout), 0);
  });

  test("two rules pointing at the same installed script are both clean", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook", { count: 2 }) });
    const r = doctor(m);
    assert.equal(findingCount(r.stdout), 0, r.stdout);
  });

  test("a command outside ~/bin is checked for executability, not for a link", () => {
    // `/bin/sh` is not something install.sh links and must not be reported as a stale symlink.
    const m = machine({ yaml: hooksYaml("/bin/sh"), script: "sh", link: "missing" });
    const r = doctor(m);
    assert.equal(findingCount(r.stdout), 0, r.stdout);
  });
});

describe("pi-check --doctor: an install that is wrong", () => {
  const cases = [
    { name: "the link was never created", link: "missing", expect: /is NOT installed/ },
    { name: "a real file sits where the symlink belongs", link: "file", expect: /real file where a symlink/ },
    { name: "the link points into a previous checkout", link: "stale", expect: /points at .*, not at/ },
    { name: "the link dangles", link: "dangling", expect: /points at .*, not at/ },
    { name: "the target lost its +x bit", link: "unexecutable", expect: /missing or not executable/ },
  ];

  for (const c of cases) {
    test(`${c.name} is one finding, and the exit code is 1`, () => {
      const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), link: c.link });
      const r = doctor(m);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(findingCount(r.stdout), 1, r.stdout);
      assert.match(r.stdout, c.expect);
      assert.match(r.stdout, /PD-01/);
    });
  }

  test("every finding names the fix, because the fix is an install and not an edit", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), link: "missing" });
    assert.match(doctor(m).stdout, /scripts\/install\.sh/);
  });

  test("a hook naming a ~/bin script the repo does not ship is reported against the repo", () => {
    // This one is broken on every machine, not on this one: install.sh has nothing to link.
    const m = machine({ yaml: hooksYaml("~/bin/never-shipped"), ships: null, script: "never-shipped", link: "missing" });
    const r = doctor(m);
    assert.equal(findingCount(r.stdout), 1, r.stdout);
    assert.match(r.stdout, /this repo has no config\/bin\/never-shipped/);
    assert.match(r.stdout, /Add the script or drop the rule/);
  });

  test("two broken rules are two findings", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook", { count: 2 }), link: "missing" });
    assert.equal(findingCount(doctor(m).stdout), 2);
  });

  test("a hooks.yaml the scanner cannot read is a finding, not a silent pass", () => {
    // An `action: run` with no `command:` means the scanner's model of the file is wrong. Reporting
    // zero here would be the worst available answer: a broken hook reported as a healthy install.
    const yaml = "hooks:\n  - id: no-command\n    event: tool_call\n    action: run\n";
    const m = machine({ yaml, link: "missing" });
    const r = doctor(m);
    assert.equal(r.status, 1);
    assert.equal(findingCount(r.stdout), 1, r.stdout);
    assert.match(r.stdout, /does not understand the file's shape/);
  });
});

describe("pi-check --doctor: what ~/.pi/agent/hooks.yaml currently is", () => {
  // The mode REPORTS this and never judges it. Every case asserts the exit status as hard as it
  // asserts the wording: a --doctor finding is fatal to install.sh and update.sh, so failing on a
  // deliberately disabled hook layer would make the documented off-switch impossible to install
  // around — the opposite of documenting it.

  test("the installer's link is reported as active", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), hooksLink: "active" });
    const r = doctor(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^hooks: .*hooks\.yaml is ACTIVE/m);
  });

  test("the off-switch says GUARDRAILS OFF and hands back the way in", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), hooksLink: "off" });
    const r = doctor(m);
    assert.equal(r.status, 0, "guardrails off on purpose is a decision, not a finding");
    assert.equal(findingCount(r.stdout), 0);
    assert.match(r.stdout, /is OFF — GUARDRAILS OFF/);
    assert.match(r.stdout, /ln -sf .*config\/hooks\.yaml/);
  });

  // Guardrails are off by default, so "the gate is empty and the run script was never linked" is
  // the ordinary state of a fresh install, not a defect. A finding here would fail --doctor, and
  // install.sh and update.sh both treat that as fatal — the default install would refuse itself.
  test("with the empty gate live, an uninstalled run script is not a finding", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), link: "missing", hooksLink: "off" });
    const r = doctor(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(findingCount(r.stdout), 0, "a rule that is not loaded on this machine cannot fail closed on it");
  });

  // The one question that does not depend on which gate is live: a rule naming a ~/bin script the
  // repo never ships is broken for every machine that opts in, and this is where it is caught.
  test("with the empty gate live, a rule naming a script the repo does not ship is still reported", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), ships: null, link: "missing", hooksLink: "off" });
    const r = doctor(m);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /this repo has no config\/bin\/pi-constraints-hook/);
  });

  test("a real file where the installer's symlink belongs is reported, not failed", () => {
    // link_one already backs this up and relinks on the next install. Saying so is this mode's
    // whole job here; failing on it would break `bin/pi-check --doctor` for anyone hand-editing.
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), hooksLink: "file" });
    const r = doctor(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(findingCount(r.stdout), 0);
    assert.match(r.stdout, /is FILE — a real file, not the installer's symlink/);
  });

  test("nothing installed is reported as absent, and names the off-switch as the better spelling", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook") });
    const r = doctor(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /is ABSENT/);
    assert.match(r.stdout, /hooks-off\.yaml/);
  });
});

describe("pi-check --doctor: the mode's own contract", () => {
  test("--json carries the findings, the count and the paths that were inspected", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook"), link: "missing" });
    const r = doctor(m, ["--json"]);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.mode, "doctor");
    assert.equal(parsed.summary.findingCount, 1);
    assert.equal(parsed.findings[0].rule, "PD-01");
    assert.equal(parsed.paths.home, m.home);
    assert.equal(parsed.paths.binDir, join(m.home, "bin"));
    assert.equal(parsed.paths.stableLink, join(m.home, "pi-config"));
    assert.equal(parsed.paths.agentDir, join(m.home, ".pi", "agent"));
    // Reported alongside the findings, never inside them: `hooksFile` carries a `note`, not a
    // `message`, so it cannot be rendered as one by accident.
    assert.equal(parsed.hooksFile.state, "absent");
    assert.equal(parsed.hooksFile.message, undefined);
  });

  for (const combination of [["--all"], ["PC-01"], ["--only", "config"], ["--live"]]) {
    test(`refuses to run alongside ${combination.join(" ")}`, () => {
      // The rules inspect the tree, this inspects the machine. One exit code cannot mean both, and
      // "pi-check failed" has to keep meaning one thing.
      const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook") });
      const r = doctor(m, combination);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /"--doctor" runs no rule/);
    });
  }

  test("--write-vendor-manifest refuses to run alongside it too", () => {
    const m = machine({ yaml: hooksYaml("~/bin/pi-constraints-hook") });
    const r = doctor(m, ["--write-vendor-manifest"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"--write-vendor-manifest" runs no rule/);
  });

  test("the usage line advertises the mode", () => {
    const r = spawnSync(process.execPath, [PI_CHECK], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--doctor/);
  });
});

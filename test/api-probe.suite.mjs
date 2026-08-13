// test/api-probe.suite.mjs — acceptance tests for bin/api-probe.mjs (EXT-31).
//
// Named `.suite.mjs`, not `.test.mjs`, for the same reason as test/pi-check.suite.mjs: it
// uses node:test's own `test`, not vitest's, and vitest's default include glob would
// otherwise pick it up and fail with "No test suite found". Run with:
//   node --test test/api-probe.suite.mjs
//
// Every test spawns the real script against this repo's own node_modules/.bin/pi (which
// matches the pinned @earendil-works/pi-coding-agent devDependency exactly), so nothing here
// depends on a global `pi` install existing on PATH — that combination is exercised
// separately by the literal acceptance command elsewhere, which
// does use `command -v pi`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, chmodSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const REAL_PI = join(REPO_ROOT, "node_modules", ".bin", "pi");
/** The tracked template every generated `config/settings.json` is built from. */
const SETTINGS_TEMPLATE = join(REPO_ROOT, "config", "settings.default.json");

/**
 * api-probe.mjs derives its repo root from its own location (`dirname(dirname(scriptPath))`) and
 * hard-requires `<root>/config/settings.json` — a file this repository does not track, because
 * scripts/install.sh generates it from `config/settings.default.json` on the target machine. Run
 * out of a fresh clone the script therefore aborts before it probes anything. That is a defect in
 * the script, reported as one; it is not something a test may hide, so the fresh-clone behaviour is
 * pinned by its own test at the bottom of this file.
 *
 * These tests are about the probe's surface extraction and its check-mode verdicts, and must not
 * depend on whether whoever runs them happens to have installed. So they run the script from a
 * fixture root that HAS the file: a byte copy of the real script (a symlink will not do — Node
 * resolves a module to its realpath, which would put the root straight back) plus
 * `config/settings.json` materialised from the tracked template. Everything else the script needs —
 * the pi package and its .d.ts files — it resolves from the `--pi` path it is handed.
 */
function makeProbeRoot() {
  const root = mkdtempSync(join(tmpdir(), "api-probe-root-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "bin", "api-probe.mjs"), join(root, "bin", "api-probe.mjs"));
  copyFileSync(SETTINGS_TEMPLATE, join(root, "config", "settings.json"));
  // The script `import`s `typescript` to read the .d.ts surface, and a bare specifier resolves from
  // the importing file's own directory upward — so the fixture root needs the dependency tree too.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  return root;
}

const PROBE_ROOT = makeProbeRoot();
const SCRIPT = join(PROBE_ROOT, "bin", "api-probe.mjs");

/** Runs api-probe.mjs. Never throws on non-zero exit — returns { exitCode, stdout, stderr, json }. */
function run(args) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  } catch (err) {
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = err.status ?? 1;
  }
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // not every mode prints JSON; caller decides whether that's expected
  }
  return { exitCode, stdout, stderr, json };
}

function scratchDir() {
  return mkdtempSync(join(tmpdir(), "api-probe-test-"));
}

// ---------------------------------------------------------------------------------------
// dump mode
// ---------------------------------------------------------------------------------------

test("dump mode: exits 0, prints a non-empty JSON surface with the expected shape", () => {
  const { exitCode, json } = run(["--pi", REAL_PI]);
  assert.equal(exitCode, 0);
  assert.ok(json, "expected valid JSON on stdout");
  assert.equal(json.probeVersion, 1);
  assert.equal(json.pi.package, "@earendil-works/pi-coding-agent");
  assert.equal(json.pi.binaryVersion, json.pi.packageVersion, "binary and package versions must match — that's the guard");

  // Spot-check known events rather than assert an exact list, so the test doesn't itself
  // become the thing that breaks on every minor PI bump.
  for (const ev of ["session_start", "tool_call", "before_agent_start", "agent_end"]) {
    assert.ok(json.events.includes(ev), `expected event "${ev}" in the extracted surface`);
  }
  assert.ok(json.events.length >= 30, `expected at least 30 events, got ${json.events.length}`);
  assert.deepEqual(json.events, [...json.events].sort(), "events must be sorted for a stable lock diff");

  for (const m of ["registerTool", "registerCommand", "on", "sendMessage", "registerProvider"]) {
    assert.ok(json.apiMethods.includes(m), `expected ExtensionAPI member "${m}"`);
  }
  assert.deepEqual(json.apiMethods, [...json.apiMethods].sort(), "apiMethods must be sorted");

  // settingsKeys must be exactly the top-level keys of its root's config/settings.json, not some
  // subset. Read from the same tracked template the fixture root was built from.
  const settingsJson = JSON.parse(readFileSync(SETTINGS_TEMPLATE, "utf8"));
  assert.deepEqual(json.settingsKeys, Object.keys(settingsJson).sort());

  // REAL_PI lives under $HOME (this repo's own node_modules) — the recorded path must be
  // redacted, since the lock is committed to a repo that lives on GitHub.
  assert.ok(json.pi.binaryPath.startsWith("~/"), `expected a home-redacted binaryPath, got "${json.pi.binaryPath}"`);
  assert.ok(!json.pi.binaryPath.includes(homedir()), "the raw home directory must not appear in recorded output");
});

// Regression (2026-08-11): the probe used to abort with exit 2 whenever config/settings.json
// carried a top-level key PI's own `Settings` interface does not declare, on the assumption that
// every settings key is PI's. It is not — PI parses settings.json verbatim and keeps unrecognised
// keys, and installed packages read their own top-level key off it (pi-smart-compact reads
// `smartCompact`). Merging W3-LSP's `lsp` block into config/settings.json therefore made every
// single probe run fail. Package-owned keys must be recorded and partitioned, never a probe abort.
test("settings keys PI's own Settings type does not declare are recorded, not a probe failure", () => {
  const { exitCode, json } = run(["--pi", REAL_PI]);
  assert.equal(exitCode, 0, "a settings key PI does not declare must not abort the probe");
  assert.ok(Array.isArray(json.settingsKeysNotDeclaredByPi), "expected a settingsKeysNotDeclaredByPi array in the surface");
  for (const k of json.settingsKeysNotDeclaredByPi) {
    assert.ok(json.settingsKeys.includes(k), `"${k}" must also appear in settingsKeys — it is a key we carry`);
  }
  assert.deepEqual(json.settingsKeysNotDeclaredByPi, [...json.settingsKeysNotDeclaredByPi].sort(), "must be sorted");
});

test("check mode: a locked settings key the lock itself marks as not-declared-by-PI is never a breaking change", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    const dump = run(["--pi", REAL_PI]);
    const lock = JSON.parse(dump.stdout);
    // A package-owned key: present in settingsKeys, and declared as PI-unowned. PI never offered
    // it, so PI cannot have removed it — contrast with the test above, which pushes a key into
    // settingsKeys only and must still exit 1.
    lock.settingsKeys.push("aPackageOwnedKeyPiNeverDeclared");
    lock.settingsKeysNotDeclaredByPi = [...(lock.settingsKeysNotDeclaredByPi ?? []), "aPackageOwnedKeyPiNeverDeclared"];
    writeFileSync(lockPath, JSON.stringify(lock));

    const { exitCode, stdout } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 0, "a package-owned settings key must not fire the A-2 detector");
    assert.match(stdout, /no breaking change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a --pi path outside $HOME is recorded as-is (redaction only strips the user's own home)", (t) => {
  const dir = scratchDir();
  try {
    if (dir.startsWith(homedir())) {
      t.skip("this machine's tmpdir() is under $HOME — cannot exercise the non-redacted branch");
      return;
    }
    const link = join(dir, "pi");
    symlinkSync(REAL_PI, link); // resolve(piPath) does not follow the symlink, so the recorded path is `link`
    const { exitCode, json } = run(["--pi", link]);
    assert.equal(exitCode, 0);
    assert.equal(json.pi.binaryPath, link);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump mode is deterministic: two runs produce the same surface modulo generatedAt", () => {
  const a = run(["--pi", REAL_PI]).json;
  const b = run(["--pi", REAL_PI]).json;
  delete a.generatedAt;
  delete b.generatedAt;
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------------------
// argument / environment errors — exit 2, never 0, never a silent empty surface
// ---------------------------------------------------------------------------------------

test("missing --pi: exit 2, usage on stderr", () => {
  const { exitCode, stdout, stderr } = run([]);
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--pi/);
});

test("--pi pointing at a nonexistent path: exit 2, error names the path", () => {
  const { exitCode, stderr } = run(["--pi", "/nonexistent/pi-binary"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /\/nonexistent\/pi-binary/);
});

test("unknown flag: exit 2", () => {
  const { exitCode, stderr } = run(["--pi", REAL_PI, "--bogus"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /--bogus/);
});

test("--pi binary whose --version disagrees with the installed npm package: exit 2, names both versions", () => {
  const dir = scratchDir();
  try {
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, "#!/bin/sh\necho '9.9.9'\n");
    chmodSync(fakePi, 0o755);
    const { exitCode, stderr } = run(["--pi", fakePi]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /9\.9\.9/);
    assert.match(stderr, /0\.84\.0/);
    assert.match(stderr, /version mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// check mode
// ---------------------------------------------------------------------------------------

test("check mode against a lock generated from the same install: exit 0, no breaking change", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    const dump = run(["--pi", REAL_PI]);
    assert.equal(dump.exitCode, 0);
    writeFileSync(lockPath, dump.stdout);

    const { exitCode, stdout } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /no breaking change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check mode: a locked event no longer produced by the installed package is a breaking change, exit 1", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    const dump = run(["--pi", REAL_PI]);
    const lock = JSON.parse(dump.stdout);
    lock.events.push("session_wipe_all_state_zz");
    writeFileSync(lockPath, JSON.stringify(lock));

    const { exitCode, stdout } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 1);
    assert.match(stdout, /BREAKING CHANGE DETECTED/);
    assert.match(stdout, /session_wipe_all_state_zz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check mode: a locked ExtensionAPI member no longer present is a breaking change, exit 1", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    const dump = run(["--pi", REAL_PI]);
    const lock = JSON.parse(dump.stdout);
    lock.apiMethods.push("registerTotallyMadeUpThing");
    writeFileSync(lockPath, JSON.stringify(lock));

    const { exitCode, stdout } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 1);
    assert.match(stdout, /registerTotallyMadeUpThing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check mode: a locked depended-on settings key no longer offered is a breaking change, exit 1", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    const dump = run(["--pi", REAL_PI]);
    const lock = JSON.parse(dump.stdout);
    lock.settingsKeys.push("thisSettingWasRemovedUpstream");
    writeFileSync(lockPath, JSON.stringify(lock));

    const { exitCode, stdout } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 1);
    assert.match(stdout, /thisSettingWasRemovedUpstream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check mode: an added event/method since the lock is informational only, exit 0", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    const dump = run(["--pi", REAL_PI]);
    const lock = JSON.parse(dump.stdout);
    lock.events = lock.events.filter((e) => e !== "turn_start"); // pretend PI added turn_start after this lock
    writeFileSync(lockPath, JSON.stringify(lock));

    const { exitCode, stdout } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /informational/);
    assert.match(stdout, /turn_start/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check mode: missing lock file is a probe failure (exit 2), distinct from a breaking change (exit 1)", () => {
  const { exitCode, stderr } = run(["--pi", REAL_PI, "--check", "--lock", "/nonexistent/lock.json"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /lock file not found/);
});

test("check mode: corrupt lock JSON is a probe failure, exit 2", () => {
  const dir = scratchDir();
  try {
    const lockPath = join(dir, "lock.json");
    writeFileSync(lockPath, "{not valid json");
    const { exitCode, stderr } = run(["--pi", REAL_PI, "--check", "--lock", lockPath]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// the fresh-clone precondition — pinned, not hidden
// ---------------------------------------------------------------------------------------

test("a repo root with no generated config/settings.json aborts loudly (exit 2) instead of probing a partial surface", () => {
  // The behaviour every test above sidesteps with its fixture root, asserted here once so the
  // sidestep cannot quietly become "we never noticed". This is what `./bin/api-probe --pi …` does
  // in a clone that has not been installed: `config/settings.json` is generated by
  // scripts/install.sh and git-ignored, so it is absent, and the probe cannot run at all.
  //
  // Exit 2 (probe failure) rather than 1 (breaking change) is correct and is the point of the
  // assertion. What is NOT correct — reported, not papered over — is that the script insists on the
  // generated file when the tracked `config/settings.default.json` carries the same top-level key
  // set and is always present. Falling back to it would let the probe run on any clone.
  const bare = mkdtempSync(join(tmpdir(), "api-probe-bare-"));
  try {
    mkdirSync(join(bare, "bin"), { recursive: true });
    mkdirSync(join(bare, "config"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "bin", "api-probe.mjs"), join(bare, "bin", "api-probe.mjs"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(bare, "node_modules"));

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [join(bare, "bin", "api-probe.mjs"), "--pi", REAL_PI], { encoding: "utf8" });
    } catch (err) {
      exitCode = err.status ?? 1;
      stderr = err.stderr ?? "";
    }
    assert.equal(exitCode, 2, "a missing precondition is a probe failure, never a breaking-change verdict");
    assert.match(stderr, /settings\.json does not exist/);
    assert.doesNotMatch(stderr, /settings\.default\.json/, "if this ever matches, the fallback landed — delete this test");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

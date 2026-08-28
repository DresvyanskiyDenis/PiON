// test/ext-28-install.suite.mjs — EXT-28 (`scripts/install.sh` + `scripts/postinstall-verify.sh` +
// `scripts/lib/portable-timeout.sh`) hardening tests.
//
// Design: every mutating scenario runs against a throwaway fixture repo + fixture $HOME under the OS
// tmpdir, never against the real `~/.pi/agent` or the real `~/pi-config` — matching the "no test may
// hit ~/.pi/agent" rule. The fixture repo symlinks the REAL scripts under test
// (so we exercise the actual committed logic, not a copy) into a minimal, self-contained config tree
// carrying exactly install.sh's `required` entry set. Incompleteness is produced deliberately, by
// deleting from that skeleton — earlier this suite instead leaned on the live checkout genuinely
// lacking `skills/`/`prompts/`, which stopped being true once wave 1 landed them.
//
// `env` is built explicitly per call, never spread from `process.env`: a developer machine behind a
// TLS-inspecting proxy exports a real NODE_EXTRA_CA_CERTS, and spreading it in would make the
// TLS/proxy-env tests pass or fail depending on who runs them — observed, not theoretical.
//
// Runs with the built-in test runner: `node --test test/ext-28-install.suite.mjs`. Named `.suite.mjs`,
// not `.test.ts`, for the same reason as `test/pi-check.suite.mjs`: it stays out of `npm test`
// (vitest) and out of `test:node`'s `test/**/*.test.ts` glob.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const REAL_SCRIPTS = join(REPO_ROOT, "scripts");
const NODE_DIR = dirname(process.execPath);

// ---------------------------------------------------------------------------------------- helpers

/** Maps `uname -sm` to install.sh's own PLATFORM values, so fixtures work on any CI runner. */
function platformAsset() {
  const s = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim();
  const m = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
  const map = {
    "Darwin arm64": "darwin-arm64",
    "Darwin x86_64": "darwin-x64",
    "Linux x86_64": "linux-x64",
    "Linux aarch64": "linux-arm64",
  };
  const platform = map[`${s} ${m}`];
  assert.ok(platform, `unsupported test platform: ${s} ${m}`);
  return platform;
}

/** A minimal, deterministic PATH: fixture $HOME/bin first, then just enough of the real system to
 * find bash/tar/jq/node/ln/readlink/mkdir/pkill. Crucially excludes ~/bin, where a real `pi` lives on
 * this machine — confirmed present — so fixture runs never accidentally talk to it. */
function curatedPath(fixtureHome) {
  return [join(fixtureHome, "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", NODE_DIR].join(":");
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A minimal repo tree with the REAL install.sh / postinstall-verify.sh / lib/* symlinked in, plus
 * just enough config/ shape for install.sh's required-entry check to pass. */
function makeRepoSkeleton() {
  const repo = freshDir("ext28-repo-");
  for (const d of ["config", "extensions", "skills", "prompts", "scripts/lib", "bin"]) {
    mkdirSync(join(repo, d), { recursive: true });
  }
  writeFileSync(join(repo, "config", "settings.json"), "{}\n");
  writeFileSync(join(repo, "config", "models.json"), JSON.stringify({ providers: {} }, null, 2) + "\n");
  writeFileSync(join(repo, "config", "routing.json"), "{}\n");
  writeFileSync(join(repo, "extensions", "placeholder.ts"), "export {};\n");
  writeFileSync(join(repo, "skills", ".gitkeep"), "");
  writeFileSync(join(repo, "prompts", ".gitkeep"), "");
  // The full `required` set install.sh step 6 enforces, not a subset of it. Every row below is a
  // `link_one required` line in scripts/install.sh; miss one and the whole run dies at
  // PI-INSTALL-E18 long before the behaviour a test is actually asserting. The four `configDir()`
  // rows (mcp.json, web.json, web-search.json, hooks.yaml) were added to install.sh after this
  // fixture was written — that drift is what made three assertions in this suite match the wrong
  // error. Keep this list in sync with install.sh's `link_one required` rows.
  writeFileSync(join(repo, "AGENTS.md"), "# fixture\n");
  writeFileSync(join(repo, "config", "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  writeFileSync(join(repo, "config", "web.json"), "{}\n");
  writeFileSync(join(repo, "config", "web-search.json"), "{}\n");
  writeFileSync(join(repo, "config", "hooks.yaml"), "hooks: []\n");
  // The provider templates the installer reads before it links anything (scripts/lib/providers.mjs)
  // and the tracked `config/*.default.json` it generates every config file FROM. Symlinked to the
  // real ones rather than stubbed: their schema is the installer's own, a hand-written stub drifts
  // from it silently, and the installer aborts (PI-INSTALL-E30) the moment one is absent.
  symlinkSync(join(REPO_ROOT, "config", "providers"), join(repo, "config", "providers"));
  for (const rel of readdirSync(join(REPO_ROOT, "config")).filter((f) => f.endsWith(".default.json"))) {
    symlinkSync(join(REPO_ROOT, "config", rel), join(repo, "config", rel));
  }

  for (const rel of ["install.sh", "postinstall-verify.sh", "auto-update-check.sh"]) {
    symlinkSync(join(REAL_SCRIPTS, rel), join(repo, "scripts", rel));
  }
  // Every helper in scripts/lib/, enumerated rather than listed: install.sh and
  // postinstall-verify.sh source or `node`-run these, and a missing one aborts the run with
  // PI-INSTALL-E09 ("re-clone the repository") long before the behaviour under test is reached —
  // which is exactly what a hardcoded pair did once `json.mjs`, `configure.mjs` and `providers.mjs`
  // were added. Reading the directory keeps the fixture honest as the helper set grows.
  for (const rel of readdirSync(join(REAL_SCRIPTS, "lib"))) {
    symlinkSync(join(REAL_SCRIPTS, "lib", rel), join(repo, "scripts", "lib", rel));
  }

  // A stub, not the real bin/pi-check: this suite is not re-testing EXT-04a's rules, only that
  // install.sh step 8 wires it in correctly when present.
  const stub = join(repo, "bin", "pi-check");
  writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(stub, 0o755);

  // A stub, not the real bin/pi-run: this suite is not re-testing V-01's wrapper behaviour, only
  // that install.sh step 6 links it onto $BIN_DIR like every other required entry — install.sh
  // `chmod`s and links it unconditionally, so a repo skeleton without it fails the whole run.
  const piRunStub = join(repo, "bin", "pi-run");
  writeFileSync(piRunStub, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(piRunStub, 0o755);

  return repo;
}

/** The npm package name in config/pi-release.lock. `npm.package` and `npm.spec` are separate fields
 * in the real lock and install.sh reads both — the spec (with version) to install, the bare package
 * to record as an NPMGLOBAL manifest row — so the fixture lock carries both too. */
const NPM_PACKAGE = "@earendil-works/pi-coding-agent";

/** `platform` and `sha256` default to the "no digest yet" placeholder install.sh already special-cases
 * (`REPLACE_AFTER_V22`) so callers that don't care about the sha-verification path (most of this
 * suite) can stay on the `--dry-run` / no-network path without also computing a real archive. */
function writeLock(repo, { version = "0.84.0", platform, sha256 = "REPLACE_AFTER_V22" }) {
  const lock = {
    version,
    releaseBase: "https://example.invalid/should-never-be-fetched-by-this-suite",
    binaries: { [platform]: { sha256 } },
    npm: { package: NPM_PACKAGE, spec: `${NPM_PACKAGE}@${version}` },
  };
  writeFileSync(join(repo, "config", "pi-release.lock"), JSON.stringify(lock, null, 2) + "\n");
}

/** Builds a fake `pi` binary tarball (reports `--version` as `version`, otherwise errors) staged for
 * `install.sh --offline --offline-dir`, and returns its sha256 for the lock file.
 *
 * The layout here is load-bearing. An upstream release archive is a TREE: it unpacks as a single
 * `pi/` directory holding the executable next to the native modules, wasm and bundled node_modules
 * it loads at runtime. A fixture that packs a bare `pi` file at the archive root instead certifies
 * a layout that does not exist — an installer that extracts straight into `bin/` passes against it
 * while producing a *directory* at `bin/pi` against the real archive.
 *
 * Note that `makeSelfInstallPi` below has modelled the true `<prefix>/.local/pi/<version>/pi/pi`
 * shape all along, for PI's own installer. The two are the same archive unpacked by two different
 * installers, which is why they must not share a directory — see that helper's own note.
 *
 * The companion file is not decoration: it is what makes "the executable cannot be lifted out of its
 * tree" true in the fixture as well as in reality, so a future change that copies the binary
 * somewhere on its own fails here instead of on someone's machine.
 */
function stageFakePiTarball(stageDir, platform, version = "0.84.0") {
  mkdirSync(stageDir, { recursive: true });
  const workDir = freshDir("ext28-fake-pi-");
  const treeDir = join(workDir, "pi");
  mkdirSync(treeDir, { recursive: true });
  const piPath = join(treeDir, "pi");
  // Reads a sibling of its own *resolved* location before answering, exactly as the real binary
  // loads its runtime assets. Both halves of that matter: a `pi` lifted out of this tree reports
  // nothing, while a `pi` invoked through a symlink onto PATH works, because a compiled executable
  // resolves its own path instead of trusting $0. install.sh depends on precisely that combination
  // — it unpacks the tree and links to the binary inside it, never moving it.
  writeFileSync(
    piPath,
    `#!/usr/bin/env bash\n` +
      `self="$0"\n` +
      `while [ -L "$self" ]; do\n` +
      `  link="$(readlink -- "$self")"\n` +
      `  case "$link" in /*) self="$link" ;; *) self="$(dirname -- "$self")/$link" ;; esac\n` +
      `done\n` +
      `here="$(cd -- "$(dirname -- "$self")" && pwd -P)"\n` +
      `[ -f "$here/runtime-asset.txt" ] || { echo "fake-pi: runtime tree missing" >&2; exit 1; }\n` +
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n` +
      `echo "fake-pi: unsupported args: $*" >&2\nexit 1\n`,
  );
  chmodSync(piPath, 0o755);
  writeFileSync(join(treeDir, "runtime-asset.txt"), `pi ${version} runtime asset\n`);
  const tarballPath = join(stageDir, `pi-${platform}.tar.gz`);
  execFileSync("tar", ["-czf", tarballPath, "-C", workDir, "pi"], {
    env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  return { tarballPath, sha256 };
}

/** Where install.sh unpacks the release archive: `$PREFIX/.local/share/pi-config/runtime/<version>`,
 * with the executable at `<that>/pi/pi`. Deliberately NOT `makeSelfInstallPi`'s `.local/pi/` — see
 * that helper. */
function piRuntimeDir(prefix, version) {
  return join(prefix, ".local", "share", "pi-config", "runtime", version);
}

/** Builds the shape PI's *own* binary installer produces — `$fixtureHome/.local/pi/<version>/pi/pi`,
 * an unpacked release tree with a real, executable `pi` at the bottom — and returns its path so a
 * caller can `symlinkSync` it onto `$fixtureHome/bin/pi`, matching what was observed on the real
 * machine 2026-08-11 (`~/bin/pi -> ~/.local/pi/0.84.0/pi/pi`).
 *
 * This path is PI's, not ours, and the tests below rely on that: install.sh unpacks its own runtime
 * into `piRuntimeDir()` above instead, so neither installer writes into the other's tree and
 * uninstall.sh's recursive TREE delete can never reach a pi the user installed themselves. Same
 * version on both sides is the interesting case, so use it. */

function makeSelfInstallPi(fixtureHome, version) {
  const dir = join(fixtureHome, ".local", "pi", version, "pi");
  mkdirSync(dir, { recursive: true });
  const piPath = join(dir, "pi");
  writeFileSync(
    piPath,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n` +
      `echo "self-install-pi: unsupported args: $*" >&2\nexit 1\n`,
  );
  chmodSync(piPath, 0o755);
  return piPath;
}

/** Runs a script with a fully explicit env (never inherits this process's real env — see file
 * header) and never throws; failures are ordinary return values.
 *
 * `spawnSync`, not `execFileSync`: the latter only surfaces stderr on the throw path, so the
 * success path had to hardcode `stderr: ""` — a successful run's warnings were invisible to every
 * assertion and leaked into the test runner's own stderr instead. */
function runScript(scriptPath, args, env) {
  const res = spawnSync("bash", [scriptPath, ...args], { encoding: "utf8", env });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function baseEnv(fixtureHome, extra = {}) {
  return { HOME: fixtureHome, PATH: curatedPath(fixtureHome), ...extra };
}

/** install.sh's own end-of-run summary line. It used to read `install complete — N step(s) changed,
 * mode=<mode>`; the rewritten script prints `Done — N step(s) changed` and reports the mode in the
 * "What you now have" block below it. Matched as one anchored pattern, in one place, so the next
 * rewording is a single edit rather than a hunt. */
const DONE_LINE = /^\s*Done — (\d+) step\(s\) changed\s*$/m;

/**
 * A `crontab(1)` that keeps the table in a file under the fixture $HOME instead of in the real
 * per-user cron spool. Every scheduling assertion in this suite goes through it: `crontab` is
 * per-USER, not per-$HOME, so a test that called the real one would rewrite the crontab of whoever
 * ran `npm test` — on their laptop, with their jobs in it. The fixture PATH puts $HOME/bin first
 * (see curatedPath), which is the same trick the offline runs use for `pi`.
 *
 * It implements exactly the three forms install.sh and uninstall.sh use: `-l` to read (exit 1 with
 * "no crontab" when there is none, as the real one does — that exit status is load-bearing, the
 * scripts branch on it), `FILE` to replace, and `-` to replace from stdin.
 */
function installFakeCrontab(fixtureHome) {
  const tab = join(fixtureHome, "crontab.tab");
  const bin = join(fixtureHome, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "crontab");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      `TAB="${tab}"`,
      'case "${1:-}" in',
      '  -l) [ -f "$TAB" ] || { printf \'no crontab for fixture\\n\' >&2; exit 1; }; cat "$TAB" ;;',
      '  -r) rm -f "$TAB" ;;',
      '  -)  cat > "$TAB" ;;',
      '  *)  cat "$1" > "$TAB" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  return tab;
}

/** The crontab as install.sh left it, or [] when no table was ever written. */
function cronLines(tab) {
  return existsSync(tab) ? readFileSync(tab, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
}

const CRON_MARK = "# pi-config:auto-update";
const markedLines = (tab) => cronLines(tab).filter((l) => l.includes(CRON_MARK));


// =========================================================================================
// install.sh
// =========================================================================================

describe("install.sh", () => {
  test("--help prints the whole header block and nothing past it", () => {
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(join(REAL_SCRIPTS, "install.sh"), ["--help"], baseEnv(fixtureHome));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage:/);
    // The link to its own documentation, which the old line range cut off entirely.
    assert.match(res.stdout, /getting-started\/install/);
    assertHelpIsExactlyTheHeader(res.stdout, /getting-started\/install\/$/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  // Was "--dry-run on the live (currently-incomplete) repo fails loudly with PI-INSTALL-E18": it
  // asserted E18 against the *live* repo because, on the day it was written, this checkout had no
  // skills/ or prompts/ tree. Both now exist (as do AGENTS.md and the four config/ rows install.sh
  // added later), so the premise is gone and the assertion could only ever match by accident. The
  // two invariants it was really guarding are both real and both kept, split in two so neither
  // depends on the live repo happening to be broken:
  //   1. a missing required entry fails loudly with E18 naming it, and --dry-run still writes nothing;
  //   2. --dry-run against the live repo writes nothing either, on the success path.
  test("PI-INSTALL-E18: a missing required entry fails loudly, and --dry-run still writes nothing", () => {
    const repo = makeRepoSkeleton();
    // `prompts`, not `skills`: `skills` is now a `link_one optional` row (the repo ships no skills of
    // its own), so deleting it is a supported shape rather than a half-clone and E18 is never raised.
    // `prompts` is still `link_one required` and, unlike the required config/*.json rows, it is a
    // tracked directory the installer never regenerates — so its absence is a real half-clone.
    rmSync(join(repo, "prompts"), { recursive: true, force: true });
    writeLock(repo, { platform: platformAsset() });
    const fixtureHome = freshDir("ext28-home-");

    const res = runScript(join(repo, "scripts", "install.sh"), ["--dry-run"], baseEnv(fixtureHome));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /PI-INSTALL-E18/);
    assert.match(res.stderr, /prompts/);
    // --dry-run's whole point: not one byte written under $HOME, even along a real failure path.
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("--dry-run on the live repo: completes, verifies no artifact it never fetched, and writes nothing", () => {
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(join(REAL_SCRIPTS, "install.sh"), ["--dry-run"], baseEnv(fixtureHome));
    // Regression: once config/pi-release.lock carried real digests (digestsClosedOn 2026-08-07), a
    // non-offline --dry-run reached step 4's sha256 check on the tarball it had deliberately only
    // *printed* a curl for. `shasum` failed, and under `set -euo pipefail` the assignment took the
    // whole script down with a bare "No such file or directory" — exit 1, no PI-INSTALL code, no
    // cause. Every exit path of this script owes a code; a dry run that skipped the download owes
    // no digest at all.
    assert.equal(res.status, 0, `dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /No such file or directory/);
    assert.match(res.stderr, /sha256 NOT checked/);
    assert.match(res.stdout, DONE_LINE);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("--express: the summary names the branches actually protected, not the answer nobody was asked for", () => {
    // Section 6 asks which branches are protected only on the LONG path. On --express the answer is
    // therefore empty, the guard write correctly skips an empty value, and config/guard.default.json
    // keeps shipping ["main","master"] — so the branches ARE protected. The summary printed the
    // empty answer, which told the express user, the one most likely to read that line at all, that
    // nothing was. Read back from the file, the same rule the MCP line beside it already follows.
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(
      join(REAL_SCRIPTS, "install.sh"),
      ["--dry-run", "--express", "--yes", "--providers", "github-copilot"],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 0, `express dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.match(`${res.stdout}${res.stderr}`, /protected branches: main,master/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("--answers pinning a hosted search backend: both web files get the same provider, and the key is deferred, never written into config", () => {
    // Section 7 offers searxng, tavily, brave, exa or none. The three hosted backends are the only
    // answers that need a credential, and a non-interactive run is where that is easiest to lose:
    // there is no terminal to type a key on, so the run owes the user a manual step instead of a
    // config file that silently references a variable nobody set.
    const fixtureHome = freshDir("ext28-home-");
    const answersDir = freshDir("ext28-answers-");
    const answers = join(answersDir, "answers.conf");
    writeFileSync(answers, "web.backend=tavily\n");

    const res = runScript(
      join(REAL_SCRIPTS, "install.sh"),
      ["--dry-run", "--yes", "--answers", answers, "--providers", "github-copilot"],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 0, `answers dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /web search: tavily/);
    // The pair EXT-07's session_start guard cross-checks: a run that patched one and not the other
    // would install a harness that refuses to start.
    assert.match(out, /patch web\.json: search\.backend=tavily/);
    assert.match(out, /patch web-search\.json: provider=tavily webSearch\.enabled=true/);
    // The key itself: accounted for as a manual step, and never a value in a tracked config file.
    // The deferred line is assembled from `envVar` rather than written out whole because this
    // repository's own publication gate (test/content/publication.test.ts) rejects any tracked line
    // that assigns something to a credential-shaped variable name — placeholder value or not.
    const envVar = "TAVILY_API_KEY";
    assert.match(out, new RegExp(`${envVar}\\s+deferred`));
    assert.match(out, new RegExp(`echo '${envVar}=<your value>' >> \\S+secrets\\.env`));
    assert.doesNotMatch(out, /tavilyApiKey/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("the default backend is none, and the run says web_fetch keeps working without a key", () => {
    // "none" is the default answer, so it is the state most installs end in. It disables web_search
    // only — claiming or implying that it disables web access altogether would send people looking
    // for a search key they do not need to read a URL.
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(
      join(REAL_SCRIPTS, "install.sh"),
      ["--dry-run", "--yes", "--providers", "github-copilot"],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 0, `default dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /patch web\.json: search\.backend=none/);
    assert.match(out, /patch web-search\.json: provider=none webSearch\.enabled=false/);
    assert.match(out, /web_fetch is unaffected and still needs no key.*Jina Reader/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("PI-INSTALL-E19: refuses when auth.json/trust.json/sessions is a symlink into the repo", () => {
    const repo = makeRepoSkeleton();
    const platform = platformAsset();
    writeLock(repo, { platform });
    const fixtureHome = freshDir("ext28-home-");
    const agentDir = join(fixtureHome, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    // Simulate the exact failure this guard exists for: a credential file symlinked into the repo.
    symlinkSync(join(repo, "config", "settings.json"), join(agentDir, "auth.json"));

    const res = runScript(join(repo, "scripts", "install.sh"), ["--dry-run"], baseEnv(fixtureHome));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /PI-INSTALL-E19/);
    assert.match(res.stderr, /auth\.json/);
  });

  test("offline binary install end-to-end: succeeds, is idempotent, and correctly invokes postinstall-verify.sh", () => {
    const repo = makeRepoSkeleton();
    const platform = platformAsset();
    const stageDir = freshDir("ext28-offline-");
    const { sha256 } = stageFakePiTarball(stageDir, platform);
    writeLock(repo, { platform, sha256 });

    const fixtureHome = freshDir("ext28-home-");
    writeFileSync(join(fixtureHome, ".zshrc"), "# pre-existing rc file\n");

    const env = baseEnv(fixtureHome);
    const args = ["--mode", "binary", "--offline", "--offline-dir", stageDir];

    const first = runScript(join(repo, "scripts", "install.sh"), args, env);
    assert.equal(first.status, 0, `first run failed:\nSTDOUT:${first.stdout}\nSTDERR:${first.stderr}`);
    assert.match(first.stdout, DONE_LINE);
    // The regression this task closes: install.sh referenced the old `scripts/verify.sh` name and
    // postinstall-verify.sh shipped without the executable bit, so step 9 silently never ran.
    // Both are fixed; prove step 9 actually executed the real script by looking for its own,
    // distinctive per-check output inside install.sh's captured output.
    assert.doesNotMatch(
      first.stdout + first.stderr,
      /scripts\/postinstall-verify\.sh not present yet/,
      "step 9 must find and run postinstall-verify.sh, not skip it",
    );
    assert.match(first.stdout, /pi version pinned/);
    assert.match(first.stdout, /0\.84\.0 at /);

    // Idempotency: a second identical run must change nothing at all. Read off the summary line's
    // own counter rather than the last line of output — install.sh prints several more lines (next
    // steps, credential disclaimer) after it.
    const second = runScript(join(repo, "scripts", "install.sh"), args, env);
    assert.equal(second.status, 0, `second run failed:\nSTDOUT:${second.stdout}\nSTDERR:${second.stderr}`);
    const summary = second.stdout.match(DONE_LINE);
    assert.ok(summary, `no summary line in the second run's output:\n${second.stdout}`);
    assert.equal(summary[1], "0", `second run reported ${summary[1]} changed step(s):\n${second.stdout}`);
  });

  test("--offline with a wrong sha256 in the lock fails PI-INSTALL-E05, never installs the binary", () => {
    const repo = makeRepoSkeleton();
    const platform = platformAsset();
    const stageDir = freshDir("ext28-offline-badsha-");
    stageFakePiTarball(stageDir, platform);
    writeLock(repo, { platform, sha256: "0000000000000000000000000000000000000000000000000000000000000000" });

    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(
      join(repo, "scripts", "install.sh"),
      ["--mode", "binary", "--offline", "--offline-dir", stageDir],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /PI-INSTALL-E05/);
    assert.match(res.stderr, /sha256 mismatch/);
  });

  test("binary mode: a symlink into PI's own self-install at the expected version is a no-op, not overwritten", () => {
    // Reproduces the exact shape found on the real machine 2026-08-11: ~/bin/pi is a symlink into
    // ~/.local/pi/<version>/pi/pi, not the real file this script's own tar -xzf would produce.
    const repo = makeRepoSkeleton();
    const platform = platformAsset();
    writeLock(repo, { platform }); // sha256 unused: version already matches, no download/extract happens
    const fixtureHome = freshDir("ext28-home-");
    const binDir = join(fixtureHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const selfInstallPi = makeSelfInstallPi(fixtureHome, "0.84.0");
    symlinkSync(selfInstallPi, join(binDir, "pi"));

    const res = runScript(join(repo, "scripts", "install.sh"), ["--mode", "binary"], baseEnv(fixtureHome));
    assert.equal(res.status, 0, `run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    // The wording is the rewritten script's: it no longer names PI's self-install layout
    // specifically, it reports the resolved target of whatever symlink it found. The property under
    // test is unchanged — the already-correct version is recognised through the symlink, so nothing
    // is downloaded, extracted or repointed.
    assert.match(res.stdout, /OK {2}pi 0\.84\.0 already installed \(symlink -> .*\.local\/pi\/0\.84\.0\/pi\/pi\)/);
    // No "changed" line anywhere in step 4's own output for pi, and the symlink itself survived
    // verbatim — the whole point of recognising this shape instead of blindly re-extracting.
    assert.doesNotMatch(res.stdout, /changed .*pi 0\.84\.0/);
    assert.equal(readlinkSync(join(binDir, "pi")), selfInstallPi, "the working symlink must not be touched");
  });

  test("binary mode: a version-mismatched self-install symlink is repointed, but PI's own installed copy is never deleted", () => {
    const repo = makeRepoSkeleton();
    const platform = platformAsset();
    const stageDir = freshDir("ext28-offline-clobber-");
    const { sha256 } = stageFakePiTarball(stageDir, platform); // reports 0.84.0
    writeLock(repo, { platform, sha256 });

    const fixtureHome = freshDir("ext28-home-");
    const binDir = join(fixtureHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const staleSelfInstallPi = makeSelfInstallPi(fixtureHome, "0.83.0"); // deliberately stale
    symlinkSync(staleSelfInstallPi, join(binDir, "pi"));
    const staleContentsBefore = readFileSync(staleSelfInstallPi);

    const res = runScript(
      join(repo, "scripts", "install.sh"),
      ["--mode", "binary", "--offline", "--offline-dir", stageDir],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 0, `run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    // Again the rewrite's shorter wording; the announcement is still made, on stderr, and still
    // names both versions. What the assertions below check is the part that matters and is
    // unchanged: the copy the stale symlink pointed at is never written through or deleted.
    assert.match(res.stderr, /replacing pi 0\.83\.0 with the pinned 0\.84\.0/);
    // The literal "not clobbering PI's own installed binary" assertion: the file the stale symlink
    // pointed at is untouched, byte for byte, even though $BIN_DIR/pi itself now points elsewhere.
    assert.ok(lstatSync(staleSelfInstallPi).isFile(), "the self-installed copy must still exist");
    assert.deepEqual(readFileSync(staleSelfInstallPi), staleContentsBefore, "the self-installed copy must be byte-identical");
    // bin/pi is a symlink, and it is one for a reason: the release archive is a tree whose binary
    // loads its siblings at runtime, so install.sh unpacks the tree and links to the executable
    // inside it rather than lifting the executable out.
    const link = readlinkSync(join(binDir, "pi"));
    assert.equal(link, join(piRuntimeDir(fixtureHome, "0.84.0"), "pi", "pi"), "bin/pi points into our own runtime tree");
    assert.equal(
      execFileSync(join(binDir, "pi"), ["--version"], { encoding: "utf8" }).trim(),
      "0.84.0",
      "the linked binary runs, i.e. it can still see the runtime tree around it",
    );
  });

  test("PI-INSTALL-E13: a directory sitting at $BIN_DIR/pi is named, not crashed on", () => {
    // The state left behind on any machine that ran an installer which extracted the release tree
    // into $BIN_DIR: a *directory* at ~/bin/pi. Without the guard the run does not stop there —
    // `ln -sfn` quietly puts its link inside the directory and exits 0, and the failure surfaces
    // several steps later as PI-INSTALL-E06 "an older pi is earlier on PATH", which sends you
    // hunting through $PATH for a problem that is sitting at the target path itself.
    const repo = makeRepoSkeleton();
    const platform = platformAsset();
    const stageDir = freshDir("ext28-offline-dirpi-");
    const { sha256 } = stageFakePiTarball(stageDir, platform);
    writeLock(repo, { platform, sha256 });

    const fixtureHome = freshDir("ext28-home-");
    const strandedTree = join(fixtureHome, "bin", "pi", "pi");
    mkdirSync(strandedTree, { recursive: true });

    const res = runScript(
      join(repo, "scripts", "install.sh"),
      ["--mode", "binary", "--offline", "--offline-dir", stageDir],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /PI-INSTALL-E13/);
    assert.doesNotMatch(res.stderr, /PI-INSTALL-E06/, "the misleading late failure is what this replaces");
    assert.match(res.stderr, /rm -rf/);
    assert.ok(lstatSync(strandedTree).isDirectory(), "it says how to remove it; it does not remove it");
  });
});

// =========================================================================================
// the price question — scripts/lib/providers.mjs, which is what turns interview answers into
// config/models.json
// =========================================================================================
//
// A fresh install used to end "consistent" and die on its first billed turn: the gateway fragments
// rendered a model with every field a turn needs and no `cost`, the composer substituted four zeros
// nobody wrote, and `extensions/cost-gate` aborted turn one with the money already spent. The fix is
// not another gate — there were two already — but moving the answer earlier, to the one point where
// being wrong costs nothing. These tests drive the generator install.sh calls, with the answers an
// operator would have typed.

// =========================================================================================
// install.sh — the maintenance section: auto-update scheduling
// =========================================================================================

describe("the installer schedules the update check", () => {
  const platform = platformAsset();

  /** A real (not --dry-run) offline install, run through the fake crontab. */
  function offlineInstall(fixtureHome, answersText, extraArgs = []) {
    const repo = makeRepoSkeleton();
    const stageDir = freshDir("ext28-offline-cron-");
    const { sha256 } = stageFakePiTarball(stageDir, platform);
    writeLock(repo, { platform, sha256 });
    const answers = join(freshDir("ext28-answers-cron-"), "answers.conf");
    writeFileSync(answers, answersText);
    const run = (...args) =>
      runScript(
        join(repo, "scripts", "install.sh"),
        ["--mode", "binary", "--offline", "--offline-dir", stageDir, "--answers", answers, ...extraArgs, ...args],
        baseEnv(fixtureHome),
      );
    return { repo, run, answers };
  }

  test("enabled: exactly one marked 30-minute entry, and a second run adds no second one", () => {
    const fixtureHome = freshDir("ext28-home-");
    const tab = installFakeCrontab(fixtureHome);
    const { run } = offlineInstall(fixtureHome, "autoupdate.enabled=true\nautoupdate.mode=prompt\n");

    const first = run();
    assert.equal(first.status, 0, `install failed:\nSTDOUT:${first.stdout}\nSTDERR:${first.stderr}`);

    const marked = markedLines(tab);
    assert.equal(marked.length, 1, `expected one marked entry, got:\n${cronLines(tab).join("\n")}`);
    assert.match(marked[0], /^\*\/30 \* \* \* \* \S+\/scripts\/auto-update-check\.sh /);
    // Cron mails every byte a job writes. The entry has to be silent or the user gets 48 mails a day.
    assert.match(marked[0], />\/dev\/null 2>&1/);

    // Idempotency, which for a crontab means the read-filter-write produced a byte-identical table
    // rather than an appended duplicate — the failure mode `crontab -l | { cat; echo …; }` has.
    const second = run();
    assert.equal(second.status, 0, `second run failed:\nSTDOUT:${second.stdout}\nSTDERR:${second.stderr}`);
    assert.deepEqual(markedLines(tab), marked, "the second run rewrote or duplicated the entry");
    const summary = second.stdout.match(DONE_LINE);
    assert.ok(summary, `no summary line:\n${second.stdout}`);
    assert.equal(summary[1], "0", `second run reported ${summary[1]} changed step(s):\n${second.stdout}`);
  });

  test("disabled by default: no crontab is written at all", () => {
    const fixtureHome = freshDir("ext28-home-");
    const tab = installFakeCrontab(fixtureHome);
    const { run } = offlineInstall(fixtureHome, "");
    const res = run();
    assert.equal(res.status, 0, `install failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.deepEqual(cronLines(tab), [], "an opt-in feature touched the crontab while opted out");
  });

  test("--section maintenance turns it off again, and leaves every other entry alone", () => {
    const fixtureHome = freshDir("ext28-home-");
    const tab = installFakeCrontab(fixtureHome);
    // Somebody else's job, already in the table. The installer edits ONE marked line; a rewrite
    // that dropped this would be the most expensive bug in the feature.
    const theirs = "0 5 * * * /usr/bin/true # nightly backup";
    writeFileSync(tab, `${theirs}\n`);

    const on = offlineInstall(fixtureHome, "autoupdate.enabled=true\nautoupdate.mode=auto\n");
    const enabled = on.run();
    assert.equal(enabled.status, 0, `install failed:\nSTDOUT:${enabled.stdout}\nSTDERR:${enabled.stderr}`);
    assert.equal(markedLines(tab).length, 1);
    assert.ok(cronLines(tab).includes(theirs), "the installer dropped an unrelated cron entry");

    const off = join(freshDir("ext28-answers-off-"), "answers.conf");
    writeFileSync(off, "autoupdate.enabled=false\n");
    const res = runScript(
      join(on.repo, "scripts", "install.sh"),
      ["--section", "maintenance", "--answers", off],
      baseEnv(fixtureHome),
    );
    assert.equal(res.status, 0, `--section maintenance failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.deepEqual(markedLines(tab), [], "turning it off left the cron entry behind");
    assert.deepEqual(cronLines(tab), [theirs], "turning it off disturbed an unrelated entry");
    assert.equal(
      readFileSync(join(on.repo, "config", "auto-update.json"), "utf8").includes('"enabled": false'),
      true,
      "the preference file still says enabled",
    );
  });
});

const PROVIDERS_TOOL = join(REAL_SCRIPTS, "lib", "providers.mjs");
const PROVIDERS_DIR = join(REPO_ROOT, "config", "providers");

/** providers.mjs delimits its TSV fields with US (0x1f), never a tab. See its own header for why. */
const FIELD_SEP = "\u001f";

/** The four rate fields of PI's `ModelCostRates`. All four, or the object is read as unpriced. */
const COST_RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/** The gateway-shaped fragments: their price is a fact about somebody else's deployment. */
const GATEWAYS = ["litellm", "openai-compatible"];

function providersTool(args) {
  const res = spawnSync(process.execPath, [PROVIDERS_TOOL, ...args], { encoding: "utf8" });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** `describe`'s PROMPT rows, keyed by prompt id. Field order is fixed by providers.mjs. */
function promptRows(providerId) {
  const res = providersTool(["describe", PROVIDERS_DIR, providerId]);
  assert.equal(res.status, 0, res.stderr);
  const rows = new Map();
  for (const line of res.stdout.split("\n")) {
    const f = line.split(FIELD_SEP);
    if (f[0] !== "PROMPT") continue;
    rows.set(f[1], {
      type: f[2], label: f[3], required: f[5], choices: f[6], choiceLabels: f[7],
      whenId: f[8], whenValue: f[9], help: f[12],
    });
  }
  return rows;
}

/**
 * Both gateways answer the same interview apart from `reasoning`, so one answer table with a
 * per-fragment pricing branch covers both. `pricing` is what an operator picks on screen.
 */
function gatewayAnswers(providerId, { pricing, second = true }) {
  const lines = [
    `${providerId}.baseUrl=https://gateway.example.com/v1`,
    `${providerId}.apiKeyEnv=GATEWAY_KEY_NAME`,
    `${providerId}.egress=internal`,
    `${providerId}.concurrency=4`,
    `${providerId}.model1Id=strong-alias`,
    `${providerId}.model1Context=200000`,
    `${providerId}.model1Reasoning=true`,
    `${providerId}.model1Pricing=${pricing}`,
    `tier.strong=${providerId}/strong-alias`,
  ];
  if (pricing === "metered") {
    lines.push(`${providerId}.model1CostInput=2.5`, `${providerId}.model1CostOutput=10`);
  }
  if (second) {
    lines.push(
      `${providerId}.model2Id=light-alias`,
      `${providerId}.model2Context=128000`,
      `${providerId}.model2Reasoning=false`,
      `${providerId}.model2Pricing=${pricing}`,
      `tier.light=${providerId}/light-alias`,
    );
    if (pricing === "metered") {
      lines.push(`${providerId}.model2CostInput=0.075`, `${providerId}.model2CostOutput=0.3`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Run the generator exactly as install.sh does, and return the models.json it would write. */
function generateModels(providerId, answersText) {
  const dir = freshDir("ext28-answers-");
  const answers = join(dir, "answers.conf");
  writeFileSync(answers, answersText);
  const outModels = join(dir, "models.json");
  const res = providersTool([
    "generate",
    "--providers-dir", PROVIDERS_DIR,
    "--select", providerId,
    "--answers", answers,
    "--models-default", join(REPO_ROOT, "config", "models.default.json"),
    "--routing-default", join(REPO_ROOT, "config", "routing.default.json"),
    "--out-models", outModels,
    "--out-routing", join(dir, "routing.json"),
  ]);
  assert.equal(res.status, 0, `generate failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
  return JSON.parse(readFileSync(outModels, "utf8")).providers[providerId].models;
}

describe("the installer asks what a call costs", () => {
  for (const providerId of GATEWAYS) {
    test(`${providerId}: the interview asks per model, and the opt-out is on the menu`, () => {
      const prompts = promptRows(providerId);
      for (const n of [1, 2]) {
        const pricing = prompts.get(`model${n}Pricing`);
        assert.ok(pricing, `model${n}Pricing is not asked at all`);
        assert.equal(pricing.type, "choice");
        assert.equal(pricing.required, "1", "a price nobody has to answer is a price nobody answers");
        // Both declarations the runtime gate accepts, offered as answers rather than as advice.
        assert.equal(pricing.choices, "metered,unmetered");
        assert.match(pricing.choiceLabels, /bills nothing, or bills by something other than tokens/);
        // The conversion the operator gets wrong: gateways quote dollars per TOKEN.
        for (const side of ["Input", "Output"]) {
          const rate = prompts.get(`model${n}Cost${side}`);
          assert.ok(rate, `model${n}Cost${side} is not asked`);
          assert.equal(rate.type, "decimal", "an int prompt would refuse 2.5");
          assert.match(rate.label, /dollars per MILLION tokens/);
          assert.equal(rate.whenId, `model${n}Pricing`);
          assert.equal(rate.whenValue, "metered");
        }
      }
      assert.match(prompts.get("model1CostInput").help, /MULTIPLY BY 1000000/);
      // The second model is optional, so its price question must be too — otherwise a one-model
      // install is asked to price a model it never declared.
      assert.equal(prompts.get("model2Pricing").whenId, "model2Id");
    });

    test(`${providerId}: a metered answer lands the rates it was given, as numbers`, () => {
      const models = generateModels(providerId, gatewayAnswers(providerId, { pricing: "metered" }));
      assert.deepEqual(
        models.map((m) => [m.id, m.cost]),
        [
          ["strong-alias", { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 }],
          ["light-alias", { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 }],
        ],
        "the rates have to arrive as JSON numbers: PI does not coerce, and a quoted rate is read " +
          "as no rate at all",
      );
    });

    test(`${providerId}: the opt-out lands four written zeros, and nothing else`, () => {
      const models = generateModels(providerId, gatewayAnswers(providerId, { pricing: "unmetered" }));
      for (const model of models) {
        assert.deepEqual(
          model.cost,
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          `${model.id} did not come out as the deliberate opt-out`,
        );
      }
      // Four zeros, not a fifth spelling. A sentinel here would give the cost object two readings.
      assert.equal(Object.keys(models[0].cost).length, COST_RATE_FIELDS.length);
    });

    test(`${providerId}: the silent-omission shape is gone, on both answers and on one model`, () => {
      const shapes = [
        gatewayAnswers(providerId, { pricing: "metered" }),
        gatewayAnswers(providerId, { pricing: "unmetered" }),
        gatewayAnswers(providerId, { pricing: "metered", second: false }),
      ];
      for (const answers of shapes) {
        for (const model of generateModels(providerId, answers)) {
          for (const field of COST_RATE_FIELDS) {
            assert.equal(
              typeof model.cost?.[field],
              "number",
              `${model.id} reaches models.json with cost.${field} unstated, which is the shape ` +
                `extensions/cost-gate ends the first billed turn for and bin/pi-check rule PC-27 ` +
                `reports before that turn is ever sent`,
            );
          }
        }
      }
    });
  }

  test("a metered answer with no rate typed is refused, not zeroed", () => {
    // The failure this whole change is about, inverted: the generator must not invent a price for
    // an operator who said the endpoint is metered. An interactive run cannot get here (the prompt
    // is required and has no default); an --answers file can, and it has to fail loudly.
    const answers = gatewayAnswers("litellm", { pricing: "metered", second: false })
      .split("\n")
      .filter((l) => !l.startsWith("litellm.model1CostInput="))
      .join("\n");
    const dir = freshDir("ext28-answers-");
    const file = join(dir, "answers.conf");
    writeFileSync(file, answers);
    const res = providersTool([
      "generate",
      "--providers-dir", PROVIDERS_DIR,
      "--select", "litellm",
      "--answers", file,
      "--models-default", join(REPO_ROOT, "config", "models.default.json"),
      "--routing-default", join(REPO_ROOT, "config", "routing.default.json"),
      "--print-only",
    ]);
    assert.equal(res.status, 2, `expected a refusal, got:\n${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /model1CostInput.*required and unanswered/);
    // The prompt validation catches the missing answer before cost validation runs; the error is the "required and unanswered" message above.
  });
});

// =========================================================================================
// postinstall-verify.sh
// =========================================================================================

describe("postinstall-verify.sh", () => {
  test("--help prints the exit-status contract, and not the maintainer note under it", () => {
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(join(REAL_SCRIPTS, "postinstall-verify.sh"), ["--help"], baseEnv(fixtureHome));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage:/);
    // The line the old range cut, and the reason this one was the costly truncation: a caller
    // scripting against the exit status needs to know a WARN is not a failure.
    assert.match(res.stdout, /WARN never fails the run/);
    assertHelpIsExactlyTheHeader(res.stdout, /opt-in check that was not requested\.$/);
    // The EXT-10 gate rationale moved down to the gate itself when --help began printing the
    // header in full — it is a note to whoever edits that code, not to whoever runs the script.
    assert.doesNotMatch(res.stdout, /scheduled for W3c/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("--json: valid machine-readable shape; exit 1 (not 2 — the harness itself ran fine) when checks fail", () => {
    const repo = makeRepoSkeleton();
    writeLock(repo, { platform: platformAsset() });
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(join(repo, "scripts", "postinstall-verify.sh"), ["--json"], baseEnv(fixtureHome));
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.results.length >= 11, "expects at least the 11 default checks");
    for (const r of parsed.results) {
      assert.ok(["PASS", "FAIL", "WARN", "SKIP"].includes(r.status), `unexpected status: ${r.status}`);
    }
    assert.equal(typeof parsed.summary.fail, "number");
    assert.ok(parsed.summary.fail >= 1, "this minimal fixture is expected to fail some checks");
  });

  test("spends nothing by default: model round trip and credentials resolve are both SKIP, and an ambient DATABRICKS_TOKEN never appears in the output", () => {
    const repo = makeRepoSkeleton();
    writeLock(repo, { platform: platformAsset() });
    const fixtureHome = freshDir("ext28-home-");

    const res = runScript(join(repo, "scripts", "postinstall-verify.sh"), ["--json"], baseEnv(fixtureHome));
    const parsed = JSON.parse(res.stdout);
    const byName = Object.fromEntries(parsed.results.map((r) => [r.name, r]));
    assert.equal(byName["model round trip"]?.status, "SKIP");
    assert.equal(byName["credentials resolve"]?.status, "SKIP");

    const canary = "canary-value-should-never-leak-into-output";
    const res2 = runScript(
      join(repo, "scripts", "postinstall-verify.sh"),
      [],
      baseEnv(fixtureHome, { DATABRICKS_TOKEN: canary }),
    );
    assert.doesNotMatch(res2.stdout + res2.stderr, new RegExp(canary));
  });

  test("REQ-PRV-12b: --credentials resolves a declared $ENV reference but never prints its value", () => {
    const repo = makeRepoSkeleton();
    writeLock(repo, { platform: platformAsset() });
    writeFileSync(
      join(repo, "config", "models.json"),
      JSON.stringify({ providers: { fake: { apiKey: "$MY_FAKE_SECRET_ENV" } } }) + "\n",
    );
    const fixtureHome = freshDir("ext28-home-");
    const secret = "sk-should-not-appear-anywhere-in-the-output";

    const res = runScript(
      join(repo, "scripts", "postinstall-verify.sh"),
      ["--credentials", "--json"],
      baseEnv(fixtureHome, { MY_FAKE_SECRET_ENV: secret }),
    );
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const parsed = JSON.parse(res.stdout);
    const entry = parsed.results.find((r) => r.name === "credentials resolve");
    assert.equal(entry?.status, "PASS");
    assert.match(entry.detail, /1 reference\(s\) resolved/);
  });

  // Table-driven regression test for the ::1 gap this task's hardening pass closed: the check
  // previously accepted NO_PROXY missing ::1 entirely, contradicting the documented requirement
  // that NO_PROXY must cover 127.0.0.1, localhost AND ::1 or the local (llama-swap / loopback MCP)
  // lane gets routed through the corporate proxy.
  const NO_PROXY_CASES = [
    { noProxy: "", expectStatus: "FAIL", expectMissing: ["127.0.0.1", "localhost", "::1"] },
    { noProxy: "127.0.0.1", expectStatus: "FAIL", expectMissing: ["localhost", "::1"] },
    { noProxy: "127.0.0.1,localhost", expectStatus: "FAIL", expectMissing: ["::1"] },
    { noProxy: "127.0.0.1,localhost,::1", expectStatus: "PASS", expectMissing: [] },
  ];
  for (const { noProxy, expectStatus, expectMissing } of NO_PROXY_CASES) {
    test(`TLS/proxy env: NO_PROXY='${noProxy}' -> ${expectStatus}`, () => {
      const repo = makeRepoSkeleton();
      writeLock(repo, { platform: platformAsset() });
      const fixtureHome = freshDir("ext28-home-");
      const caBundle = join(repo, "config", "pi-release.lock"); // any readable file will do
      const res = runScript(
        join(repo, "scripts", "postinstall-verify.sh"),
        ["--json"],
        baseEnv(fixtureHome, {
          NODE_EXTRA_CA_CERTS: caBundle,
          HTTPS_PROXY: "http://proxy.example:8080",
          NO_PROXY: noProxy,
        }),
      );
      const parsed = JSON.parse(res.stdout);
      const entry = parsed.results.find((r) => r.name === "TLS/proxy env");
      assert.equal(entry?.status, expectStatus, entry?.detail);
      for (const tok of expectMissing) assert.match(entry.detail, new RegExp(tok.replace(/[.]/g, "\\.")));
    });
  }

  test("TLS/proxy env: no HTTPS_PROXY at all -> NO_PROXY is not checked", () => {
    const repo = makeRepoSkeleton();
    writeLock(repo, { platform: platformAsset() });
    const fixtureHome = freshDir("ext28-home-");
    const res = runScript(
      join(repo, "scripts", "postinstall-verify.sh"),
      ["--json"],
      baseEnv(fixtureHome, { NODE_EXTRA_CA_CERTS: join(repo, "config", "pi-release.lock"), NO_PROXY: "" }),
    );
    const parsed = JSON.parse(res.stdout);
    const entry = parsed.results.find((r) => r.name === "TLS/proxy env");
    assert.equal(entry?.status, "PASS");
  });
});

// =========================================================================================
// uninstall.sh
// =========================================================================================
//
// Every scenario below drives `--dry-run` only — never a real uninstall, even against a fixture
// $HOME. That's stricter than the install.sh suite above (which does run install.sh for real
// against fixtures): uninstall.sh is destructive-shaped tooling, so its tests stay on the
// "prints what it would do" side of the line and assert against the printed intent plus an
// unchanged-filesystem snapshot, never against files it actually removed.

/** Symlinks the REAL uninstall.sh into a repo skeleton's scripts/, the same way makeRepoSkeleton()
 * already does for install.sh/postinstall-verify.sh — required so uninstall.sh's own
 * `REPO_DIR="$(dirname "${BASH_SOURCE[0]}")/.."` resolves to the *fixture* repo, not this
 * checkout, when the test runs it via that path. */
function makeRepoSkeletonWithUninstall() {
  const repo = makeRepoSkeleton();
  symlinkSync(join(REAL_SCRIPTS, "uninstall.sh"), join(repo, "scripts", "uninstall.sh"));
  return repo;
}

/** Adds one executable stub under `config/bin/`, mirroring install.sh step 6's dynamic
 * `config/bin/*` -> `$BIN_DIR/*` loop, which makeRepoSkeleton() doesn't populate on its own. */
function addConfigBinHelper(repo, name) {
  const dir = join(repo, "config", "bin");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(p, 0o755);
}

/** A real, complete install.sh run (offline, binary mode) against a fresh fixture $HOME, so the
 * uninstall.sh tests exercise the exact symlink shape install.sh actually produces rather than a
 * hand-rolled approximation of it. Returns `{ repo, fixtureHome, env }`. */
function installedFixture({ withHelper = true } = {}) {
  const repo = makeRepoSkeletonWithUninstall();
  const platform = platformAsset();
  if (withHelper) addConfigBinHelper(repo, "fake-helper");
  const stageDir = freshDir("ext28-uninstall-offline-");
  const { sha256 } = stageFakePiTarball(stageDir, platform);
  writeLock(repo, { platform, sha256 });

  const fixtureHome = freshDir("ext28-uninstall-home-");
  writeFileSync(join(fixtureHome, ".zshrc"), "# pre-existing rc file\n");
  const env = baseEnv(fixtureHome);

  const install = runScript(
    join(repo, "scripts", "install.sh"),
    ["--mode", "binary", "--offline", "--offline-dir", stageDir],
    env,
  );
  assert.equal(install.status, 0, `fixture install failed:\nSTDOUT:${install.stdout}\nSTDERR:${install.stderr}`);

  return { repo, fixtureHome, env };
}

/** Escapes a filesystem path for embedding in a RegExp — temp dirs are tame, but a `+` or `.` in
 * $TMPDIR would otherwise quietly turn an exact-path assertion into a fuzzy one. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** uninstall.sh's removal line for one path. The manifest-driven rewrite prints
 * `   would remove <path>` under --dry-run (and `   removed <path>` on a real run) where the older
 * script echoed the shell command itself as `dry-run  rm -- '<path>'`. Anchored to the start of a
 * line and terminated, so `.../bin/pi` cannot be satisfied by a line about `.../bin/pi-run`. */
function wouldRemove(path) {
  return new RegExp(`^ *would remove ${reEscape(path)}\\s*$`, "m");
}

/** The same line for a TREE row, which carries the manifest's DETAIL column after an em dash
 * (`would remove <path> — pi 0.84.0 runtime (binary mode)`): a recursive delete says what it is
 * about to take with it. Still anchored on both sides of the path, so a sibling path cannot
 * satisfy it. */
function wouldRemoveTree(path) {
  return new RegExp(`^ *would remove ${reEscape(path)}( — .*)?$`, "m");
}

/** A shallow snapshot of every path this suite cares about, for before/after equality checks that
 * prove `--dry-run` really changed nothing. */
function snapshot(fixtureHome) {
  const agentDir = join(fixtureHome, ".pi", "agent");
  const binDir = join(fixtureHome, "bin");
  const paths = [
    join(fixtureHome, "pi-config"),
    join(agentDir, "settings.json"),
    join(agentDir, "models.json"),
    join(agentDir, "AGENTS.md"),
    join(binDir, "pi"),
    join(binDir, "pi-run"),
    join(binDir, "fake-helper"),
    join(fixtureHome, ".zshrc"),
  ];
  const out = {};
  for (const p of paths) {
    try {
      const st = lstatSync(p);
      out[p] = st.isSymbolicLink() ? `symlink:${readlinkSync(p)}` : st.isDirectory() ? "dir" : `file:${readFileSync(p, "utf8")}`;
    } catch {
      out[p] = "absent";
    }
  }
  return out;
}

/**
 * `--help` prints the file's comment header and stops there. Both ends, because each end has
 * already failed once: install.sh's range stopped before its own docs links and update.sh's before
 * exit code 130, while a range that is too LONG spills `set -euo pipefail` and the constants under
 * it into the help text. Presence alone would have passed on both truncated versions.
 */
function assertHelpIsExactlyTheHeader(stdout, lastLine) {
  const lines = stdout.trimEnd().split("\n");
  assert.match(lines.at(-1), lastLine, "--help stopped before the end of the header block");
  // NOT the literal `set -euo pipefail`: postinstall-verify.sh sets `-uo` without `-e`, so that
  // string never appears in it and the assertion would have been vacuous there — a false pass
  // that reads exactly like a real one.
  assert.doesNotMatch(stdout, /set -e?uo pipefail/, "--help printed past the header block");
}

describe("uninstall.sh", () => {
  test("--help exits 0 and prints usage without touching anything", () => {
    const fixtureHome = freshDir("ext28-uninstall-home-");
    const res = runScript(join(REAL_SCRIPTS, "uninstall.sh"), ["--help"], baseEnv(fixtureHome));
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /--purge/);
    assertHelpIsExactlyTheHeader(res.stdout, /--keep-state    # keep it without asking, even under --purge$/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("PI-UNINSTALL-E01: an unknown argument fails loud and writes nothing", () => {
    const fixtureHome = freshDir("ext28-uninstall-home-");
    const res = runScript(join(REAL_SCRIPTS, "uninstall.sh"), ["--bogus"], baseEnv(fixtureHome));
    // 2, not 1: uninstall.sh exits 2 on an unknown argument while install.sh's own PI-INSTALL-E01
    // path (`die`) exits 1 for the identical mistake. Pinned to the code the script actually
    // returns, and reported as a divergence — a caller scripting both cannot use one check.
    assert.equal(res.status, 2);
    assert.match(res.stderr, /PI-UNINSTALL-E01/);
    assert.match(res.stderr, /--bogus/);
    assert.deepEqual(readdirSync(fixtureHome), []);
  });

  test("with no terminal to answer them, the questions are not asked at all", () => {
    const { repo, fixtureHome, env } = installedFixture({ withHelper: false });
    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    const all = res.stdout + res.stderr;
    // `[ -r /dev/tty ]` is a stat, and it succeeds in a process that has no controlling terminal
    // to open. install.sh guards the same helper with `[ -t 0 ]` as well; uninstall.sh did not,
    // so it printed questions nobody could answer, leaked the failed read, and took the default.
    assert.doesNotMatch(all, /Device not configured|No such device|\/dev\/tty/);
    assert.doesNotMatch(all, /\[Y\/n\]|\[y\/N\]/);
  });

  test("a real run with nobody to confirm it refuses rather than assuming yes", () => {
    // The one invocation in this file that is not --dry-run, and it is here precisely because the
    // assertion is that it removes nothing. The final confirmation defaults to yes, so a
    // non-interactive run without --yes used to uninstall the harness with no answer given —
    // `./scripts/uninstall.sh | tee log` was enough to trigger it.
    const { repo, fixtureHome, env } = installedFixture({ withHelper: false });
    const before = snapshot(fixtureHome);
    const res = runScript(join(repo, "scripts", "uninstall.sh"), [], env);
    assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /PI-UNINSTALL-E02/);
    assert.match(res.stderr, /--yes/);
    assert.deepEqual(snapshot(fixtureHome), before, "a refused run removed something anyway");
  });

  test("the restore hint names the tracked files it just listed", () => {
    const { repo, fixtureHome, env } = installedFixture({ withHelper: false });
    // install.sh only ever patches files under config/, which is why the hint could hardcode
    // `-- config/` and stay true. The manifest format does not promise that, and a hint that
    // does not restore the path printed above it — while restoring paths that were never
    // touched — is a command the reader would run and be misled by.
    const manifest = join(fixtureHome, ".pi", "agent", "install-manifest.tsv");
    appendFileSync(manifest, `PATCHED\t${join(repo, "AGENTS.md")}\tmodified by install.sh\n`);
    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run", "--yes"], env);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /checkout -- .*AGENTS\.md/);
    assert.doesNotMatch(res.stdout, /checkout -- config\/\s*$/m);
  });

  test("--dry-run against a real install: reports every symlink it would remove, and the filesystem is unchanged after", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const before = snapshot(fixtureHome);

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    assert.equal(res.status, 0, `dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);

    const agentDir = join(fixtureHome, ".pi", "agent");
    const binDir = join(fixtureHome, "bin");
    // Config symlinks install.sh actually created for this fixture.
    assert.match(res.stdout, wouldRemove(join(agentDir, "settings.json")));
    assert.match(res.stdout, wouldRemove(join(agentDir, "models.json")));
    assert.match(res.stdout, wouldRemove(join(agentDir, "AGENTS.md")));
    // bin/pi (binary mode -> a symlink into the unpacked runtime tree, because the release archive
    // is a tree whose executable loads its siblings), bin/pi-run, and the dynamic config/bin helper
    // this fixture added.
    assert.match(res.stdout, wouldRemove(join(binDir, "pi")));
    assert.match(res.stdout, wouldRemove(join(binDir, "pi-run")));
    assert.match(res.stdout, wouldRemove(join(binDir, "fake-helper")));
    // …and the tree that symlink points into, which is the one recursive delete the manifest can
    // authorise. Asserted twice on purpose: once in the up-front preview — it is by far the largest
    // thing an uninstall removes (~83 MB of real release) and the preview is what the confirmation
    // prompt refers to, so omitting it there would be lying by omission — and once on the removal
    // line itself.
    const runtimeTree = piRuntimeDir(fixtureHome, "0.84.0");
    assert.match(res.stdout, /unpacked runtime \(1\) — removed whole, with everything inside it/);
    assert.match(res.stdout, new RegExp(`^ *${reEscape(runtimeTree)} +pi 0\\.84\\.0 runtime`, "m"));
    assert.match(res.stdout, wouldRemoveTree(runtimeTree));
    // The stable link itself, and the rc-file block.
    assert.match(res.stdout, wouldRemove(join(fixtureHome, "pi-config")));
    assert.match(res.stdout, /would remove .*\.zshrc: removed the 'pi-config' block/);
    // The generated config the installer built from the templates goes too. Matched on the tail of
    // the path, not on `repo` itself: uninstall.sh resolves its own REPO_DIR with `cd -P`, so on
    // macOS it prints /private/var/... where mkdtemp handed the test /var/....
    assert.match(res.stdout, new RegExp(`^ *would remove .*${reEscape(join("config", "models.json"))}\\s*$`, "m"));
    // … and the tracked templates it built them FROM never appear on the removal list at all.
    assert.doesNotMatch(res.stdout, /would remove .*\.default\.json/);
    assert.match(res.stdout, /Would remove \d+ item\(s\), keep \d+, skip \d+/);

    assert.deepEqual(snapshot(fixtureHome), before, "dry-run must not change a single byte under fixture $HOME");
  });

  test("re-running --dry-run is idempotent in its own right: the filesystem still hasn't moved", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const first = snapshot(fixtureHome);
    runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    assert.deepEqual(snapshot(fixtureHome), first);
  });

  test("guard: a real file where a config symlink belongs is reported, not slated for removal", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const target = join(fixtureHome, ".pi", "agent", "settings.json");
    rmSync(target); // was the real symlink install.sh created
    writeFileSync(target, "{}\n"); // now a real file — must be left alone

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    // 3, not 0: refusing to touch a foreign file is a SKIP, and a skip is what exit 3 means —
    // "finished, but something here needs you to look at it". A dry run reports it in advance.
    assert.equal(res.status, 3);
    assert.match(res.stderr, /settings\.json is a real file, not a symlink — refusing to delete it/);
    assert.doesNotMatch(res.stdout, wouldRemove(target));
    assert.equal(readFileSync(target, "utf8"), "{}\n", "the real file must survive dry-run untouched");
  });

  test("guard: a symlink pointing somewhere other than the repo is reported, not slated for removal", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const target = join(fixtureHome, ".pi", "agent", "models.json");
    const decoy = join(fixtureHome, "decoy.json");
    writeFileSync(decoy, "{}\n");
    rmSync(target);
    symlinkSync(decoy, target); // a symlink, but not the one install.sh made

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    assert.equal(res.status, 3); // a re-pointed symlink is skipped, and a skip exits 3 — see above
    assert.match(res.stderr, /models\.json points at '.*decoy\.json', not at '.*' — someone re-pointed it; left alone/);
    assert.doesNotMatch(res.stdout, wouldRemove(target));
    assert.equal(readlinkSync(target), decoy, "the foreign symlink must survive dry-run untouched");
  });

  // --purge and --purge-state no longer print a blanket `rm -rf ~/.pi`: the rewrite removes exactly
  // the paths the manifest names, plus the personal-data paths the flags answer for, each on its own
  // line. The invariant these two tests exist for is unchanged and is what they still assert — the
  // flag is what turns "kept" into "would remove", and a dry run removes nothing either way.
  test("--purge --dry-run: lists PI's own auth state for removal, and deletes nothing", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const authFile = join(fixtureHome, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, "super-secret-token\n");

    const withoutPurge = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    assert.equal(withoutPurge.status, 0);
    // Without the flag the answer is "keep", and it is stated rather than silently skipped.
    assert.match(withoutPurge.stdout, new RegExp(`^ *kept ${reEscape(authFile)} — PI's own state`, "m"));
    assert.doesNotMatch(withoutPurge.stdout, wouldRemove(authFile));

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run", "--purge"], env);
    assert.equal(res.status, 0);
    assert.match(res.stdout, wouldRemove(authFile));
    assert.equal(readFileSync(authFile, "utf8"), "super-secret-token\n", "a dry run must not touch credentials");
  });

  test("--purge-state --dry-run: lists $XDG_STATE_HOME/pi-config for removal and deletes nothing", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const stateDir = join(fixtureHome, ".local", "state", "pi-config", "scratch");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "marker.json"), "{}\n");

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run", "--purge-state"], env);
    assert.equal(res.status, 0);
    assert.match(res.stdout, wouldRemove(join(fixtureHome, ".local", "state", "pi-config")));
    assert.equal(readFileSync(join(stateDir, "marker.json"), "utf8"), "{}\n");
  });

  /** The npm-mode state install.sh leaves behind, hand-built: its own npm mode needs the network,
   * which this sandbox does not have. Writes the manifest rows install.sh writes on that path —
   * `LINK $BIN_DIR/pi <npm prefix>/bin/pi`, `NPMGLOBAL <npm.package>` and the `.install-mode`
   * marker — because the rewritten uninstall.sh is manifest-driven: with no manifest it falls back
   * to a scan that only claims symlinks pointing into the checkout, and this one points into
   * ~/.npm-global.
   *
   * The NPMGLOBAL row is the one to keep in step with scripts/install.sh by hand. A fixture that
   * omits it does not prove the uninstaller ignores the global package — it proves nothing was ever
   * declared to it, which is a different statement and an easy one to misread as a regression. */
  function npmModeFixture() {
    const repo = makeRepoSkeletonWithUninstall();
    writeLock(repo, { platform: platformAsset() }); // npm.spec -> @earendil-works/pi-coding-agent@0.84.0
    const fixtureHome = freshDir("ext28-uninstall-home-");
    const agentDir = join(fixtureHome, ".pi", "agent");
    const binDir = join(fixtureHome, "bin");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(agentDir, ".install-mode"), "npm\n");
    const npmGlobalPi = join(fixtureHome, ".npm-global", "bin", "pi");
    mkdirSync(dirname(npmGlobalPi), { recursive: true });
    writeFileSync(npmGlobalPi, "#!/usr/bin/env bash\necho 0.84.0\n");
    chmodSync(npmGlobalPi, 0o755);
    symlinkSync(npmGlobalPi, join(binDir, "pi"));
    writeFileSync(
      join(agentDir, "install-manifest.tsv"),
      [
        `LINK\t${join(binDir, "pi")}\t${npmGlobalPi}`,
        `NPMGLOBAL\t${NPM_PACKAGE}\tthe pi 0.84.0 runtime itself (npm mode: npm install -g '${NPM_PACKAGE}@0.84.0')`,
        `FILE\t${join(agentDir, ".install-mode")}\tinstall mode marker`,
      ].join("\n") + "\n",
    );
    return { repo, fixtureHome, binDir, npmGlobalPi };
  }

  test("npm mode: dry-run reports the bin/pi symlink into ~/.npm-global for removal, and leaves the package's own copy alone", () => {
    const { repo, fixtureHome, binDir, npmGlobalPi } = npmModeFixture();

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], baseEnv(fixtureHome));
    assert.equal(res.status, 0, `dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.match(res.stdout, wouldRemove(join(binDir, "pi")));
    assert.equal(readlinkSync(join(binDir, "pi")), npmGlobalPi, "npm-mode pi symlink must survive dry-run untouched");
    assert.ok(lstatSync(npmGlobalPi).isFile(), "the npm-installed copy is not this script's to delete");
  });

  // Was skipped as a regression on the grounds that the manifest-driven rewrite had dropped the
  // `npm uninstall -g` step and had no row type for a global package. Neither was true: NPMGLOBAL
  // is a row type, install.sh writes one on the npm path, and uninstall.sh both asks about it and
  // runs the removal. What was actually wrong was this file's own fixture, which hand-wrote a
  // manifest holding only LINK and FILE rows — so the uninstaller was silent about a package it
  // had never been told about, and the silence read like a missing feature.
  test("npm mode: the globally installed npm package is offered for removal, or at least named as residue", () => {
    const { repo, fixtureHome } = npmModeFixture();
    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], baseEnv(fixtureHome));

    // Deliberately NOT `assert.match(stdout, /npm uninstall -g …/)`. That pins one branch of a
    // decision the script makes from the MACHINE it runs on: it probes npm's global tree, and only
    // prints the removal command when the package is actually there. On a machine without it — CI,
    // and this sandbox — the honest output is "already gone (not in npm's global tree)", and the
    // old assertion failed on correct behaviour.
    //
    // What is environment-independent, and what this test is actually for: a package installed
    // OUTSIDE the fixture home is never swept out with the symlinks. It gets its own group, its own
    // question, and its own line in the removal phase, always naming the package.
    assert.match(res.stdout, /global npm packages \(1\)/, "must be grouped apart from the symlinks");
    assert.match(res.stdout, new RegExp(`remove these global npm package\\(s\\)\\?`), "must be its own question");
    const removalPhase = res.stdout.slice(res.stdout.indexOf("4 of 4"));
    assert.match(removalPhase, new RegExp(reEscape(NPM_PACKAGE)), "the removal phase must name the package");
  });

  // The two tests below are the ones that hold PI's own self-install apart from ours. They are
  // worth their weight because the two layouts are one directory name apart: PI's own installer
  // writes ~/.local/pi/<version>/pi/pi, install.sh writes
  // ~/.local/share/pi-config/runtime/<version>/pi/pi, and the second is a TREE row — the single
  // path by which this uninstaller can delete a directory recursively. Point that row at PI's
  // address and `uninstall.sh` silently removes a pi the user installed themselves. Both tests
  // therefore plant a self-install at the SAME version as ours, the case where a wrong path
  // collides rather than merely neighbours.
  test("binary mode: --dry-run lists our own runtime tree, and never a pi that PI installed itself", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const binDir = join(fixtureHome, "bin");
    const selfInstallPi = makeSelfInstallPi(fixtureHome, "0.84.0");
    const ourRuntime = piRuntimeDir(fixtureHome, "0.84.0");

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    assert.equal(res.status, 0, `dry-run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.match(res.stdout, wouldRemove(join(binDir, "pi")));
    assert.match(res.stdout, wouldRemoveTree(ourRuntime));
    // Nothing under PI's own prefix may appear on a removal line — not the binary, not the tree
    // around it, not the ~/.local/pi directory that holds every version PI has installed. The
    // trailing boundary keeps this from being satisfied (or defeated) by our own .local/share.
    assert.doesNotMatch(res.stdout, new RegExp(`^ *would remove ${reEscape(join(fixtureHome, ".local", "pi"))}(/|\\s|$)`, "m"));
    assert.equal(readlinkSync(join(binDir, "pi")), join(ourRuntime, "pi", "pi"), "dry-run must not touch the symlink");
    assert.ok(lstatSync(selfInstallPi).isFile(), "the self-installed copy must still exist after dry-run");
  });

  test("binary mode: a real run removes our runtime tree whole, and leaves PI's own installed copy byte-identical", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const binDir = join(fixtureHome, "bin");
    const selfInstallPi = makeSelfInstallPi(fixtureHome, "0.84.0");
    const contentsBefore = readFileSync(selfInstallPi);
    const ourRuntime = piRuntimeDir(fixtureHome, "0.84.0");

    // --yes, because that is what an unattended removal is: with no terminal to confirm on, the
    // script now refuses rather than assuming the confirmation's default of yes.
    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--yes"], env);
    assert.equal(res.status, 0, `run failed:\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    assert.throws(() => lstatSync(join(binDir, "pi")), "bin/pi must actually be gone after a real run");
    assert.throws(() => lstatSync(ourRuntime), "the runtime tree the symlink pointed into goes with it");
    // $HOME/bin is reclaimed when the sweep finds it empty — a DIR row in the manifest, removed
    // with `rmdir`, which by definition cannot take anything with it. What is asserted here is the
    // guard, not the removal: had the directory held anything of the user's, `rmdir` would have
    // refused and it would still be there.
    assert.throws(() => lstatSync(binDir), "an emptied $HOME/bin is reclaimed by the empty-dir sweep");
    assert.ok(lstatSync(selfInstallPi).isFile(), "PI's own self-installed copy must survive uninstall");
    assert.deepEqual(readFileSync(selfInstallPi), contentsBefore, "the self-installed copy must be byte-identical");
    // And the shared parent survives with it: `$HOME/.local` is a DIR row, so it is only rmdir'd
    // when empty, and PI's own tree inside it is exactly the kind of content that must stop that.
    assert.ok(lstatSync(join(fixtureHome, ".local")).isDirectory(), "a $HOME/.local holding other tools' data stays");
  });

  // Was skipped as a known regression: bin/pi was a FILE row in binary mode, and the FILE loop has
  // no re-point guard, so a bin/pi the user had swapped for a symlink to their own build was
  // deleted without a word. Binary mode records bin/pi as a LINK row now — the archive is a tree,
  // so what goes on PATH is a symlink into it — which puts it under the LINK loop's target check
  // and closes the gap. Un-skipped and kept as the regression test for that.
  test("guard: a bin/pi replaced by a symlink to something foreign is reported, not removed", () => {
    const { repo, fixtureHome, env } = installedFixture();
    const binDir = join(fixtureHome, "bin");
    const decoy = join(fixtureHome, "decoy-pi");
    writeFileSync(decoy, "#!/usr/bin/env bash\necho 0.84.0\n");
    chmodSync(decoy, 0o755);
    rmSync(join(binDir, "pi"));
    symlinkSync(decoy, join(binDir, "pi"));

    const res = runScript(join(repo, "scripts", "uninstall.sh"), ["--dry-run"], env);
    // 3, not 0: refusing a re-pointed symlink is a skip, and the exit-code contract in
    // uninstall.sh's header makes any skip a 3 — the same answer the two config-symlink guards
    // above give.
    assert.equal(res.status, 3);
    assert.match(res.stderr, /bin\/pi.*points at '.*decoy-pi'.*left alone/);
    assert.doesNotMatch(res.stdout, wouldRemove(join(binDir, "pi")));
    assert.equal(readlinkSync(join(binDir, "pi")), decoy, "the foreign symlink must survive dry-run untouched");
  });
});

// =========================================================================================
// scripts/lib/portable-timeout.sh — the shared bound used because neither `timeout` nor
// `gtimeout` is installed on this machine (verified: `command -v timeout gtimeout` both fail).
// =========================================================================================

describe("lib/portable-timeout.sh", () => {
  const LIB = join(REAL_SCRIPTS, "lib", "portable-timeout.sh");

  test("a fast command's real exit status passes through unchanged", () => {
    const out = execFileSync(
      "bash",
      ["-c", `source '${LIB}'; run_with_timeout 30 bash -c 'exit 3'; echo "exit=$?"`],
      { encoding: "utf8" },
    );
    assert.match(out, /exit=3/);
  });

  test("a real timeout normalises to exit 124, matching GNU timeout's convention", () => {
    const start = Date.now();
    const out = execFileSync(
      "bash",
      ["-c", `source '${LIB}'; run_with_timeout 1 sleep 10; echo "exit=$?"`],
      { encoding: "utf8" },
    );
    const elapsedMs = Date.now() - start;
    assert.match(out, /exit=124/);
    assert.ok(elapsedMs < 5000, `expected the 1s bound to fire quickly, took ${elapsedMs}ms`);
  });

  // Regression test for the pipe-hang defect this hardening pass fixed: the watchdog subshell
  // used to inherit the caller's stdout, so a piped invocation blocked on EOF for the full
  // timeout window even though the foreground command had already finished. Reproduced by hand
  // before the fix (a piped `postinstall-verify.sh --json` call hung for ~30s on an instant
  // check); this asserts the pure-library case stays fast when piped.
  test("piped output returns as soon as the foreground command finishes, not after the watchdog's own sleep", () => {
    const start = Date.now();
    const out = execFileSync(
      "bash",
      ["-c", `source '${LIB}'; run_with_timeout 30 bash -c 'exit 0' | cat; echo done`],
      { encoding: "utf8" },
    );
    const elapsedMs = Date.now() - start;
    assert.match(out, /done/);
    assert.ok(elapsedMs < 5000, `piped call should return almost instantly, took ${elapsedMs}ms (watchdog bound was 30s)`);
  });

  test("no external timeout/gtimeout binary is invoked (this machine has neither)", () => {
    const noExternalTimeout = "/usr/bin:/bin"; // deliberately excludes any coreutils gtimeout shim
    const out = execFileSync(
      "bash",
      ["-c", `source '${LIB}'; run_with_timeout 2 bash -c 'exit 0'; echo "exit=$?"`],
      { encoding: "utf8", env: { PATH: noExternalTimeout } },
    );
    assert.match(out, /exit=0/);
  });
});

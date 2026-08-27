// test/update-script.suite.mjs — `scripts/update.sh` behaviour tests.
//
// Design, inherited from test/ext-28-install.suite.mjs: every scenario runs against a throwaway
// fixture repo and a throwaway $PREFIX under the OS tmpdir, never against the real `~/.pi/agent`
// or the real `~/pi-config`. The fixture SYMLINKS the real `scripts/update.sh` rather than copying
// it, so these tests exercise the committed logic; update.sh derives its REPO_DIR from
// `dirname $BASH_SOURCE`, which is the path it was invoked through, so the symlink lands it in the
// fixture repo exactly as a real clone would.
//
// The fixture is a bare upstream plus a clone, because everything under test is a statement about
// the relationship between the two: behind, ahead, diverged, converged. A single repo cannot
// express any of them.
//
// `env` is built explicitly per call, never spread from `process.env`: a developer's exported
// PI_CODING_AGENT_DIR or PI_INSTALL_PREFIX would point the script at their real install while the
// assertions describe the fixture — the same trap postinstall-verify.sh documents having fallen
// into once.
//
// Runs with the built-in test runner, and `npm test` globs `test/**/*.suite.mjs`, so it is in.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readlinkSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const REAL_UPDATE = join(REPO_ROOT, "scripts", "update.sh");
const NODE_DIR = dirname(process.execPath);

// ---------------------------------------------------------------------------------------- helpers

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

/** The environment update.sh runs under. Nothing is inherited except what a shell needs. */
function envFor(home) {
  return {
    PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    NO_COLOR: "1",
    LANG: "C",
  };
}

function update(fx, ...args) {
  return spawnSync("bash", [join(fx.repo, "scripts", "update.sh"), "--prefix", fx.prefix, ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    env: envFor(fx.home),
  });
}

/**
 * A minimal but honest fixture: a bare upstream, a clone, a `scripts/install.sh` carrying nothing
 * but the `link_one` table update.sh reads out of it, and a $PREFIX shaped the way install.sh
 * leaves one — the stable symlink, the agent dir, and the manifest that records both.
 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pion-update-test-"));
  const home = join(dir, "home");
  const prefix = join(dir, "prefix");
  const upstream = join(dir, "up.git");
  const repo = join(dir, "work");
  const seed = join(dir, "seed");

  mkdirSync(home);
  mkdirSync(seed);
  git(dir, "init", "--quiet", "--initial-branch=main", seed);
  mkdirSync(join(seed, "config"));
  mkdirSync(join(seed, "scripts"));
  writeFileSync(join(seed, "config", "alpha.json"), '{"alpha":true}\n');
  writeFileSync(join(seed, "config", "beta.json"), '{"beta":true}\n');
  writeFileSync(join(seed, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(seed, "package.json"), '{"name":"fixture","engines":{"node":">=22.19.0"}}\n');
  // Only the shape update.sh reads: the link table, and one `ask` inside one `ask_section` block.
  writeFileSync(
    join(seed, "scripts", "install.sh"),
    [
      "#!/usr/bin/env bash",
      "if ask_section tools; then",
      '  ask tools.alreadyAsked "an existing question" yes',
      "fi",
      "link_one required config/alpha.json alpha.json",
      "link_one optional config/beta.json  beta.json",
      "",
    ].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");

  git(dir, "clone", "--quiet", "--bare", seed, upstream);
  git(dir, "clone", "--quiet", upstream, repo);
  // The script under test, not a copy of it.
  symlinkSync(REAL_UPDATE, join(repo, "scripts", "update.sh"));

  // What install.sh would have left behind.
  const agentDir = join(prefix, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  symlinkSync(repo, join(prefix, "pi-config"));
  const manifest = join(agentDir, "install-manifest.tsv");
  const rows = [
    ["LINK", join(prefix, "pi-config"), repo],
    ["LINK", join(agentDir, "alpha.json"), join(prefix, "pi-config", "config", "alpha.json")],
    ["LINK", join(agentDir, "beta.json"), join(prefix, "pi-config", "config", "beta.json")],
  ];
  for (const [, link, target] of rows.slice(1)) symlinkSync(target, link);
  writeFileSync(manifest, rows.map((r) => `${r[0]}\t${r[1]}\t${r[2]}`).join("\n") + "\n");

  return { dir, home, prefix, upstream, repo, seed, agentDir, manifest };
}

/** Commit something upstream, so the clone is behind by one. */
function pushUpstream(fx, mutate, message = "upstream change") {
  const staging = join(fx.dir, `push-${Math.random().toString(36).slice(2, 8)}`);
  git(fx.dir, "clone", "--quiet", fx.upstream, staging);
  mutate(staging);
  git(staging, "add", "-A");
  git(staging, "commit", "--quiet", "-m", message);
  git(staging, "push", "--quiet", "origin", "main");
  rmSync(staging, { recursive: true, force: true });
}

/**
 * Every path under `dir` except `.git`, as a comparable string: the file's content, or a symlink's
 * target, keyed by relative path. "Wrote nothing" is a claim about the WHOLE prefix — a test that
 * only re-reads the three paths it happens to remember proves nothing about the fourth.
 */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[r] = `symlink -> ${readlinkSync(join(abs, e.name))}`;
      else if (e.isDirectory()) { out[r] = "dir"; walk(r); }
      else out[r] = readFileSync(join(abs, e.name), "utf8");
    }
  };
  walk("");
  return out;
}

/** Like pushUpstream, but also fast-forwards the clone: shared history, not an available update. */
function landUpstream(fx, mutate, message) {
  pushUpstream(fx, mutate, message);
  git(fx.repo, "fetch", "--quiet");
  git(fx.repo, "merge", "--quiet", "--ff-only", "@{u}");
}

// ------------------------------------------------------------------------------------------ tests

describe("scripts/update.sh", () => {
  test("--help exits 0 and prints the flag list", () => {
    const fx = makeFixture();
    try {
      const r = update(fx, "--help");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Usage:/);
      assert.match(r.stdout, /--check/);
      assert.match(r.stdout, /PI-UPDATE-Exx/);
      // The whole exit-code table, not the first four fifths of it: the range this is printed
      // from used to stop one line short of 130 and four short of the docs links.
      assert.match(r.stdout, /130\s+interrupted/);
      assert.match(r.stdout, /getting-started\/update/);
      // Self-terminating rather than a line range: it must stop at the end of the header block
      // and never bleed into the code, whatever a later edit does to the header's length.
      assert.doesNotMatch(r.stdout, /set -euo pipefail/, "--help printed past the header block");
      assert.match(
        r.stdout.trimEnd().split("\n").at(-1),
        /getting-started\/update\/$/,
        "--help should end on the docs link — the last line of the header block",
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an unknown flag aborts with a coded failure, not a bare exit", () => {
    const fx = makeFixture();
    try {
      const r = update(fx, "--nonsense");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /PI-UPDATE-E01/);
      assert.match(r.stderr, /action:/);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a converged tree reports 0 changes and exits 0", () => {
    const fx = makeFixture();
    try {
      const r = update(fx, "--check");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Up to date — 0 step\(s\) changed/);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("--check reports an available update, changes nothing, and exits 3", () => {
    const fx = makeFixture();
    try {
      const before = git(fx.repo, "rev-parse", "HEAD");
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));
      const r = update(fx, "--check");
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stdout, /An update is available/);
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), before, "--check moved HEAD");
      assert.equal(readFileSync(join(fx.repo, "config", "alpha.json"), "utf8"), '{"alpha":true}\n');
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("--dry-run performs no mutation", () => {
    const fx = makeFixture();
    try {
      const before = git(fx.repo, "rev-parse", "HEAD");
      const manifestBefore = readFileSync(fx.manifest, "utf8");
      pushUpstream(fx, (d) => {
        writeFileSync(join(d, "config", "gamma.json"), '{"gamma":true}\n');
        writeFileSync(
          join(d, "scripts", "install.sh"),
          readFileSync(join(d, "scripts", "install.sh"), "utf8") +
            "link_one optional config/gamma.json gamma.json\n",
        );
      });
      const r = update(fx, "--dry-run", "--yes", "--no-verify");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /dry run/);
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), before, "--dry-run moved HEAD");
      assert.equal(readFileSync(fx.manifest, "utf8"), manifestBefore, "--dry-run wrote the manifest");
      assert.equal(existsSync(join(fx.agentDir, "gamma.json")), false, "--dry-run created a symlink");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a dirty working tree refuses, naming the files", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));
      writeFileSync(join(fx.repo, "config", "beta.json"), '{"beta":"mine"}\n');
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /PI-UPDATE-E07/);
      assert.match(r.stderr, /config\/beta\.json/, "the refusal did not name the file");
      assert.match(r.stderr, /will not stash your work/);
      assert.equal(readFileSync(join(fx.repo, "config", "beta.json"), "utf8"), '{"beta":"mine"}\n');

      // --check writes nothing, so a dirty tree is a warning there, not a refusal: withholding
      // the report is exactly the information the user wants before deciding to clean up.
      const checked = update(fx, "--check");
      assert.equal(checked.status, 3, checked.stderr);
      assert.match(checked.stderr, /PI-UPDATE-E07/);
      assert.match(checked.stdout, /An update is available/);
      assert.equal(readFileSync(join(fx.repo, "config", "beta.json"), "utf8"), '{"beta":"mine"}\n');
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an unfinished merge refuses before the cleanliness check", () => {
    const fx = makeFixture();
    try {
      writeFileSync(join(fx.repo, ".git", "MERGE_HEAD"), `${git(fx.repo, "rev-parse", "HEAD")}\n`);
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /PI-UPDATE-E05/);
      assert.match(r.stderr, /a merge is in progress/);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a diverged branch refuses and lists the local commits", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));
      writeFileSync(join(fx.repo, "config", "beta.json"), '{"beta":"mine"}\n');
      git(fx.repo, "commit", "--quiet", "-am", "my local work");
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /PI-UPDATE-E11/);
      assert.match(r.stderr, /my local work/, "the refusal did not name the local commit");
      assert.match(r.stderr, /only fast-forwards/);

      // --check changes nothing, so it reports the divergence and still says what is waiting.
      const checked = update(fx, "--check");
      assert.equal(checked.status, 3, checked.stderr);
      assert.match(checked.stderr, /PI-UPDATE-E11/);
      assert.match(checked.stdout, /An update is available/);
      // The user's own commit touched config/beta.json. A two-dot diff would list it as arriving.
      assert.doesNotMatch(checked.stdout, /beta\.json/, "the report claimed the user's own file was arriving");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a new config path gets linked and recorded in the manifest", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => {
        writeFileSync(join(d, "config", "gamma.json"), '{"gamma":true}\n');
        writeFileSync(
          join(d, "scripts", "install.sh"),
          readFileSync(join(d, "scripts", "install.sh"), "utf8") +
            "link_one optional config/gamma.json gamma.json\n",
        );
      });
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 0, r.stderr);
      const link = join(fx.agentDir, "gamma.json");
      assert.equal(
        readlinkSync(link),
        join(fx.prefix, "pi-config", "config", "gamma.json"),
        "the new config was not linked",
      );
      assert.match(readFileSync(fx.manifest, "utf8"), new RegExp(`^LINK\t${link}\t`, "m"));
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a symlink pointing somewhere else is reported, never re-pointed", () => {
    const fx = makeFixture();
    try {
      const link = join(fx.agentDir, "beta.json");
      const mine = join(fx.dir, "my-own-beta.json");
      writeFileSync(mine, '{"beta":"mine"}\n');
      rmSync(link);
      symlinkSync(mine, link);
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readlinkSync(link), mine, "the update re-pointed a symlink it did not own");
      assert.match(r.stdout, /points at .*my-own-beta\.json/);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an unchanged lockfile skips npm entirely", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /package-lock\.json unchanged — no npm run needed/);
      assert.equal(existsSync(join(fx.repo, "node_modules")), false);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a changed lockfile plans an npm ci, and --skip-packages stands it down", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => writeFileSync(join(d, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n'));
      const planned = update(fx, "--check");
      assert.equal(planned.status, 3, planned.stderr);
      assert.match(planned.stdout, /npm ci --ignore-scripts \(the lockfile changed\)/);

      const r = update(fx, "--yes", "--no-verify", "--skip-packages");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /npm skipped \(--skip-packages\)/);
      assert.equal(existsSync(join(fx.repo, "node_modules")), false);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an untracked file in the way refuses before anything is fetched into the tree", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => writeFileSync(join(d, "NOTES.md"), "upstream\n"));
      writeFileSync(join(fx.repo, "NOTES.md"), "mine\n");
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /PI-UPDATE-E12/);
      assert.match(r.stderr, /NOTES\.md/);
      assert.equal(readFileSync(join(fx.repo, "NOTES.md"), "utf8"), "mine\n");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a new interview question names the section to reconfigure", () => {
    const fx = makeFixture();
    try {
      pushUpstream(fx, (d) => {
        const p = join(d, "scripts", "install.sh");
        writeFileSync(
          p,
          readFileSync(p, "utf8").replace(
            '  ask tools.alreadyAsked "an existing question" yes',
            '  ask tools.alreadyAsked "an existing question" yes\n  ask tools.brandNew "a brand new question" yes',
          ),
        );
      });
      const r = update(fx, "--check");
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stdout, /tools\.brandNew/);
      assert.match(r.stdout, /--reconfigure --section tools/);
      assert.doesNotMatch(r.stdout, /tools\.alreadyAsked/, "an existing answer was reported as new");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("no install manifest is fatal for an update and a warning for --check", () => {
    const fx = makeFixture();
    try {
      rmSync(fx.manifest);
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));

      const checked = update(fx, "--check");
      assert.equal(checked.status, 3, checked.stderr);
      assert.match(checked.stderr, /no install manifest/);

      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /PI-UPDATE-E09/);
      assert.match(r.stderr, /install\.sh first/);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("every failure path in the source carries a PI-UPDATE code", () => {
    const src = readFileSync(REAL_UPDATE, "utf8");
    const lines = src.split("\n");
    const bare = lines
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /^\s*exit 1\s*(#.*)?$/.test(l));
    // die() is the ONE place that exits 1, and it prints a code, a cause and an action first.
    assert.equal(
      bare.length,
      1,
      `a bare 'exit 1' escaped die(): ${bare.map(([n]) => `line ${n}`).join(", ")}`,
    );
    const dieBody = src.slice(src.indexOf("die() {"), src.indexOf("die() {") + 300);
    assert.match(dieBody, /exit 1/, "the one 'exit 1' is not the one inside die()");

    // Every call site names a code of the right shape — no `die "something went wrong"`.
    // refuse_or_warn() relays its own first argument to die(); that one relay is the exception,
    // and there must be exactly one of it, so the exception cannot become a habit.
    const calls = (src.match(/^\s*(?:die|refuse_or_warn) "[^"]*"/gm) ?? []).map((c) => c.trim());
    const relays = calls.filter((c) => c === 'die "$1"');
    assert.equal(relays.length, 1, "more than one die() call relays an argument instead of a code");
    const coded = calls.filter((c) => c !== 'die "$1"');
    assert.ok(coded.length >= 10, `expected the failure paths to be coded, found ${coded.length}`);
    for (const c of coded) {
      assert.match(c, /"PI-UPDATE-E\d\d"/, `uncoded failure: ${c}`);
    }
  });

  test("a failing verification is never summarised as 'nothing left to do'", () => {
    // The two lines contradicted each other: exit 4 means "the update landed, read the
    // verification table", while the summary printed "Nothing is left for you to do by hand"
    // immediately below that table. MANUAL_TODO is empty in that case — correctly, the UPDATE has
    // no leftover step — but the reader trusts the last line printed, and the last line said the
    // failures were not their problem.
    const fx = makeFixture();
    pushUpstream(
      fx,
      (dir) => {
        writeFileSync(
          join(dir, "scripts", "postinstall-verify.sh"),
          "#!/usr/bin/env bash\nprintf '  FAIL   a real check   it did not pass\\n'\nexit 1\n",
          { mode: 0o755 },
        );
      },
      "add a verifier that fails",
    );

    const r = update(fx, "--yes");
    assert.equal(r.status, 4, `expected exit 4 from a failed verification:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /a real check/, "the verifier's own table should still be shown");
    assert.doesNotMatch(r.stdout, /Nothing is left for you to do by hand/);
  });
  // ------------------------------------------------------------ the three advertised refusals
  // README.md:60-65 and docs/getting-started/update.md make three promises about what this
  // script will NOT do. The tests above cover the tracked-file half of the first one; these
  // cover the parts a colleague only discovers by losing something.

  test("an untracked file the update does not touch is not a dirty tree", () => {
    // `git status --porcelain --untracked-files=no` is deliberate, and it is the difference
    // between "refuses to run on a dirty tree" and "refuses to run in a directory you have ever
    // put a scratch file in". Only an untracked file upstream ALSO adds is a blocker (E12), and
    // that one is tested separately.
    const fx = makeFixture();
    try {
      writeFileSync(join(fx.repo, "scratch-notes.txt"), "mine\n");
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 0, `an untracked file blocked the update:\n${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /PI-UPDATE-E07/);
      assert.equal(readFileSync(join(fx.repo, "config", "alpha.json"), "utf8"), '{"alpha":2}\n');
      assert.equal(readFileSync(join(fx.repo, "scratch-notes.txt"), "utf8"), "mine\n");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a hand-edited generated config is not a dirty tree", () => {
    // The generated set (config/models.json and friends) is git-ignored precisely so that editing
    // it is normal. If it counted as dirty, a colleague who ever ran the installer could never
    // update again — the failure would be total and would look like the script's own rule.
    const fx = makeFixture();
    try {
      landUpstream(fx, (d) => {
        writeFileSync(join(d, ".gitignore"), "config/alpha.json\n");
        git(d, "rm", "--quiet", "--cached", "config/alpha.json");
      }, "ignore the generated config");
      writeFileSync(join(fx.repo, "config", "alpha.json"), '{"alpha":"hand-edited"}\n');
      // Scoped to the file: the fixture's own `scripts/update.sh` is a symlink to the real script
      // and is untracked by construction, so a bare `git status` is never empty here.
      assert.equal(
        git(fx.repo, "status", "--porcelain", "--", "config/alpha.json"),
        "",
        "fixture: the edit should be invisible to git",
      );

      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "beta.json"), '{"beta":2}\n'));
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 0, `a git-ignored generated config blocked the update:\n${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /PI-UPDATE-E07/);
      assert.equal(
        readFileSync(join(fx.repo, "config", "alpha.json"), "utf8"),
        '{"alpha":"hand-edited"}\n',
        "the update rewrote a generated config",
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a diverged branch is left byte-identical — no rebase, no merge, no stash", () => {
    // "It only fast-forwards" is a claim about what the tree looks like AFTERWARDS, not about
    // which message was printed. A rebase that happened and then failed would still print E11.
    const fx = makeFixture();
    try {
      writeFileSync(join(fx.repo, "config", "beta.json"), '{"beta":"mine"}\n');
      git(fx.repo, "add", "-A");
      git(fx.repo, "commit", "--quiet", "-m", "my local work");
      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "alpha.json"), '{"alpha":2}\n'));

      const headBefore = git(fx.repo, "rev-parse", "HEAD");
      const treeBefore = snapshot(fx.repo);
      const prefixBefore = snapshot(fx.prefix);

      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1, `expected a refusal:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /PI-UPDATE-E11/);
      assert.match(r.stderr, /my local work/, "the refusal did not list the local commit");
      assert.match(r.stderr, /only fast-forwards/);

      assert.equal(git(fx.repo, "rev-parse", "HEAD"), headBefore, "HEAD moved on a diverged branch");
      assert.deepEqual(snapshot(fx.repo), treeBefore, "the working tree changed on a diverged branch");
      assert.deepEqual(snapshot(fx.prefix), prefixBefore, "the prefix changed on a diverged branch");
      const gitDir = join(fx.repo, ".git");
      for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"]) {
        assert.equal(existsSync(join(gitDir, marker)), false, `${marker} exists — something tried to join the branches`);
      }
      assert.equal(git(fx.repo, "stash", "list"), "", "the script stashed something");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a generated config whose template moved upstream is named, left alone, and handed a command", () => {
    // The third promise, and the one with no test at all until now: install.sh generates
    // config/<name>.json from config/<name>.default.json plus your answers, and never resets it
    // afterwards. So an upstream change to the template is a change you did NOT get. Merging it
    // is a judgement call; naming it is not.
    const fx = makeFixture();
    try {
      landUpstream(fx, (d) => {
        writeFileSync(join(d, ".gitignore"), "config/gen.json\n");
        writeFileSync(join(d, "config", "gen.default.json"), '{"gen":"template v1"}\n');
      }, "add a generated-config template");
      // What install.sh would have produced from it, then hand-edited.
      writeFileSync(join(fx.repo, "config", "gen.json"), '{"gen":"mine, edited"}\n');
      const generatedBefore = readFileSync(join(fx.repo, "config", "gen.json"), "utf8");

      pushUpstream(fx, (d) => writeFileSync(join(d, "config", "gen.default.json"), '{"gen":"template v2"}\n'));
      const r = update(fx, "--yes", "--no-verify");

      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /config\/gen\.default\.json was modified upstream/, "the template change was not named");
      assert.match(r.stdout, /config\/gen\.json is yours and stays untouched/);
      assert.match(r.stdout, /install\.sh --reconfigure/, "no command was handed back");
      assert.match(r.stdout, /For you to look at — nothing here was changed/);
      assert.equal(
        readFileSync(join(fx.repo, "config", "gen.json"), "utf8"),
        generatedBefore,
        "the update resolved the conflict instead of reporting it",
      );
      assert.equal(
        readFileSync(join(fx.repo, "config", "gen.default.json"), "utf8"),
        '{"gen":"template v2"}\n',
        "the template itself should have arrived",
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("--check and --dry-run write nothing outside .git, anywhere under the prefix", () => {
    // The existing tests spot-check HEAD, the manifest and one symlink. This one compares the
    // whole of both trees, because the interesting write is always the one nobody thought to
    // re-read: a scratch file dropped in the repo, a stray entry in the agent dir.
    const fx = makeFixture();
    try {
      landUpstream(fx, (d) => {
        writeFileSync(join(d, ".gitignore"), "config/gen.json\n");
        writeFileSync(join(d, "config", "gen.default.json"), '{"gen":"template v1"}\n');
      }, "add a generated-config template");
      writeFileSync(join(fx.repo, "config", "gen.json"), '{"gen":"mine"}\n');
      writeFileSync(join(fx.repo, "scratch-notes.txt"), "mine\n");

      // An update carrying every kind of thing the script reacts to: a new linkable config, a
      // moved template, a moved lockfile, a new interview question.
      pushUpstream(fx, (d) => {
        writeFileSync(join(d, "config", "gamma.json"), '{"gamma":true}\n');
        writeFileSync(join(d, "config", "gen.default.json"), '{"gen":"template v2"}\n');
        writeFileSync(join(d, "package-lock.json"), '{"lockfileVersion":3,"moved":true}\n');
        writeFileSync(
          join(d, "scripts", "install.sh"),
          readFileSync(join(d, "scripts", "install.sh"), "utf8")
            .replace("link_one required", "link_one optional config/gamma.json gamma.json\nlink_one required")
            .replace('ask tools.alreadyAsked "an existing question" yes',
                     'ask tools.alreadyAsked "an existing question" yes\n  ask tools.brandNew "a new question" no'),
        );
      });

      const repoBefore = snapshot(fx.repo);
      const prefixBefore = snapshot(fx.prefix);
      const homeBefore = snapshot(fx.home);

      const checked = update(fx, "--check");
      assert.equal(checked.status, 3, checked.stderr);
      assert.deepEqual(snapshot(fx.repo), repoBefore, "--check wrote inside the checkout");
      assert.deepEqual(snapshot(fx.prefix), prefixBefore, "--check wrote inside the prefix");
      assert.deepEqual(snapshot(fx.home), homeBefore, "--check wrote inside HOME");

      const dry = update(fx, "--dry-run", "--yes", "--no-verify");
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      assert.deepEqual(snapshot(fx.repo), repoBefore, "--dry-run wrote inside the checkout");
      assert.deepEqual(snapshot(fx.prefix), prefixBefore, "--dry-run wrote inside the prefix");
      assert.deepEqual(snapshot(fx.home), homeBefore, "--dry-run wrote inside HOME");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a git-ignored generated config that upstream starts tracking is refused, not overwritten", () => {
    // The one place the three promises did not hold. `git merge --ff-only` overwrites an IGNORED
    // file without a word — only untracked-and-not-ignored files make git refuse — so the script's
    // own E12 collision check let this path through with a `report_add` and then fast-forwarded
    // over it. The user's hand-edited config was gone, and the summary said so in the future tense
    // ("your copy WOULD be overwritten") under the heading "nothing here was changed".
    // config/models.json is the file this happens to, and it is the one carrying their gateway URL.
    const fx = makeFixture();
    try {
      landUpstream(fx, (d) => {
        writeFileSync(join(d, ".gitignore"), "config/gen.json\n");
      }, "ignore the generated config");
      writeFileSync(join(fx.repo, "config", "gen.json"), '{"gen":"mine, edited"}\n');
      const headBefore = git(fx.repo, "rev-parse", "HEAD");

      pushUpstream(fx, (d) => {
        writeFileSync(join(d, "config", "gen.json"), '{"gen":"upstream now tracks this"}\n');
        git(d, "add", "-f", "config/gen.json");
      });

      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 1, `expected a refusal:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /PI-UPDATE-E17/);
      assert.match(r.stderr, /config\/gen\.json/, "the refusal did not name the file");
      assert.equal(
        readFileSync(join(fx.repo, "config", "gen.json"), "utf8"),
        '{"gen":"mine, edited"}\n',
        "the update overwrote a hand-edited generated config",
      );
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), headBefore, "the checkout moved anyway");

      // --check reports it like every other blocking condition, and still exits 3.
      const checked = update(fx, "--check");
      assert.equal(checked.status, 3, checked.stderr);
      assert.match(checked.stderr, /PI-UPDATE-E17/);
      assert.equal(readFileSync(join(fx.repo, "config", "gen.json"), "utf8"), '{"gen":"mine, edited"}\n');
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an ignored file identical to the version upstream is adding is not a refusal", () => {
    // Nothing to lose means nothing to refuse: the common case is a generated file that happens
    // to match what upstream now ships. Blocking there would be a rule with no victim.
    const fx = makeFixture();
    try {
      landUpstream(fx, (d) => {
        writeFileSync(join(d, ".gitignore"), "config/gen.json\n");
      }, "ignore the generated config");
      writeFileSync(join(fx.repo, "config", "gen.json"), '{"gen":"identical"}\n');
      pushUpstream(fx, (d) => {
        writeFileSync(join(d, "config", "gen.json"), '{"gen":"identical"}\n');
        git(d, "add", "-f", "config/gen.json");
      });
      const r = update(fx, "--yes", "--no-verify");
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /PI-UPDATE-E17/);
      assert.equal(readFileSync(join(fx.repo, "config", "gen.json"), "utf8"), '{"gen":"identical"}\n');
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});


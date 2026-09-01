// test/pi-check.suite.mjs — table-driven acceptance tests for bin/pi-check (EXT-04a core).
//
// Design: one checked-in clean baseline fixture (test/fixtures/pi-check/clean/) that passes
// every rule with zero findings, plus one mutation function per rule that copies the
// baseline into a scratch directory and breaks exactly the thing that rule checks. This
// keeps 16 near-identical fixture trees out of the repo while still giving each rule its
// own deliberately-broken fixture (the "17 fixtures, 17 single-finding
// assertions" pattern — here 16 rules, same pattern).
//
// Runs with the built-in test runner: `node --test test/pi-check.suite.mjs`.
//
// Named `.suite.mjs`, not `.test.mjs`: vitest's default include glob
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) would otherwise auto-discover this file and fail it
// with "No test suite found" — it uses node:test's own `test`/`describe`, not vitest's. This
// repo's shared `test:node` npm script also only globs `test/**/*.test.ts`, so either name
// requires an explicit path to run; `.suite.mjs` is the one that doesn't also break `npm test`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute paths of every file directly inside `dir` (non-recursive — bin/lib and bin/rules are flat). */
function listDir(dir) {
  return readdirSync(dir).map((f) => join(dir, f));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const PI_CHECK = join(REPO_ROOT, "bin", "pi-check");
const CLEAN_FIXTURE = join(HERE, "fixtures", "pi-check", "clean");

/**
 * How many rules a default (non---live) run reports. DERIVED, not hardcoded: this assertion
 * used to be a literal 18 and went stale the moment EXT-27 added PC-20, failing two tests for a
 * reason that had nothing to do with either rule. The invariant worth pinning is "every rule file
 * ships and exactly the --live-tagged ones are held back", not a number someone must remember to
 * bump. `tags` is a static `export const` in every rule module, so reading it is cheap and exact.
 */
const DEFAULT_RULE_COUNT = await (async () => {
  const files = readdirSync(join(REPO_ROOT, "bin", "rules")).filter((f) => f.endsWith(".mjs"));
  let count = 0;
  for (const f of files) {
    const mod = await import(pathToFileURL(join(REPO_ROOT, "bin", "rules", f)).href);
    if (!(Array.isArray(mod.tags) && mod.tags.includes("live"))) count += 1;
  }
  return count;
})();

/** Copies the clean fixture into a fresh scratch dir and returns its path. */
function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), "pi-check-test-"));
  cpSync(CLEAN_FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * The clean fixture as a REPOSITORY: a scratch copy with its own git history, every file tracked.
 *
 * PC-06's scan surface is `git ls-files`, and it reports "I could not enumerate" as a finding rather
 * than passing silently — deliberately, so a broken checkout cannot look clean. The checked-in
 * fixture directory only satisfies that by inheriting the ambient repository, which makes every
 * zero-finding assertion below depend on how the suite was obtained (an exported tree, a `git
 * archive`, or a working copy where git is not usable all fail). Giving the fixture its own history
 * makes those assertions self-contained. `git init` is local, offline and confined to the temp dir.
 */
function freshRepoCopy() {
  const dir = freshCopy();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: dir, env, stdio: "ignore" });
  return dir;
}

/**
 * Runs pi-check against `repoDir`. Never throws on a non-zero exit (findings/usage errors
 * are the normal outcomes under test) — returns { exitCode, stdout, stderr, json }.
 */
function runPiCheck(repoDir, extraArgs = []) {
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [PI_CHECK, "--all", "--json", "--repo", repoDir, ...extraArgs], {
      encoding: "utf8",
      env: { ...process.env },
    });
  } catch (err) {
    // execFileSync throws on non-zero exit; the output is still on the error object.
    stdout = err.stdout ?? "";
    exitCode = err.status ?? 1;
  }
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // leave json null; caller decides whether that's a failure
  }
  return { exitCode, stdout, json };
}

function edit(dir, relPath, transform) {
  const p = join(dir, relPath);
  writeFileSync(p, transform(readFileSync(p, "utf8")));
}

// ---------------------------------------------------------------------------------------
// 1. The clean tree passes.
// ---------------------------------------------------------------------------------------

test("clean fixture: --all passes with zero findings, exit 0", () => {
  const { exitCode, json } = runPiCheck(freshRepoCopy());
  assert.ok(json, "expected valid --json output");
  assert.equal(json.summary.findingCount, 0);
  // Every rule file ships; the --live-tagged ones (PC-19, VP-10) are excluded from the default
  // run — see the PC-19-specific tests below.
  assert.equal(json.summary.ruleCount, DEFAULT_RULE_COUNT);
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------------------
// 2. Each rule fires on its own deliberately-broken fixture.
// ---------------------------------------------------------------------------------------

/**
 * The digest PC-25 stores for `name`. Mirrors the salt and the tokenisation in
 * bin/rules/pc-25-no-do-not-publish-names.mjs; only ever called here with invented names.
 */
function digestFor(name) {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return createHash("sha256").update(`pion-do-not-publish-v1\n${tokens.join("-")}`).digest("hex");
}

/** @type {Array<{ id: string, break: (dir: string) => void }>} */
const MUTATIONS = [
  {
    id: "PC-01",
    break: (dir) => edit(dir, "config/routing.json", (t) => t.replace('"acme/gpt-nova"', '"gpt-nova"')),
  },
  {
    id: "PC-02",
    break: (dir) => edit(dir, "config/routing.json", (t) => t.replace('"acme/gpt-nova-mini"', '"ghost-provider/gpt-nova-mini"')),
  },
  {
    id: "PC-03",
    break: (dir) => edit(dir, "config/routing.json", (t) => t.replace('"onProviderError"', '"fallback": ["acme/gpt-nova-mini"], "onProviderError"')),
  },
  {
    id: "PC-04",
    break: (dir) => edit(dir, "agents/example.md", (t) => t.replace("model: fast", "model: nonexistent-tier")),
  },
  {
    id: "PC-05",
    break: (dir) => edit(dir, "agents/example.md", (t) => t.replace("model: fast", "model: fast\nfallbackModels: [acme/gpt-nova-mini]")),
  },
  {
    id: "PC-06",
    // PC-06 now enumerates via `git ls-files` (see bin/rules/pc-06-no-committed-secrets.mjs), so
    // unlike every other MUTATIONS entry this one needs a real git repo under it, not just a
    // plain copy — freshCopy() alone would make PC-06 report "not a git repository" instead of
    // scanning config/models.json's content, and never see the injected literal at all.
    break: (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      // Built at runtime, not as one source-line literal: PC-06 also scans this test file (it
      // is git-tracked), and a bare "sk-...36 chars" string sitting in this table would trip
      // the live `pi-check --all` run against this repo the moment it lands in test/.
      const injectedSecret = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
      edit(dir, "config/models.json", (t) => t.replace('"$ACME_API_KEY"', `"${injectedSecret}"`));
      execFileSync("git", ["add", "-A"], { cwd: dir });
    },
  },
  {
    id: "PC-07",
    break: (dir) => edit(dir, "extensions/example.ts", (t) => t + '\n// spawn: claude -p "do a thing"\n'),
  },
  {
    id: "PC-08",
    break: (dir) => edit(dir, "agents/example.md", (t) => t.replace("A benign test-fixture agent", "A benign test-fixture agent for claude-opus-5")),
  },
  {
    id: "PC-09",
    break: (dir) => edit(dir, "config/settings.json", (t) => t.replace('"packages": []', '"packages": ["not-in-the-ledger"]')),
  },
  {
    id: "PC-10",
    break: (dir) => edit(dir, "config/models.json", (t) => t.replace("https://api.example.test", "https://<EXAMPLE_HOST>")),
  },
  {
    id: "PC-11",
    break: (dir) => edit(dir, "config/settings.json", (t) => t.replace('"defaultProvider"', '"pin": "REPLACE_AFTER_V1",\n  "defaultProvider"')),
  },
  {
    id: "PC-12",
    break: (dir) => writeFileSync(join(dir, "PRIVATE.md"), "# not gitignored, should be flagged\n"),
  },
  {
    id: "PC-13",
    break: (dir) => edit(dir, "config/shell/pi-env.sh", (t) => t + "\nexport PI_EXPERIMENTAL=1\n"),
  },
  {
    id: "PC-14",
    break: (dir) => edit(dir, "config/shell/pi-env.sh", (t) => t + "\nexport PI_ALLOW_BROWSER_COOKIES=1\n"),
  },
  {
    id: "PC-15",
    break: (dir) => edit(dir, "extensions/example.ts", (t) => t.replace("// no-op", 'headers["X-Initiator"] = "agent";')),
  },
  {
    id: "PC-16",
    break: (dir) => writeFileSync(join(dir, "extensions", "oops.test.ts"), "// should never be discovered as an extension\n"),
  },
  {
    id: "PC-17",
    break: (dir) => rmSync(join(dir, "vendor", "examplepkg", "LICENSE")),
  },
  {
    id: "PC-18",
    break: (dir) => edit(dir, "config/packages.lock.json", (t) => t.replace('"1.0.0"', '"9.9.9"')),
  },
  {
    id: "PC-21",
    // An edit to a vendored file that nobody re-recorded. The other two change classes (added, removed) and the missing-manifest
    // case get their own tests in section 7 below.
    break: (dir) => edit(dir, "pi-packages/examplepkg/example.ts", (t) => t + "\nexport const smuggled = true;\n"),
  },
  {
    id: "PC-24",
    // The break has to create the directory as well as the file: `test/path-rules/fixtures/` does
    // not exist in the fixture tree at all, and an absent directory is PC-24's own definition of a
    // normal unconfigured state (the real rules directory lives outside the repo entirely). The
    // file it writes uses a character class, which the hand-rolled matcher deliberately refuses
    // rather than silently never matching.
    break: (dir) => {
      mkdirSync(join(dir, "test", "path-rules", "fixtures"), { recursive: true });
      writeFileSync(
        join(dir, "test", "path-rules", "fixtures", "broken.md"),
        '---\npaths:\n  - "**/[abc].py"\n---\nBroken body.\n',
      );
    },
  },
  {
    id: "PC-25",
    // The names PC-25 really looks for cannot appear in this file — a gate that ships the list it
    // forbids is the leak it exists to prevent, and this suite is git-tracked. So the mutation
    // rewrites the fixture's digest file to hold the digest of a harmless invented name and then
    // plants that name in a path. It exercises the real path scan, with nothing real in it.
    // Needs a git repo underneath for the same reason PC-06's mutation does: the scan surface is
    // `git ls-files`, and without one PC-25 reports "cannot enumerate" and never looks at a path.
    break: (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "config", "do-not-publish.digests.txt"), `2 ${digestFor("example-forbidden")}\n`);
      mkdirSync(join(dir, "docs", "example-forbidden"), { recursive: true });
      writeFileSync(join(dir, "docs", "example-forbidden", "note.md"), "Placeholder.\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
    },
  },
  {
    id: "PC-27",
    // The shape a gateway fragment renders by default: a complete model definition with no
    // `cost` at all. The clean fixture prices gpt-nova and zeroes gpt-nova-mini, so this break
    // also pins the distinction the rule is built on, that deleting the rates is a finding while
    // writing them as zeros is not.
    break: (dir) =>
      edit(dir, "config/models.json", (t) =>
        t.replace(',\n          "cost": { "input": 2, "output": 12, "cacheRead": 0.2, "cacheWrite": 2 }', ""),
      ),
  },
  {
    id: "PC-26",
    // The clean fixture ships no config/slop-lint.json, so PC-26 runs on its built-in
    // defaults, whose budget is 0. That posture is the point: an unconfigured tree gets the
    // STRICT reading, so this rule cannot be switched off by deleting a file the way a
    // "config present means enabled" design could be. The break adds one extension whose
    // thrown message carries an em dash, taking the count from 0 to 1.
    break: (dir) => {
      writeFileSync(
        join(dir, "extensions", "sloppy.ts"),
        'export function refuse(): never {\n  throw new Error("refused \u2014 nothing to do");\n}\n',
      );
    },
  },
  {
    id: "PC-28",
    // The exact defect shape (00-postmortem.md \u00a7D4): AGENTS.md asserts a default tier that
    // config/dispatch.json no longer agrees with. The clean fixture ships no AGENTS.md and no
    // dispatch.json, so the break adds both.
    break: (dir) => {
      writeFileSync(join(dir, "config", "dispatch.json"), JSON.stringify({ defaultTier: "fast" }, null, 2) + "\n");
      writeFileSync(join(dir, "AGENTS.md"), "Every subagent defaults to the `strong` tier.\n");
    },
  },
  {
    id: "PC-29",
    // The exact defect shape: config/dispatch.json declares the subagent contract's obligation
    // sections and the contract document no longer carries one of them. The clean fixture ships
    // neither file, so the break adds both — which also pins the tolerance, since every other
    // fixture-based test here runs against a tree that declares no contract at all.
    break: (dir) => {
      writeFileSync(
        join(dir, "config", "dispatch.json"),
        JSON.stringify(
          {
            subagentContract: {
              doc: "config/subagent-tool-description.md",
              requiredSections: ["Before you write", "Whether to dispatch at all"],
              minSectionLines: 2,
              worthiness: { leadHandlesChangedLinesUnder: 40, leadHandlesFilesTouchedAtMost: 2 },
            },
          },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(
        join(dir, "config", "subagent-tool-description.md"),
        "## Whether to dispatch at all\n\nUnder 40 changed lines in at most 2 files: do it yourself.\nOtherwise a dispatch is permitted.\n",
      );
    },
  },
  {
    id: "PC-30",
    // The defect worth pinning is not a typo in the pin file, it is a pin that has quietly stopped
    // pinning. The clean fixture's routing.json defines `strong` and `fast` and nothing else, so a
    // pin naming a third tier is exactly what a rename in the routing table leaves behind: the file
    // stays syntactically perfect and the project silently runs unpinned.
    break: (dir) => {
      mkdirSync(join(dir, ".pi"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "lead-model.json"),
        JSON.stringify(
          { version: 1, tier: "renamed-away", since: "2026-08-31", reason: "a reason long enough to pass the floor" },
          null,
          2,
        ) + "\n",
      );
    },
  },
];

describe("each rule fires exactly on its own broken fixture", () => {
  for (const { id, break: breakFixture } of MUTATIONS) {
    test(`${id} fires on its fixture and only that fixture is broken`, () => {
      const dir = freshCopy();
      try {
        breakFixture(dir);
        const { exitCode, json } = runPiCheck(dir);
        assert.ok(json, `expected valid --json output for ${id}`);
        assert.equal(exitCode, 1, `expected exit 1 for ${id}, findings: ${JSON.stringify(json?.findings)}`);
        const rulesFired = new Set(json.findings.map((f) => f.rule));
        assert.ok(rulesFired.has(id), `expected ${id} among firing rules, got: ${[...rulesFired].join(",")}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------
// 2b. PC-12's two git-based checks (F8, adversarial security review): a .gitignore pattern
//     alone cannot prove a path was "never tracked" — it says nothing about a file already in
//     the index, or one that was committed once and later deleted from the working tree. Both
//     scenarios need a real git repo, so unlike the MUTATIONS table above these run `git init`
//     in a scratch copy of the clean fixture (a temp dir, never the project's own .git).
// ---------------------------------------------------------------------------------------

function gitScratchRepo() {
  const dir = freshCopy();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function gitCommit(dir, message) {
  execFileSync(
    "git",
    ["-c", "user.name=pi-check-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message],
    { cwd: dir },
  );
}

test("PC-12 git regression: a .gitignore-covered file that was force-added and committed is still flagged (F8)", () => {
  const dir = gitScratchRepo();
  try {
    writeFileSync(join(dir, ".gitignore"), "PRIVATE.md\n");
    writeFileSync(join(dir, "PRIVATE.md"), "# secret\n");
    execFileSync("git", ["add", "-f", "PRIVATE.md"], { cwd: dir });
    gitCommit(dir, "force-add private file despite .gitignore");

    const { exitCode, json } = runPiCheck(dir);
    assert.equal(exitCode, 1);
    const pc12 = json.findings.filter((f) => f.rule === "PC-12");
    // The old, gitignore-only check saw PRIVATE.md as covered and stayed silent — a .gitignore
    // pattern has no effect on a file `git add -f`'d into the index before or after it existed.
    assert.ok(
      pc12.some((f) => /currently tracked by git/.test(f.message)),
      `expected a "currently tracked by git" PC-12 finding, got: ${JSON.stringify(pc12)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-12 git regression: a file added to history and later deleted from disk is still flagged, even though it no longer exists (F8)", () => {
  const dir = gitScratchRepo();
  try {
    writeFileSync(join(dir, "OPERATOR.local.md"), "# local operator notes\n");
    execFileSync("git", ["add", "OPERATOR.local.md"], { cwd: dir });
    gitCommit(dir, "add operator notes");
    execFileSync("git", ["rm", "-q", "OPERATOR.local.md"], { cwd: dir });
    gitCommit(dir, "remove operator notes");

    // Gone from disk and out of the index — the old exists()-gated check would see nothing here.
    assert.ok(!existsSync(join(dir, "OPERATOR.local.md")));

    const { exitCode, json } = runPiCheck(dir);
    assert.equal(exitCode, 1);
    const pc12 = json.findings.filter((f) => f.rule === "PC-12");
    assert.ok(
      pc12.some((f) => /added to git history at least once/.test(f.message)),
      `expected an "added to git history" PC-12 finding, got: ${JSON.stringify(pc12)}`,
    );
    // The deletion is committed, so the index is clean — no "currently tracked" double-count.
    assert.ok(
      !pc12.some((f) => /currently tracked by git/.test(f.message)),
      `did not expect a "currently tracked" finding once the deletion is committed, got: ${JSON.stringify(pc12)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 2c. PC-06's widened scan (F7, security review residual): git enumeration, the lock-file and
//     credential-fixture exclusions, and the "fails loud, never silently scans nothing" git
//     contract. Uses gitScratchRepo() like PC-12's own git-dependent tests above, since PC-06's
//     entire scan surface is now `git ls-files`.
// ---------------------------------------------------------------------------------------

test("PC-06 git regression: a secret-shaped literal in a file outside the original two scanned paths is now found", () => {
  const dir = gitScratchRepo();
  try {
    // extensions/example.ts is git-tracked in the clean fixture, but was never one of the two
    // hardcoded paths (config/models.json, config/shell/pi-env.sh) the old PC-06 scanned.
    const injectedSecret = ["ghp", "A".repeat(32)].join("_");
    edit(dir, "extensions/example.ts", (t) => t + `\nconst leaked = "${injectedSecret}"; // never do this\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });

    const { exitCode, json } = runPiCheck(dir);
    assert.equal(exitCode, 1);
    const pc06 = json.findings.filter((f) => f.rule === "PC-06");
    assert.ok(
      pc06.some((f) => f.file === "extensions/example.ts"),
      `expected a PC-06 finding in extensions/example.ts, got: ${JSON.stringify(pc06)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-06: config/packages.lock.json's sha256 integrity hashes are not reported (lock-file exclusion)", () => {
  const dir = gitScratchRepo();
  try {
    const fakeSha256 = "a1b2c3".repeat(11); // 66 hex-shaped chars — long enough to match SECRET_LITERAL's bare clause
    edit(dir, "config/packages.lock.json", (t) => t.replace('"vendor": true', `"vendor": true, "sha256": "${fakeSha256}"`));
    execFileSync("git", ["add", "-A"], { cwd: dir });

    const { exitCode, json } = runPiCheck(dir);
    const pc06InLock = (exitCode === 0 ? [] : json.findings).filter((f) => f.rule === "PC-06" && f.file.endsWith("packages.lock.json"));
    assert.deepEqual(pc06InLock, [], `expected no PC-06 findings in packages.lock.json, got: ${JSON.stringify(pc06InLock)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-06: a $ENV_VAR reference outside the original two paths is still clean", () => {
  const dir = gitScratchRepo();
  try {
    edit(dir, "extensions/example.ts", (t) => t + '\nconst configuredVia = "$SOME_SERVICE_API_KEY"; // reference only, never a literal\n');
    execFileSync("git", ["add", "-A"], { cwd: dir });

    const { exitCode, json } = runPiCheck(dir);
    assert.equal(exitCode, 0, `expected a clean run, got findings: ${JSON.stringify(json?.findings)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-06: a tracked binary asset is skipped even if its bytes happen to look secret-shaped", () => {
  const dir = gitScratchRepo();
  try {
    mkdirSync(join(dir, "assets"), { recursive: true });
    const secretShapedTail = ["sk", "A".repeat(30)].join("-");
    // A NUL byte plus a secret-shaped run of bytes. The binary sniff is what skips this, and now
    // the only thing that does: the skills-root extension pre-filter went away with the bucket
    // collapse, because a path under the (git-ignored) single `skills/` root can never be tracked
    // and so can never reach this scan at all.
    writeFileSync(join(dir, "assets", "logo.png"), Buffer.from(`\x00PNG\x00${secretShapedTail}`, "latin1"));
    execFileSync("git", ["add", "-A"], { cwd: dir });

    const { exitCode, json } = runPiCheck(dir);
    const pc06InAsset = (exitCode === 0 ? [] : json.findings).filter((f) => f.rule === "PC-06" && f.file.includes("logo.png"));
    assert.deepEqual(pc06InAsset, [], `expected no PC-06 findings in the binary asset, got: ${JSON.stringify(pc06InAsset)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-06: outside a git repository it fails loud with a named-cause finding, never a silent 0-finding pass", () => {
  const dir = freshCopy(); // no git init — the case this test targets
  try {
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [PI_CHECK, "PC-06", "--json", "--repo", dir], { encoding: "utf8" });
    } catch (err) {
      stdout = err.stdout ?? "";
    }
    const json = JSON.parse(stdout);
    assert.equal(json.summary.findingCount, 1);
    assert.equal(json.findings[0].rule, "PC-06");
    assert.match(json.findings[0].message, /git/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 3. A real regression is caught, then the tree is restored clean (mirrors spec check 3).
// ---------------------------------------------------------------------------------------

test("a real regression (bare id reintroduced) is caught by PC-01 and PC-08 together", () => {
  const dir = freshCopy();
  try {
    edit(dir, "config/routing.json", (t) => t.replace('"acme/gpt-nova"', '"claude-opus-5"'));
    const { exitCode, json } = runPiCheck(dir);
    assert.equal(exitCode, 1);
    const rulesFired = new Set(json.findings.map((f) => f.rule));
    assert.ok(rulesFired.has("PC-01"), "PC-01 (provider-qualified) should fire");
    assert.ok(rulesFired.has("PC-08"), "PC-08 (bare Anthropic id) should fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 4. It resolves no credential — the audit-26 assertion.
// ---------------------------------------------------------------------------------------

test("resolves no credential: a canary env var is never read, and a git-only PATH still exits 0", () => {
  // Originally PATH=/nonexistent (the "audit-26 assertion",
  // check 4's "platform-neutral fallback"): proving pi-check spawns nothing that could read a
  // credential by making ANY execve fail. PC-12 already spawns `git` but tolerates ENOENT
  // silently (falls back to its .gitignore-only signal), so that literal PATH kept passing.
  // PC-06 is now a second, declared git-spawning exception, but per this rule's explicit
  // fail-loud contract (see gitTrackedFiles' header comment in
  // bin/rules/pc-06-no-committed-secrets.mjs) it reports git-unavailable as a Finding rather
  // than silently scanning nothing — so a git-less PATH is no longer "0 findings", it is
  // "PC-06 correctly noticing it cannot check". The security property this test actually
  // guards — no OTHER binary is ever spawned, and ACME_API_KEY's value is never read into a
  // finding — is still fully proved by a PATH containing ONLY the directory that holds `git`.
  const gitDir = dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
  const out = execFileSync(process.execPath, [PI_CHECK, "--all", "--repo", freshRepoCopy()], {
    encoding: "utf8",
    env: { PATH: gitDir, ACME_API_KEY: "canary-should-not-be-read" },
  });
  assert.match(out, new RegExp(`^0 finding\\(s\\) in ${DEFAULT_RULE_COUNT} rules$`, "m"));
});

test("static scan: no rule, lib or CLI file imports child_process/network modules or calls a spawn API, except the declared exceptions", () => {
  // Precise on purpose: a bare "exec(" would false-positive on RegExp.prototype.exec(), which
  // pc-09 and the frontmatter reader both use legitimately. This only matches an actual
  // import/require of a spawning or network module, or a child_process-specific call name.
  const FORBIDDEN = /(?:from\s+|require\()["'](?:node:)?(?:child_process|net|http|https|dns|tls)["']|execSync\(|spawnSync\(|execFileSync\(|\bspawn\(|\bfetch\(/;
  // Five declared, deliberate exceptions, for different reasons:
  //   - PC-19 (VP-10) spawns npm and touches the network — see the companion test below, which
  //     asserts it is exactly this one file and that it never runs without --live.
  //   - PC-12 (F8, adversarial security review) spawns `git` — local, read-only, no network —
  //     to check whether a private path is tracked or was ever added in history; a .gitignore
  //     pattern alone cannot answer either question. Unlike PC-19 it is NOT --live-gated: it
  //     runs as part of the default `--all` sweep, same as before this fix.
  //   - PC-06 (F7, security review residual) spawns `git ls-files` — local, read-only, no
  //     network — for the same reason PC-12 does: git is the only source of truth for "what
  //     actually reaches GitHub". Also not --live-gated; it is the rule's entire scan surface.
  //   - PC-23 spawns `git ls-files`, and `git log` behind PI_LEAK_CHECK_HISTORY, for the third
  //     time for that same reason: a pattern that has already been committed is still published,
  //     and only git can say so. Local, read-only, no network.
  //   - PC-25 spawns `git ls-files` and `git log --diff-filter=A`, again for that reason and one
  //     more: a name deleted from the working tree is still in history, and history is what a
  //     clone gets. Local, read-only, no network.
  const SPAWN_EXCEPTIONS = [
    "pc-25-no-do-not-publish-names.mjs",
    "pc-19-npm-registry-version-agreement.mjs",
    "pc-12-private-files-not-tracked.mjs",
    "pc-06-no-committed-secrets.mjs",
    "pc-23-no-configured-leak-patterns.mjs",
  ];
  const targets = [
    join(REPO_ROOT, "bin", "pi-check"),
    ...listDir(join(REPO_ROOT, "bin", "lib")),
    ...listDir(join(REPO_ROOT, "bin", "rules")),
  ];
  const offenders = [];
  for (const file of targets) {
    if (SPAWN_EXCEPTIONS.some((exception) => file.endsWith(exception))) continue;
    const text = readFileSync(file, "utf8");
    if (FORBIDDEN.test(text)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `pi-check must never be able to spawn a process or touch the network outside ${SPAWN_EXCEPTIONS.join(", ")}: ${offenders.join(", ")}`,
  );
});

test("the --live exception is exactly PC-19, and PC-19 is gated: it touches nothing when ctx.live is falsy", async () => {
  const pc19Path = join(REPO_ROOT, "bin", "rules", "pc-19-npm-registry-version-agreement.mjs");
  const text = readFileSync(pc19Path, "utf8");
  assert.match(text, /child_process/, "PC-19 is expected to be the file that spawns npm");
  const mod = await import(pc19Path);
  assert.equal(mod.requiresLive, true);
  assert.deepEqual(mod.run({ live: false }), [], "PC-19 must return zero findings, and do zero I/O, when ctx.live is falsy");
});

test("PC-19's version comparator: agreement is silent, disagreement names both values (unit-level, no network)", async () => {
  const { compareResolvedVersions } = await import(
    join(REPO_ROOT, "bin", "rules", "pc-19-npm-registry-version-agreement.mjs")
  );
  assert.deepEqual(
    compareResolvedVersions({ name: "x", lockVersion: "1.0.0", viewVersion: "1.0.0", packVersion: "1.0.0" }),
    [],
  );
  const viewPackMismatch = compareResolvedVersions({ name: "x", lockVersion: "1.0.0", viewVersion: "1.0.0", packVersion: "1.0.1" });
  assert.equal(viewPackMismatch.length, 2, "pack disagreeing with both view AND the recorded lock pin is two distinct findings");
  const lockOnlyStale = compareResolvedVersions({ name: "x", lockVersion: "0.9.0", viewVersion: "1.0.0", packVersion: "1.0.0" });
  assert.equal(lockOnlyStale.length, 1);
  assert.match(lockOnlyStale[0].message, /packages\.lock\.json pins "0\.9\.0"/);
});

// ---------------------------------------------------------------------------------------
// 6. --only TAG and the PC-19 CLI gate (EXT-04 additions).
// ---------------------------------------------------------------------------------------

test("--only packages selects the tagged offline rules and excludes PC-19 without --live", () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [PI_CHECK, "--only", "packages", "--json", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    stdout = err.stdout;
  }
  const json = JSON.parse(stdout);
  // PC-21 is tagged "packages" as well: an unrecorded edit to a vendored package is a package
  // finding, and scripts/install.sh step 8 + postinstall-verify.sh are the runs that should catch it.
  assert.deepEqual([...json.rulesRun].sort(), ["PC-09", "PC-17", "PC-18", "PC-21"]);
  assert.equal(json.summary.findingCount, 0);
});

test("--only with an unknown/untagged value exits 2", () => {
  let status = 0;
  try {
    execFileSync(process.execPath, [PI_CHECK, "--only", "not-a-real-tag", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 2);
});

test("--all and --only cannot be combined", () => {
  let status = 0;
  try {
    execFileSync(process.execPath, [PI_CHECK, "--all", "--only", "packages", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 2);
});

test("--all excludes PC-19 from rulesRun without --live, and reports the skip on stderr", () => {
  // spawnSync (not execFileSync): a clean run exits 0, so the informative skip-note on
  // stderr must be readable on the success path too, not just from a thrown error object.
  const result = spawnSync(process.execPath, [PI_CHECK, "--all", "--json", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  const json = JSON.parse(result.stdout);
  assert.ok(!json.rulesRun.includes("PC-19"));
  assert.match(result.stderr, /PC-19 skipped — requires --live/);
});

test("naming PC-19 directly without --live exits 2 and names the flag it needs", () => {
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [PI_CHECK, "PC-19", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
    stderr = err.stderr ?? "";
  }
  assert.equal(status, 2);
  assert.match(stderr, /--live/);
});

// ---------------------------------------------------------------------------------------
// 5. --json shape and CLI usage errors.
// ---------------------------------------------------------------------------------------

test("--json output has the documented shape", () => {
  const { json } = runPiCheck(CLEAN_FIXTURE);
  assert.ok(Array.isArray(json.findings));
  assert.ok(Array.isArray(json.rulesRun));
  assert.equal(typeof json.summary.findingCount, "number");
  assert.equal(typeof json.summary.ruleCount, "number");
});

test("named-rule invocation runs only the requested rules", () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [PI_CHECK, "PC-01", "PC-08", "--json", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    stdout = err.stdout;
  }
  const json = JSON.parse(stdout);
  assert.deepEqual(json.rulesRun, ["PC-01", "PC-08"]);
});

test("an unknown rule id exits 2, not 1", () => {
  let status = 0;
  try {
    execFileSync(process.execPath, [PI_CHECK, "PC-99", "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 2);
});

test("no arguments at all exits 2 with a usage message", () => {
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [PI_CHECK, "--repo", CLEAN_FIXTURE], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
    stderr = err.stderr ?? "";
  }
  assert.equal(status, 2);
  assert.match(stderr, /usage/);
});

// ---------------------------------------------------------------------------------------
// 7. PC-21 — the vendored-tree hash manifest.
//
//    The MUTATIONS entry above covers "a vendored file was MODIFIED". These cover the three cases
//    a per-file hash comparison exists to separate from each other — added, removed, and no record
//    at all — plus the one documented escape hatch (`--write-vendor-manifest`), because a gate
//    whose legitimate override is untested is a gate people will delete instead of using.
//
//    The clean-fixture case is not repeated here: test 1 above already asserts the checked-in
//    fixture (which now carries pi-packages/examplepkg/example.ts and its recorded manifest)
//    passes every rule with zero findings, and DEFAULT_RULE_COUNT picked PC-21 up on its own.
// ---------------------------------------------------------------------------------------

const VENDOR_MANIFEST = join("pi-packages", "vendor-files.lock.json");
const VENDORED_FILE = join("pi-packages", "examplepkg", "example.ts");

/** The PC-21 findings from an --all run against `dir`. */
function pc21Findings(dir) {
  const { json } = runPiCheck(dir);
  assert.ok(json, "expected valid --json output");
  return json.findings.filter((f) => f.rule === "PC-21");
}

test("PC-21: the clean fixture's vendored tree agrees with its recorded manifest (no findings from this rule alone)", () => {
  const findings = pc21Findings(CLEAN_FIXTURE);
  assert.deepEqual(findings, [], `expected no PC-21 findings on the clean fixture, got: ${JSON.stringify(findings)}`);
});

test("PC-21: a file ADDED to a vendored package is caught, even though every recorded hash still matches", () => {
  const dir = freshCopy();
  try {
    // The smuggling case: nothing that was reviewed changed, so a tarball-sha256 check (and every
    // per-recorded-file check) still passes. Only enumerating the tree finds this.
    writeFileSync(join(dir, "pi-packages", "examplepkg", "extra.ts"), "export const extra = 1;\n");
    const findings = pc21Findings(dir);
    assert.equal(findings.length, 1, `expected exactly one PC-21 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "pi-packages/examplepkg/extra.ts");
    assert.match(findings[0].message, /on disk but not recorded/);
    assert.match(findings[0].message, /--write-vendor-manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-21: a file REMOVED from a vendored package is caught (a deleted local patch breaks no import)", () => {
  const dir = freshCopy();
  try {
    rmSync(join(dir, VENDORED_FILE));
    const findings = pc21Findings(dir);
    assert.equal(findings.length, 1, `expected exactly one PC-21 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "pi-packages/examplepkg/example.ts");
    assert.match(findings[0].message, /missing from disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-21: a MISSING manifest is a finding, never a silent pass, whenever pi-packages/ exists", () => {
  const dir = freshCopy();
  try {
    rmSync(join(dir, VENDOR_MANIFEST));
    const { exitCode } = runPiCheck(dir);
    assert.equal(exitCode, 1);
    const findings = pc21Findings(dir);
    assert.equal(findings.length, 1, `expected exactly one PC-21 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "pi-packages/vendor-files.lock.json");
    assert.match(findings[0].message, /unverifiable, which is an unknown, not a clean pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-21: with no pi-packages/ tree at all the rule is a no-op (nothing vendored, nothing to record)", () => {
  const dir = freshCopy();
  try {
    rmSync(join(dir, "pi-packages"), { recursive: true });
    // Asserted per-rule, not on the exit code: a scratch copy is not a git repository, so PC-06
    // reports its own "cannot enumerate git-tracked files" finding here (see section 2c) and the
    // run exits 1 for a reason that has nothing to do with PC-21.
    assert.deepEqual(pc21Findings(dir), [], "a tree that vendors nothing must not produce a PC-21 finding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-21: a hand-edited manifest (a row deleted to silence a finding) is caught by fileCount, not just by the diff", () => {
  const dir = freshCopy();
  try {
    edit(dir, VENDOR_MANIFEST, (t) => {
      const parsed = JSON.parse(t);
      parsed.files = {};
      return JSON.stringify(parsed, null, 2) + "\n";
    });
    const findings = pc21Findings(dir);
    assert.ok(
      findings.some((f) => /declares fileCount 1 but carries 0 entries/.test(f.message)),
      `expected a fileCount mismatch finding, got: ${JSON.stringify(findings)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-21's escape hatch: --write-vendor-manifest re-records a legitimate edit, is idempotent, and refuses to run alongside a check", () => {
  const dir = freshCopy();
  try {
    edit(dir, VENDORED_FILE, (t) => t + "\nexport const legitimatePatch = true;\n");
    assert.equal(pc21Findings(dir).length, 1, "the edit must be caught before it is recorded");

    const first = execFileSync(process.execPath, [PI_CHECK, "--write-vendor-manifest", "--repo", dir], { encoding: "utf8" });
    assert.match(first, /updated pi-packages\/vendor-files\.lock\.json/);
    assert.deepEqual(pc21Findings(dir), [], "after re-recording, the tree agrees with the manifest again");

    // Idempotent: a second regeneration of an unchanged tree writes identical bytes and says so,
    // which is what makes `git diff` after a regeneration mean "the vendored tree changed".
    const second = execFileSync(process.execPath, [PI_CHECK, "--write-vendor-manifest", "--repo", dir], { encoding: "utf8" });
    assert.match(second, /unchanged pi-packages\/vendor-files\.lock\.json/);

    // "check" and "re-record" must never be the same invocation.
    let status = 0;
    try {
      execFileSync(process.execPath, [PI_CHECK, "--all", "--write-vendor-manifest", "--repo", dir], { encoding: "utf8" });
    } catch (err) {
      status = err.status;
    }
    assert.equal(status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 2f. PC-25's two properties that the MUTATIONS entry cannot show: it fails CLOSED when it has
//     nothing to check against, and its content scan is deliberately restricted to multi-token
//     names. Both use invented names for the same reason the mutation does.
// ---------------------------------------------------------------------------------------

function pc25Findings(dir) {
  const { json } = runPiCheck(dir);
  assert.ok(json, "expected valid --json output");
  return json.findings.filter((f) => f.rule === "PC-25");
}

test("PC-25 fails closed: a missing digest file is a finding, not a silent pass", () => {
  const dir = freshRepoCopy();
  try {
    rmSync(join(dir, "config", "do-not-publish.digests.txt"));
    const findings = pc25Findings(dir);
    assert.equal(findings.length, 1, `expected exactly one PC-25 finding, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /fails closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-25 scans content for a multi-token name but not for a single-token one", () => {
  const dir = freshRepoCopy();
  try {
    writeFileSync(
      join(dir, "config", "do-not-publish.digests.txt"),
      `2 ${digestFor("example-forbidden")}\n1 ${digestFor("placeholder")}\n`,
    );
    writeFileSync(join(dir, "docs", "prose.md"), "A sentence mentioning example forbidden things.\nAnd a placeholder.\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });

    const findings = pc25Findings(dir);
    assert.equal(findings.length, 1, `expected exactly one PC-25 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "docs/prose.md");
    assert.equal(findings[0].line, 1, "the multi-token name is caught in prose; the single-token one on line 2 is not");
    // The finding must not quote what it matched — that is what would put the name in a CI log.
    assert.ok(!/example/i.test(findings[0].message), `finding repeated the matched text: ${findings[0].message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 8. PC-26 — the prose ratchet. The MUTATIONS table proves it fires; these prove the two
//    properties that make it a ratchet rather than a number somebody bumps.
// ---------------------------------------------------------------------------------------

const EM_DASH = "\u2014";

/** Write an extension whose thrown messages carry `n` em dashes, one per function. */
function seedProse(dir, n) {
  let body = "";
  for (let k = 0; k < n; k++) {
    body += `export function refuse${k}(): never {\n  throw new Error("refused ${EM_DASH} case ${k}");\n}\n`;
  }
  writeFileSync(join(dir, "extensions", "prose.ts"), body);
}

/** The PC-26 findings from an --all run against `dir`. */
function pc26Findings(dir) {
  const { json } = runPiCheck(dir);
  assert.ok(json, "expected valid --json output");
  return json.findings.filter((f) => f.rule === "PC-26");
}

test("PC-26: the recorded budget is a ceiling, and the sites over it are named in the finding", () => {
  const dir = freshCopy();
  try {
    writeFileSync(join(dir, "config", "slop-lint.json"), JSON.stringify({ budget: 2 }, null, 2) + "\n");
    seedProse(dir, 3);
    const findings = pc26Findings(dir);
    assert.equal(findings.length, 1, `expected one PC-26 finding, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /carries 3 em dashes, 1 over the budget of 2/);
    // A bare count tells nobody where to look, and this number is not re-derivable by hand.
    assert.match(findings[0].message, /extensions\/prose\.ts:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-26: a budget the tree has fallen BELOW also fails, so freed slots are not banked", () => {
  // The half that makes it a ratchet. Without it, somebody cleans three call sites, nobody
  // edits the config, and the next change gets three em dashes free while the gate stays
  // green — the budget having quietly become fiction.
  const dir = freshCopy();
  try {
    writeFileSync(join(dir, "config", "slop-lint.json"), JSON.stringify({ budget: 5 }, null, 2) + "\n");
    seedProse(dir, 2);
    const findings = pc26Findings(dir);
    assert.equal(findings.length, 1, `expected one PC-26 finding, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /carries 2 em dashes but the budget .* is still 5/);
    assert.match(findings[0].message, /lower it to 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-26: a budget that is absent or not a non-negative integer is refused, not guessed at", () => {
  const dir = freshCopy();
  try {
    for (const bad of [{}, { budget: "many" }, { budget: -1 }, { budget: 1.5 }]) {
      writeFileSync(join(dir, "config", "slop-lint.json"), JSON.stringify(bad, null, 2) + "\n");
      const findings = pc26Findings(dir);
      assert.equal(findings.length, 1, `expected one PC-26 finding for ${JSON.stringify(bad)}`);
      assert.match(findings[0].message, /"budget" is missing or is not a non-negative integer/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-26: config widens the scan but cannot silence it", () => {
  const dir = freshCopy();
  try {
    // Narrowing `roots` to a directory that does not exist is the most direct attempt to switch
    // the rule off. It still runs, still counts (to zero), and still holds the tree to the
    // recorded budget — so a disabling edit surfaces as a failure rather than as silence.
    writeFileSync(join(dir, "config", "slop-lint.json"), JSON.stringify({ roots: ["nowhere"], budget: 4 }, null, 2) + "\n");
    seedProse(dir, 4);
    const findings = pc26Findings(dir);
    assert.equal(findings.length, 1, `expected one PC-26 finding, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /carries 0 em dashes but the budget .* is still 4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 9. PC-28 — routing prose matches config/routing.default.json and config/dispatch.json
//     (FIX-ROUTING-SINGLE-AUTHORITY). The MUTATIONS entry above proves the exact historical
//     defect shape fires; these prove the two directions the fix spec calls for by name: a
//     matching pair passes, and a bare mention of a tier — the false-positive shape the spec
//     warns a "suppressed rule is worth less than no rule" about — never fires on its own.
// ---------------------------------------------------------------------------------------

/** The PC-28 findings from an --all run against `dir`. */
function pc28Findings(dir) {
  const { json } = runPiCheck(dir);
  assert.ok(json, "expected valid --json output");
  return json.findings.filter((f) => f.rule === "PC-28");
}

test("PC-28: a model:level pairing that matches config/routing.json produces no findings", () => {
  const dir = freshCopy();
  try {
    // Fixture's "strong" tier is acme/gpt-nova at thinkingLevel high — restated exactly.
    writeFileSync(join(dir, "AGENTS.md"), 'A child carries `model: "acme/gpt-nova:high"`.\n');
    assert.deepEqual(pc28Findings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-28: a model:level pairing that disagrees with config/routing.json fires, naming both values", () => {
  const dir = freshCopy();
  try {
    // Fixture's "strong" tier declares thinkingLevel high, not medium.
    writeFileSync(join(dir, "AGENTS.md"), 'A child carries `model: "acme/gpt-nova:medium"`.\n');
    const findings = pc28Findings(dir);
    assert.equal(findings.length, 1, `expected one PC-28 finding, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /pins "acme\/gpt-nova" at thinkingLevel "medium"/);
    assert.match(findings[0].message, /tier "strong" declares thinkingLevel "high"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-28: a defaultTier claim that agrees with config/dispatch.json produces no findings", () => {
  const dir = freshCopy();
  try {
    writeFileSync(join(dir, "config", "dispatch.json"), JSON.stringify({ defaultTier: "strong" }, null, 2) + "\n");
    writeFileSync(join(dir, "AGENTS.md"), "Every subagent defaults to the `strong` tier.\n");
    assert.deepEqual(pc28Findings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-28: a bare tier mention, with no model:level pairing and no defaults-to claim, never fires", () => {
  const dir = freshCopy();
  try {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "Deviate only consciously: `fast` for a mechanical one-liner, `strong` for hard debugging.\n",
    );
    assert.deepEqual(pc28Findings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 10. PC-29 — the subagent contract keeps the obligation sections config/dispatch.json
//     declares, and states no threshold that block disagrees with. The MUTATIONS entry above
//     proves a dropped section fires; these prove the rest of the ratchet in both directions,
//     including the three ways prose decays that this rule was written for: the section is
//     deleted, the section is hollowed out to a heading, or the number in it drifts from the
//     number the config carries.
// ---------------------------------------------------------------------------------------

/** The PC-29 findings from an --all run against `dir`. */
function pc29Findings(dir) {
  const { json } = runPiCheck(dir);
  assert.ok(json, "expected valid --json output");
  return json.findings.filter((f) => f.rule === "PC-29");
}

/**
 * Seeds a fixture with a subagentContract block and a contract document. Both numbers differ from
 * the ones this repo's own config carries, which is what proves the rule reads them rather than
 * knowing them.
 */
function seedContract(dir, docBody, overrides = {}) {
  writeFileSync(
    join(dir, "config", "dispatch.json"),
    JSON.stringify(
      {
        subagentContract: {
          doc: "config/subagent-tool-description.md",
          requiredSections: ["Before you write", "Whether to dispatch at all"],
          minSectionLines: 2,
          worthiness: { leadHandlesChangedLinesUnder: 40, leadHandlesFilesTouchedAtMost: 2 },
          ...overrides,
        },
      },
      null,
      2,
    ) + "\n",
  );
  if (docBody !== null) writeFileSync(join(dir, "config", "subagent-tool-description.md"), docBody);
}

const MATCHING_CONTRACT_DOC = [
  "## Whether to dispatch at all",
  "",
  "Under 40 changed lines in at most 2 files: make the change yourself.",
  "At or above either bound, a dispatch is permitted.",
  "",
  "## Before you write",
  "",
  "Read the module map, then name by path the module you extend.",
  "A new top-level module needs the lead's explicit approval.",
  "",
].join("\n");

test("PC-29: a contract carrying every declared section and both declared bounds produces no findings", () => {
  const dir = freshCopy();
  try {
    seedContract(dir, MATCHING_CONTRACT_DOC);
    assert.deepEqual(pc29Findings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-29: a section reduced to its heading fires, naming the shortfall", () => {
  const dir = freshCopy();
  try {
    seedContract(
      dir,
      MATCHING_CONTRACT_DOC.replace("Read the module map, then name by path the module you extend.\n", ""),
    );
    const findings = pc29Findings(dir);
    assert.equal(findings.length, 1, `expected one PC-29 finding, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /section "Before you write" carries 1 non-blank line\(s\), below the 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-29: a threshold that disagrees with config/dispatch.json fires, naming both values", () => {
  const dir = freshCopy();
  try {
    seedContract(dir, MATCHING_CONTRACT_DOC.replace("40 changed lines", "80 changed lines"));
    const findings = pc29Findings(dir);
    assert.equal(findings.length, 2, `expected two PC-29 findings, got: ${JSON.stringify(findings)}`);
    assert.match(findings[0].message, /states "80 changed lines".*leadHandlesChangedLinesUnder is 40/);
    assert.match(findings[1].message, /never states the worthiness bound of 40 lines/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-29: a contract document the config declares but the tree does not have fires against the config", () => {
  const dir = freshCopy();
  try {
    seedContract(dir, null);
    const findings = pc29Findings(dir);
    assert.equal(findings.length, 1, `expected one PC-29 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "config/dispatch.json");
    assert.match(findings[0].message, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-29: a dispatch.json that declares no subagentContract is silent, not noisy", () => {
  const dir = freshCopy();
  try {
    writeFileSync(join(dir, "config", "dispatch.json"), JSON.stringify({ maxDepth: 2 }, null, 2) + "\n");
    writeFileSync(join(dir, "config", "subagent-tool-description.md"), "## Anything\n\nNo obligations here at all.\n");
    assert.deepEqual(pc29Findings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// 11. PC-31 and the warning channel — a report that must never fail a build.
//
// PC-31 is the first rule that emits `severity: "warn"`, so these tests are as much about the
// channel as about the rule. The property that matters is the one that is easy to lose in a
// refactor: a warning is printed, counted and reported under its own key, and the exit code
// stays 0. The moment a warning can turn a green run red, "legal but pointless" becomes a
// build break and the whole gate gets switched off.
// ---------------------------------------------------------------------------------------

/** Rewrites the fixture's routing.json with `retry` merged into its `onProviderError` block. */
function withRetry(dir, retry) {
  edit(dir, "config/routing.json", (t) => {
    const routing = JSON.parse(t);
    routing.onProviderError.retry = retry;
    return JSON.stringify(routing, null, 2) + "\n";
  });
}

/** Runs PC-31 alone against `dir` and returns { exitCode, stdout, json }. */
function runPc31(dir, extraArgs = ["--json"]) {
  const result = spawnSync(process.execPath, [PI_CHECK, "PC-31", ...extraArgs, "--repo", dir], { encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // text mode: the caller reads stdout
  }
  return { exitCode: result.status, stdout: result.stdout, json };
}

const RETRIES_EMPTY = { classes: ["network", "empty-response"], maxAttempts: 1 };

test('PC-31: retrying "empty-response" with no onEmpty.strategy warns, and warns without failing', () => {
  const dir = freshRepoCopy();
  try {
    withRetry(dir, RETRIES_EMPTY);
    const { exitCode, json } = runPc31(dir);
    assert.equal(json.summary.warningCount, 1);
    assert.equal(json.summary.findingCount, 0);
    assert.deepEqual(json.findings, [], "a warning must not reach findings — that array is what fails the build");
    assert.equal(json.warnings[0].rule, "PC-31");
    assert.equal(json.warnings[0].severity, "warn");
    assert.equal(json.warnings[0].file, "config/routing.json");
    assert.match(json.warnings[0].message, /onEmpty\.strategy/);
    assert.equal(exitCode, 0, "a warning never sets a non-zero exit code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-31: the warning is line-addressed to the class that triggered it, not to the top of the file", () => {
  const dir = freshRepoCopy();
  try {
    withRetry(dir, RETRIES_EMPTY);
    const { json } = runPc31(dir);
    const lines = readFileSync(join(dir, "config", "routing.json"), "utf8").split("\n");
    assert.ok(json.warnings[0].line > 0);
    assert.match(lines[json.warnings[0].line - 1], /"empty-response"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PC-31: an explicit strategy is a decision and is silent — "identical" as much as "vary"', () => {
  for (const strategy of ["identical", "vary"]) {
    const dir = freshRepoCopy();
    try {
      withRetry(dir, { ...RETRIES_EMPTY, onEmpty: { strategy, thinkingLevel: "low", maxExtraAttempts: 0 } });
      const { json } = runPc31(dir);
      assert.deepEqual(json.warnings, [], `strategy "${strategy}" is written down, so there is nothing to report`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("PC-31: the two configurations that cannot retry pointlessly are silent (no empty-response class, maxAttempts 0)", () => {
  for (const retry of [{ classes: ["network"], maxAttempts: 1 }, { ...RETRIES_EMPTY, maxAttempts: 0 }]) {
    const dir = freshRepoCopy();
    try {
      withRetry(dir, retry);
      const { json } = runPc31(dir);
      assert.deepEqual(json.warnings, [], `no retry happens under ${JSON.stringify(retry)}, so none is wasted`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("PC-31: a routing file with no retry block at all is silent (the clean fixture ships one)", () => {
  const dir = freshRepoCopy();
  try {
    assert.deepEqual(runPc31(dir).json.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the text report tags a warning and counts it in its own tail, separately from findings", () => {
  const dir = freshRepoCopy();
  try {
    withRetry(dir, RETRIES_EMPTY);
    const { exitCode, stdout } = runPc31(dir, []);
    assert.match(stdout, /PC-31 {2}config\/routing\.json:\d+ +warn /);
    assert.match(stdout, /0 finding\(s\), 1 warning\(s\) in 1 rule/);
    assert.equal(exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json always carries the warning channel, even on a tree with nothing to warn about", () => {
  const { json } = runPiCheck(CLEAN_FIXTURE);
  assert.ok(Array.isArray(json.warnings), "the key is unconditional, so a consumer never has to test for it");
  assert.equal(json.summary.warningCount, 0);
});

// ---------------------------------------------------------------------------------------
// 12. PC-32 — compat.supportsPromptCacheKey warns; it is inert under --mode binary and needs
// the runtime patched even under --mode npm. Same warning channel as PC-31, so exit code
// stays 0 throughout.
// ---------------------------------------------------------------------------------------

/** Rewrites the fixture's models.json, merging `compat` into the named provider's block. */
function withCompat(dir, providerId, compat) {
  edit(dir, "config/models.json", (t) => {
    const models = JSON.parse(t);
    models.providers[providerId].compat = compat;
    return JSON.stringify(models, null, 2) + "\n";
  });
}

/** Runs PC-32 alone against `dir` and returns { exitCode, stdout, json }. */
function runPc32(dir, extraArgs = ["--json"]) {
  const result = spawnSync(process.execPath, [PI_CHECK, "PC-32", ...extraArgs, "--repo", dir], { encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // text mode: the caller reads stdout
  }
  return { exitCode: result.status, stdout: result.stdout, json };
}

test("PC-32: compat.supportsPromptCacheKey: true warns, and warns without failing", () => {
  const dir = freshRepoCopy();
  try {
    withCompat(dir, "acme", { supportsPromptCacheKey: true });
    const { exitCode, json } = runPc32(dir);
    assert.equal(json.summary.warningCount, 1);
    assert.equal(json.summary.findingCount, 0);
    assert.deepEqual(json.findings, [], "a warning must not reach findings — that array is what fails the build");
    assert.equal(json.warnings[0].rule, "PC-32");
    assert.equal(json.warnings[0].severity, "warn");
    assert.equal(json.warnings[0].file, "config/models.json");
    assert.match(json.warnings[0].message, /supportsPromptCacheKey/);
    assert.match(json.warnings[0].message, /--mode binary/);
    assert.equal(exitCode, 0, "a warning never sets a non-zero exit code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-32: the warning is line-addressed to the flag that triggered it, not to the top of the file", () => {
  const dir = freshRepoCopy();
  try {
    withCompat(dir, "acme", { supportsPromptCacheKey: true });
    const { json } = runPc32(dir);
    const lines = readFileSync(join(dir, "config", "models.json"), "utf8").split("\n");
    assert.ok(json.warnings[0].line > 0);
    assert.match(lines[json.warnings[0].line - 1], /"supportsPromptCacheKey"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-32: supportsPromptCacheKey: false is silent — the derived-null case a default install ships", () => {
  const dir = freshRepoCopy();
  try {
    withCompat(dir, "acme", { supportsPromptCacheKey: false });
    const { json } = runPc32(dir);
    assert.deepEqual(json.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-32: an unrelated compat flag is silent — only supportsPromptCacheKey is this rule's business", () => {
  const dir = freshRepoCopy();
  try {
    withCompat(dir, "acme", { supportsReasoningEffort: true });
    const { json } = runPc32(dir);
    assert.deepEqual(json.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC-32: a models.json with no compat block at all is silent (the clean fixture ships one)", () => {
  const dir = freshRepoCopy();
  try {
    assert.deepEqual(runPc32(dir).json.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * bin/rules/pc-23-no-configured-leak-patterns.mjs — the private→public port leak guard.
 *
 * Every scenario below is driven through the real `bin/pi-check` CLI, against a disposable git
 * repository under `$TMPDIR` (never `/tmp`, never this checkout) — the same "real OS process,
 * real git" style `test/pi-check.suite.mjs` uses for PC-12's git-dependent checks, chosen here for
 * the same reason: PC-23's enumeration is `git ls-files`, so a fixture without real git history
 * cannot exercise it honestly.
 *
 * The invented pattern used throughout, "internal.example.invalid", is not a real hostname —
 * `.invalid` is the IANA-reserved TLD for exactly this purpose (RFC 2606).
 *
 * This file never runs `npm test` or the whole `test/**\/*.test.ts` glob itself; it is meant to be
 * run standalone: `node --test test/bin/rules/pc-23-no-configured-leak-patterns.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PI_CHECK = join(REPO_ROOT, "bin", "pi-check");
const RULE_MODULE = join(REPO_ROOT, "bin", "rules", "pc-23-no-configured-leak-patterns.mjs");

const FAKE_PATTERN = "internal.example.invalid";

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, empty git repository under $TMPDIR (os.tmpdir() already honours $TMPDIR). */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pc-23-test-"));
  scratchDirs.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir, env, stdio: "ignore" });
  return dir;
}

function writeTracked(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.name=pc-23-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message],
    { cwd: dir },
  );
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: { findings: { rule: string; file: string; line?: number; message: string }[] } | null;
}

/**
 * Runs `bin/pi-check PC-23 --json --repo <dir>`, never inheriting the two env vars from the host.
 *
 * `spawnSync`, not `execFileSync`: the latter only returns stderr when the process EXITS
 * NON-ZERO — on a clean pass (exit 0) its stderr is captured internally and thrown away, which
 * would make the "unconfigured is a clean pass with a notice on stderr" test unable to see the
 * one thing it exists to check.
 */
function runPc23(dir: string, envExtra: NodeJS.ProcessEnv = {}): RunResult {
  const env = { ...process.env };
  delete env.PI_LEAK_CHECK_PATTERNS;
  delete env.PI_LEAK_CHECK_HISTORY;
  Object.assign(env, envExtra);

  const result = spawnSync(process.execPath, [PI_CHECK, "PC-23", "--json", "--repo", dir], { encoding: "utf8", env });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;

  let json: RunResult["json"] = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // left null; the assertion that needs it will fail loudly with stdout/stderr attached
  }
  return { exitCode, stdout, stderr, json };
}

describe("PC-23 — module shape", () => {
  it("exports id PC-23 and a run function, matching the CLI contract every other rule follows", async () => {
    const mod = await import(pathToFileURL(RULE_MODULE).href);
    assert.equal(mod.id, "PC-23");
    assert.equal(typeof mod.run, "function");
    assert.equal(typeof mod.title, "string");
  });
});

describe("PC-23 — unconfigured is a clean pass with a notice, never a failure", () => {
  it("zero findings, exit 0, and a stderr notice naming both configuration channels", () => {
    const dir = freshRepo();
    writeTracked(dir, "README.md", "nothing sensitive here\n");
    commitAll(dir, "initial");

    const r = runPc23(dir);
    assert.equal(r.exitCode, 0);
    assert.ok(r.json, `expected valid --json output, got stdout: ${r.stdout}`);
    assert.deepEqual(r.json!.findings, []);
    assert.match(r.stderr, /no leak-check patterns configured/);
    assert.match(r.stderr, /PI_LEAK_CHECK_PATTERNS/);
    assert.match(r.stderr, /config\/leak-patterns\.local\.txt/);
  });
});

describe("PC-23 — env-var-configured pattern, working tree", () => {
  it("fires when the pattern is present in a tracked file, and names file + line", () => {
    const dir = freshRepo();
    writeTracked(dir, "docs/notes.md", `line one\nendpoint: https://${FAKE_PATTERN}/api\nline three\n`);
    commitAll(dir, "add notes");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN });
    assert.equal(r.exitCode, 1);
    assert.ok(r.json, `expected valid --json output, got stdout: ${r.stdout}`);
    const findings = r.json!.findings.filter((f) => f.rule === "PC-23");
    assert.equal(findings.length, 1, `expected exactly one PC-23 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "docs/notes.md");
    assert.equal(findings[0].line, 2);
  });

  it("stays clean when the configured pattern is absent from the tree", () => {
    const dir = freshRepo();
    writeTracked(dir, "docs/notes.md", "nothing to see here\n");
    commitAll(dir, "add notes");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.json!.findings, []);
  });

  it("matches case-insensitively", () => {
    const dir = freshRepo();
    writeTracked(dir, "docs/notes.md", `see INTERNAL.EXAMPLE.INVALID for details\n`);
    commitAll(dir, "add notes");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN });
    assert.equal(r.exitCode, 1);
  });

  it("never repeats the matched pattern text anywhere in its own output", () => {
    const dir = freshRepo();
    writeTracked(dir, "docs/notes.md", `endpoint: ${FAKE_PATTERN}\n`);
    commitAll(dir, "add notes");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN });
    assert.equal(r.exitCode, 1);
    assert.ok(!r.stdout.includes(FAKE_PATTERN), `finding output must not echo the matched pattern:\n${r.stdout}`);
    assert.ok(!r.stderr.includes(FAKE_PATTERN), `stderr must not echo the matched pattern either:\n${r.stderr}`);
  });

  it("accepts a comma-separated list and fires on the second entry", () => {
    const dir = freshRepo();
    writeTracked(dir, "docs/notes.md", `see ${FAKE_PATTERN}\n`);
    commitAll(dir, "add notes");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: `some-other-value.example.invalid,${FAKE_PATTERN}` });
    assert.equal(r.exitCode, 1);
  });
});

describe("PC-23 — the git-ignored local file source", () => {
  it("fires on a pattern supplied only via config/leak-patterns.local.txt, with no env var set — and the local file itself stays untracked, matching the real repo's own .gitignore convention", () => {
    const dir = freshRepo();
    writeTracked(dir, ".gitignore", "config/leak-patterns.local.txt\n");
    writeTracked(dir, "docs/notes.md", `endpoint: ${FAKE_PATTERN}\n`);
    writeTracked(dir, "config/leak-patterns.local.txt", `# comment line, ignored\n\n${FAKE_PATTERN}\n`);
    commitAll(dir, "add notes"); // config/leak-patterns.local.txt is gitignored, so `git add -A` never stages it

    const r = runPc23(dir);
    assert.equal(r.exitCode, 1, `expected the local-file pattern to fire, got stdout: ${r.stdout}`);
    const findings = r.json!.findings.filter((f) => f.rule === "PC-23");
    // Exactly the one real hit — proof the (untracked) local file was READ for its patterns but
    // never itself SCANNED as a tracked file.
    assert.equal(findings.length, 1, `expected exactly one finding, got: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].file, "docs/notes.md");
  });

  it("combines with the env var rather than replacing it", () => {
    const dir = freshRepo();
    writeTracked(dir, ".gitignore", "config/leak-patterns.local.txt\n");
    writeTracked(dir, "a.md", "aaa.example.invalid\n");
    writeTracked(dir, "b.md", `${FAKE_PATTERN}\n`);
    writeTracked(dir, "config/leak-patterns.local.txt", "aaa.example.invalid\n");
    commitAll(dir, "add both");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN });
    assert.equal(r.exitCode, 1);
    const findings = r.json!.findings.filter((f) => f.rule === "PC-23");
    assert.equal(findings.length, 2, `expected findings for both a.md and b.md, got: ${JSON.stringify(findings)}`);
  });
});

describe("PC-23 — history is opt-in and off by default", () => {
  it("a pattern removed from the working tree but present in an earlier commit is invisible without PI_LEAK_CHECK_HISTORY", () => {
    const dir = freshRepo();
    writeTracked(dir, "config.md", `old endpoint ${FAKE_PATTERN}\n`);
    commitAll(dir, "the leak, once");
    writeTracked(dir, "config.md", "old endpoint removed\n");
    commitAll(dir, "scrub it");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN });
    assert.equal(r.exitCode, 0, "the working-tree scan alone must not see history");
    assert.deepEqual(r.json!.findings, []);
  });

  it("the same history is found with PI_LEAK_CHECK_HISTORY=1, without repeating the pattern text", () => {
    const dir = freshRepo();
    writeTracked(dir, "config.md", `old endpoint ${FAKE_PATTERN}\n`);
    commitAll(dir, "the leak, once");
    writeTracked(dir, "config.md", "old endpoint removed\n");
    commitAll(dir, "scrub it");

    const r = runPc23(dir, { PI_LEAK_CHECK_PATTERNS: FAKE_PATTERN, PI_LEAK_CHECK_HISTORY: "1" });
    assert.equal(r.exitCode, 1, `expected history finding, got stdout: ${r.stdout}`);
    const findings = r.json!.findings.filter((f) => f.rule === "PC-23");
    assert.ok(
      findings.some((f) => f.file.includes("history")),
      `expected a "(git history...)" finding, got: ${JSON.stringify(findings)}`,
    );
    assert.ok(!r.stdout.includes(FAKE_PATTERN));
  });
});

describe("PC-23 — no writing git command is ever invoked", () => {
  it("the rule source contains no git subcommand that mutates the repository", () => {
    // A static, cheap guard against regression: every git subcommand this rule spawns must be
    // one of the read-only ones it is documented to use. A future edit that adds `git add` or
    // `git commit` to this file would be exactly the hazard the task that created it forbids.
    const src = readFileSync(RULE_MODULE, "utf8");
    const invoked = [...src.matchAll(/"git",\s*\[\s*"-C",\s*[^,]+,\s*"([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(invoked.length > 0, "expected to find at least one git invocation to check");
    for (const sub of invoked) {
      assert.ok(["ls-files", "log"].includes(sub), `unexpected git subcommand "${sub}" in ${RULE_MODULE}`);
    }
  });
});

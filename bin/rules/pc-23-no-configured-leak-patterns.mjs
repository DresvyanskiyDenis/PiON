// bin/rules/pc-23-no-configured-leak-patterns.mjs — private-to-public port leak guard.
//
// The private→public sync (a private harness's config ported into this public repo) is manual,
// and until this rule existed the only guard against an internal hostname or an employer name
// riding along was the *.default.json + .gitignore convention itself — a convention, not a check.
//
// This rule cannot hardcode what it looks for: a check that ships the secrets it detects is
// itself the leak. So the forbidden values never live in this file, or anywhere else in the
// repository. They come from whoever is running the check, through exactly two channels, either
// or both:
//
//   - the PATTERNS_ENV environment variable — a newline- or comma-separated list
//   - the LOCAL_FILE below it — one pattern per line, '#'-comment and blank lines ignored,
//     git-ignored by convention (see .gitignore) so it can never itself become the leak
//
// Neither configured is the expected state for almost every clone of this repo (nobody but Denis
// has values to hide), so that state is a clean pass with a notice on stderr, never a finding —
// this must not fail CI for someone who has nothing to hide (this is a *sensitive* default, unlike
// every other rule here, which fails closed).
//
// Matching is a plain, case-insensitive literal substring — never a regex the caller supplies,
// which would let a malformed pattern turn this into an arbitrary-computation or ReDoS surface for
// no benefit: a hostname or a company name needs no regex metacharacters to match.
//
// Scope is the working tree as git currently tracks it (`git ls-files` — the same enumeration
// PC-06 uses, for the same reason: untracked content cannot reach GitHub, so it is not this
// rule's problem). History is a second, OPT-IN pass behind PI_LEAK_CHECK_HISTORY: a pattern that
// was ever added or removed anywhere in history is found with `git log --all -S<pattern>`
// (pickaxe — plain-string, not regex, matching the working-tree semantics above), because a later
// deletion or a .gitignore line does not remove a value from history — see PC-12's identical
// reasoning for PRIVATE.md and OPERATOR.local.md. Every git invocation here is read-only: no
// `add`, no `commit`, nothing that mutates the repository this check is asked to inspect.
//
// A finding never repeats the matched text, the pattern, or even a slice of either — only the
// file, and where relevant the line, that a human should go look at. Printing 8 characters of a
// real internal hostname into a CI log is a smaller version of the exact leak this rule exists to
// stop.

/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

export const id = "PC-23";
export const title = "No pattern from $PI_LEAK_CHECK_PATTERNS / config/leak-patterns.local.txt appears in a git-tracked file";

const PATTERNS_ENV = "PI_LEAK_CHECK_PATTERNS";
const HISTORY_ENV = "PI_LEAK_CHECK_HISTORY";
const LOCAL_FILE = "config/leak-patterns.local.txt";

// Same bound and same reasoning as PC-06: a sub-second offline gate cannot afford to read and
// scan an arbitrarily large tracked file, and every legitimate text file in this repo is
// comfortably under it.
const MAX_SCAN_BYTES = 256 * 1024;
const SNIFF_BYTES = 8000;

/** @param {string} raw @returns {string[]} */
function splitPatterns(raw) {
  return raw
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));
}

/** @param {RuleContext} ctx @returns {string[]} deduplicated, order-preserving */
function loadPatterns(ctx) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  const fromEnv = process.env[PATTERNS_ENV];
  if (fromEnv) for (const p of splitPatterns(fromEnv)) add(p);
  const fromFile = ctx.readText(LOCAL_FILE);
  if (fromFile) for (const p of splitPatterns(fromFile)) add(p);
  return out;
}

/** @param {unknown} err @returns {boolean} */
function isGitUnavailable(err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true;
  const stderr = err && typeof err === "object" && "stderr" in err ? err.stderr : undefined;
  return typeof stderr === "string" && stderr.includes("not a git repository");
}

/**
 * The set of paths git currently tracks under `repoRoot` — this rule's whole working-tree scan
 * surface, for the same reason PC-06 uses it: what git does not track cannot reach a public
 * remote.
 * @param {string} repoRoot
 * @returns {{ files: string[] } | { error: string }}
 */
function gitTrackedFiles(repoRoot) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8" });
    return { files: out.split("\0").filter((f) => f.length > 0) };
  } catch (err) {
    if (isGitUnavailable(err)) {
      const cause = err && typeof err === "object" && "code" in err && err.code === "ENOENT" ? "git is not installed" : "not a git repository";
      return {
        error: `cannot enumerate git-tracked files under "${repoRoot}" (${cause}) — with patterns configured, this rule cannot claim a clean pass without a way to enumerate what would actually be published`,
      };
    }
    throw err;
  }
}

/** True if the first SNIFF_BYTES of `absPath` contain a NUL byte — the same binary sniff PC-06 uses. @param {string} absPath @returns {boolean} */
function looksBinary(absPath) {
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Commits in which `pattern` (a plain string, never a regex) was added or removed anywhere in
 * history — read-only `git log --all -S`, the same pickaxe PC-12 documents for the identical
 * "a later deletion does not erase history" reasoning.
 * @param {string} repoRoot @param {string} pattern @returns {string[]}
 */
function gitPickaxeCommits(repoRoot, pattern) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "--all", `-S${pattern}`, "--pretty=format:%H"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.length > 0);
  } catch (err) {
    if (isGitUnavailable(err)) return [];
    throw err;
  }
}

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const patterns = loadPatterns(ctx);
  if (patterns.length === 0) {
    process.stderr.write(
      `pi-check: ${id} — no leak-check patterns configured (set $${PATTERNS_ENV} and/or create ${LOCAL_FILE}, git-ignored) — nothing to check, passing\n`,
    );
    return [];
  }

  /** @type {Finding[]} */
  const findings = [];

  const enumerated = gitTrackedFiles(ctx.repoRoot);
  if ("error" in enumerated) {
    findings.push({ rule: id, file: ".", message: enumerated.error });
    return findings; // no enumeration, no history lookup either — both need the same git
  }

  const lowerPatterns = patterns.map((p) => p.toLowerCase());

  for (const file of enumerated.files) {
    const absPath = join(ctx.repoRoot, file);
    let size;
    try {
      size = statSync(absPath).size;
    } catch {
      continue; // tracked in the index but not on disk right now — nothing to scan
    }
    if (size === 0 || size > MAX_SCAN_BYTES) continue;
    if (looksBinary(absPath)) continue;

    for (const { line, text } of ctx.lines(file)) {
      const lower = text.toLowerCase();
      if (lowerPatterns.some((p) => lower.includes(p))) {
        findings.push({
          rule: id,
          file,
          line,
          message:
            "a configured forbidden pattern appears in this git-tracked line — a private-to-public port likely carried across an internal identifier; remove it before this reaches the public remote (the matched text is deliberately not repeated here)",
        });
      }
    }
  }

  if (process.env[HISTORY_ENV] === "1") {
    for (const pattern of patterns) {
      const commits = gitPickaxeCommits(ctx.repoRoot, pattern);
      if (commits.length > 0) {
        findings.push({
          rule: id,
          file: "(git history, git log --all -S)",
          message: `a configured forbidden pattern was added or removed at least once in git history (${commits.length} commit(s), e.g. ${commits[0]}) — deleting it from the working tree does not remove it from history; it must be purged (the matched text is deliberately not repeated here)`,
        });
      }
    }
  }

  return findings;
}

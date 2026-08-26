// bin/rules/pc-25-no-do-not-publish-names.mjs — the do-not-publish name gate.
//
// Some skills are tracked in the private harness this repository is ported from and must never
// appear here: third-party trees with no licence, tenant-specific workflows, personal finance and
// tax material. The private side proves "never tracked there". This rule is the other half:
// "never arrived here".
//
// THE RULE CANNOT SHIP THE LIST. A gate whose source file enumerates the names it forbids has
// published them, and the gate becomes the leak — the same reasoning PC-23 documents for internal
// hostnames, one step further, because here even a git-ignored local file is not enough: the check
// has to keep working in a fresh clone, in CI, for a contributor who has no local configuration.
//
// So the names are stored as salted SHA-256 digests, one per line, in DIGESTS_FILE:
//
//     <token-count> <sha256-hex>
//
// The digest is over `SALT + "\n" + tokens.join("-")`, where the tokens come from lower-casing the
// name and splitting it on every run of non-alphanumeric characters. `<token-count>` is how many
// tokens the name has; it is the one thing that must be public, because the scanner needs to know
// which n-gram window sizes to slide.
//
// SALT is a constant in this file and is NOT a secret — it cannot be, since the check runs
// anywhere. It exists to make a rainbow table of common English words useless against this file;
// anyone who can guess a name can still confirm the guess. That is an honest, limited property and
// it is the right one: the goal is that reading this repository does not TELL you the names, not
// that a determined guesser can never confirm one.
//
// Two scans, deliberately asymmetric:
//
//   - PATH scan, every name. Over `git ls-files` and, because deleting a file does not remove it
//     from history, over `git log --all --diff-filter=A --name-only` as well. Each `/`-separated
//     segment is tokenised (the final segment with its extension dropped) and every window of
//     every recorded token count is hashed. So a name embedded in a longer directory or file name
//     is still found.
//
//   - CONTENT scan, MULTI-TOKEN names only. A single-token name is a word — one of these really is
//     the English word for a piece of writing — and it appears in ordinary prose in this repository
//     already. Scanning content for it would produce a permanent false positive that someone would
//     eventually silence, taking the useful half of the rule with it. Multi-token names are
//     distinctive enough that a content hit is a real hit. This asymmetry is a deliberate,
//     documented gap: a single-token name pasted into prose is not caught here.
//
// Fails CLOSED. A missing, empty or malformed digest file is a finding, not a silent pass — an
// empty guard that reports success is worse than no guard, because it is believed.
//
// A finding never repeats the matched text and never names which digest matched. It gives the file
// and, for content, the line. That is enough to go and look, and it keeps CI logs clean of the
// thing the rule exists to keep out.

/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

export const id = "PC-25";
export const title = "No do-not-publish name appears in a tracked path, in git history, or in file contents";

const DIGESTS_FILE = "config/do-not-publish.digests.txt";
const DIGESTS_FILE_ENV = "PI_DO_NOT_PUBLISH_DIGESTS_FILE";

/** Not a secret — see the header. It defeats a generic wordlist, nothing more. */
const SALT = "pion-do-not-publish-v1";

/** Same bound and reasoning as PC-06 and PC-23. */
const MAX_SCAN_BYTES = 256 * 1024;
const SNIFF_BYTES = 8000;

/** @param {string} phrase @returns {string} */
function digestOf(phrase) {
  return createHash("sha256").update(`${SALT}\n${phrase}`).digest("hex");
}

/** Lower-cases and splits on every run of non-alphanumeric characters. @param {string} s @returns {string[]} */
function tokenise(s) {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * @param {string} raw
 * @returns {{ byCount: Map<number, Set<string>>, counts: number[] } | { error: string }}
 */
function parseDigests(raw) {
  /** @type {Map<number, Set<string>>} */
  const byCount = new Map();
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo++;
    const text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    const m = /^([1-9][0-9]?) ([0-9a-f]{64})$/.exec(text);
    if (!m) {
      return { error: `${DIGESTS_FILE}:${lineNo} is not "<token-count> <sha256-hex>" — the gate cannot run against a file it cannot parse` };
    }
    const count = Number(m[1]);
    if (!byCount.has(count)) byCount.set(count, new Set());
    byCount.get(count).add(m[2]);
  }
  if (byCount.size === 0) return { error: `${DIGESTS_FILE} contains no digests — an empty do-not-publish gate reports success without checking anything` };
  return { byCount, counts: [...byCount.keys()].sort((a, b) => a - b) };
}

/**
 * True if any window of `tokens`, at any recorded size, hashes to a recorded digest.
 * @param {string[]} tokens
 * @param {Map<number, Set<string>>} byCount
 * @param {number[]} counts
 * @param {(count: number) => boolean} [accept] which token counts to consider
 * @returns {boolean}
 */
function matches(tokens, byCount, counts, accept) {
  for (const n of counts) {
    if (accept && !accept(n)) continue;
    if (tokens.length < n) continue;
    const set = byCount.get(n);
    for (let i = 0; i + n <= tokens.length; i++) {
      if (set.has(digestOf(tokens.slice(i, i + n).join("-")))) return true;
    }
  }
  return false;
}

/**
 * The tokens of each `/`-separated segment of `path`, one token list per segment, with the final
 * segment's extension dropped. Kept per-segment on purpose: a name must not be matched across a
 * `/` boundary, or `a/b` would match a name spelled `a-b`, which is a different thing entirely.
 * @param {string} path
 * @returns {string[][]}
 */
function pathSegmentTokens(path) {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return [];
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf(".");
  parts[parts.length - 1] = dot > 0 ? last.slice(0, dot) : last;
  return parts.map(tokenise);
}

/** @param {string} path @param {Map<number, Set<string>>} byCount @param {number[]} counts @returns {boolean} */
function pathMatches(path, byCount, counts) {
  return pathSegmentTokens(path).some((tokens) => matches(tokens, byCount, counts));
}

/** @param {unknown} err @returns {boolean} */
function isGitUnavailable(err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true;
  const stderr = err && typeof err === "object" && "stderr" in err ? err.stderr : undefined;
  return typeof stderr === "string" && stderr.includes("not a git repository");
}

/** @param {string} repoRoot @param {string[]} args @returns {string[] | null} */
function gitLines(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split(/\0|\n/)
      .filter((l) => l.length > 0);
  } catch (err) {
    if (isGitUnavailable(err)) return null;
    throw err;
  }
}

/** @param {string} absPath @returns {boolean} */
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

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const digestsPath = process.env[DIGESTS_FILE_ENV] ?? DIGESTS_FILE;
  const raw = ctx.readText(digestsPath);
  if (raw === null) {
    return [
      {
        rule: id,
        file: digestsPath,
        message: `the do-not-publish digest file is missing — this gate fails closed rather than passing an unchecked tree; restore it or regenerate it with scripts/gen-do-not-publish-digests.mjs`,
      },
    ];
  }
  const parsed = parseDigests(raw);
  if ("error" in parsed) return [{ rule: id, file: digestsPath, message: parsed.error }];
  const { byCount, counts } = parsed;
  const multiToken = (n) => n > 1;

  /** @type {Finding[]} */
  const findings = [];

  const tracked = gitLines(ctx.repoRoot, ["ls-files", "-z"]);
  if (tracked === null) {
    return [
      {
        rule: id,
        file: ".",
        message: `cannot enumerate git-tracked files under "${ctx.repoRoot}" (git is unavailable, or this is not a git repository) — this gate cannot claim a clean pass without a way to enumerate what would actually be published`,
      },
    ];
  }

  for (const file of tracked) {
    if (pathMatches(file, byCount, counts)) {
      findings.push({
        rule: id,
        file,
        message:
          "a do-not-publish name appears in this tracked path — it must not reach the public remote; remove the file and check whether anything references it (the matched name is deliberately not repeated here)",
      });
    }
  }

  const added = gitLines(ctx.repoRoot, ["log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:"]) ?? [];
  const flaggedHistory = new Set();
  for (const file of added) {
    if (flaggedHistory.has(file)) continue;
    if (pathMatches(file, byCount, counts)) {
      flaggedHistory.add(file);
      findings.push({
        rule: id,
        file: "(git history, git log --all --diff-filter=A)",
        message:
          "a path carrying a do-not-publish name was added at least once in git history — deleting it from the working tree does not remove it; the history must be purged (the path and the matched name are deliberately not repeated here)",
      });
    }
  }

  for (const file of tracked) {
    const absPath = join(ctx.repoRoot, file);
    let size;
    try {
      size = statSync(absPath).size;
    } catch {
      continue; // in the index but not on disk right now — nothing to scan
    }
    if (size === 0 || size > MAX_SCAN_BYTES) continue;
    if (file === digestsPath) continue; // the digest file legitimately holds digests, not names
    if (looksBinary(absPath)) continue;

    for (const { line, text } of ctx.lines(file)) {
      if (matches(tokenise(text), byCount, counts, multiToken)) {
        findings.push({
          rule: id,
          file,
          line,
          message:
            "a do-not-publish name appears in this line — remove it before this reaches the public remote (the matched name is deliberately not repeated here)",
        });
      }
    }
  }

  return findings;
}

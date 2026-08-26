// bin/rules/pc-06-no-committed-secrets.mjs — REQ-PRV-12a / REQ-PRV-13, widened (F7, security
// review residual).
//
// The original version of this rule only scanned two hardcoded paths (config/models.json,
// config/shell/pi-env.sh — the two files config/README.md rule 1 names as ever legitimately
// holding a credential *reference*). Everything else in the repo — skills/,
// extensions/, scripts/, docs/, test/, ... — was structurally invisible to it: a
// secret pasted anywhere outside those two files passed `pi-check --all` with zero findings.
//
// This version enumerates from `git ls-files` instead of a hand-maintained allowlist: anything
// git does not track cannot reach GitHub, and anything git DOES track can, so "what git tracks"
// is the correct, self-maintaining scan surface — a new skill/doc/extension file is covered the
// moment it is added, with no rule update required. The narrowing is now a documented, per-file
// EXCLUSION list (binary, integrity-hash, oversized) plus one documented per-MATCH heuristic
// (below), not an undocumented per-file inclusion list.

/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { SECRET_LITERAL } from "../lib/patterns.mjs";

export const id = "PC-06";
export const title = "No literal-secret-shaped value anywhere git tracks (REQ-PRV-12a, REQ-PRV-13)";
export const closes = ["REQ-PRV-12a", "REQ-PRV-13"];

// Lock/manifest files whose entire reason to exist is pinning integrity data — sha256/sha1 hex
// digests, and npm-style SRI "integrity" strings (sha512-<base64>, which mixes digits with
// non-hex letters, so the per-match heuristic below cannot safely reject it on its own — see
// pi-packages/vendor.lock.json's "integrity" field). Matched by BASENAME, not full path: the
// same file name recurs at more than one depth in this repo (e.g.
// test/fixtures/pi-check/clean/config/packages.lock.json is a copy of the real one for rule
// testing), and the property that makes a lock file safe to skip is its well-known name/purpose,
// not which directory it happens to sit in.
//   - packages.lock.json / package-lock.json: named explicitly in the task this rule closes.
//   - pi-release.lock: pins per-platform release-binary sha256 hashes (REQ-PRV-47).
//   - vendor.lock.json: per-vendored-package sha256 + npm "integrity" (sha512-base64) strings.
// Found empirically by running this widened rule against the live repo.
const INTEGRITY_LOCK_BASENAMES = new Set(["packages.lock.json", "package-lock.json", "pi-release.lock", "vendor.lock.json"]);

// Files whose whole purpose is exercising literal, synthetically-shaped credential values so
// OTHER code's redaction/caching logic can be tested without a real credential ever existing.
// Named individually rather than excluding all of test/: everywhere else in test/ (assertions,
// helpers, non-credential fixtures) stays in scope, so a real secret pasted into an unrelated
// test is still caught. See each file's own header comment for its "no real credential" claim.
const CREDENTIAL_FIXTURE_FILES = new Set([
  "test/ext-13-dbx-token-cached.test.ts", // synthetic dapi-shaped STUB_TOKEN values for the TTL-cache script's own tests
]);

// Above this many bytes we skip a file rather than read + regex it. The largest hand-authored
// text file this bound was measured against is ~201 KiB; the largest generated text artifact
// (pi-packages/pi-mcp-adapter/app-bridge.bundle.js, a bundled third-party dependency whose
// unminified source is the .ts files sitting right next to it, and IS scanned) is ~289 KiB.
// 256 KiB sits between them: every legitimate config/doc/skill file is comfortably under it,
// and skipping a file this large means "not scanned by PC-06" — it is a bound on the checker's
// own runtime (pi-check must stay a sub-second gate, and install.sh runs it), not a judgement
// that big files are safe.
const MAX_SCAN_BYTES = 256 * 1024;

// How many leading bytes we read to decide binary vs. text — the same heuristic git, grep -I
// and diff use: a NUL byte this early in the file does not occur in any text encoding this
// repo uses (UTF-8 has none), so its presence is a reliable, content-based binary signal —
// unlike trusting a file's extension, which a renamed or extensionless binary would evade.
const SNIFF_BYTES = 8000;


// The four prefixes SECRET_LITERAL's alternation recognizes explicitly. Used only to decide
// which of the two content checks below applies — see looksLikeAuthoredTextNotASecret.
const KNOWN_PREFIX = /^(sk-|gh[po]_|dapi)/;

/**
 * A SECRET_LITERAL match is worth reporting only if it plausibly reads as GENERATED randomness.
 * Verified empirically: running this rule, once widened to the whole repo, against the live
 * tree produced ~400 findings, and every single one outside a real secret's shape fell into one
 * of two buckets, both handled here:
 *
 *  1. Human-authored, delimiter-joined text — markdown TOC anchors ("#pattern-6-log-traces-..."),
 *     GOTCHAS.md-style anchors ("-wrong-mlflow-version-for-trace-ingestion"), SNAKE_CASE/ALL_CAPS
 *     error constants ("DELTA_CLUSTERING_COLUMNS_DATATYPE_NOT_SUPPORTED"), and comment divider
 *     lines ("----...----"). All of these are built from short dash/underscore-joined WORDS; a
 *     real secret's tail essentially never contains more than its own prefix's single separator
 *     (verified against every credential-shaped fixture in this repo's own tests). Two or more
 *     `-`/`_` characters is the signature of a hand-written identifier or slug, not randomness —
 *     this check applies to every branch, prefixed or not.
 *
 *  2. Bare (unprefixed) 40+-char runs that are either PURE lowercase/uppercase hex — a SHA-1
 *     (40 hex chars) or SHA-256 (64 hex chars) digest or a git commit id, never this rule's four
 *     target credential shapes — or contain NO digit at all, i.e. a camelCase/PascalCase source
 *     identifier ("serverStreamResultPatchNotificationSchema": English words concatenated, not
 *     random bytes). These two checks are scoped to the UNPREFIXED branch only: a real
 *     sk-/gho_/ghp_/dapi-prefixed token keeps its format-context (e.g. a real Databricks PAT IS
 *     hex-shaped, and a real key is not guaranteed to contain a digit), so blinding those
 *     branches to hex or digit-free tails would be a bigger regression than the noise it removes.
 *
 * @param {string} match @returns {boolean}
 */
function looksLikeAuthoredTextNotASecret(match) {
  const delimiters = (match.match(/[-_]/g) ?? []).length;
  if (delimiters >= 2) return true;
  if (KNOWN_PREFIX.test(match)) return false;
  if (/^[0-9a-fA-F]+$/.test(match)) return true;
  if (!/\d/.test(match)) return true;
  return false;
}

/** @param {unknown} err @returns {boolean} */
function isGitUnavailable(err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true;
  const stderr = err && typeof err === "object" && "stderr" in err ? err.stderr : undefined;
  return typeof stderr === "string" && stderr.includes("not a git repository");
}

/**
 * The set of paths git currently tracks under `repoRoot`, relative to `repoRoot`. This is the
 * only enumeration method: unlike PC-12 (which still has a real, if weaker, .gitignore-based
 * signal when git is unavailable), PC-06 has no scan surface at all without it — "silently scan
 * nothing" here is indistinguishable from "clean", which is exactly the gap this rule closes.
 * So git being unavailable becomes a Finding (an unknown, not a pass) rather than being
 * swallowed, and any OTHER git failure is left to throw, per this checker's documented
 * contract that a crash is a bug in the checker, not a finding about the repo.
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
        error: `cannot enumerate git-tracked files under "${repoRoot}" (${cause}) — PC-06's whole scan surface is "git ls-files"; without it this is an unknown, not a clean pass`,
      };
    }
    throw err;
  }
}

/** True if the first SNIFF_BYTES of `absPath` contain a NUL byte. @param {string} absPath @returns {boolean} */
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
  const enumerated = gitTrackedFiles(ctx.repoRoot);
  if ("error" in enumerated) {
    return [{ rule: id, file: ".", message: enumerated.error }];
  }

  /** @type {Finding[]} */
  const findings = [];
  for (const file of enumerated.files) {
    if (INTEGRITY_LOCK_BASENAMES.has(basename(file))) continue;
    if (CREDENTIAL_FIXTURE_FILES.has(file)) continue;

    const absPath = join(ctx.repoRoot, file);
    let size;
    try {
      size = statSync(absPath).size;
    } catch {
      continue; // git lists it (e.g. mid-rename in the index) but it is not on disk to read — nothing to scan
    }
    if (size === 0 || size > MAX_SCAN_BYTES) continue;
    if (looksBinary(absPath)) continue;

    const isShell = file.endsWith(".sh");
    for (const { line, text } of ctx.lines(file)) {
      if (isShell && /^\s*#/.test(text)) continue; // comments document the *shape*, e.g. "sk-..."
      SECRET_LITERAL.lastIndex = 0;
      for (const m of text.matchAll(SECRET_LITERAL)) {
        if (looksLikeAuthoredTextNotASecret(m[0])) continue;
        findings.push({
          rule: id,
          file,
          line,
          message: `value shaped like a literal secret ("${m[0].slice(0, 8)}…") — this rule never resolves it, only its shape is checked; use a $ENV_VAR or !command reference instead`,
        });
      }
    }
  }
  return findings;
}

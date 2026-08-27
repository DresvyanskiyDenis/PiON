/**
 * The repo-wide sibling of `agents.test.ts`'s publication gate (test/content/agents.test.ts:171-208).
 * That gate only ever sees `agents/` — `for (const file of mdFiles(sharedDir))` — so a leak pasted
 * into `docs/`, `extensions/`, `scripts/`, a fixture, or anywhere else outside `agents/` was
 * structurally invisible to it. This file runs the same *kind* of check — shape-based, never a
 * literal secret, narrow enough to survive contact with a real tree — over every path
 * `git ls-files` returns, which is the actual publication boundary: untracked and `.gitignore`d
 * files are never pushed, so scanning the filesystem instead of the index would both under- and
 * over-report.
 *
 * Every pattern below was arrived at empirically: run wide, read every hit, either narrow the
 * shape until the false positive stops matching, or — only when the false positive is
 * shape-identical to what we're hunting (a deliberate canary) — name the one file it lives in and
 * skip that file for that check, the same trade `bin/rules/pc-06-no-committed-secrets.mjs` already
 * makes for the same file. A pattern that needed a growing allowlist to stay clean was dropped
 * instead; see the file's closing comment for the casualties (`mcp__`, private IPs, `soul`,
 * generic hostnames, email addresses) — those are `agents.test.ts`'s job over agent prose, not
 * this file's job over arbitrary shipped text, and widening them here reproduced exactly the
 * false positives the task brief predicted.
 *
 * `PI_PUBLICATION_DENY` is supported the same way `agents.test.ts` supports it: a `|`-joined
 * regex source read from the environment, appended as one more shape, with an invalid source left
 * to throw at collection time rather than being caught and swallowed — a fork's own literals never
 * silently fail to gate.
 */
import "../lib/repo-config.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { REPO } from "../lib/repo-config.ts";

/** One line of one git-tracked file, 1-based to match every editor and `git blame`. */
interface TrackedLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** What one pattern hit looks like once we're ready to fail loudly about it. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly shape: string;
  readonly matched: string;
}

// --- enumeration ------------------------------------------------------------------------------

/**
 * `git ls-files`, not a filesystem walk. A walk would scan `node_modules/`, `.env`, and anything
 * else `.gitignore` keeps local — none of which is published — and would miss nothing tracked but
 * deleted-on-disk. `-z` because a handful of skill/doc filenames in this repo contain spaces.
 */
function gitTrackedFiles(): string[] {
  const out = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter((f) => f.length > 0);
}

/**
 * True if the first 8000 bytes contain a NUL — the same content-based binary sniff `git`, `grep -I`
 * and PC-06 use. Cheaper and more reliable than trusting an extension: a renamed or extensionless
 * binary is still caught, and no text encoding this repo uses (UTF-8) ever emits a NUL this early.
 */
function looksBinary(absPath: string): boolean {
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(8000);
    const bytesRead = readSync(fd, buf, 0, 8000, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Fast pre-filter for the obvious binary asset extensions — `looksBinary` still runs after, so a
 * mislabeled file is never trusted on extension alone; this only skips the syscalls for the common
 * case (mirrors PC-06's `ASSET_EXTENSIONS`). */
const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|ico|webp|bmp|pptx|pdf|woff2?|ttf|otf|eot)$/i;

/**
 * `package-lock.json` alone: it is huge (256 KiB at last measure), entirely machine-generated
 * `integrity`/hash fields, and reading + regexing it on every `npm test` buys nothing — nothing a
 * human typed is in it. The OTHER `*.lock.json` files in this repo (`config/packages.lock.json`,
 * `config/api-surface.lock.json`, `pi-packages/vendor.lock.json`, `vendor-files.lock.json`) are
 * deliberately left in scope: unlike PC-06 (which does generic 40+-char base64/hex entropy
 * matching and would otherwise trip on every hash in them), none of the shape-based patterns below
 * do bare-entropy matching, so those files scan clean today and stay a real check going forward.
 */
const SKIP_BASENAMES = new Set(["package-lock.json"]);

/**
 * `pi-packages/` is scanned like everywhere else, not excluded. It is a vendored upstream tree
 * with legitimate third-party author names, emails and URLs in its own `LICENSE`/`README.md`/
 * `CHANGELOG.md` — but none of that prose is home-path-, credential-, tenant-host-, or
 * `.env`-assignment-shaped, so it costs nothing to include and a real secret pasted into it during
 * vendoring (this repo does hand-copy files in, per `pi-packages/README.md`) would otherwise have
 * a free pass. Verified empirically: including it changes the finding count by zero.
 *
 * This set is deliberately EMPTY, and keeping it that way is the standard to hold a new pattern to.
 * It exists at all because the obvious candidate for an exclusion is
 * `test/ext-13-dbx-token-cached.test.ts`, whose stub tokens are the closest thing in this tree to a
 * real credential — and `bin/rules/pc-06-no-committed-secrets.mjs` does exclude it, legitimately,
 * because PC-06 matches `dapi` plus any 8+ alphanumeric run and every stub in that file trips it.
 *
 * The fix here was not to copy that exclusion but to remove the need for one: those fixtures no
 * longer use the `dapi` + 32-lowercase-hex shape of a genuine Databricks PAT (GitHub's own push
 * protection rejected the first push of this repository over exactly that string, which is the
 * strongest possible argument that a public repo should not carry it). Nothing is lost — the script
 * under test never validates the token's shape, only redacts it — and three scanners stop needing to
 * be told to look away.
 *
 * So: if a pattern you add here needs a file named in this set, prefer changing the file.
 */
const CREDENTIAL_FIXTURE_FILES = new Set<string>([]);

/** Every tracked, non-binary, non-skipped file, split into lines. Read once at module load — the
 * suite runs once per process, and ~520 small files cost nothing to hold in memory. */
function collectTrackedLines(): TrackedLine[] {
  const lines: TrackedLine[] = [];
  for (const file of gitTrackedFiles()) {
    if (SKIP_BASENAMES.has(basename(file))) continue;
    const absPath = `${REPO}/${file}`;
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch {
      continue; // git lists it (e.g. mid-rename in the index) but it is not on disk to read
    }
    if (size === 0) continue;
    if (ASSET_EXTENSIONS.test(file) || looksBinary(absPath)) continue;
    const text = readFileSync(absPath, "utf8");
    text.split("\n").forEach((t, i) => lines.push({ file, line: i + 1, text: t }));
  }
  return lines;
}

const REPO_LINES = collectTrackedLines();

/** A fork's own literals, opt-in through the environment — same knob, same contract, as
 * `agents.test.ts`: an invalid regex source throws here (at collection time) rather than being
 * caught and silently disabling the check. */
const PI_PUBLICATION_DENY = process.env.PI_PUBLICATION_DENY?.trim();
const DENY_PATTERN = PI_PUBLICATION_DENY ? new RegExp(PI_PUBLICATION_DENY, "i") : undefined;

function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => `${f.file}:${f.line}: ${f.shape} — matched ${JSON.stringify(f.matched.slice(0, 40))}`)
    .join("\n");
}

// A captured value is a placeholder, a reference, or nothing — never a leak:
//   - empty, or a single character: this repo's own placeholder convention for a synthetic
//     fixture value (test/guard/gates.test.ts's `"TOKEN=x"`) — no real credential is one char.
//   - starts with `$`: a `$VAR`, `${VAR}`, or `$(command substitution)` reference, never
//     resolved by this check (config/bin/dbx-token-cached, scripts/install.sh,
//     scripts/uninstall.sh all assign this way).
//   - starts with `{{`: an unrendered template token.
//   - ends with `...`: this repo's own doc convention for "a real value goes here"
//     (`sk-ant-...`, `gho_...`, `dapi...` across config/providers/*.json, config/shell/pi-env.sh).
//   - purely digits: a count/flag/port (`DEL_SECRETS` set to `0` or `1` in scripts/uninstall.sh),
//     never a credential shape. Spelled out rather than shown as an assignment for the same
//     reason as the `.ghe.com` note in the enterprise-host check below — this file is tracked and
//     scans itself.
//   - trailing backticks: markdown inline code, not part of the value. A doc that writes a
//     placeholder as `KEY=gho_...` reaches this predicate with the closing backtick attached,
//     because the unquoted alternative in the pattern stops only at whitespace, `;`, `#` or a
//     quote — so `endsWith("...")` stops matching and a correct sentence becomes a finding. The
//     backtick is stripped below rather than added as a sixth rule: it is markup around the
//     value, and every rule here should get to see the same string a reader sees.
const isSafeValue = (raw: string): boolean => {
  const v = raw.trim().replace(/`+$/, "");
  if (v.length <= 1) return true;
  if (v.startsWith("$")) return true;
  if (v.startsWith("{{")) return true;
  if (v.endsWith("...")) return true;
  if (/^[0-9]+$/.test(v)) return true;
  return false;
};

describe("publication gate — every git-tracked file, not just agents/", () => {
  it("no real home-directory path — only this repo's own documented placeholder names ship", () => {
    // Names this repo actually uses as a home-directory placeholder, read off the tree itself
    // (test/doctor/*.test.ts, test/path-defaults/*.test.ts, test/lib/escape-hatch.test.ts): "x"
    // and "d" as single-letter stand-ins, "user" as the path-defaults fixture HOME, "you" is the
    // fourth name the task brief itself names as a documented doc placeholder (not currently used,
    // kept so a future doc reaching for it doesn't need this list edited). Anything else after
    // `/Users/` or `/home/` is either nobody's real home (impossible to author by accident) or is —
    // which is exactly the leak this check exists to catch.
    const PLACEHOLDER_NAMES = new Set(["x", "d", "user", "you"]);
    // The name must start with a letter: `/fake/home/.cache/...` (test/mcp/stdio-env.test.ts) is a
    // dotfile under a fake HOME, not a username, and `[a-zA-Z]` as the first character excludes it
    // without needing to name that file.
    const HOME_PATH = /\/(?:Users|home)\/([a-zA-Z][a-zA-Z0-9_-]*)/g;
    const findings: Finding[] = [];
    for (const { file, line, text } of REPO_LINES) {
      HOME_PATH.lastIndex = 0;
      for (const m of text.matchAll(HOME_PATH)) {
        if (PLACEHOLDER_NAMES.has(m[1].toLowerCase())) continue;
        findings.push({ file, line, shape: "a real home-directory path", matched: m[0] });
      }
    }
    assert.deepEqual(findings, [], `home-directory path(s) found:\n${formatFindings(findings)}`);
  });

  it("no live-credential-shaped string (sk-/gh*_/dapi/AKIA/xox/PEM/JWT)", () => {
    // Delimiter-count heuristic straight from PC-06's own `looksLikeAuthoredTextNotASecret`: a
    // hand-written hyphenated slug ("sk-should-not-appear-anywhere-in-the-output", the fixture
    // string in test/ext-28-install.suite.mjs) accumulates far more than the one separator a real
    // token's random tail would ever contain. Only applies to the two prefixes whose tail alphabet
    // includes `-`/`_` (sk-, xox-) — gh*_ and dapi's tails are alnum/hex-only, so a hyphen can
    // never appear in a genuine match there and the heuristic has nothing to filter.
    // Delimiter count ALONE is not enough, and getting that wrong is worse than having no check:
    // a genuine Anthropic key is `sk-ant-api03-<random>`, which carries three hyphens and would be
    // waved through as "authored" by a bare delimiter count. What actually separates the two is
    // segment length — a hand-written slug is short words end to end, while every real token has at
    // least one long unbroken random run. So both conditions must hold: many delimiters AND no
    // segment longer than 12 characters.
    const LONGEST_AUTHORED_WORD = 12;
    const authoredNotSecret = (s: string): boolean => {
      if ((s.match(/[-_]/g)?.length ?? 0) < 2) return false;
      return s.split(/[-_]/).every((segment) => segment.length <= LONGEST_AUTHORED_WORD);
    };
    const SHAPES: Array<[RegExp, string, boolean]> = [
      // 20+ char tail: long enough that `sk-ant-...`/`sk-...` (the literal-ellipsis placeholders
      // in config/providers/*.json and config/shell/pi-env.sh) never reach threshold.
      [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "an OpenAI/Anthropic-shaped sk- API key", true],
      // ghp_/gho_/ghu_/ghs_/ghr_ — GitHub's own five token-type prefixes. 30+ char tail: every
      // ghp_/gho_ fixture in test/quota/*.test.ts (ghp_test, ghp_x, ghp_abc123, gho_should, ...)
      // is well under this.
      [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "a GitHub PAT/OAuth-token-shaped string", false],
      // A real Databricks PAT is dapi + 32 lowercase hex chars. No file in this tree carries that
      // shape any more — the stub tokens in test/ext-13-dbx-token-cached.test.ts were rewritten to
      // mixed-case precisely so this pattern could stay strict with no exclusion (see
      // CREDENTIAL_FIXTURE_FILES above).
      [/\bdapi[a-f0-9]{32,}\b/gi, "a Databricks PAT-shaped token (dapi + 32 hex)", false],
      [/\bAKIA[A-Z0-9]{16}\b/g, "an AWS access-key-id-shaped string", false],
      [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "a Slack token-shaped string", true],
      [/-----BEGIN(?:\s+[A-Z0-9]+)*\s+PRIVATE KEY-----/g, "a PEM private-key block", false],
      // header.payload.signature, each segment long enough that the canary JWT in
      // test/ext-13-dbx-token-cached.test.ts (whose signature segment is the literal 3-char
      // stub "abc") never reaches the signature-segment threshold — no file exclusion needed for
      // this shape, the length floor alone keeps it clean.
      [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g, "a JWT-shaped three-part token", false],
    ];
    const findings: Finding[] = [];
    for (const { file, line, text } of REPO_LINES) {
      if (CREDENTIAL_FIXTURE_FILES.has(file)) continue;
      for (const [pattern, shape, checkAuthored] of SHAPES) {
        pattern.lastIndex = 0;
        for (const m of text.matchAll(pattern)) {
          if (checkAuthored && authoredNotSecret(m[0])) continue;
          findings.push({ file, line, shape, matched: m[0] });
        }
      }
    }
    assert.deepEqual(findings, [], `credential-shaped string(s) found:\n${formatFindings(findings)}`);
  });

  it("no tenant/workspace id inside a hostname", () => {
    // The exact shape agents.test.ts already carries, confirmed clean repo-wide (not just
    // agents/): a URL whose host segment embeds an 8+ digit run, the pattern a SaaS tenant
    // subdomain or workspace id takes.
    const TENANT_HOST = /\bhttps?:\/\/[a-z0-9-]*\d{8,}[a-z0-9-]*\./gi;
    const findings: Finding[] = [];
    for (const { file, line, text } of REPO_LINES) {
      TENANT_HOST.lastIndex = 0;
      for (const m of text.matchAll(TENANT_HOST)) {
        findings.push({ file, line, shape: "a tenant/workspace id inside a hostname", matched: m[0] });
      }
    }
    assert.deepEqual(findings, [], `tenant/workspace-id hostname(s) found:\n${formatFindings(findings)}`);
  });

  it("no literal enterprise GitHub host — only <tenant>.ghe.com / {{tenant}}.ghe.com placeholders ship", () => {
    // Every `*.ghe.com` mention in this repo (config/providers/github-copilot.json,
    // extensions/quota/copilot.ts, scripts/verify-environment.sh, wiki/Provider-Cheat-Sheet.md) is
    // `<tenant>.ghe.com` or `{{tenant}}.ghe.com`: the label immediately before `.ghe.com` is a
    // template placeholder's closing `>`/`}}`, not an alphanumeric hostname label, so this pattern
    // — which requires the label itself to be `[a-z0-9][a-z0-9-]*` — never matches any of them.
    // A real alphanumeric label in that position would match, which is the point.
    // (Written as prose rather than as an example host on purpose: this file is itself tracked, so
    // an illustrative literal here would trip its own check.)
    const GHE_HOST = /\b[a-z0-9][a-z0-9-]*\.ghe\.com\b/gi;
    const findings: Finding[] = [];
    for (const { file, line, text } of REPO_LINES) {
      GHE_HOST.lastIndex = 0;
      for (const m of text.matchAll(GHE_HOST)) {
        findings.push({ file, line, shape: "a literal enterprise GitHub host", matched: m[0] });
      }
    }
    assert.deepEqual(findings, [], `literal enterprise host(s) found:\n${formatFindings(findings)}`);
  });

  it("no populated .env-style credential assignment — variable NAMES are fine, assigned VALUES are not", () => {
    // Deliberately requires the `=` to sit directly against the key, with no space — the dotenv/
    // shell-export convention (`TOKEN="$(...)"`, `SECRETS_FILE="$PI_HOME/..."`) as opposed to a
    // TS/JS declaration (`export const SECRET_LITERAL = new RegExp(...)`, `const TOKEN_RE = /.../`),
    // which this repo's formatter always spaces around `=`. That one structural fact is what keeps
    // this pattern off every `*_TOKEN`/`*_SECRET` identifier in extensions/**/*.ts without needing
    // a word-boundary trick — a word boundary would ALSO have to reject `ANTHROPIC_API_KEY` (the
    // sensitive word is a suffix there, not a prefix), which is exactly the shape a real leak
    // takes, so boundary-anchoring the key was the wrong lever; anchoring the `=` spacing is not.
    const ENV_ASSIGN = /(API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=(?:"([^"]*)"|'([^']*)'|([^\s;#"']*))/g;
    const findings: Finding[] = [];
    for (const { file, line, text } of REPO_LINES) {
      ENV_ASSIGN.lastIndex = 0;
      for (const m of text.matchAll(ENV_ASSIGN)) {
        const value = m[2] ?? m[3] ?? m[4] ?? "";
        if (isSafeValue(value)) continue;
        findings.push({ file, line, shape: `a populated ${m[1]}-shaped assignment`, matched: m[0] });
      }
    }
    assert.deepEqual(findings, [], `populated credential assignment(s) found:\n${formatFindings(findings)}`);
  });

  it("the credential predicate reads an inline-code placeholder the way a reader does", () => {
    // Regression. A doc writing `COPILOT_GITHUB_TOKEN=gho_...` in backticks was a finding: the
    // unquoted alternative stops at whitespace, `;`, `#` or a quote, so the closing backtick came
    // along for the ride and the `...` convention no longer matched. It failed CLOSED, so it was
    // never a hole — it was a gate that a correct document could not pass, which is worse in the
    // long run than a noisy one: it teaches the next writer to reword around the gate, and a gate
    // people route around stops being evidence of anything.
    const placeholders = ["gho_...`", "sk-ant-...`", "$PI_COPILOT_BASE_URL`", "{{model1Id}}`", "x`", "8080`"];
    for (const v of placeholders) {
      assert.equal(isSafeValue(v), true, `${JSON.stringify(v)} is a placeholder in inline code, not a value`);
    }
    for (const v of ["hunter2", "correct-horse-battery-staple`"]) {
      assert.equal(isSafeValue(v), false, `${JSON.stringify(v)} is populated and must stay a finding`);
    }
  });

  it("$PI_PUBLICATION_DENY, when a fork sets it, gates the whole tracked tree the same way agents.test.ts's copy does", () => {
    if (!DENY_PATTERN) return; // nothing to check on a clean checkout — this is the opt-in knob, not a shipped rule
    const findings: Finding[] = [];
    for (const { file, line, text } of REPO_LINES) {
      const m = text.match(DENY_PATTERN);
      if (m) findings.push({ file, line, shape: "a string listed in $PI_PUBLICATION_DENY", matched: m[0] });
    }
    assert.deepEqual(findings, [], `$PI_PUBLICATION_DENY hit(s) found:\n${formatFindings(findings)}`);
  });
});

// Patterns considered and DROPPED — each reproduced a false positive the task brief predicted,
// confirmed by actually running the widened pattern against this tree before writing this file:
//
//   - `mcp__`            — extensions/** legitimately handles MCP tool names as shipped code (this
//                           is agents.test.ts's check, over agent prose only, for a reason: a
//                           frontmatter `tools:` grant is a narrow, structured thing to check;
//                           "does this file's PROSE mention an mcp__ tool" is not).
//   - private/link-local IPs (127.0.0.1, 10.x, 192.168.x, tailnet 100.64.0.0/10) — used throughout
//                           test/ and config/ as legitimate example/default addresses; there is no
//                           shape that separates "someone's real tailnet IP" from "the placeholder
//                           IP this test always uses" without an allowlist that would grow with
//                           every new test file, exactly the "switched off within a week" failure
//                           mode the existing gate's own comment warns about.
//   - `soul`              — extensions/compaction/pinned.ts's `isSoulShaped()` is the machinery
//                           that REFUSES to ship an identity file; naming it in prose is the whole
//                           point, and a repo-wide word-boundary match on "soul" would flag its own
//                           safety mechanism.
//   - generic hostnames   — no shape distinguishes a real internal hostname from every legitimate
//                           `example.com`/`localhost`/`api.github.com` reference in docs and tests.
//   - email addresses     — `dresvyanskiydenis@gmail.com` in CODE_OF_CONDUCT.md is a deliberate,
//                           intentional contact address, and `test@example.com`/`test@example.invalid`
//                           are fixtures throughout test/; agents.test.ts's narrower version (over
//                           agent prose only, which has no legitimate reason to name an email at
//                           all) is where this check belongs.

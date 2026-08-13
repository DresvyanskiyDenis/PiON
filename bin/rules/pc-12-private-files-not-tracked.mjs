/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { execFileSync } from "node:child_process";

export const id = "PC-12";
export const title = "PRIVATE.md, OPERATOR.local.md, agents-private/ and skills-private/ are never tracked (D-6)";
export const closes = ["REQ-CTX-13"];

// A .gitignore pattern has no effect on a file already IN the index (`git add -f`, or a commit
// made before the ignore rule existed) — the .gitignore check below is a useful proxy but not
// proof of "never tracked" on its own (F8, adversarial security review). So beyond it, this rule
// ALSO shells out to `git ls-files` (is it tracked right now?) and `git log --all
// --diff-filter=A` (was it ever added, anywhere in history, even if later removed?) for every
// candidate NAME, regardless of whether it currently exists on disk — unlike the .gitignore
// check, which only means something for a path that is actually present. A path added once and
// later deleted from the working tree is exactly the leak this half of F8 is about: gone from
// disk, still in history, invisible to both `.gitignore` and an exists()-gated check. All three
// conditions must hold for a candidate to be clean.
//
// `git` unavailability is handled, not ignored: this checker's original design goal — it must run
// in a container with no git binary — still matters, so `git` missing (ENOENT) or `repoRoot` not
// being inside a work tree at all
// ("fatal: not a git repository") both collapse to "these two checks add no signal here",
// falling back to the .gitignore check alone — see `isGitUnavailable()`. This is not a weakened
// signal: outside a git work tree there is, by construction, no tracked-file index and no commit
// history to have ever added anything to, so an empty result is the correct answer, not a guess.
// Any OTHER git failure (a real repository that errors for an unrelated reason) is left
// uncaught, matching this checker's documented contract: a rule throwing is a bug in the
// checker itself, reported distinctly (exit 2), not folded into a finding.
const CANDIDATES = ["PRIVATE.md", "OPERATOR.local.md", "agents-private", "skills-private"];

/** @param {unknown} err @returns {boolean} */
function isGitUnavailable(err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true;
  const stderr = err && typeof err === "object" && "stderr" in err ? err.stderr : undefined;
  return typeof stderr === "string" && stderr.includes("not a git repository");
}

/** Paths git currently has in its index matching `relPath`, relative to `repoRoot`. Empty if none (or git can't answer — see the header). @param {string} repoRoot @param {string} relPath @returns {string[]} */
function gitTrackedPaths(repoRoot, relPath) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "ls-files", "--", relPath], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.length > 0);
  } catch (err) {
    if (isGitUnavailable(err)) return [];
    throw err;
  }
}

/** Commit hashes where `relPath` was ADDED, anywhere across all history. Empty if never (or git can't answer). @param {string} repoRoot @param {string} relPath @returns {string[]} */
function gitEverAddedCommits(repoRoot, relPath) {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "log", "--all", "--diff-filter=A", "--pretty=format:%H", "--", relPath],
      { encoding: "utf8" },
    );
    return out.split("\n").filter((l) => l.length > 0);
  } catch (err) {
    if (isGitUnavailable(err)) return [];
    throw err;
  }
}

/**
 * @param {string[]} patterns raw, trimmed, non-comment .gitignore lines
 * @param {string} name
 */
function isIgnored(patterns, name) {
  return patterns.some((p) => {
    const bare = p.replace(/^\/+/, "").replace(/\/+$/, "");
    return bare === name || p === `/${name}` || p === `${name}/`;
  });
}

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  const gitignoreText = ctx.readText(".gitignore") ?? "";
  const patterns = gitignoreText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  for (const name of CANDIDATES) {
    // The .gitignore check only means something for a path that currently exists — unchanged.
    if (ctx.exists(name) && !isIgnored(patterns, name)) {
      findings.push({
        rule: id,
        file: name,
        message: `"${name}" exists in the repo but is not covered by any .gitignore pattern — Soul-adjacent personal content must never be trackable (D-6)`,
      });
    }

    // The two git checks below are NOT gated on ctx.exists(name): the whole point of F8 is a
    // path that was committed and later deleted from the working tree — gone from disk, still
    // in history, and invisible to the exists()-gated check above and to plain `.gitignore`.
    const tracked = gitTrackedPaths(ctx.repoRoot, name);
    if (tracked.length > 0) {
      findings.push({
        rule: id,
        file: name,
        message: `"${name}" is currently tracked by git (git ls-files: ${tracked.join(", ")}) — a .gitignore pattern has no effect on a file already added; untrack it with "git rm --cached" (D-6)`,
      });
    }

    const addedCommits = gitEverAddedCommits(ctx.repoRoot, name);
    if (addedCommits.length > 0) {
      findings.push({
        rule: id,
        file: name,
        message: `"${name}" was added to git history at least once (${addedCommits.length} commit(s), e.g. ${addedCommits[0]}) — adding a .gitignore pattern afterwards does not remove it from history; it must be purged (D-6)`,
      });
    }
  }
  return findings;
}

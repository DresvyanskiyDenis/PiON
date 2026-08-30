/**
 * Repository ownership, answered by git rather than by string prefix.
 *
 * ## Why this exists
 *
 * Every containment check in this tree used to ask "does this absolute path start with the repo
 * root?". That question has a wrong answer for a mode this harness is expected to work in: a
 * linked git worktree lives at a path with no textual relationship to the main checkout
 * (`~/pi-config` and `~/work/wt-feature` share no prefix) while being the same repository, on a
 * different branch. Under a prefix test the second one reads as somebody else's directory, so a
 * check meant to say "inside the project" says "outside" — and a check meant to say "this file
 * must not live in the repo" fails to notice that it does.
 *
 * The correct test is the one git itself uses: **two directories belong to the same repository iff
 * `git rev-parse --git-common-dir` resolves to the same path from both.** `--git-dir` is
 * per-worktree (`.git/worktrees/<name>` for a linked one) and so cannot answer this; `--git-common-dir`
 * is the shared directory every worktree of a repo points at. `extensions/worktree/git.ts` already
 * relies on exactly this pair for `REQ-CTX-60`'s worktree detection; this module reuses the same
 * plumbing for the ownership question.
 *
 * The property that makes it usable in a guard: it is **deterministic and local**. One `git`
 * subprocess, read-only, no network, no model judgement, and a wrong answer is impossible rather
 * than merely unlikely.
 *
 * ## Failure posture
 *
 * Every failure — git missing, a timeout, a path in no repository at all — yields `null`/`false`,
 * i.e. "not the same repository". That is the *conservative* direction for both callers: the guard
 * falls back to the prefix verdict it would have produced anyway, and the operator-identity refusal
 * keeps refusing exactly what it refused before. Nothing here can widen a boundary by failing.
 *
 * ## Cost
 *
 * Answers are cached per resolved directory for the life of the process, because both callers ask
 * about the same handful of directories repeatedly and the answer cannot change while a checkout
 * stays where it is. Callers reach this only after a cheap prefix test has already missed, so the
 * common path spawns nothing.
 */
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const GIT_TIMEOUT_MS = 1500;

/** Resolved directory → its `--git-common-dir`, or `null` for "no repository / cannot tell". */
const commonDirCache = new Map<string, string | null>();

/**
 * The nearest ancestor of `p` that exists and is a directory, or `null`.
 *
 * A write target and an operator-file candidate are both routinely paths that do not exist yet, and
 * `git -C` needs a real directory to answer from. Walking up is what makes "would a file created
 * here belong to this repo?" answerable at all.
 */
function nearestExistingDir(p: string): string | null {
  let current = resolve(p);
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // Does not exist — the parent is the next candidate, same as for an existing plain file.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `git rev-parse --git-common-dir` for the repository containing `p`, as an absolute, symlink-resolved
 * path — or `null` when `p` is in no repository, or git cannot be run.
 *
 * The output is resolved against the directory it was asked from: git answers a bare `.git` when the
 * question came from the top of a primary checkout, and an absolute path from elsewhere. Comparing
 * the raw strings would make one checkout look like two repositories depending on where the question
 * was asked — the same trap `extensions/worktree/git.ts` documents.
 */
export function gitCommonDir(p: string): string | null {
  const dir = nearestExistingDir(p);
  if (dir === null) return null;

  const cached = commonDirCache.get(dir);
  if (cached !== undefined) return cached;

  let answer: string | null = null;
  try {
    const raw = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (raw.length > 0) answer = realpathSync(resolve(dir, raw));
  } catch {
    // No repository, no git binary, a timeout, or a common dir that no longer exists on disk.
    // All of them mean the same thing to a caller: ownership could not be established.
    answer = null;
  }

  commonDirCache.set(dir, answer);
  return answer;
}

/**
 * True when `a` and `b` are two paths in the **same repository** — the main checkout and any of its
 * linked worktrees included, a nested submodule or an unrelated repo excluded.
 */
export function sameRepo(a: string, b: string): boolean {
  const left = gitCommonDir(a);
  if (left === null) return false;
  return left === gitCommonDir(b);
}

/** Tests only: the cache is keyed by directory and a test creates and destroys repos in one process. */
export function clearRepoOwnershipCache(): void {
  commonDirCache.clear();
}

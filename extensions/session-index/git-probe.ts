/**
 * Minimal, local-only branch/worktree probe.
 *
 * An earlier draft's sample imports `getWorktreeInfo` from `../worktree/index.ts` (EXT-23).
 * That module does not exist in this tree yet — EXT-23 is a sibling wave-3 item being built in
 * parallel, and a static import of a file that may not exist at build time would break `tsc` for
 * everyone importing this module, not just EXT-26. So this is a deliberately small (~20 line)
 * stand-in using `git` directly, scoped to a single `cwd`. Once EXT-23 lands, swap this for
 * `getWorktreeInfo()` to avoid two independent git probes drifting apart — that swap is the open
 * question this stand-in leaves behind.
 */
import { execFileSync } from "node:child_process";

export interface GitInfo {
  readonly branch: string | null;
  readonly worktree: boolean;
}

const GIT_TIMEOUT_MS = 1500;

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args as string[], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

/** Never throws — a missing git binary, a non-repo cwd, or a timeout all yield the neutral value. */
export function probeGitInfo(cwd: string): GitInfo {
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const gitDir = git(["rev-parse", "--git-dir"], cwd);
    const commonDir = git(["rev-parse", "--git-common-dir"], cwd);
    return { branch: branch || null, worktree: gitDir !== commonDir };
  } catch {
    return { branch: null, worktree: false };
  }
}

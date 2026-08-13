/**
 * Pure git plumbing for worktree detection and lifecycle (EXT-23).
 *
 * Every call goes through `pi.exec`, never `node:child_process` directly, so these commands
 * participate in whatever exec-level policy PI itself applies to extension-issued commands.
 * Nothing here ever touches the user's actual working tree: `addWorktree`/`removeWorktree` only
 * ever act on paths `index.ts` created and recorded in the registry itself.
 */
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  readonly isRepo: boolean;
  /** `git rev-parse --git-common-dir` !== ".git" (and not a bare "…/.git") — REQ-CTX-60's exact test. */
  readonly isWorktree: boolean;
  /** `git rev-parse --show-toplevel` — the toplevel of THIS worktree, not necessarily the main one. */
  readonly root: string;
  /** The shared git dir every worktree of this repo points at. May be relative (".git") or absolute. */
  readonly commonDir: string;
  readonly branch: string;
  readonly dirty: number;
}

const GIT_TIMEOUT_MS = 15_000;

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
  return pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

function notARepo(cwd: string): WorktreeInfo {
  return { isRepo: false, isWorktree: false, root: cwd, commonDir: "", branch: "", dirty: 0 };
}

/** Never throws: a non-repo `cwd`, a missing `git`, or a timeout are all reported as `{isRepo: false}`. */
export async function detect(pi: ExtensionAPI, cwd: string): Promise<WorktreeInfo> {
  try {
    const common = await git(pi, cwd, ["rev-parse", "--git-common-dir"]);
    if (common.code !== 0) return notARepo(cwd);
    const [gitDir, top, branch, status] = await Promise.all([
      git(pi, cwd, ["rev-parse", "--git-dir"]),
      git(pi, cwd, ["rev-parse", "--show-toplevel"]),
      git(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(pi, cwd, ["status", "--porcelain"]),
    ]);
    if (top.code !== 0) return notARepo(cwd);
    const commonDir = common.stdout.trim();
    // `--git-dir` is per-worktree (e.g. `.git/worktrees/<name>` for a linked worktree);
    // `--git-common-dir` is shared by every worktree of the repo. They differ exactly when the
    // session is inside a linked worktree — REQ-CTX-60's exact test. String-matching
    // `commonDir` against a literal ".git" is fragile: git reports it as absolute or relative
    // depending on cwd, and an absolute common-dir from the PRIMARY checkout would then read as
    // "false positive worktree". Comparing both rev-parse outputs (resolved the same way by the
    // same git invocation) sidesteps that entirely.
    return {
      isRepo: true,
      isWorktree: gitDir.code === 0 && gitDir.stdout.trim() !== commonDir,
      root: top.stdout.trim(),
      commonDir,
      branch: branch.code === 0 ? branch.stdout.trim() : "HEAD",
      dirty: status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0,
    };
  } catch {
    return notARepo(cwd);
  }
}

/** Resolves `commonDir` to an absolute path — the registry lives next to it (§8.2). */
export function resolveCommonDir(info: Pick<WorktreeInfo, "root" | "commonDir">): string {
  return info.commonDir === "" || info.commonDir === ".git" ? `${info.root}/.git` : info.commonDir;
}

export async function addWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  path: string,
  branch: string,
): Promise<void> {
  const r = await git(pi, repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (r.code !== 0) {
    throw new Error(
      `git worktree add -b ${branch} ${path} HEAD failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
}

export async function removeWorktree(pi: ExtensionAPI, repoRoot: string, path: string): Promise<void> {
  const r = await git(pi, repoRoot, ["worktree", "remove", "--force", path]);
  if (r.code !== 0) {
    throw new Error(
      `git worktree remove --force ${path} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
}

export async function pruneWorktrees(pi: ExtensionAPI, repoRoot: string): Promise<void> {
  await git(pi, repoRoot, ["worktree", "prune"]);
}

export async function isDirty(pi: ExtensionAPI, path: string): Promise<boolean> {
  const r = await git(pi, path, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * Safe delete only (`-d`, never `-D`): succeeds when the branch is already merged into its
 * starting point, i.e. the worktree it lived in added no commits — the "unmerged-empty" case.
 * A branch that gained real commits is left alone on purpose: deleting someone's work because
 * their worktree happened to read clean on `git status` would be its own bug. Failure is
 * swallowed — an unmerged branch left behind is not an error, it is the point of `-d`.
 */
export async function deleteBranchIfMerged(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<void> {
  await git(pi, repoRoot, ["branch", "-d", branch]);
}

/** `kill -0` liveness check. EPERM means the pid exists but is owned by someone else — still alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

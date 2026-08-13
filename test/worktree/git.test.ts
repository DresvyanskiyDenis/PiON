import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  addWorktree,
  deleteBranchIfMerged,
  detect,
  isDirty,
  isPidAlive,
  pruneWorktrees,
  removeWorktree,
  resolveCommonDir,
} from "../../extensions/worktree/git.ts";

const execFileAsync = promisify(execFile);

/** Minimal stand-in for `pi.exec` — real `git`, real process, same {stdout,stderr,code,killed} shape. */
function fakePi(): ExtensionAPI {
  const exec = async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options?.cwd,
        timeout: options?.timeout,
      });
      return { stdout, stderr, code: 0, killed: false } satisfies ExecResult;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: typeof e.code === "number" ? e.code : 1,
        killed: false,
      } satisfies ExecResult;
    }
  };
  return { exec } as unknown as ExtensionAPI;
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ext23-git-"));
  await execFileAsync("git", ["init", "-q", "--initial-branch=main", dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("git.ts detect()", () => {
  const pi = fakePi();
  let repo: string;

  before(async () => {
    repo = await initRepo();
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("never throws and reports isRepo:false on a plain directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext23-none-"));
    try {
      const info = await detect(pi, dir);
      assert.equal(info.isRepo, false);
      assert.equal(info.isWorktree, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never throws on a nonexistent directory", async () => {
    const info = await detect(pi, join(tmpdir(), "ext23-does-not-exist-anywhere"));
    assert.equal(info.isRepo, false);
  });

  it("reports isRepo:true, isWorktree:false, and the branch in the primary checkout", async () => {
    const info = await detect(pi, repo);
    assert.equal(info.isRepo, true);
    assert.equal(info.isWorktree, false);
    assert.equal(info.branch, "main");
    assert.equal(info.dirty, 0);
  });

  it("reports dirty count from git status --porcelain", async () => {
    await writeFile(join(repo, "scratch.txt"), "x");
    try {
      const info = await detect(pi, repo);
      assert.equal(info.dirty, 1);
    } finally {
      await rm(join(repo, "scratch.txt"), { force: true });
    }
  });

  it("reports isWorktree:true from inside a linked worktree, never nested twice", async () => {
    const wtPath = join(tmpdir(), `ext23-linked-${process.pid}`);
    await addWorktree(pi, repo, wtPath, "linked-branch");
    try {
      const info = await detect(pi, wtPath);
      assert.equal(info.isRepo, true);
      assert.equal(info.isWorktree, true, "REQ-CTX-60's exact test: git-common-dir !== .git");
      assert.equal(info.branch, "linked-branch");
    } finally {
      await removeWorktree(pi, repo, wtPath);
    }
  });
});

describe("git.ts worktree lifecycle", () => {
  const pi = fakePi();
  let repo: string;

  before(async () => {
    repo = await initRepo();
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("addWorktree creates a real worktree git worktree list can see", async () => {
    const path = join(tmpdir(), `ext23-add-${process.pid}`);
    await addWorktree(pi, repo, path, "feature/add-test");
    try {
      const list = await execFileAsync("git", ["-C", repo, "worktree", "list"]);
      assert.match(list.stdout, /feature\/add-test/);
    } finally {
      await removeWorktree(pi, repo, path);
    }
  });

  it("addWorktree throws with git's own stderr on failure (fail loud)", async () => {
    await assert.rejects(
      () => addWorktree(pi, repo, "/definitely/not/writable/anywhere", "bad-branch"),
      /git worktree add -b bad-branch .* failed \(exit \d+\):/,
    );
  });

  it("removeWorktree removes it and pruneWorktrees clears leftover metadata", async () => {
    const path = join(tmpdir(), `ext23-remove-${process.pid}`);
    await addWorktree(pi, repo, path, "feature/remove-test");
    await removeWorktree(pi, repo, path);
    const list = await execFileAsync("git", ["-C", repo, "worktree", "list"]);
    assert.doesNotMatch(list.stdout, /feature\/remove-test/);
    await pruneWorktrees(pi, repo); // must not throw with nothing to prune
  });

  it("isDirty is false right after creation and true after an uncommitted edit", async () => {
    const path = join(tmpdir(), `ext23-dirty-${process.pid}`);
    await addWorktree(pi, repo, path, "feature/dirty-test");
    try {
      assert.equal(await isDirty(pi, path), false);
      await writeFile(join(path, "new.txt"), "content");
      assert.equal(await isDirty(pi, path), true);
    } finally {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", path]);
    }
  });

  it("deleteBranchIfMerged deletes a commit-less branch but leaves one with real commits", async () => {
    const cleanPath = join(tmpdir(), `ext23-branch-clean-${process.pid}`);
    const dirtyPath = join(tmpdir(), `ext23-branch-commits-${process.pid}`);
    await addWorktree(pi, repo, cleanPath, "agent/clean");
    await addWorktree(pi, repo, dirtyPath, "agent/has-commits");
    await execFileAsync("git", ["-C", dirtyPath, "commit", "-q", "--allow-empty", "-m", "child work"]);
    try {
      await removeWorktree(pi, repo, cleanPath);
      await removeWorktree(pi, repo, dirtyPath);
      await deleteBranchIfMerged(pi, repo, "agent/clean");
      await deleteBranchIfMerged(pi, repo, "agent/has-commits");

      const branches = (await execFileAsync("git", ["-C", repo, "branch", "--list"])).stdout;
      assert.doesNotMatch(branches, /agent\/clean/, "commit-less branch is safe to reclaim");
      assert.match(branches, /agent\/has-commits/, "a branch with real commits must survive -d");
    } finally {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", cleanPath]).catch(() => {});
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", dirtyPath]).catch(() => {});
      await execFileAsync("git", ["-C", repo, "branch", "-D", "agent/has-commits"]).catch(() => {});
    }
  });
});

describe("resolveCommonDir", () => {
  it("resolves the bare '.git' case relative to root", () => {
    assert.equal(resolveCommonDir({ root: "/repo", commonDir: ".git" }), "/repo/.git");
  });
  it("resolves the empty (non-repo) case the same way, harmlessly", () => {
    assert.equal(resolveCommonDir({ root: "/repo", commonDir: "" }), "/repo/.git");
  });
  it("passes an already-absolute commonDir through unchanged", () => {
    assert.equal(resolveCommonDir({ root: "/wt", commonDir: "/repo/.git/worktrees/wt" }), "/repo/.git/worktrees/wt");
  });
});

describe("isPidAlive", () => {
  it("is true for this process's own pid", () => {
    assert.equal(isPidAlive(process.pid), true);
  });
  it("is false for a pid that cannot exist (0 or negative)", () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
  });
  it("is false for a very large pid extremely unlikely to be alive", () => {
    assert.equal(isPidAlive(2 ** 30), false);
  });
});

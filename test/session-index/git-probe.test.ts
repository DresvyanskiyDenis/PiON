import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { probeGitInfo } from "../../extensions/session-index/git-probe.ts";

describe("probeGitInfo", () => {
  it("never throws on a directory that is not a git repo at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-probe-none-"));
    try {
      const info = probeGitInfo(dir);
      assert.equal(info.branch, null);
      assert.equal(info.worktree, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never throws on a nonexistent directory", () => {
    const info = probeGitInfo("/definitely/does/not/exist/anywhere");
    assert.equal(info.branch, null);
    assert.equal(info.worktree, false);
  });

  it("reports the branch of a real checkout, and worktree=false when it is the main one", async (t) => {
    // Used to probe `process.cwd()` and assert a branch came back, which made the result depend on
    // how the suite was invoked: run it from an exported tree, a `git archive`, or any directory that
    // is not itself a checkout, and it failed while the probe was working perfectly. The subject is
    // the probe, so the repository is built here, in a temp dir, and thrown away.
    const dir = await mkdtemp(join(tmpdir(), "git-probe-repo-"));
    try {
      // A pristine environment: no user or system gitconfig, so no templates, hooks or signing key.
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      };
      const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "ignore" });
      try {
        run(["init", "-q", "-b", "probe-branch"]);
        // `rev-parse --abbrev-ref HEAD` has nothing to resolve on an unborn branch, so the repo needs
        // one commit before it is a repo the probe can answer about.
        run(["commit", "-q", "--allow-empty", "-m", "init"]);
      } catch {
        // No usable `git` binary here. The probe's behaviour in that case is the neutral value, which
        // the two tests above already cover, so there is nothing left for this one to assert.
        t.skip("git is unavailable");
        return;
      }

      const info = probeGitInfo(dir);
      assert.equal(info.branch, "probe-branch");
      assert.equal(info.worktree, false, "the main checkout is not a linked worktree");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Repository ownership by `git rev-parse --git-common-dir`, not by string prefix.
 *
 * The failure this pins is not hypothetical: this harness is expected to work inside a linked git
 * worktree, and a worktree of `~/pi-config` living at `~/work/wt-feature` shares no prefix with the
 * main checkout. Every containment check written as `startsWith(root)` therefore reads ordinary
 * work on another branch as a write into somebody else's tree — and reads an operator-identity file
 * planted in that worktree as "not in the repo".
 *
 * So the cases below are built on a **real** git repo with a **real** `git worktree add`, not on a
 * fixture that merely looks like one: the whole claim is about what git answers, and a mock of git
 * would only pin the mock. The suite skips itself when `git` is unavailable rather than passing
 * vacuously.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  clearRepoOwnershipCache,
  gitCommonDir,
  sameRepo,
} from "../../extensions/lib/same-repo.ts";
import { classify } from "../../extensions/guard/write-surface.ts";
import { isInsideRepo } from "../../extensions/session-context.ts";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo with one commit — `git worktree add` refuses to work without a HEAD to branch from. */
function makeRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.invalid"]);
  git(root, ["config", "user.name", "test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed"]);
}

describe("repository ownership is git's answer, not the path's prefix", { skip: !hasGit() }, () => {
  let scratch: string;
  let main: string;
  let worktree: string;
  let stranger: string;
  let isolatedTmp: string;

  /**
   * Points `sandboxRoots()`'s two non-cwd roots at an empty directory for the duration of `fn`.
   *
   * Without this the guard assertions below pass for the wrong reason: the fixtures live under
   * `os.tmpdir()`, which IS a sandbox root, so every path in them classifies `inside` on the prefix
   * test and the git question is never reached. A test that green-lights the fix while never
   * exercising it is the exact failure mode this change was written to remove.
   */
  function withIsolatedSandboxRoots(fn: () => void): void {
    const saved = {
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.TMPDIR = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TEMP = isolatedTmp;
    process.env.XDG_STATE_HOME = isolatedTmp;
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "pi-same-repo-"));
    main = join(scratch, "checkout");
    // Deliberately NOT under `main` — a sibling path sharing no prefix is the whole point.
    worktree = join(scratch, "wt-feature");
    stranger = join(scratch, "unrelated");
    isolatedTmp = join(scratch, "empty-tmp");
    mkdirSync(isolatedTmp, { recursive: true });

    makeRepo(main);
    git(main, ["worktree", "add", "-q", "-b", "feature", worktree, "HEAD"]);
    makeRepo(stranger);
    clearRepoOwnershipCache();
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
    clearRepoOwnershipCache();
  });

  it("a linked worktree and its main checkout are the same repository", () => {
    assert.equal(sameRepo(main, worktree), true);
    assert.equal(sameRepo(worktree, main), true, "the relation is symmetric");
  });

  it("neither path is a prefix of the other — the string test would say 'outside'", () => {
    assert.equal(worktree.startsWith(main), false);
    assert.equal(main.startsWith(worktree), false);
  });

  it("`--git-dir` differs across worktrees while `--git-common-dir` does not", () => {
    // The exact distinction `extensions/worktree/git.ts` documents: had this module compared
    // `--git-dir`, the two checkouts would read as two repositories and the fix would be a no-op.
    const perWorktree = (cwd: string) =>
      execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    assert.notEqual(perWorktree(main), perWorktree(worktree));
    assert.equal(gitCommonDir(main), gitCommonDir(worktree));
  });

  it("an unrelated repository is not the same repository", () => {
    assert.equal(sameRepo(main, stranger), false);
  });

  it("a path in no repository at all answers false, and never throws", () => {
    assert.equal(gitCommonDir(scratch), null);
    assert.equal(sameRepo(main, scratch), false);
  });

  it("answers for a file that does not exist yet, from its nearest existing ancestor", () => {
    // Write targets and operator-file candidates are routinely paths nothing has created.
    const planned = join(worktree, "does", "not", "exist", "yet.txt");
    assert.equal(sameRepo(main, planned), true);
  });

  it("guard: a write into a sibling worktree of the session repo is INSIDE the project", () => {
    // The regression itself, at the call site that produces the guard verdict. With the prefix test
    // alone this is `outside`, and every ordinary edit on another branch is recorded as an
    // out-of-project write.
    withIsolatedSandboxRoots(() => {
      assert.deepEqual(classify(join(worktree, "seed.txt"), main), {
        location: "inside",
        resolved: resolve(join(worktree, "seed.txt")),
      });
    });
  });

  it("operator identity: a candidate in a linked worktree counts as inside the repo", () => {
    // The mirror image of the guard case, and the reason this one is a containment bug rather than
    // a cosmetic one: `resolveOperator` REFUSES a candidate that `isInsideRepo` flags, so under the
    // prefix test a file planted in a worktree of this very repo was read instead of refused.
    const saved = process.env.PI_CONFIG_REPO;
    process.env.PI_CONFIG_REPO = main;
    try {
      assert.equal(isInsideRepo(join(worktree, "OPERATOR.local.md")), true);
      assert.equal(isInsideRepo(join(main, "config", "operator", "OPERATOR.md")), true);
      assert.equal(isInsideRepo(join(stranger, "OPERATOR.local.md")), false);
    } finally {
      if (saved === undefined) delete process.env.PI_CONFIG_REPO;
      else process.env.PI_CONFIG_REPO = saved;
    }
  });

  it("guard: a foreign repository is still OUTSIDE — ownership widens to the repo and nothing else", () => {
    withIsolatedSandboxRoots(() => {
      assert.equal(classify(join(stranger, "seed.txt"), main).location, "outside");
      assert.equal(classify("/etc/hosts", main).location, "outside");
    });
  });
});

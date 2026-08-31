import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_STATE_DIR,
  applyChildrenIsolation,
  applyIsolation,
  preflightWorktree,
  registerWorktreeProvider,
  resetWorktreePreflight,
  resetWorktreeProvider,
  setWorktreePreflight,
  worktreeProvider,
} from "../../extensions/dispatch/isolation.ts";
import { scratch } from "./helpers.ts";

const REQUEST = { agent: "surgeon", toolCallId: "call-1", cwd: "/repo" };

/**
 * `/repo` in these fixtures is not a repository at all, so the tests that exercise the package
 * path have to say what the preflight is supposed to have answered. Injecting it is not a way
 * around the check — the check itself has its own tests below, against real repositories.
 */
const FEASIBLE = () =>
  ({ ok: true, repoRoot: "/repo", commonDir: "/repo/.git", baseCommit: "0".repeat(40) }) as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/** A repository with one commit, or with none when `commit` is false. */
function repo(commit = true): string {
  const dir = scratch("ext05-worktree-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  if (commit) {
    writeFileSync(join(dir, "README.md"), "seed\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-qm", "seed");
  }
  return dir;
}

describe("worktree provider seam (EXT-23)", () => {
  beforeEach(() => resetWorktreeProvider());

  it("starts empty and reports a replacement rather than swapping silently", () => {
    assert.equal(worktreeProvider(), undefined);
    assert.deepEqual(registerWorktreeProvider({ id: "ext-23", create: () => ({ cwd: "/wt" }) }), {});
    assert.equal(worktreeProvider()?.id, "ext-23");
    const again = registerWorktreeProvider({ id: "other", create: () => ({ cwd: "/wt2" }) });
    assert.deepEqual(again, { replaced: "ext-23" });
  });
});

describe("applyIsolation", () => {
  beforeEach(() => {
    resetWorktreeProvider();
    resetWorktreePreflight();
  });
  afterEach(() => resetWorktreePreflight());

  it("does nothing at all for isolation: none", async () => {
    const input: Record<string, unknown> = { agent: "scout" };
    assert.deepEqual(await applyIsolation(input, "none", REQUEST), { kind: "none" });
    assert.deepEqual(input, { agent: "scout" });
  });

  it("routes the child into EXT-23's directory when a provider is registered", async () => {
    registerWorktreeProvider({
      id: "ext-23",
      create: (req) => ({ cwd: `/worktrees/${req.agent}-${req.toolCallId}`, detail: "fresh branch" }),
    });
    const input: Record<string, unknown> = { agent: "surgeon", prompt: "refactor" };
    const outcome = await applyIsolation(input, "worktree", REQUEST);
    assert.deepEqual(outcome, {
      kind: "provider",
      providerId: "ext-23",
      cwd: "/worktrees/surgeon-call-1",
      detail: "fresh branch",
    });
    assert.equal(input.cwd, "/worktrees/surgeon-call-1");
    assert.equal(input.worktree, undefined, "the package must not also create one");
  });

  it("falls back to the package's own worktree when EXT-23 is not loaded", async () => {
    setWorktreePreflight(FEASIBLE);
    const input: Record<string, unknown> = { agent: "surgeon", prompt: "refactor" };
    assert.deepEqual(await applyIsolation(input, "worktree", REQUEST), { kind: "package" });
    assert.equal(input.worktree, true);
  });

  it("REFUSES the package path when the repository could not host a worktree", async () => {
    // `input.worktree = true` is a REQUEST: the package builds the tree inside the child it
    // spawns, so without this the lead gets a well-formed run id for a child that dies out of
    // band — indistinguishable from a launched run, and an automatic retry would re-spend on it.
    setWorktreePreflight(() => ({ ok: false, reason: "/repo is not inside a git working tree" }));
    const input: Record<string, unknown> = { agent: "surgeon", prompt: "refactor" };
    const outcome = await applyIsolation(input, "worktree", REQUEST);
    assert.equal(outcome.kind, "refused");
    const reason = outcome.kind === "refused" ? outcome.reason : "";
    assert.match(reason, /not inside a git working tree/);
    assert.match(reason, /rather than returning a run id for a child that would fail after launch/);
    assert.equal(input.worktree, undefined, "and no silent downgrade to running in the checkout");
  });

  it("REFUSES rather than running in the user's checkout when the provider throws", async () => {
    registerWorktreeProvider({
      id: "ext-23",
      create: () => {
        throw new TypeError("git worktree add failed");
      },
    });
    const input: Record<string, unknown> = { agent: "surgeon" };
    const outcome = await applyIsolation(input, "worktree", REQUEST);
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /TypeError: git worktree add failed/);
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /Refusing to run it in \/repo/);
    assert.equal(input.cwd, undefined);
    assert.equal(input.worktree, undefined, "no silent downgrade to the package path either");
  });

  it("REFUSES when the provider returns no directory", async () => {
    registerWorktreeProvider({ id: "ext-23", create: () => ({ cwd: "" }) });
    const outcome = await applyIsolation({ agent: "surgeon" }, "worktree", REQUEST);
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /returned no directory/);
  });

  it("REFUSES a fanout call with no provider, because worktree: true needs a single named agent", async () => {
    const input: Record<string, unknown> = { tasks: [{ agent: "surgeon" }, { agent: "surgeon" }] };
    const outcome = await applyIsolation(input, "worktree", REQUEST);
    assert.equal(outcome.kind, "refused");
    assert.match(
      outcome.kind === "refused" ? outcome.reason : "",
      /only accepts worktree: true together with agent: <name>/,
    );
    assert.equal(input.worktree, undefined);
  });

  it("awaits an async provider", async () => {
    registerWorktreeProvider({ id: "ext-23", create: async () => Promise.resolve({ cwd: "/worktrees/async" }) });
    const input: Record<string, unknown> = { agent: "surgeon" };
    const outcome = await applyIsolation(input, "worktree", REQUEST);
    assert.equal(outcome.kind, "provider");
    assert.equal(input.cwd, "/worktrees/async");
  });
});

/** `isolation: worktree` must be honoured whatever call shape carries the declaring child. */
describe("applyChildrenIsolation", () => {
  const CHILDREN = { agents: ["surgeon"], toolCallId: "call-1", cwd: "/repo" };

  beforeEach(() => {
    resetWorktreeProvider();
    setWorktreePreflight(FEASIBLE);
  });

  it("asks pi-subagents for managed per-child isolation and names who declared it", () => {
    const input: Record<string, unknown> = { workflowScript: "return runs.run('m', {agent: 'surgeon'})" };
    const outcome = applyChildrenIsolation(input, { ...CHILDREN, agents: ["surgeon", "editor"] });
    assert.deepEqual(outcome, { kind: "package", children: { agents: ["surgeon", "editor"] } });
    assert.equal(input.worktree, true);
  });

  /**
   * The provider is skipped here ON PURPOSE, and this is the assertion that says so. EXT-23 grants
   * ONE directory per tool call and releases it on that call's tool_result; N children in one
   * directory is not isolation, and N grants for one call would leak N-1 worktrees.
   */
  it("does not ask EXT-23 for a directory, because one directory cannot isolate N children", () => {
    registerWorktreeProvider({
      id: "ext-23",
      create: () => {
        throw new Error("the children path must not request a single-directory grant");
      },
    });
    const input: Record<string, unknown> = { tasks: [{ agent: "surgeon" }, { agent: "surgeon" }] };
    assert.equal(applyChildrenIsolation(input, CHILDREN).kind, "package");
    assert.equal(input.worktree, true);
    assert.equal(input.cwd, undefined, "the children keep their own cwds");
  });

  it("REFUSES when no worktree can be created from the session cwd, naming the agents", () => {
    setWorktreePreflight(() => ({ ok: false, reason: "unborn HEAD" }));
    const input: Record<string, unknown> = { workflowScript: "return runs.run('m', {agent: 'surgeon'})" };
    const outcome = applyChildrenIsolation(input, CHILDREN);
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /agent "surgeon" declares isolation: worktree/);
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /unborn HEAD/);
    assert.match(
      outcome.kind === "refused" ? outcome.reason : "",
      /children that would run in your checkout/,
    );
    assert.equal(input.worktree, undefined, "no request is made for a worktree that cannot exist");
  });

  /**
   * `isolation` is the public alias, normalised into `worktree` before the executor sees either —
   * and a call carrying both with different answers is rejected outright
   * (`pi-subagents/src/extension/public-execution.ts:54`). Leaving the stale key next to the flag
   * would turn an isolation fix into a hard tool error.
   */
  it("drops a conflicting isolation: none rather than shipping a call the package rejects", () => {
    const input: Record<string, unknown> = { workflowScript: "runs.run('m', {agent: 'surgeon'})", isolation: "none" };
    const outcome = applyChildrenIsolation(input, CHILDREN);
    assert.deepEqual(outcome, { kind: "package", children: { agents: ["surgeon"], overrode: `isolation: "none"` } });
    assert.equal(input.isolation, undefined);
    assert.equal(input.worktree, true);
  });

  it("overrides worktree: false, and reports that it did", () => {
    const input: Record<string, unknown> = { workflowScript: "runs.run('m', {agent: 'surgeon'})", worktree: false };
    const outcome = applyChildrenIsolation(input, CHILDREN);
    assert.deepEqual(outcome, { kind: "package", children: { agents: ["surgeon"], overrode: "worktree: false" } });
    assert.equal(input.worktree, true);
  });

  it("leaves an isolation: worktree the call already asked for alone", () => {
    const input: Record<string, unknown> = { workflowScript: "runs.run('m', {agent: 'surgeon'})", isolation: "worktree" };
    const outcome = applyChildrenIsolation(input, CHILDREN);
    assert.deepEqual(outcome, { kind: "package", children: { agents: ["surgeon"] } });
    assert.equal(input.isolation, "worktree", "consistent with worktree: true; the package normalises it");
    assert.equal(input.worktree, true);
  });
});

describe("preflightWorktree — asked of real repositories", () => {
  const made: string[] = [];
  const make = (commit = true): string => {
    const dir = repo(commit);
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a directory that is not a repository at all", () => {
    const plain = scratch("ext05-plain-");
    made.push(plain);
    const verdict = preflightWorktree(plain);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /not inside a git working tree/);
  });

  it("refuses an unborn HEAD, because there is no commit to branch from", () => {
    const verdict = preflightWorktree(make(false));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /no HEAD to branch a worktree from/);
  });

  it("accepts a clean repository and reports what the package would branch from", () => {
    const dir = make();
    const verdict = preflightWorktree(dir);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.repoRoot, git(dir, "rev-parse", "--show-toplevel"));
    assert.equal(verdict.baseCommit, git(dir, "rev-parse", "HEAD"));
    assert.ok(verdict.commonDir.startsWith("/"), "a bare `.git` must be resolved, not left relative");
  });

  it("refuses a dirty tree, and says what to do instead of isolation: none", () => {
    const dir = make();
    writeFileSync(join(dir, "README.md"), "edited\n");
    const verdict = preflightWorktree(dir);
    assert.equal(verdict.ok, false);
    const reason = verdict.ok === false ? verdict.reason : "";
    assert.match(reason, /uncommitted change/);
    assert.match(reason, /Commit or stash/);
    assert.match(reason, /Do not answer this by declaring isolation: none/);
  });

  it("ignores the package's own run state, which is exactly what the package ignores", () => {
    const dir = make();
    mkdirSync(join(dir, PACKAGE_STATE_DIR), { recursive: true });
    writeFileSync(join(dir, PACKAGE_STATE_DIR, "run.json"), "{}\n");
    assert.equal(preflightWorktree(dir).ok, true);
  });

  it("identifies a linked worktree by common dir, not by path prefix", () => {
    // The case a prefix test gets wrong: same repository, a toplevel nowhere near the primary
    // checkout. A linked worktree is where this project expects its sessions to run.
    const primary = make();
    const linked = join(scratch("ext05-linked-"), "wt");
    made.push(resolve(linked, ".."));
    git(primary, "worktree", "add", "-q", "-b", "side", linked);
    try {
      const here = preflightWorktree(linked);
      const there = preflightWorktree(primary);
      assert.equal(here.ok, true);
      assert.equal(there.ok, true);
      if (!here.ok || !there.ok) return;
      assert.equal(here.commonDir, there.commonDir, "one repository, so one common dir");
      assert.notEqual(here.repoRoot, there.repoRoot, "and two toplevels that share no prefix");
    } finally {
      git(primary, "worktree", "remove", "--force", linked);
    }
  });
});

describe("preflightWorktree — still agrees with the package it predicts", () => {
  // The preflight is a first-party re-statement of a precondition that lives in `pi-subagents`.
  // Nothing in this tree value-imports that package (Node will not strip types under
  // `node_modules`), so the drift risk is closed here instead: load the real module through jiti,
  // the loader the runtime itself uses, and make it answer.
  const require_ = createRequire(import.meta.url);

  type Create = (
    cwd: string,
    runId: string,
    count: number,
    options?: { baseDir?: string },
  ) => unknown;

  async function createWorktrees(): Promise<Create> {
    const { createJiti } = require_("jiti");
    const jiti = createJiti(import.meta.url, { moduleCache: true });
    // By path, not by specifier: the package's `exports` map publishes its entry point and
    // nothing else, and this file is deliberately reaching past that to the module whose
    // precondition `preflightWorktree` restates. `test/dispatch/watchdog-settings.test.ts` reads
    // the same tree the same way.
    const mod = (await jiti.import(
      fileURLToPath(new URL("../../node_modules/pi-subagents/src/runs/shared/worktree.ts", import.meta.url)),
    )) as { createWorktrees: Create };
    return mod.createWorktrees;
  }

  it("refuses a dirty tree upstream too, which is why the preflight refuses one here", async () => {
    const dir = repo();
    const base = scratch("ext05-wtbase-");
    try {
      writeFileSync(join(dir, "README.md"), "edited\n");
      assert.equal(preflightWorktree(dir).ok, false);
      const create = await createWorktrees();
      assert.throws(() => create(dir, `dirty-${process.pid}`, 1, { baseDir: base }), /clean git working tree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("and builds the tree once the preflight says it can", async () => {
    const dir = repo();
    // The package's default base directory is a fixed path keyed only by run id, so a leftover
    // from an earlier run would fail this for a reason that is not about the code. Its own
    // `baseDir` option is the seam for that.
    const base = scratch("ext05-wtbase-");
    try {
      assert.equal(preflightWorktree(dir).ok, true);
      const create = await createWorktrees();
      const setup = create(dir, `clean-${process.pid}`, 1, { baseDir: base }) as {
        worktrees: Array<{ path: string }>;
      };
      assert.equal(setup.worktrees.length, 1);
      assert.ok(setup.worktrees[0]!.path.startsWith(base));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

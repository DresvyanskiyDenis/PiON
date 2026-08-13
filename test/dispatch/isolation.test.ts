import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyIsolation,
  registerWorktreeProvider,
  resetWorktreeProvider,
  worktreeProvider,
} from "../../extensions/dispatch/isolation.ts";

const REQUEST = { agent: "surgeon", toolCallId: "call-1", cwd: "/repo" };

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
  beforeEach(() => resetWorktreeProvider());

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
    const input: Record<string, unknown> = { agent: "surgeon", prompt: "refactor" };
    assert.deepEqual(await applyIsolation(input, "worktree", REQUEST), { kind: "package" });
    assert.equal(input.worktree, true);
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

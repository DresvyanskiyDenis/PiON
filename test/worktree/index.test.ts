import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import type { ExecResult, ExtensionAPI, ExtensionContext, SessionStartEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { applyIsolation, resetWorktreeProvider } from "../../extensions/dispatch/isolation.ts";
import { getWorktreeInfo, register, resetWorktreeState } from "../../extensions/worktree/index.ts";

const execFileAsync = promisify(execFile);

/**
 * A fake `ExtensionAPI`/`ExtensionContext` pair: real `git` underneath `pi.exec`, but
 * `pi.on`/`pi.events`/`ctx.ui` are captured in-memory so the test can fire the exact events
 * `index.ts` registers for and assert on the exact side effects (status text, bus emissions,
 * notifications) without a real PI runtime.
 */
function makeHarness(cwd: string) {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const busEvents: { channel: string; data: unknown }[] = [];
  const statuses = new Map<string, string | undefined>();
  const notifications: { message: string; type: string }[] = [];

  const pi = {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const { stdout, stderr } = await execFileAsync(command, args, { cwd: options?.cwd, timeout: options?.timeout });
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
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        busEvents.push({ channel, data });
      },
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    // `lib/announce.ts` routes a notice through `ctx.ui.notify` only when hasUI is true;
    // this harness models an interactive session so the two "must report" assertions below
    // (dirty worktree kept, dirty orphan swept-around) observe it on `notifications`, the
    // same channel a real TUI session would receive it on.
    hasUI: true,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
      notify: (message: string, type: string = "info") => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;

  async function fire(event: string, payload: unknown): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  return { pi, ctx, fire, busEvents, statuses, notifications };
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ext23-index-"));
  await execFileAsync("git", ["init", "-q", "--initial-branch=main", dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

const SESSION_START: SessionStartEvent = { type: "session_start", reason: "startup" };

/**
 * `lib/paths.ts`'s `stateRoot()` reads `XDG_STATE_HOME`, exactly like the
 * `PI_CODING_AGENT_DIR=$(mktemp -d)` convention for `~/.pi/agent`. Every test that exercises
 * `createGrant()` (which writes under `<stateRoot>/wt/`) must isolate this the same way, or two
 * test runs racing on the SAME real `~/.local/state/pi-config/wt/<id>` directory collide — and a
 * stray failure leaves worktrees behind in the developer's actual state dir.
 */
function isolateStateHome() {
  const original = process.env.XDG_STATE_HOME;
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext23-state-"));
    process.env.XDG_STATE_HOME = dir;
  });
  after(async () => {
    if (original === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = original;
    await rm(dir, { recursive: true, force: true });
  });
}

describe("worktree/index.ts — detection and publication", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
    resetWorktreeState();
    resetWorktreeProvider();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("publishes isRepo:false and clears the statusline outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext23-notrepo-"));
    try {
      const h = makeHarness(dir);
      register(h.pi);
      await h.fire("session_start", SESSION_START);
      assert.equal(getWorktreeInfo()?.isRepo, false);
      assert.equal(h.statuses.get("worktree"), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes branch + status in the primary checkout, no ⑂ prefix", async () => {
    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);
    const info = getWorktreeInfo();
    assert.equal(info?.isRepo, true);
    assert.equal(info?.isWorktree, false);
    assert.equal(info?.branch, "main");
    assert.equal(h.statuses.get("worktree"), "main");
  });

  it("emits worktree:info on the shared bus", async () => {
    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);
    const evt = h.busEvents.find((e) => e.channel === "worktree:info");
    assert.ok(evt, "expected a worktree:info bus emission");
    assert.equal((evt?.data as { isRepo: boolean }).isRepo, true);
  });
});

describe("worktree/index.ts — isolation provider (EXT-05 integration, real dispatch/isolation.ts)", () => {
  isolateStateHome();
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
    resetWorktreeState();
    resetWorktreeProvider();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("registers itself as provider id 'ext-23', the id dispatch/isolation.ts documents", async () => {
    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    const input: Record<string, unknown> = { agent: "surgeon" };
    const outcome = await applyIsolation(input, "worktree", { agent: "surgeon", toolCallId: "call-1", cwd: repo });
    assert.equal(outcome.kind, "provider");
    assert.equal(outcome.kind === "provider" ? outcome.providerId : undefined, "ext-23");
  });

  it("creates a real worktree under <state>/wt/ for a primary-checkout session, and applyIsolation writes cwd", async () => {
    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    const input: Record<string, unknown> = { agent: "surgeon" };
    const outcome = await applyIsolation(input, "worktree", { agent: "surgeon", toolCallId: "call-abc123", cwd: repo });
    assert.equal(outcome.kind, "provider");
    const grantedCwd = outcome.kind === "provider" ? outcome.cwd : undefined;
    assert.ok(grantedCwd, "expected a granted cwd");
    assert.match(grantedCwd as string, /\/wt\//, "child cwd must live under <state>/wt/");
    assert.equal(input.cwd, grantedCwd);
    assert.equal(input.worktree, undefined, "the package must not also try to create one");

    const st = await stat(grantedCwd as string);
    assert.ok(st.isDirectory());
    const list = (await execFileAsync("git", ["-C", repo, "worktree", "list"])).stdout;
    assert.match(list, /agent\/wt-surgeon-/);

    // Edits inside the child worktree must not appear in the parent checkout (V-26).
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(grantedCwd as string, "SCRATCH.md"), "child work\n");
    await assert.rejects(() => stat(join(repo, "SCRATCH.md")));
  });

  it("never nests: a session already inside a worktree reuses its own root instead of creating another", async () => {
    // Put the "session" itself inside a linked worktree of `repo`.
    const wtPath = join(tmpdir(), `ext23-parent-wt-${process.pid}`);
    await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "wave2-check", wtPath, "HEAD"]);
    try {
      const h = makeHarness(wtPath);
      register(h.pi);
      await h.fire("session_start", SESSION_START);
      assert.equal(getWorktreeInfo()?.isWorktree, true);

      const before = (await execFileAsync("git", ["-C", repo, "worktree", "list"])).stdout;
      const beforeCount = before.trim().split("\n").length;

      const input: Record<string, unknown> = { agent: "isolated-writer" };
      const outcome = await applyIsolation(input, "worktree", {
        agent: "isolated-writer",
        toolCallId: "call-nested",
        cwd: wtPath,
      });
      assert.equal(outcome.kind, "provider");
      // git resolves symlinks (macOS: /var -> /private/var) when it reports --show-toplevel, so
      // compare realpaths rather than the raw tmpdir() string.
      const grantedCwd = outcome.kind === "provider" ? (outcome.cwd as string) : undefined;
      assert.ok(grantedCwd);
      assert.equal(await realpath(grantedCwd as string), await realpath(wtPath), "must reuse, not nest");

      const after = (await execFileAsync("git", ["-C", repo, "worktree", "list"])).stdout;
      const afterCount = after.trim().split("\n").length;
      assert.equal(afterCount, beforeCount, "git worktree list must be unchanged — no nested worktree created");
    } finally {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", wtPath]).catch(() => {});
    }
  });

  it("REFUSES rather than silently running in the checkout when cwd is not a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext23-refuse-"));
    try {
      const h = makeHarness(dir);
      register(h.pi);
      await h.fire("session_start", SESSION_START);

      const input: Record<string, unknown> = { agent: "surgeon" };
      const outcome = await applyIsolation(input, "worktree", { agent: "surgeon", toolCallId: "call-x", cwd: dir });
      assert.equal(outcome.kind, "refused");
      assert.equal(input.cwd, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("worktree/index.ts — eager release on tool_result and crash-safe sweep", () => {
  isolateStateHome();
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
    resetWorktreeState();
    resetWorktreeProvider();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("releases a clean worktree as soon as its dispatch tool_call settles", async () => {
    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    const toolCallId = "call-release-clean";
    const input: Record<string, unknown> = { agent: "surgeon" };
    const outcome = await applyIsolation(input, "worktree", { agent: "surgeon", toolCallId, cwd: repo });
    const grantedCwd = outcome.kind === "provider" ? outcome.cwd : undefined;
    assert.ok(grantedCwd);

    const toolResult: ToolResultEvent = {
      type: "tool_result",
      toolName: "dispatch_agent",
      toolCallId,
      input: {},
      content: [],
      details: undefined,
      isError: false,
    };
    await h.fire("tool_result", toolResult);

    await assert.rejects(() => stat(grantedCwd as string), "clean worktree must be reclaimed immediately");
    const list = (await execFileAsync("git", ["-C", repo, "worktree", "list"])).stdout;
    assert.doesNotMatch(list, /agent\/wt-surgeon-/);
  });

  it("keeps a dirty worktree at tool_result time and reports it — never rm -rf uncommitted work", async () => {
    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    const toolCallId = "call-release-dirty";
    const input: Record<string, unknown> = { agent: "scout" };
    const outcome = await applyIsolation(input, "worktree", { agent: "scout", toolCallId, cwd: repo });
    const grantedCwd = outcome.kind === "provider" ? (outcome.cwd as string) : undefined;
    assert.ok(grantedCwd);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(grantedCwd as string, "uncommitted.md"), "keep me\n");

    const toolResult: ToolResultEvent = {
      type: "tool_result",
      toolName: "dispatch_agent",
      toolCallId,
      input: {},
      content: [],
      details: undefined,
      isError: false,
    };
    await h.fire("tool_result", toolResult);

    const st = await stat(grantedCwd as string);
    assert.ok(st.isDirectory(), "dirty worktree must survive the release attempt");
    assert.ok(
      h.notifications.some((n) => n.message.includes("not reclaiming") && n.message.includes(grantedCwd as string)),
      "must report why it was kept",
    );

    await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", grantedCwd as string]);
  });

  it("sweep at the next session_start reclaims a clean worktree orphaned by a dead pid", async () => {
    const regDir = join(repo, ".git");
    const { writeFile: wf, mkdir } = await import("node:fs/promises");
    await mkdir(regDir, { recursive: true });

    const orphanPath = join(tmpdir(), `ext23-orphan-clean-${process.pid}`);
    await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "agent/wt-orphan-clean", orphanPath, "HEAD"]);

    const deadPid = 2 ** 30; // never a real pid
    await wf(
      join(regDir, "pi-worktrees.json"),
      JSON.stringify({
        "wt-orphan-clean": {
          id: "wt-orphan-clean",
          path: orphanPath,
          repo,
          branch: "agent/wt-orphan-clean",
          ownerPid: deadPid,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    await assert.rejects(() => stat(orphanPath), "a clean orphaned worktree must be swept away");
  });

  it("sweep keeps a dirty worktree orphaned by a dead pid and reports it, dropping nothing", async () => {
    const regDir = join(repo, ".git");
    const { writeFile: wf, mkdir } = await import("node:fs/promises");
    await mkdir(regDir, { recursive: true });

    const orphanPath = join(tmpdir(), `ext23-orphan-dirty-${process.pid}`);
    await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "agent/wt-orphan-dirty", orphanPath, "HEAD"]);
    await wf(join(orphanPath, "uncommitted.md"), "do not delete me\n");

    const deadPid = 2 ** 30;
    await wf(
      join(regDir, "pi-worktrees.json"),
      JSON.stringify({
        "wt-orphan-dirty": {
          id: "wt-orphan-dirty",
          path: orphanPath,
          repo,
          branch: "agent/wt-orphan-dirty",
          ownerPid: deadPid,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    const st = await stat(orphanPath);
    assert.ok(st.isDirectory(), "dirty orphaned worktree must survive the sweep");
    assert.ok(
      h.notifications.some((n) => n.message.includes("orphaned worktree with uncommitted changes")),
      "sweep must report the orphan by name",
    );

    const registry = JSON.parse(await readFile(join(regDir, "pi-worktrees.json"), "utf8"));
    assert.ok(registry["wt-orphan-dirty"], "the entry must not be dropped for a tree that was kept");

    await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", orphanPath]);
  });

  it("sweep leaves alone a worktree whose owner pid is still alive", async () => {
    const regDir = join(repo, ".git");
    const { writeFile: wf, mkdir } = await import("node:fs/promises");
    await mkdir(regDir, { recursive: true });

    const livePath = join(tmpdir(), `ext23-live-${process.pid}`);
    await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "agent/wt-live", livePath, "HEAD"]);
    await wf(
      join(regDir, "pi-worktrees.json"),
      JSON.stringify({
        "wt-live": {
          id: "wt-live",
          path: livePath,
          repo,
          branch: "agent/wt-live",
          ownerPid: process.pid, // this test process — very much alive
          createdAt: new Date().toISOString(),
        },
      }),
    );

    const h = makeHarness(repo);
    register(h.pi);
    await h.fire("session_start", SESSION_START);

    const st = await stat(livePath);
    assert.ok(st.isDirectory(), "a worktree whose owner is still running must be left alone");

    await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", livePath]).catch(() => {});
  });
});

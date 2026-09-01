import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { id, looksLikeNode, register, resolveNodeExecutable, type NodeResolutionSources } from "../../extensions/digest/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

// ---------------------------------------------------------------------------
// harness — same shape as test/session-context.test.ts's fakePi/fakeCtx
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "PI_DIGEST_WORKER",
  "PI_SUBAGENT_NAME",
  "PI_DIGEST_CONFIG",
  "XDG_STATE_HOME",
  "PI_ROUTING_JSON",
  "PI_DIGEST_NODE_BIN",
] as const;

let sandbox: string;
let savedEnv: Record<string, string | undefined>;
let counter = 0;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-digest-index-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetSurfaced();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fakePi() {
  const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      assert.equal(handlers.has(event), false, `duplicate handler bound for ${event}`);
      handlers.set(event, handler);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

interface FakeSession {
  sessionId: string;
  sessionFile?: string;
  entryCount: number;
}

function fakeCtx(session: FakeSession, cwd: string) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    hasUI: false,
    cwd,
    sessionManager: {
      getSessionFile: () => session.sessionFile,
      getSessionId: () => session.sessionId,
      getEntries: () => Array.from({ length: session.entryCount }, () => ({ type: "message" })),
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, notifications };
}

async function writeDigestConfig(overrides: Record<string, unknown>): Promise<string> {
  const path = join(sandbox, `digest-${counter++}.json`);
  await writeFile(path, JSON.stringify({ digest: overrides }));
  return path;
}

async function writeSession(name: string, body = `{"type":"info"}\n`): Promise<string> {
  const path = join(sandbox, `${name}-${counter++}.jsonl`);
  await writeFile(path, body);
  return path;
}

/** Polls a directory until it has at least `n` entries or the deadline passes. */
async function waitForFileCount(dir: string, n: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.length >= n || Date.now() > deadline) return entries;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Waits for the postcondition the drain actually establishes: `n` digests written AND the queue
 * emptied. Both, or neither is a finished drain.
 *
 * Waiting on the file count alone is a race, and it is the one that made this file flaky.
 * `bin/pi-digest-drain` writes the digest and only THEN unlinks the job — the crash-safe order,
 * since unlinking first would lose a session's transcript to a mid-write kill. So the instant the
 * n-th digest appears there is still a `.json` in the queue, for as long as the `rm` takes. On an
 * idle machine that is under a millisecond and the next assertion never notices; under concurrent
 * suite load the process can lose the CPU inside that window and the queue assertion reads the job
 * that is about to be removed.
 *
 * Proven rather than reasoned: inserting a 200 ms sleep between the drain's `writeDigest` and its
 * `rm` reproduces the observed failure exactly — file count and per-session assertions pass, the
 * queue assertion fails — with no load and no timeout involved.
 *
 * The budget is therefore NOT the fix and has not been raised. Measured end-to-end drain time for
 * these five jobs: ~1.5 s idle, ~2.5 s with 6 busy cores, and the last-file-to-empty-queue lag is
 * ~1 ms. 10 s stays a wide margin over the real work; what changed is that the wait now ends when
 * the work is done instead of when it is nearly done.
 */
async function waitForDrain(
  outDir: string,
  queueDir: string,
  n: number,
  timeoutMs: number,
): Promise<{ files: string[]; queued: string[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = await readdir(outDir).catch(() => [] as string[]);
    const queued = (await readdir(queueDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
    if ((files.length >= n && queued.length === 0) || Date.now() > deadline) return { files, queued };
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------

describe("digest — module contract", () => {
  it("exports a stable id used by manifest.ts / doctor / the deadman", () => {
    assert.equal(id, "digest");
  });
});

describe("digest — recursion guards fire before any await (wave1-specs.md §3.2: register() must stay fast)", () => {
  it("guard 1 — PI_DIGEST_WORKER=1: register() returns synchronously and binds nothing", () => {
    process.env.PI_DIGEST_WORKER = "1";
    const { pi, handlers } = fakePi();
    const result = register(pi);
    assert.equal(result, undefined, "must be a plain synchronous return, not a resolved promise");
    assert.equal(handlers.size, 0);
  });

  it("guard 2 — PI_SUBAGENT_NAME set: a subagent turn is not a session a human digests", () => {
    process.env.PI_SUBAGENT_NAME = "researcher";
    const { pi, handlers } = fakePi();
    const result = register(pi);
    assert.equal(result, undefined);
    assert.equal(handlers.size, 0);
  });
});

describe("digest — config-driven enable/disable", () => {
  it("digest.enabled=false: resolves without binding session_shutdown or session_before_compact", async () => {
    process.env.PI_DIGEST_CONFIG = await writeDigestConfig({ enabled: false });
    const { pi, handlers } = fakePi();
    await register(pi);
    assert.equal(handlers.size, 0);
  });

  it("digest.enabled=true (default, no file present): both events are bound", async () => {
    process.env.PI_DIGEST_CONFIG = join(sandbox, "never-written.json");
    const { pi, handlers } = fakePi();
    await register(pi);
    assert.deepEqual([...handlers.keys()].sort(), ["session_before_compact", "session_shutdown"]);
  });

  it("a present-but-malformed config throws — index.ts's per-module try/catch is the only thing that swallows this", async () => {
    process.env.PI_DIGEST_CONFIG = await writeDigestConfig({ summarizer: { kind: "not-a-real-kind" } });
    const { pi } = fakePi();
    await assert.rejects(async () => {
      await register(pi);
    });
  });
});

describe("digest — session_shutdown gating", () => {
  it("--no-session runs (no session file) are skipped, no job spooled, no error", async () => {
    const xdg = join(sandbox, `xdg-${counter++}`);
    process.env.XDG_STATE_HOME = xdg;
    process.env.PI_DIGEST_CONFIG = join(sandbox, "unused.json");
    const { pi, handlers } = fakePi();
    await register(pi);
    const handler = handlers.get("session_shutdown")!;
    const { ctx, notifications } = fakeCtx({ sessionId: "no-file", sessionFile: undefined, entryCount: 10 }, sandbox);

    await handler({ type: "session_shutdown", reason: "quit" }, ctx);

    const queueDir = join(xdg, "pi-config", "digest-queue");
    assert.deepEqual(await readdir(queueDir).catch(() => []), []);
    assert.deepEqual(notifications, []);
  });

  it("a session below minTurns is never spooled", async () => {
    const xdg = join(sandbox, `xdg-${counter++}`);
    process.env.XDG_STATE_HOME = xdg;
    process.env.PI_DIGEST_CONFIG = await writeDigestConfig({ minTurns: 5, outputDir: join(sandbox, `out-${counter}`) });
    const { pi, handlers } = fakePi();
    await register(pi);
    const handler = handlers.get("session_shutdown")!;
    const sessionFile = await writeSession("short");
    const { ctx } = fakeCtx({ sessionId: "short-session", sessionFile, entryCount: 2 }, sandbox);

    await handler({ type: "session_shutdown", reason: "quit" }, ctx);

    const queueDir = join(xdg, "pi-config", "digest-queue");
    assert.deepEqual(await readdir(queueDir).catch(() => []), []);
  });

  it("a qualifying session enqueues a job carrying the shutdown reason", async () => {
    const xdg = join(sandbox, `xdg-${counter++}`);
    process.env.XDG_STATE_HOME = xdg;
    // "off" summarizer: exercises the real spool + runDetached + bin/pi-digest-drain chain with
    // zero token spend and no external binary dependency.
    process.env.PI_DIGEST_CONFIG = await writeDigestConfig({
      minTurns: 0,
      outputDir: join(sandbox, `out-${counter}`),
      summarizer: { kind: "off" },
    });
    const { pi, handlers } = fakePi();
    await register(pi);
    const handler = handlers.get("session_shutdown")!;
    const sessionFile = await writeSession("qualifying");
    const { ctx } = fakeCtx({ sessionId: "qualifying-session", sessionFile, entryCount: 4 }, sandbox);

    await handler({ type: "session_shutdown", reason: "reload" }, ctx);

    const outDir = JSON.parse(await readFile(process.env.PI_DIGEST_CONFIG!, "utf8")).digest.outputDir;
    const files = await waitForFileCount(outDir, 1, 8_000);
    assert.equal(files.length, 1);
    const body = await readFile(join(outDir, files[0]), "utf8");
    assert.match(body, /digest_version: 2/);
    assert.match(body, /reason: shutdown:reload/);
    assert.match(body, /\(summarizer disabled\)/);
  });
});

describe("digest — session_before_compact must never cancel or override compaction", () => {
  it("returns exactly undefined, both when nothing qualifies and on the real spool+spawn path", async () => {
    const xdg = join(sandbox, `xdg-${counter++}`);
    process.env.XDG_STATE_HOME = xdg;
    process.env.PI_DIGEST_CONFIG = await writeDigestConfig({
      minTurns: 0,
      outputDir: join(sandbox, `out-${counter}`),
      summarizer: { kind: "off" },
    });
    const { pi, handlers } = fakePi();
    await register(pi);
    const handler = handlers.get("session_before_compact")!;

    const { ctx: emptyCtx } = fakeCtx({ sessionId: "s-empty", sessionFile: undefined, entryCount: 0 }, sandbox);
    const r1 = await handler({ type: "session_before_compact", reason: "threshold" }, emptyCtx);
    assert.equal(r1, undefined);

    const sessionFile = await writeSession("compact");
    const { ctx: realCtx } = fakeCtx({ sessionId: "s-real", sessionFile, entryCount: 3 }, sandbox);
    const r2 = await handler({ type: "session_before_compact", reason: "manual" }, realCtx);
    assert.equal(r2, undefined, "must never return {cancel} or {compaction} — that is not this extension's job");
  });
});

describe("digest — looksLikeNode", () => {
  it("recognises node and node.exe, case-insensitively, regardless of directory", () => {
    assert.equal(looksLikeNode("/usr/bin/node"), true);
    assert.equal(looksLikeNode("C:\\Program Files\\nodejs\\node.exe"), true);
    assert.equal(looksLikeNode("/usr/local/bin/NODE"), true);
  });

  it("rejects the standalone pi binary — the exact REQ-PRV-61 failure mode", () => {
    assert.equal(looksLikeNode("/usr/local/bin/pi"), false);
    assert.equal(looksLikeNode("/opt/pi/pi.exe"), false);
    // A name that merely contains "node" (an unrelated tool, a directory) must not pass either.
    assert.equal(looksLikeNode("/usr/bin/nodemon"), false);
  });
});

describe("digest — resolveNodeExecutable (REQ-PRV-61: process.execPath is `pi` in binary mode)", () => {
  function sources(overrides: Partial<NodeResolutionSources> = {}): NodeResolutionSources {
    return {
      execPath: "/usr/bin/node",
      env: {},
      platform: "linux",
      fileExists: () => false,
      ...overrides,
    };
  }

  it("uses execPath unchanged when it already looks like node — the ordinary dev/npm case", () => {
    assert.equal(resolveNodeExecutable(sources({ execPath: "/usr/bin/node" })), "/usr/bin/node");
  });

  it("an explicit PI_DIGEST_NODE_BIN override wins even when execPath already looks like node", () => {
    assert.equal(
      resolveNodeExecutable(sources({ execPath: "/usr/bin/node", env: { PI_DIGEST_NODE_BIN: "/custom/node" } })),
      "/custom/node",
    );
  });

  it("binary mode: execPath is the pi binary, PATH has a real node — finds it", () => {
    const found = "/opt/homebrew/bin/node";
    const result = resolveNodeExecutable(
      sources({
        execPath: "/usr/local/bin/pi",
        env: { PATH: "/usr/bin:/opt/homebrew/bin" },
        fileExists: (p) => p === found,
      }),
    );
    assert.equal(result, found);
  });

  it("binary mode: searches PATH left to right and stops at the first match", () => {
    const result = resolveNodeExecutable(
      sources({
        execPath: "/usr/local/bin/pi",
        env: { PATH: "/first/bin:/second/bin" },
        fileExists: (p) => p === "/first/bin/node" || p === "/second/bin/node",
      }),
    );
    assert.equal(result, "/first/bin/node");
  });

  it("binary mode on Windows: searches PATH for node.exe, not node", () => {
    const result = resolveNodeExecutable(
      sources({
        execPath: "C:\\Program Files\\pi\\pi.exe",
        platform: "win32",
        env: { PATH: "C:\\nodejs" },
        fileExists: (p) => p === "C:\\nodejs\\node.exe",
      }),
    );
    assert.equal(result, "C:\\nodejs\\node.exe");
  });

  it("binary mode, node nowhere on PATH: falls back to the bare 'node' — spawn() still searches PATH itself, and an unresolvable node is already reported through runDetached's onError", () => {
    const result = resolveNodeExecutable(
      sources({ execPath: "/usr/local/bin/pi", env: { PATH: "/usr/bin:/bin" }, fileExists: () => false }),
    );
    assert.equal(result, "node");
  });

  it("binary mode, no PATH at all: still falls back to 'node' rather than throwing", () => {
    assert.doesNotThrow(() => resolveNodeExecutable(sources({ execPath: "/usr/local/bin/pi", env: {} })));
  });

  it("the default sources honour the real PI_DIGEST_NODE_BIN override", () => {
    process.env.PI_DIGEST_NODE_BIN = "/env-configured/node";
    assert.equal(resolveNodeExecutable(), "/env-configured/node");
  });
});

describe("digest — REQ-EXT-22 acceptance: five sessions exiting inside ten seconds", () => {
  it("yields exactly one digest file per session and drains the queue, through the real extension->spool->runDetached->bin/pi-digest-drain chain", async () => {
    const xdg = join(sandbox, `xdg-${counter++}`);
    const outDir = join(sandbox, `out-e2e-${counter}`);
    process.env.XDG_STATE_HOME = xdg;
    process.env.PI_DIGEST_CONFIG = await writeDigestConfig({
      minTurns: 0,
      outputDir: outDir,
      // A real subprocess (cat), not "off", so this also proves the summariser spawn path
      // (spawnCapture's stdin write/close) works under the same real-detach conditions the
      // "off" tests above don't exercise.
      summarizer: { kind: "command", argv: ["cat"], timeoutMs: 5_000 },
    });
    const { pi, handlers } = fakePi();
    await register(pi);
    const handler = handlers.get("session_shutdown")!;

    // Real PI session ids are full UUIDs; the output filename intentionally truncates to an
    // 8-hex-char prefix, mirroring OpenCode's own digest convention. Five sequential
    // human-readable ids ("sess-e2e-1".."sess-e2e-5") all share that first-8-char prefix and
    // would collide by construction — that is a defect in this test's fixture data, not in the
    // filename scheme, so the fixture now uses realistic random-UUID-shaped ids instead.
    const sessionIds = Array.from({ length: 5 }, (_, i) => `${randomUUID()}-e2e-${i + 1}`);
    for (const sessionId of sessionIds) {
      const sessionFile = await writeSession(sessionId, `{"session":"${sessionId}"}\n`);
      const { ctx } = fakeCtx({ sessionId, sessionFile, entryCount: 3 }, sandbox);
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    }

    const queueDir = join(xdg, "pi-config", "digest-queue");
    const { files, queued } = await waitForDrain(outDir, queueDir, sessionIds.length, 10_000);
    assert.equal(files.length, sessionIds.length, `expected ${sessionIds.length} digests, got [${files.join(", ")}]`);
    for (const sessionId of sessionIds) {
      assert.ok(
        files.some((f) => f.includes(sessionId.slice(0, 8))),
        `no digest file for ${sessionId} among [${files.join(", ")}]`,
      );
    }

    // `queued` is the same read the wait ended on, not a fresh one: re-reading here would put the
    // race back, one poll interval later.
    assert.deepEqual(queued, [], "the queue must be fully drained — nothing lost, nothing stuck");
  });
});

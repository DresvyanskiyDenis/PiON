// EXT-11's `"compact"` control handler (`extensions/compaction/peer.ts`).
//
// `agentsRoot()` reads `XDG_STATE_HOME` fresh on every call (its own doc comment: "so a test can
// move XDG_STATE_HOME"), which is the seam this file uses — no directory.ts function here takes an
// explicit root, unlike directory.test.ts, because peer.ts calls `deliver`/`agentsRoot` the same
// way `register()` does in production: through the ambient state root, not an injected one.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { agentsRoot, drainInbox } from "../../extensions/message-agent/directory.ts";
import {
  __resetPeerCompactStateForTests,
  createPeerCompactHandler,
  resetPeerCompactStateForSession,
} from "../../extensions/compaction/peer.ts";

let sandbox: string;
let previousXdgStateHome: string | undefined;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-peer-compact-"));
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = sandbox;
});
after(async () => {
  if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousXdgStateHome;
  await rm(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  __resetPeerCompactStateForTests();
});
afterEach(() => {
  __resetPeerCompactStateForTests();
});

// Each test uses its own sender name: `agentsRoot()` is one real directory shared for the whole
// file (see the header above), so a name reused across tests would let one test's reply land in
// an inbox a later test is also reading from.
function envelope(from: string, overrides: Record<string, unknown> = {}) {
  return { id: "env-1", from, fromSessionId: `sess-${from}`, at: Date.now(), ...overrides };
}

function control(selfSessionId: string, overrides: Record<string, unknown> = {}) {
  return { pi: {}, selfName: "self", selfSessionId, ...overrides };
}

/** `ctx.compact()`'s callback runs synchronously, matching what an in-process fake can promise. */
function fakeCtx({
  idle = true,
  onCompact,
}: {
  idle?: boolean;
  onCompact?: (options: { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void }) => void;
} = {}) {
  return {
    isIdle: () => idle,
    compact: (options: Parameters<NonNullable<typeof onCompact>>[0] = {}) => {
      if (onCompact) onCompact(options);
    },
  };
}

/**
 * `onComplete`/`onError`'s own reply is `void replyToSender(...)` — fire-and-forget, deliberately:
 * a real `ctx.compact()` calls these whenever compaction actually finishes, long after
 * `dispatchControl` has moved on, so nothing in production ever awaits them either. A test that
 * calls the fake synchronously still has to let that detached write actually reach disk before
 * reading it back.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function reads(target: string) {
  const { messages } = await drainInbox(agentsRoot(), target);
  return messages;
}

describe("createPeerCompactHandler", () => {
  it("defers rather than compacting mid-turn", async () => {
    const handler = createPeerCompactHandler(5 * 60_000);
    const result = await handler(
      envelope("sender-midrun"),
      fakeCtx({ idle: false }) as never,
      control("sess-midrun") as never,
    );
    assert.deepEqual(result, { outcome: "deferred", detail: "session is mid-turn" });
  });

  it("compacts and reports ok with the reclaimed token count", async () => {
    const handler = createPeerCompactHandler(5 * 60_000);
    const ctx = fakeCtx({
      onCompact: (options) => {
        options.onComplete?.({ tokensBefore: 150_000, estimatedTokensAfter: 40_000 });
      },
    });
    const result = await handler(
      envelope("sender-ok", { instructions: "keep it brief" }),
      ctx as never,
      control("sess-ok") as never,
    );
    assert.deepEqual(result, { outcome: "ok" });
    await settle();

    const replies = await reads("sender-ok");
    assert.equal(replies.length, 1);
    assert.match(replies[0]!.message, /^ok: compacted/);
    assert.match(replies[0]!.message, /~110k tokens/);
  });

  it("reports refused, not ok, when compact() throws synchronously", async () => {
    const handler = createPeerCompactHandler(5 * 60_000);
    const ctx = fakeCtx({
      onCompact: () => {
        throw new Error("no model selected");
      },
    });
    const result = await handler(envelope("sender-throw"), ctx as never, control("sess-throw") as never);
    assert.equal(result.outcome, "refused");

    const replies = await reads("sender-throw");
    assert.equal(replies.length, 1);
    assert.match(replies[0]!.message, /^refused: compact failed internally: .*no model selected/);
  });

  it("rate-limits a second request within minIntervalMs, and replies refused rather than silently dropping it", async () => {
    const handler = createPeerCompactHandler(5 * 60_000);
    const ctx = fakeCtx({ onCompact: (o) => o.onComplete?.({ tokensBefore: 100, estimatedTokensAfter: 10 }) });

    const first = await handler(
      envelope("sender-ratelimit", { id: "env-1" }),
      ctx as never,
      control("sess-ratelimit") as never,
    );
    assert.equal(first.outcome, "ok");
    await settle();

    const second = await handler(
      envelope("sender-ratelimit", { id: "env-2" }),
      ctx as never,
      control("sess-ratelimit") as never,
    );
    assert.equal(second.outcome, "refused");

    const replies = await reads("sender-ratelimit");
    assert.equal(replies.length, 2);
    assert.match(replies[1]!.message, /^refused: this session compacted for a peer/);
  });

  it("resetPeerCompactStateForSession lifts the rate limit for that session", async () => {
    const handler = createPeerCompactHandler(5 * 60_000);
    const ctx = fakeCtx({ onCompact: (o) => o.onComplete?.({ tokensBefore: 100, estimatedTokensAfter: 10 }) });

    const first = await handler(
      envelope("sender-reset", { id: "env-1" }),
      ctx as never,
      control("sess-reset") as never,
    );
    assert.equal(first.outcome, "ok");

    resetPeerCompactStateForSession("sess-reset");

    const second = await handler(
      envelope("sender-reset", { id: "env-2" }),
      ctx as never,
      control("sess-reset") as never,
    );
    assert.equal(second.outcome, "ok");
  });
});

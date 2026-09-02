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
import type { Envelope } from "../../extensions/message-agent/directory.ts";
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

async function reads(target: string) {
  const { messages } = await drainInbox(agentsRoot(), target);
  return messages;
}

/**
 * `onComplete`/`onError`'s own reply is `void replyToSender(...)` — fire-and-forget, deliberately:
 * a real `ctx.compact()` calls these whenever compaction actually finishes, long after
 * `dispatchControl` has moved on, so nothing in production ever awaits them either. A test that
 * calls the fake synchronously still has to let that detached write actually reach disk before
 * reading it back — a fixed sleep guesses how long that takes and is wrong under load (GH#25: a
 * `settle()` short enough to keep the suite fast landed before the write under parallel load, same
 * class of race as `directory.test.ts`'s gh#33 staging tests). Polling for the expected count
 * instead returns the instant the write actually lands, and only spends up to `timeoutMs` in the
 * one case that matters: a write that genuinely never arrives, which is exactly when the caller's
 * own assertion should see the real, incomplete state and fail on it.
 *
 * `reads()` (`drainInbox`) is a dequeue, not a peek: every call moves whatever it finds out of the
 * inbox into `.delivering/`, so a poll that only looked at the latest call's count would silently
 * lose an envelope a prior, too-early poll had already drained — accumulating across calls is what
 * makes repeated polling of a destructive read safe.
 */
async function waitForReplies(target: string, expectedCount: number, timeoutMs = 2_000) {
  const collected: Envelope[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    collected.push(...(await reads(target)));
    if (collected.length >= expectedCount || Date.now() > deadline) return collected;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

    const replies = await waitForReplies("sender-ok", 1);
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
    // No settle needed here: the rate limit itself is set synchronously (`lastPeerCompactAt.set(...)`
    // runs before `ctx.compact()` is even called), so the second call's own outcome does not depend
    // on the first reply having reached disk yet.

    const second = await handler(
      envelope("sender-ratelimit", { id: "env-2" }),
      ctx as never,
      control("sess-ratelimit") as never,
    );
    assert.equal(second.outcome, "refused");

    // The first reply ("ok") is fire-and-forget; the second ("refused") is awaited synchronously
    // inside the handler before it returns. Which one's write actually lands on disk first is not
    // guaranteed by that — the first's write was merely *started* earlier, not finished — so this
    // matches on content, not position.
    const replies = await waitForReplies("sender-ratelimit", 2);
    assert.equal(replies.length, 2);
    assert.ok(replies.some((r) => /^ok: compacted/.test(r.message)));
    assert.ok(replies.some((r) => /^refused: this session compacted for a peer/.test(r.message)));
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

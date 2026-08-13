import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { backfill } from "../../extensions/session-index/backfill.ts";
import { openIndexDb, resetIndexDbCache } from "../../extensions/session-index/db.ts";

let sandbox: string;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "session-index-backfill-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function line(entry: unknown): string {
  return JSON.stringify(entry) + "\n";
}

function assistantLine(id: string, parentId: string | null, ts: string, cost: number) {
  return line({
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-x",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      stopReason: "stop",
      timestamp: Date.parse(ts),
    },
  });
}

function sessionInfo(over: Partial<SessionInfo> & { path: string; id: string }): SessionInfo {
  return {
    cwd: "/repo",
    created: new Date("2026-08-01T09:00:00.000Z"),
    modified: new Date("2026-08-01T09:05:00.000Z"),
    messageCount: 1,
    firstMessage: "hi",
    allMessagesText: "hi",
    ...over,
  };
}

describe("backfill", () => {
  it("indexes a single session end to end", async () => {
    const dir = await mkdtemp(join(sandbox, "single-"));
    const path = join(dir, "a.jsonl");
    await writeFile(
      path,
      line({ type: "session", version: 3, id: "sess-a", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        assistantLine("e1", null, "2026-08-01T09:00:01.000Z", 0.05),
    );
    resetIndexDbCache();
    const db = openIndexDb(join(dir, "index.db"));
    const result = backfill(db, [sessionInfo({ path, id: "sess-a" })]);
    assert.equal(result.indexed, 1);
    assert.deepEqual(result.skipped, []);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("sess-a")!;
    assert.equal(row.turns, 1);
    assert.equal(row.tokens_input, 100);
    assert.equal(row.cost_known, 1);
    assert.equal(row.cost_usd, 0.05);
    assert.equal(row.parent_id, null);
  });

  it("resolves parent_id by mapping SessionHeader.parentSession (a file path) through the sibling file's own id", async () => {
    const dir = await mkdtemp(join(sandbox, "parent-"));
    const parentPath = join(dir, "parent.jsonl");
    const childPath = join(dir, "child.jsonl");
    await writeFile(
      parentPath,
      line({ type: "session", version: 3, id: "sess-parent", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        assistantLine("e1", null, "2026-08-01T09:00:01.000Z", 0.01),
    );
    await writeFile(
      childPath,
      line({
        type: "session",
        version: 3,
        id: "sess-child",
        timestamp: "2026-08-01T09:10:00.000Z",
        cwd: "/repo",
        parentSession: parentPath,
      }) + assistantLine("e1", null, "2026-08-01T09:10:01.000Z", 0.02),
    );
    resetIndexDbCache();
    const db = openIndexDb(join(dir, "index.db"));
    const result = backfill(db, [
      sessionInfo({ path: parentPath, id: "sess-parent" }),
      sessionInfo({ path: childPath, id: "sess-child", parentSessionPath: parentPath }),
    ]);
    assert.equal(result.indexed, 2);

    const child = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get("sess-child")!;
    assert.equal(child.parent_id, "sess-parent");
  });

  it("REQ-PRV-74: a github-copilot session gets cost_known=0 and cost_usd NULL even though usage.cost.total was nonzero", async () => {
    const dir = await mkdtemp(join(sandbox, "copilot-"));
    const path = join(dir, "c.jsonl");
    await writeFile(
      path,
      line({ type: "session", version: 3, id: "sess-c", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        line({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-01T09:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            api: "openai-responses",
            provider: "github-copilot",
            model: "gpt-x",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.parse("2026-08-01T09:00:01.000Z"),
          },
        }),
    );
    resetIndexDbCache();
    const db = openIndexDb(join(dir, "index.db"));
    backfill(db, [sessionInfo({ path, id: "sess-c" })]);
    const row = db.prepare("SELECT cost_usd, cost_known FROM sessions WHERE id = ?").get("sess-c")!;
    assert.equal(row.cost_known, 0);
    assert.equal(row.cost_usd, null);
  });

  it("a malformed session file is skipped, not fatal — the rest of the batch still indexes", async () => {
    const dir = await mkdtemp(join(sandbox, "skip-"));
    const goodPath = join(dir, "good.jsonl");
    const badPath = join(dir, "missing.jsonl"); // never written — read will throw ENOENT
    await writeFile(
      goodPath,
      line({ type: "session", version: 3, id: "sess-good", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        assistantLine("e1", null, "2026-08-01T09:00:01.000Z", 0.01),
    );
    resetIndexDbCache();
    const db = openIndexDb(join(dir, "index.db"));
    const result = backfill(db, [
      sessionInfo({ path: goodPath, id: "sess-good" }),
      sessionInfo({ path: badPath, id: "sess-bad" }),
    ]);
    assert.equal(result.indexed, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.path, badPath);
    assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get("sess-good"));
    assert.equal(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get("sess-bad"), undefined);
  });

  it("read-only by construction (E5): every session file is byte-identical before and after a full backfill", async () => {
    const dir = await mkdtemp(join(sandbox, "readonly-"));
    const path1 = join(dir, "one.jsonl");
    const path2 = join(dir, "two.jsonl");
    await writeFile(
      path1,
      line({ type: "session", version: 3, id: "sess-1", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        assistantLine("e1", null, "2026-08-01T09:00:01.000Z", 0.01),
    );
    await writeFile(
      path2,
      line({ type: "session", version: 3, id: "sess-2", timestamp: "2026-08-01T09:00:00.000Z", cwd: "/repo" }) +
        assistantLine("e1", null, "2026-08-01T09:00:01.000Z", 0.02),
    );
    const before1 = await readFile(path1, "utf8");
    const before2 = await readFile(path2, "utf8");

    resetIndexDbCache();
    const db = openIndexDb(join(dir, "index.db"));
    backfill(db, [sessionInfo({ path: path1, id: "sess-1" }), sessionInfo({ path: path2, id: "sess-2" })]);

    assert.equal(await readFile(path1, "utf8"), before1);
    assert.equal(await readFile(path2, "utf8"), before2);
  });
});

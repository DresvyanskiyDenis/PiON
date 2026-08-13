import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readSessionFile } from "../../extensions/session-index/session-file.ts";

let sandbox: string;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "session-index-file-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function sessionJsonl(): string {
  const header = { type: "session", version: 3, id: "sess-1", timestamp: "2026-08-01T10:00:00.000Z", cwd: "/repo" };
  const userMsg = {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-08-01T10:00:01.000Z",
    message: { role: "user", content: "hi", timestamp: Date.parse("2026-08-01T10:00:01.000Z") },
  };
  const assistantMsg = {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-08-01T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-x",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: "stop",
      timestamp: Date.parse("2026-08-01T10:00:02.000Z"),
    },
  };
  return [header, userMsg, assistantMsg].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("readSessionFile", () => {
  it("splits the header out from the entries", async () => {
    const path = join(sandbox, "s1.jsonl");
    await writeFile(path, sessionJsonl());
    const { header, entries } = readSessionFile(path);
    assert.equal(header?.id, "sess-1");
    assert.equal(header?.cwd, "/repo");
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.type, "message");
  });

  it("never writes to the file it reads — byte-identical before and after, and mtime untouched", async () => {
    const path = join(sandbox, "s2.jsonl");
    await writeFile(path, sessionJsonl());
    const before = await readFile(path, "utf8");
    const statBefore = await stat(path);
    readSessionFile(path);
    const after = await readFile(path, "utf8");
    const statAfter = await stat(path);
    assert.equal(after, before);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
  });

  it("skips a malformed line instead of throwing (parseSessionEntries' own contract)", async () => {
    const path = join(sandbox, "s3.jsonl");
    const content = sessionJsonl() + "{not json\n";
    await writeFile(path, content);
    const { header, entries } = readSessionFile(path);
    assert.equal(header?.id, "sess-1");
    assert.equal(entries.length, 2, "the malformed trailing line must be skipped, not crash the parse");
  });

  it("throws on a missing file — callers decide how to handle that, this layer doesn't swallow it", () => {
    assert.throws(() => readSessionFile(join(sandbox, "does-not-exist.jsonl")));
  });
});

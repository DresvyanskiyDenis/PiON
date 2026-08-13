import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { all, drop, record, registryPath } from "../../extensions/worktree/registry.ts";
import type { RegistryEntry } from "../../extensions/worktree/registry.ts";

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "wt-scout-a1b2",
    path: "/state/wt/wt-scout-a1b2",
    repo: "/repo",
    branch: "agent/wt-scout-a1b2",
    ownerPid: process.pid,
    toolCallId: "call-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("registry.ts", () => {
  let dir: string;
  let path: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext23-registry-"));
    path = registryPath(dir);
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registryPath places the file next to the git-common-dir", () => {
    assert.equal(path, join(dir, "pi-worktrees.json"));
  });

  it("all() on a missing registry file returns empty, never throws", async () => {
    assert.deepEqual(await all(join(dir, "does-not-exist.json")), []);
  });

  it("record() then all() round-trips one entry", async () => {
    const entry = makeEntry();
    await record(path, entry);
    const entries = await all(path);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], entry);
  });

  it("record() is a write-before-create: the file exists even if the caller never creates the worktree", async () => {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(parsed["wt-scout-a1b2"]);
  });

  it("record() of a second entry keeps the first (merge, not replace)", async () => {
    const second = makeEntry({ id: "wt-surgeon-c3d4", path: "/state/wt/wt-surgeon-c3d4" });
    await record(path, second);
    const entries = await all(path);
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.id === "wt-scout-a1b2"));
    assert.ok(entries.some((e) => e.id === "wt-surgeon-c3d4"));
  });

  it("drop() removes exactly the named entry and leaves the other", async () => {
    await drop(path, "wt-scout-a1b2");
    const entries = await all(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, "wt-surgeon-c3d4");
  });

  it("drop() of an id that is not present is a silent no-op", async () => {
    await drop(path, "wt-does-not-exist");
    const entries = await all(path);
    assert.equal(entries.length, 1);
  });

  it("a corrupt registry file is treated as empty rather than throwing", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "ext23-registry-corrupt-"));
    const badPath = registryPath(badDir);
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(badPath, "{ not valid json");
      assert.deepEqual(await all(badPath), []);
      // and recovery: recording after corruption must still succeed and start clean.
      await record(badPath, makeEntry({ id: "wt-after-corruption" }));
      const entries = await all(badPath);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.id, "wt-after-corruption");
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  it("concurrent record() calls do not lose an update (the mkdir lock actually serialises)", async () => {
    const concurrentDir = await mkdtemp(join(tmpdir(), "ext23-registry-concurrent-"));
    const concurrentPath = registryPath(concurrentDir);
    try {
      const writers = Array.from({ length: 12 }, (_, i) =>
        record(concurrentPath, makeEntry({ id: `wt-concurrent-${i}`, path: `/state/wt/wt-concurrent-${i}` })),
      );
      await Promise.all(writers);
      const entries = await all(concurrentPath);
      assert.equal(entries.length, 12, "every concurrent writer's entry must survive the race");
    } finally {
      await rm(concurrentDir, { recursive: true, force: true });
    }
  });

  it("does not leave a stale .lock directory behind after a successful write", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(() => access(`${path}.lock`));
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readLockMeta } from "../../extensions/lib/detach.ts";
import { isProcessAlive, JOB_LOCK_VERSION, withJobLock } from "../../extensions/jobs/lock.ts";

let sandbox: string;
let counter = 0;

function freshLock(): string {
  return join(sandbox, `job-${counter++}`, "lock");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-jobs-lock-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("job lock (EXT-24, on EXT-01's detach lock)", () => {
  it("writes a meta stamp readable by detach.ts's own reader", async () => {
    const lockDir = freshLock();
    await withJobLock(lockDir, async () => {
      const meta = await readLockMeta(lockDir);
      assert.ok(meta, "meta.json is written inside the critical section");
      assert.equal(meta.pid, process.pid);
      assert.equal(meta.version, JOB_LOCK_VERSION);
    });
    assert.equal(await readLockMeta(lockDir), null, "and released afterwards");
  });

  it("serialises concurrent holders", async () => {
    const lockDir = freshLock();
    let inside = 0;
    let maxInside = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        withJobLock(lockDir, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await delay(5);
          order.push(index);
          inside--;
        }),
      ),
    );

    assert.equal(maxInside, 1, "never two holders at once");
    assert.equal(order.length, 8);
  });

  it("releases the lock when the critical section throws", async () => {
    const lockDir = freshLock();
    await assert.rejects(
      withJobLock(lockDir, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await readLockMeta(lockDir), null);
    await withJobLock(lockDir, async () => {});
  });

  it("reclaims a lock whose holder is dead", async () => {
    const lockDir = freshLock();
    await mkdir(lockDir, { recursive: true });
    // pid 1 is alive; a pid that cannot exist is the honest way to fake a crashed holder.
    let deadPid = 2 ** 22 - 1;
    while (isProcessAlive(deadPid)) deadPid--;
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now(), pid: deadPid, version: JOB_LOCK_VERSION }),
    );

    let ran = false;
    await withJobLock(lockDir, async () => {
      ran = true;
    });
    assert.equal(ran, true, "a crashed holder does not wedge the job forever");
  });

  it("fails loudly, naming the holder, when a live lock never frees", async () => {
    const lockDir = freshLock();
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now(), pid: process.pid, version: JOB_LOCK_VERSION }),
    );

    await assert.rejects(
      withJobLock(lockDir, async () => {}, { maxAttempts: 3, staleMs: 60_000 }),
      (err: Error) =>
        /is held by pid/.test(err.message) &&
        err.message.includes(String(process.pid)) &&
        err.message.includes(lockDir),
    );
    await rm(lockDir, { recursive: true, force: true });
  });
});

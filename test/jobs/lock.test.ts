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

  it("gives up inside its own deadline, naming the holder that is still there", async () => {
    const lockDir = freshLock();
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now(), pid: process.pid, version: JOB_LOCK_VERSION }),
    );

    const startedAt = Date.now();
    await assert.rejects(
      withJobLock(lockDir, async () => {}, { timeoutMs: 200, staleMs: 60_000 }),
      (err: Error) =>
        /was not acquired within 200ms/.test(err.message) &&
        /still held by pid/.test(err.message) &&
        err.message.includes(String(process.pid)) &&
        err.message.includes(lockDir),
    );

    const waited = Date.now() - startedAt;
    // The lower bound is the contract and is exact: the loop only breaks once the deadline has
    // passed, so giving up early is a bug however loaded the machine is. The upper bound is
    // deliberately loose — it is here to catch a wait that is not bounded at all, not to
    // measure scheduling latency, which is the assertion that made the old shape flaky.
    assert.ok(waited >= 200, `gave up after ${waited}ms, inside its own budget`);
    assert.ok(waited < 5_000, `waited ${waited}ms for a 200ms budget`);
    await rm(lockDir, { recursive: true, force: true });
  });

  it("says the holder never stamped the lock, rather than naming a pid it never read", async () => {
    const lockDir = freshLock();
    // The window between `mkdir` and the `meta.json` write, held open.
    await mkdir(lockDir, { recursive: true });

    await assert.rejects(
      withJobLock(lockDir, async () => {}, { timeoutMs: 60, staleMs: 60_000 }),
      /had not stamped it yet/,
    );
    await rm(lockDir, { recursive: true, force: true });
  });

  it("does not invent a holder when the wait ends with the lock free", async () => {
    const lockDir = freshLock();
    await mkdir(lockDir, { recursive: true });
    let deadPid = 2 ** 22 - 1;
    while (isProcessAlive(deadPid)) deadPid--;
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now(), pid: deadPid, version: JOB_LOCK_VERSION }),
    );

    // A zero budget reclaims the dead holder and then has nothing left to retry with, so the
    // wait ends with the lock genuinely free. Under load the old code reached the same state by
    // losing every race, and reported it as "held by pid unknown" — a wedged holder that did
    // not exist.
    await assert.rejects(
      withJobLock(lockDir, async () => {}, { timeoutMs: 0 }),
      (err: Error) => /free again/.test(err.message) && !/held by pid/.test(err.message),
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderSemaphore, ProviderSemaphoreSet } from "../../extensions/dispatch/semaphore.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("ProviderSemaphore", () => {
  it("rejects a non-positive limit instead of pretending to be unbounded", () => {
    assert.throws(() => new ProviderSemaphore(0), RangeError);
    assert.throws(() => new ProviderSemaphore(-1), RangeError);
    assert.throws(() => new ProviderSemaphore(1.5), RangeError);
  });

  it("admits up to the limit and queues the rest", async () => {
    const sem = new ProviderSemaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    assert.equal(sem.active, 2);
    let third = false;
    const pending = sem.acquire().then((release) => {
      third = true;
      return release;
    });
    await tick();
    assert.equal(third, false, "the third acquire must queue, not error and not proceed");
    assert.equal(sem.waiting, 1);
    a();
    const c = await pending;
    assert.equal(third, true);
    assert.equal(sem.active, 2);
    b();
    c();
    assert.equal(sem.active, 0);
    assert.equal(sem.waiting, 0);
  });

  it("REGRESSION: a release never lets a newcomer overtake a waiter into the same permit", async () => {
    // This is an earlier draft's Semaphore bug. Its release does `active--` then resolves the
    // waiter's promise; the waiter increments a microtask later. A caller that arrives in that
    // window sees active < limit, passes the synchronous check, and both run. With local:1 that
    // is two llama.cpp children on one GPU.
    const sem = new ProviderSemaphore(1);
    const first = await sem.acquire();

    let waiterRunning = false;
    const waiter = sem.acquire().then((release) => {
      waiterRunning = true;
      return release;
    });
    await tick();
    assert.equal(sem.waiting, 1);

    first(); // releases -> hands the permit to the waiter

    // The newcomer arrives synchronously in the same turn as the release, before the woken
    // waiter has had a chance to run.
    let newcomerRunning = false;
    const newcomer = sem.acquire().then((release) => {
      newcomerRunning = true;
      return release;
    });

    await tick();
    assert.equal(waiterRunning, true, "the queued waiter must get the permit");
    assert.equal(newcomerRunning, false, "the newcomer must NOT overtake into the same permit");
    assert.equal(sem.active, 1, "exactly one permit is outstanding");

    (await waiter)();
    (await newcomer)();
    assert.equal(sem.active, 0);
  });

  it("never exceeds the limit under a burst, and observes a peak of exactly the limit", async () => {
    for (const limit of [1, 2, 3]) {
      const sem = new ProviderSemaphore(limit);
      let live = 0;
      let peak = 0;
      const work = Array.from({ length: 12 }, () =>
        sem.run(async () => {
          live++;
          peak = Math.max(peak, live);
          await tick();
          await tick();
          live--;
        }),
      );
      await Promise.all(work);
      assert.equal(peak, limit, `limit ${limit}: peak concurrency should be exactly ${limit}, got ${peak}`);
      assert.equal(sem.active, 0);
      assert.equal(sem.waiting, 0);
    }
  });

  it("is FIFO", async () => {
    const sem = new ProviderSemaphore(1);
    const order: number[] = [];
    const held = await sem.acquire();
    const runs = [1, 2, 3, 4].map((n) =>
      sem.run(async () => {
        order.push(n);
      }),
    );
    await tick();
    held();
    await Promise.all(runs);
    assert.deepEqual(order, [1, 2, 3, 4]);
  });

  it("releases the permit when the task throws", async () => {
    const sem = new ProviderSemaphore(1);
    await assert.rejects(sem.run(() => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(sem.active, 0);
    // The lane is still usable.
    assert.equal(await sem.run(() => 42), 42);
  });

  it("has an idempotent release", async () => {
    const sem = new ProviderSemaphore(2);
    const release = await sem.acquire();
    release();
    release();
    release();
    assert.equal(sem.active, 0, "a double release must not manufacture permits");
  });

  it("queues rather than errors when the queue is long", async () => {
    const sem = new ProviderSemaphore(1);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => sem.run(() => i)));
    assert.deepEqual(results, Array.from({ length: 50 }, (_, i) => i));
  });
});

describe("ProviderSemaphoreSet", () => {
  it("uses routing.json's per-provider caps and falls back to the default", () => {
    // `litellm` (cap 6) was deleted from the harness; the `cheap` tier it used to own now shares
    // the `databricks` provider's semaphore (cap 4) with the `confidential` tier.
    const set = new ProviderSemaphoreSet({ local: 1, databricks: 4, bad: 0 as unknown as number }, 3);
    assert.equal(set.limitFor("local"), 1);
    assert.equal(set.limitFor("databricks"), 4);
    assert.equal(set.limitFor("github-copilot"), 3, "unconfigured provider gets the default");
    assert.equal(set.limitFor("bad"), 3, "a nonsense cap is replaced by the default, not honoured");
  });

  it("keeps one lane per provider and does not cross-block", async () => {
    const set = new ProviderSemaphoreSet({ local: 1, databricks: 2 }, 3);
    const localHold = await set.for("local").acquire();
    // A different provider must not be blocked by a saturated `local` lane.
    const ran = await set.run("databricks", () => "ok");
    assert.equal(ran, "ok");
    localHold();
    const snap = set.snapshot();
    assert.deepEqual(
      snap.map((s) => [s.provider, s.limit]),
      [
        ["databricks", 2],
        ["local", 1],
      ],
    );
  });

  it("rejects a nonsense default", () => {
    assert.throws(() => new ProviderSemaphoreSet({}, 0), RangeError);
  });
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { enqueueDigestJob } from "../../extensions/digest/spool.ts";
import { DIGEST_VERSION } from "../../extensions/digest/config.ts";

let sandbox: string;
let counter = 0;
before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-digest-spool-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function dir(): string {
  return join(sandbox, `q-${counter++}`);
}

describe("spool — enqueueDigestJob", () => {
  it("creates the queue dir 0700 and writes exactly one *.json job, no leftover *.tmp", async () => {
    const d = dir();
    const path = await enqueueDigestJob(
      { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/repo", reason: "shutdown:quit" },
      d,
    );
    assert.equal((await stat(d)).mode & 0o777, 0o700);

    const entries = await readdir(d);
    const visible = entries.filter((f) => !f.startsWith("."));
    assert.equal(visible.length, 1, `expected exactly one visible entry, got [${entries.join(", ")}]`);
    assert.equal(
      entries.some((f) => f.endsWith(".tmp")),
      false,
      "no .tmp file should survive a successful enqueue",
    );
    assert.ok(path.endsWith(".json"));

    const job = JSON.parse(await readFile(path, "utf8"));
    assert.equal(job.sessionId, "s1");
    assert.equal(job.sessionFile, "/tmp/s1.jsonl");
    assert.equal(job.cwd, "/repo");
    assert.equal(job.reason, "shutdown:quit");
    assert.equal(job.digestVersion, DIGEST_VERSION);
    assert.equal(typeof job.queuedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(job.queuedAt)));
  });

  it("two enqueues for the SAME session in the same millisecond both survive (random suffix)", async () => {
    const d = dir();
    const input = { sessionId: "same-session", sessionFile: "/tmp/x.jsonl", cwd: "/repo" };
    const [a, b] = await Promise.all([
      enqueueDigestJob({ ...input, reason: "compact:threshold" }, d),
      enqueueDigestJob({ ...input, reason: "shutdown:quit" }, d),
    ]);
    assert.notEqual(a, b, "a collision would silently drop one of the two jobs");
    const entries = (await readdir(d)).filter((f) => f.endsWith(".json"));
    assert.equal(entries.length, 2);
  });

  it("enqueueing 20 jobs concurrently yields 20 distinct job files (no rename collisions)", async () => {
    const d = dir();
    const paths = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        enqueueDigestJob(
          { sessionId: `s-${i}`, sessionFile: `/tmp/s-${i}.jsonl`, cwd: "/repo", reason: "shutdown:quit" },
          d,
        ),
      ),
    );
    assert.equal(new Set(paths).size, 20);
    const entries = (await readdir(d)).filter((f) => f.endsWith(".json"));
    assert.equal(entries.length, 20);
  });

  it("the write is atomic: no reader can ever observe a partially-written job file", async () => {
    // Simulates the "kill -9 mid-write" acceptance check: the
    // published file only ever appears via rename(2), which POSIX guarantees is atomic on the
    // same filesystem, so a concurrent reader either sees nothing or sees the complete file —
    // never a truncated one. Poll aggressively while an enqueue is in flight and assert every
    // *.json file seen parses cleanly.
    const d = dir();
    let sawAny = false;
    const inspect = async (): Promise<void> => {
      const entries = (await readdir(d).catch(() => [])).filter((f) => f.endsWith(".json"));
      for (const f of entries) {
        const raw = await readFile(join(d, f), "utf8").catch(() => null);
        if (raw === null) continue; // deleted between readdir and read — not what we're testing
        sawAny = true;
        assert.doesNotThrow(() => JSON.parse(raw), `observed a non-JSON job file: ${raw}`);
      }
    };

    // The poller runs for exactly as long as the enqueue is in flight. It used to run for a fixed
    // 200 event-loop turns, which is a budget with no relation to the work it is watching — and a
    // self-defeating one: every iteration puts a readdir on the same libuv threadpool the enqueue's
    // mkdir/write/rename must queue on, so the harder the poller looks the later the file lands.
    // Measured under concurrent suite load the file first appeared as late as turn 121 of 200, a
    // margin of 1.65x, and in-process repetition missed outright. Coupling the loop to the work
    // removes the budget rather than enlarging it.
    let enqueued = false;
    let torn: unknown;
    // The `.catch` is attached at construction rather than at the await below. `inspect()` rejects
    // exactly when it finds a torn file — the failure this test exists to catch — and the enqueue
    // does real I/O in between, so an unattached rejection would surface as an unhandledRejection
    // crash instead of an assertion, on the one path that matters most.
    const poller = (async () => {
      while (!enqueued) {
        await inspect();
        await new Promise((r) => setImmediate(r));
      }
    })().catch((err: unknown) => {
      torn = err;
    });

    try {
      await enqueueDigestJob(
        { sessionId: "atomic", sessionFile: "/tmp/a.jsonl", cwd: "/repo", reason: "shutdown:quit" },
        d,
      );
    } finally {
      // The flag is the loop's only bound. A rejecting enqueue that skipped it would leave the
      // poller spinning on setImmediate, holding the event loop open — `node --test` would hang
      // with no failure and no output, which is worse than the flake this change removes.
      enqueued = true;
    }
    await poller;
    if (torn !== undefined) throw torn;

    // One deterministic read after the rename has certainly happened, so `sawAny` cannot be a
    // statement about scheduling luck. The concurrent window above is still where a torn file
    // would be caught; this only keeps the guard against a vacuously green run honest.
    await inspect();
    assert.ok(sawAny, "the poller should have observed the published file at least once");
  });
});

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
    const poller = (async () => {
      for (let i = 0; i < 200; i++) {
        const entries = (await readdir(d).catch(() => [])).filter((f) => f.endsWith(".json"));
        for (const f of entries) {
          sawAny = true;
          const raw = await readFile(join(d, f), "utf8").catch(() => null);
          if (raw === null) continue; // deleted between readdir and read — not what we're testing
          assert.doesNotThrow(() => JSON.parse(raw), `observed a non-JSON job file: ${raw}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    await enqueueDigestJob(
      { sessionId: "atomic", sessionFile: "/tmp/a.jsonl", cwd: "/repo", reason: "shutdown:quit" },
      d,
    );
    await poller;
    assert.ok(sawAny, "the poller should have observed the published file at least once");
  });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_RECURSION_ENV,
  readLockMeta,
  releaseLock,
  runDetached,
} from "../../extensions/lib/detach.ts";

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-detach-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function lockPath(): string {
  return join(root, "locks", `w-${counter++}`);
}

/** A worker that appends its pid to `marker` and exits. */
function markerWorker(marker: string): [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, process.pid + "\\n")`,
  ];
}

async function waitForLines(file: string, expected: number, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = existsSync(file)
      ? (await readFile(file, "utf8")).split("\n").filter((l) => l.length > 0)
      : [];
    if (lines.length >= expected || Date.now() > deadline) return lines;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("detach", () => {
  it("spawns once and stamps the lock with the WORKER's pid and the version", async () => {
    const lockDir = lockPath();
    const marker = join(root, `m-${counter}.txt`);
    const outcome = await runDetached(markerWorker(marker), { lockDir, version: "3" });

    assert.equal(outcome, "spawned");
    const meta = await readLockMeta(lockDir);
    assert.ok(meta);
    assert.equal(meta.version, "3");
    assert.equal(typeof meta.at, "number");

    const lines = await waitForLines(marker, 1);
    assert.equal(lines.length, 1);
    assert.notEqual(
      meta.pid,
      process.pid,
      "the spawner exits at session shutdown; stamping its pid makes the lock look abandoned",
    );
    assert.equal(meta.pid, Number(lines[0]), "the recorded holder must be the worker itself");
  });

  it("the lock directory is created 0700", async () => {
    const lockDir = lockPath();
    await runDetached(markerWorker(join(root, "ignored.txt")), { lockDir, version: "1" });
    const st = await stat(lockDir);
    assert.equal(st.mode & 0o777, 0o700);
  });

  it("concurrency: 8 parallel calls produce exactly one spawn and one child", async () => {
    const lockDir = lockPath();
    const marker = join(root, `m8-${counter}.txt`);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => runDetached(markerWorker(marker), { lockDir, version: "1" })),
    );

    assert.equal(outcomes.filter((o) => o === "spawned").length, 1, `got ${outcomes.join(",")}`);
    assert.equal(outcomes.filter((o) => o === "locked").length, 7, `got ${outcomes.join(",")}`);
    const lines = await waitForLines(marker, 1);
    await new Promise((r) => setTimeout(r, 250));
    const settled = await waitForLines(marker, 1, 0);
    assert.equal(lines.length, 1);
    assert.equal(settled.length, 1, "exactly one worker process may ever have run");
  });

  it("recursion: an already-inside-a-worker process never spawns", async () => {
    const lockDir = lockPath();
    const marker = join(root, `mr-${counter}.txt`);
    process.env[DEFAULT_RECURSION_ENV] = "1";
    try {
      const outcome = await runDetached(markerWorker(marker), { lockDir, version: "1" });
      assert.equal(outcome, "recursion");
    } finally {
      delete process.env[DEFAULT_RECURSION_ENV];
    }
    assert.equal(existsSync(lockDir), false, "no lock may be taken on the recursion path");
    assert.equal((await waitForLines(marker, 1, 300)).length, 0);
  });

  it("recursion guard: a custom env var name is honoured", async () => {
    const lockDir = lockPath();
    process.env.MY_WORKER_FLAG = "yes";
    try {
      assert.equal(
        await runDetached(markerWorker(join(root, "x.txt")), {
          lockDir,
          version: "1",
          recursionEnv: "MY_WORKER_FLAG",
        }),
        "recursion",
      );
    } finally {
      delete process.env.MY_WORKER_FLAG;
    }
  });

  it("the child is marked as a worker so it cannot re-enter", async () => {
    const lockDir = lockPath();
    const out = join(root, `env-${counter}.txt`);
    await runDetached(
      [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.env.PI_CONFIG_WORKER + ":" + process.env.PI_CONFIG_WORKER_VERSION)`,
      ],
      { lockDir, version: "7" },
    );
    await waitForLines(out, 1);
    assert.equal(await readFile(out, "utf8"), "1:7");
  });

  it("stale by age: a lock older than staleMs is reclaimed", async () => {
    const lockDir = lockPath();
    const marker = join(root, `ms-${counter}.txt`);
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now() - 20 * 60_000, pid: process.pid, version: "1" }),
    );

    const outcome = await runDetached(markerWorker(marker), { lockDir, version: "2" });
    assert.equal(outcome, "stale-cleared");
    assert.equal((await waitForLines(marker, 1)).length, 1);
    assert.equal((await readLockMeta(lockDir))?.version, "2");
  });

  it("stale by dead holder: a fresh lock whose pid is gone is reclaimed", async () => {
    const lockDir = lockPath();
    const marker = join(root, `md-${counter}.txt`);
    const deadPid = await spawnAndReap();

    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now(), pid: deadPid, version: "1" }),
    );

    assert.equal(await runDetached(markerWorker(marker), { lockDir, version: "1" }), "stale-cleared");
    assert.equal((await waitForLines(marker, 1)).length, 1);
  });

  it("a lock with no meta yet is NOT treated as stale", async () => {
    const lockDir = lockPath();
    const marker = join(root, `mn-${counter}.txt`);
    // Exactly the window between mkdir and writeMeta in another process.
    await mkdir(lockDir, { recursive: true, mode: 0o700 });

    assert.equal(await runDetached(markerWorker(marker), { lockDir, version: "1" }), "locked");
    assert.equal((await waitForLines(marker, 1, 300)).length, 0);
  });

  it("releaseLock frees the mutex and is safe when not held", async () => {
    const lockDir = lockPath();
    const marker = join(root, `mrel-${counter}.txt`);
    assert.equal(await runDetached(markerWorker(marker), { lockDir, version: "1" }), "spawned");
    await releaseLock(lockDir);
    assert.equal(existsSync(lockDir), false);
    await releaseLock(lockDir);
    assert.equal(await runDetached(markerWorker(marker), { lockDir, version: "1" }), "spawned");
  });

  it("latency: returns well inside the REQ-EXT-23 budget even for a long worker", async () => {
    const lockDir = lockPath();
    const started = Date.now();
    const outcome = await runDetached([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
      lockDir,
      version: "1",
    });
    const elapsed = Date.now() - started;
    assert.equal(outcome, "spawned");
    assert.ok(elapsed < 200, `runDetached took ${elapsed} ms, budget is 200 ms (REQ-EXT-23: 1 s)`);
  });

  it("a worker that cannot start is reported loudly and releases the lock", async () => {
    const lockDir = lockPath();
    const lines: string[] = [];
    const outcome = await runDetached([join(root, "no-such-binary"), "arg"], {
      lockDir,
      version: "1",
      onError: (l) => void lines.push(l),
    });
    assert.equal(outcome, "spawned", "spawn() does not fail synchronously; the error is async");

    const deadline = Date.now() + 3000;
    while (lines.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines.length, 1, "the failure must be surfaced, not swallowed");
    assert.match(lines[0], /failed to start/);
    assert.match(lines[0], /no-such-binary/);
    assert.match(lines[0], /ENOENT/);

    while (existsSync(lockDir) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(lockDir), false, "a worker that never started must not hold the lock");
  });

  it("an unusable lock path is reported as an error, not as a silent no-op", async () => {
    const blocker = join(root, `blocker-${counter++}`);
    await writeFile(blocker, "not a directory");
    const lines: string[] = [];
    const outcome = await runDetached(markerWorker(join(root, "x.txt")), {
      lockDir: join(blocker, "child", "lock"),
      version: "1",
      onError: (l) => void lines.push(l),
    });
    assert.equal(outcome, "error");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /could not acquire/);
    assert.match(lines[0], /ENOTDIR/);
  });
});

/** Returns a pid that is guaranteed to be dead and reaped. */
function spawnAndReap(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => setTimeout(() => resolve(child.pid ?? 999999), 50));
  });
}

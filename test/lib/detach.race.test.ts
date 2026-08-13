/**
 * The permanent regression test for the outage this module exists to prevent: unserialised
 * session-exit workers fired 18 processes inside 30 s and took the box to load 233 with swap
 * exhausted (REQ-CTX-24, REQ-EXT-22).
 *
 * These are real OS processes, not concurrent promises in one event loop. An in-process test
 * cannot prove an `mkdir(2)` mutex — what is being tested is what happens when two processes'
 * worth of kernel scheduling meet the same inode. Each racer also exits immediately after
 * spawning, exactly as a `pi` process does at session shutdown, so the test covers the case
 * where the lock holder outlives the process that took the lock.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const RACER = fileURLToPath(new URL("./fixtures/detach-racer.ts", import.meta.url));
/** Long enough that every scenario finishes while the first worker is still holding. */
const WORKER_LIFETIME_MS = 30_000;

let root: string;
const spawnedWorkers: number[] = [];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-detach-race-"));
});
after(async () => {
  for (const pid of spawnedWorkers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await rm(root, { recursive: true, force: true });
});

interface RacerResult {
  outcome: string;
  stderr: string;
  code: number | null;
}

function racer(lockDir: string, marker: string, startAt: number): Promise<RacerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [RACER, lockDir, marker, String(startAt), String(WORKER_LIFETIME_MS)],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_CONFIG_WORKER: "" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ outcome: stdout.trim(), stderr, code }));
  });
}

async function markerPids(file: string): Promise<number[]> {
  if (!existsSync(file)) return [];
  const pids = (await readFile(file, "utf8"))
    .split("\n")
    .filter((l) => l.length > 0)
    .map(Number);
  for (const pid of pids) if (!spawnedWorkers.includes(pid)) spawnedWorkers.push(pid);
  return pids;
}

function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assertNoInternalFailures(results: readonly RacerResult[]): void {
  for (const r of results) {
    assert.equal(r.code, 0, `racer exited ${r.code}: ${r.stderr}`);
    assert.equal(r.stderr, "", "no racer may report an internal failure");
  }
}

describe("detach — five real processes racing one lock", () => {
  it("simultaneous start: exactly one spawns, four are locked out, one child runs", async () => {
    const lockDir = join(root, "locks", "simultaneous");
    const marker = join(root, "simultaneous.txt");
    // Node start-up here is ~40 ms; 1200 ms lets every process reach the barrier, so they
    // contend on mkdir rather than on the process launcher.
    const startAt = Date.now() + 1200;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => racer(lockDir, marker, startAt)),
    );
    const outcomes = results.map((r) => r.outcome);
    assertNoInternalFailures(results);

    assert.equal(
      outcomes.filter((o) => o === "spawned" || o === "stale-cleared").length,
      1,
      `expected exactly one winner, got [${outcomes.join(", ")}]`,
    );
    assert.equal(
      outcomes.filter((o) => o === "locked").length,
      4,
      `expected four losers, got [${outcomes.join(", ")}]`,
    );

    await settle(500);
    assert.equal(
      (await markerPids(marker)).length,
      1,
      "exactly one worker process may ever have started",
    );
  });

  it("REQ-EXT-22: five sessions exiting inside ten seconds still produce one worker", async () => {
    const lockDir = join(root, "locks", "ten-seconds");
    const marker = join(root, "ten-seconds.txt");
    const t0 = Date.now();

    // The historical shape: five sessions ending one after another over ten seconds, each
    // process gone long before its worker is. The lock must survive its own spawner.
    const results: RacerResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await racer(lockDir, marker, Date.now() + 50));
      if (i < 4) await settle(2000);
    }
    const elapsed = Date.now() - t0;
    assertNoInternalFailures(results);

    assert.ok(elapsed >= 8000, `the scenario must span ~10 s, spanned ${elapsed} ms`);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["spawned", "locked", "locked", "locked", "locked"],
    );
    assert.equal((await markerPids(marker)).length, 1);
  });

  it("a stale lock is cleared by exactly one of five racers", async () => {
    const lockDir = join(root, "locks", "stale-race");
    const marker = join(root, "stale-race.txt");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now() - 60 * 60_000, pid: process.pid, version: "old" }),
    );

    const startAt = Date.now() + 1200;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => racer(lockDir, marker, startAt)),
    );
    const outcomes = results.map((r) => r.outcome);
    assertNoInternalFailures(results);

    // Which label the winner carries depends on who happened to clear the stale directory and
    // who happened to win the mkdir that followed; that a racer can win with a plain "spawned"
    // is correct. What must never happen is two winners.
    assert.equal(
      outcomes.filter((o) => o === "stale-cleared" || o === "spawned").length,
      1,
      `exactly one racer may take a stale lock, got [${outcomes.join(", ")}]`,
    );
    assert.equal(outcomes.filter((o) => o === "locked").length, 4, `got [${outcomes.join(", ")}]`);

    await settle(500);
    assert.equal((await markerPids(marker)).length, 1);
  });

  it("high contention on a stale lock still yields exactly one winner", async () => {
    // Twelve racers on the stale path, which is where the reclaim TOCTOU lived: one racer
    // inspecting the lock as stale while another was legitimately acquiring it produced two
    // simultaneous workers.
    const lockDir = join(root, "locks", "stale-storm");
    const marker = join(root, "stale-storm.txt");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockDir, "meta.json"),
      JSON.stringify({ at: Date.now() - 60 * 60_000, pid: process.pid, version: "old" }),
    );

    const startAt = Date.now() + 1500;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => racer(lockDir, marker, startAt)),
    );
    const outcomes = results.map((r) => r.outcome);
    assertNoInternalFailures(results);

    assert.equal(
      outcomes.filter((o) => o === "stale-cleared" || o === "spawned").length,
      1,
      `exactly one racer may take a stale lock, got [${outcomes.join(", ")}]`,
    );
    await settle(500);
    assert.equal((await markerPids(marker)).length, 1);
  });

  it("a lock whose worker has died is reclaimed by the next session", async () => {
    const lockDir = join(root, "locks", "worker-died");
    const marker = join(root, "worker-died.txt");

    // A short-lived worker: the lock must NOT keep blocking after its holder is gone, or a
    // single crashed digest run would silence every later session for fifteen minutes.
    const short = spawn(
      process.execPath,
      [RACER, lockDir, marker, String(Date.now() + 50), "150"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_CONFIG_WORKER: "" } },
    );
    const first = await new Promise<string>((resolve) => {
      let out = "";
      short.stdout.on("data", (c) => (out += String(c)));
      short.on("close", () => resolve(out.trim()));
    });
    assert.equal(first, "spawned");

    await settle(1200);
    const second = await racer(lockDir, marker, Date.now() + 50);
    assert.equal(second.outcome, "stale-cleared", second.stderr);
    await settle(500);
    assert.equal((await markerPids(marker)).length, 2);
  });
});

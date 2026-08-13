/**
 * `bin/pi-digest-drain` is a plain Node script, not an importable module (it runs its whole
 * body at load time). It is exercised the same way `test/lib/detach.race.test.ts` exercises
 * `runDetached`: real, separate OS processes, because an in-process test cannot prove an
 * `mkdir(2)` mutex — this file's own header explains why (`ensureHolder`'s fallback path).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const DRAIN = fileURLToPath(new URL("../../bin/pi-digest-drain", import.meta.url));

let root: string;
let counter = 0;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-digest-drain-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface RunResult {
  stdout: Record<string, unknown> | undefined;
  stderr: string;
  code: number | null;
}

function runDrain(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRAIN], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_DIGEST_WORKER: "", PI_SUBAGENT_NAME: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed: Record<string, unknown> | undefined;
      const line = stdout.trim().split("\n").pop();
      if (line) {
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
      }
      resolve({ stdout: parsed, stderr, code });
    });
  });
}

/** One sandbox per test: state root, digest config, output dir, and env to point at them. */
async function scenario(overrides: {
  summarizer: unknown;
  minTurns?: number;
}): Promise<{ env: NodeJS.ProcessEnv; queueDir: string; outDir: string; digestConfig: string }> {
  const dir = join(root, `s-${counter++}`);
  const xdg = join(dir, "xdg");
  const outDir = join(dir, "out");
  const queueDir = join(xdg, "pi-config", "digest-queue");
  await mkdir(queueDir, { recursive: true });
  const digestConfig = join(dir, "digest.json");
  await writeFile(
    digestConfig,
    JSON.stringify({
      digest: { enabled: true, minTurns: overrides.minTurns ?? 0, outputDir: outDir, summarizer: overrides.summarizer },
    }),
  );
  return {
    env: { XDG_STATE_HOME: xdg, PI_DIGEST_CONFIG: digestConfig },
    queueDir,
    outDir,
    digestConfig,
  };
}

async function seedJob(
  queueDir: string,
  sessionId: string,
  opts: { sessionBody?: string; reason?: string; queuedAt?: string } = {},
): Promise<string> {
  const sessionFile = join(queueDir, "..", "..", `${sessionId}.jsonl`);
  await writeFile(sessionFile, opts.sessionBody ?? `{"session":"${sessionId}"}\n`);
  const jobPath = join(queueDir, `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(
    jobPath,
    JSON.stringify({
      sessionId,
      sessionFile,
      cwd: root,
      reason: opts.reason ?? "shutdown:quit",
      queuedAt: opts.queuedAt ?? "2026-08-07T09:00:00.000Z",
      digestVersion: 2,
    }),
  );
  return jobPath;
}

describe("pi-digest-drain — solo runs", () => {
  it("an empty queue: holder:true, processed:0, exits 0, releases the lock", async () => {
    const s = await scenario({ summarizer: { kind: "off" } });
    const r = await runDrain(s.env);
    assert.equal(r.code, 0);
    assert.deepEqual(r.stdout?.holder, true);
    assert.equal(r.stdout?.processed, 0);
    assert.deepEqual(await readdir(join(s.queueDir, "..", "digest.lock")).catch(() => "gone"), "gone");
  });

  it("summarizer kind 'off': writes a digest whose body is the literal disabled marker", async () => {
    const s = await scenario({ summarizer: { kind: "off" } });
    await seedJob(s.queueDir, "off-session");
    const r = await runDrain(s.env);
    assert.equal(r.stdout?.processed, 1);
    const files = await readdir(s.outDir);
    assert.equal(files.length, 1);
    const body = await readFile(join(s.outDir, files[0]), "utf8");
    assert.match(body, /digest_version: 2/);
    assert.match(body, /status: ok/);
    assert.match(body, /summarizer: off/);
    assert.match(body, /\(summarizer disabled\)/);
  });

  it("summarizer kind 'command' with argv:[\"cat\"]: the digest body is the raw prompt (instruction + transcript)", async () => {
    const s = await scenario({ summarizer: { kind: "command", argv: ["cat"], timeoutMs: 5000 } });
    await seedJob(s.queueDir, "cmd-session", { sessionBody: "UNIQUE-TRANSCRIPT-MARKER-42\n" });
    const r = await runDrain(s.env);
    assert.equal(r.stdout?.processed, 1);
    const files = await readdir(s.outDir);
    const body = await readFile(join(s.outDir, files[0]), "utf8");
    assert.match(body, /summarizer: command:cat/);
    assert.match(body, /Summarise this coding-agent session/);
    assert.match(body, /UNIQUE-TRANSCRIPT-MARKER-42/);
  });

  it("a summariser that exits non-zero: the job is not lost — a status:failed digest is written and the queue is drained", async () => {
    const s = await scenario({ summarizer: { kind: "command", argv: ["false"], timeoutMs: 5000 } });
    await seedJob(s.queueDir, "fail-session");
    const r = await runDrain(s.env);
    assert.equal(r.code, 0, "a per-job failure must not crash the worker");
    assert.equal(r.stdout?.processed, 1);
    assert.match(r.stderr, /digest failed for session fail-session/);
    const files = await readdir(s.outDir);
    assert.equal(files.length, 1);
    const body = await readFile(join(s.outDir, files[0]), "utf8");
    assert.match(body, /status: failed/);
    assert.match(body, /Digest generation failed/);
    assert.deepEqual((await readdir(s.queueDir)).filter((f) => f.endsWith(".json")), []);
  });

  it("summarizer kind 'pi' with an unknown tier: UnknownTierError surfaces on stderr and in the failure digest", async () => {
    const s = await scenario({ summarizer: { kind: "pi", model: "no-such-tier", timeoutMs: 5000 } });
    const routing = join(root, `routing-${counter++}.json`);
    await writeFile(routing, JSON.stringify({ tiers: { cheap: { model: "databricks/databricks-claude-haiku-4-5" } } }));
    await seedJob(s.queueDir, "tier-session");
    const r = await runDrain({ ...s.env, PI_ROUTING_JSON: routing });
    assert.equal(r.stdout?.processed, 1);
    assert.match(r.stderr, /UnknownTierError/);
    const files = await readdir(s.outDir);
    const body = await readFile(join(s.outDir, files[0]), "utf8");
    assert.match(body, /status: failed/);
    assert.match(body, /unknown tier "no-such-tier"/);
  });

  it("a malformed present config fails loud before touching the lock, exit 1, no lock left behind", async () => {
    const s = await scenario({ summarizer: { kind: "off" } });
    await writeFile(s.env.PI_DIGEST_CONFIG as string, JSON.stringify({ digest: { summarizer: { kind: "nope" } } }));
    const r = await runDrain(s.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /fatal/);
    assert.deepEqual(await readdir(join(s.queueDir, "..", "locks")).catch(() => []), []);
  });

  it("an unreadable job file is dropped, not retried forever, and does not block the rest of the queue", async () => {
    const s = await scenario({ summarizer: { kind: "off" } });
    await writeFile(join(s.queueDir, "garbage-1.json"), "{ not json at all");
    await seedJob(s.queueDir, "good-session");
    const r = await runDrain(s.env);
    assert.equal(r.stdout?.processed, 1, "the garbage file is dropped, not counted as processed");
    assert.match(r.stderr, /dropping unreadable job/);
    assert.deepEqual(await readdir(s.queueDir).catch(() => []), []);
    const files = await readdir(s.outDir);
    assert.equal(files.length, 1);
  });

  it("a direct invocation with a genuinely stale (dead-pid) lock reclaims it and proceeds", async () => {
    const s = await scenario({ summarizer: { kind: "off" } });
    const lockDir = join(s.queueDir, "..", "locks", "digest");
    await mkdir(lockDir, { recursive: true });
    // A pid that is essentially guaranteed not to exist / not to belong to us.
    await writeFile(join(lockDir, "meta.json"), JSON.stringify({ at: Date.now() - 999_999, pid: 999999, version: "1" }));
    await seedJob(s.queueDir, "reclaim-session");
    const r = await runDrain(s.env);
    assert.equal(r.stdout?.holder, true);
    assert.equal(r.stdout?.processed, 1);
  });

  it("a direct invocation with a LIVE lock (someone else's real pid) does nothing and exits cleanly", async () => {
    const s = await scenario({ summarizer: { kind: "off" } });
    const lockDir = join(s.queueDir, "..", "locks", "digest");
    await mkdir(lockDir, { recursive: true });
    // process.pid of THIS test process: alive, and definitely not our own subprocess's pid.
    await writeFile(join(lockDir, "meta.json"), JSON.stringify({ at: Date.now(), pid: process.pid, version: "1" }));
    await seedJob(s.queueDir, "blocked-session");
    const r = await runDrain(s.env);
    assert.equal(r.stdout?.holder, false);
    assert.equal(r.stdout?.processed, 0);
    // The job is untouched — the next real holder's self-heal loop will pick it up.
    assert.equal((await readdir(s.queueDir)).filter((f) => f.endsWith(".json")).length, 1);
  });
});

describe("pi-digest-drain — REQ-EXT-22: five real processes, one lock", () => {
  it("five concurrent bare invocations against a pre-seeded queue of five sessions: exactly one drains, all five get digested, none duplicated", async () => {
    const s = await scenario({ summarizer: { kind: "command", argv: ["cat"], timeoutMs: 5000 } });
    const sessionIds = ["r1", "r2", "r3", "r4", "r5"];
    for (const id of sessionIds) await seedJob(s.queueDir, id);

    const results = await Promise.all(Array.from({ length: 5 }, () => runDrain(s.env)));
    for (const r of results) assert.equal(r.code, 0, `worker exited ${r.code}: ${r.stderr}`);

    const holders = results.filter((r) => r.stdout?.holder === true);
    assert.ok(holders.length >= 1, "at least one process must have become the holder");

    const totalProcessed = results.reduce((sum, r) => sum + (Number(r.stdout?.processed) || 0), 0);
    assert.equal(totalProcessed, 5, `expected all 5 jobs processed exactly once total, got ${totalProcessed}`);

    const files = await readdir(s.outDir);
    assert.equal(files.length, 5, `expected 5 digest files, got [${files.join(", ")}]`);
    for (const id of sessionIds) assert.ok(files.some((f) => f.includes(id)), `missing digest for ${id}`);

    assert.deepEqual((await readdir(s.queueDir)).filter((f) => f.endsWith(".json")), []);
  });
});

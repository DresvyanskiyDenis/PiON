import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertDepthAllowed,
  AUTO_PRUNE_HOURS_ENV,
  autoPruneRetentionHours,
  DEFAULT_PRUNE_HOURS,
  ensureJobsRoot,
  isProcessAlive,
  jobDir,
  jobsRoot,
  JOB_SCHEMA,
  killJob,
  listJobs,
  listJobsSync,
  MAX_DEPTH,
  parseJobDepth,
  pruneJobs,
  readState,
  reap,
  startJob,
  wrapCommand,
  type JobState,
} from "../../extensions/jobs/store.ts";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

let sandbox: string;
let root: string;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` passes or the budget runs out. Keeps the tests honest but not flaky. */
async function until(check: () => Promise<boolean> | boolean, budgetMs = 8_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${budgetMs}ms`);
    await delay(50);
  }
}

async function waitForTerminal(id: string, budgetMs = 8_000): Promise<JobState> {
  let last: JobState | undefined;
  await until(async () => {
    const state = await readState(root, id);
    if (!state) return false;
    last = await reap(root, state);
    return last.status !== "running";
  }, budgetMs);
  return last!;
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-jobs-"));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("jobs store (EXT-24)", () => {
  let prevXdg: string | undefined;
  let counter = 0;

  beforeEach(async () => {
    prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(sandbox, `state-${counter++}`);
    root = await ensureJobsRoot();
    delete process.env.PI_JOB_ID;
    delete process.env.PI_JOB_DEPTH;
  });

  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  });

  it("puts the store beside the per-session scratch, not inside it", () => {
    assert.equal(jobsRoot(), join(process.env.XDG_STATE_HOME!, "pi-config", "jobs"));
  });

  it("D2: state.json carries schema, running status and the parent session", async () => {
    const started = await startJob({
      root,
      command: "sleep 5",
      cwd: process.cwd(),
      parentSession: "sess-A",
    });
    const raw = JSON.parse(await readFile(join(jobDir(root, started.id), "state.json"), "utf8"));
    assert.equal(raw.schema, JOB_SCHEMA);
    assert.equal(raw.status, "running");
    assert.equal(raw.parentSession, "sess-A");
    assert.equal(raw.pid, raw.pgid);
    assert.ok(raw.startedAt > 0);
    await killJob(root, started, { graceMs: 50 });
  });

  it("REQ-CTX-45: a job started by one session is listed by another", async () => {
    const started = await startJob({
      root,
      command: "sleep 5",
      cwd: process.cwd(),
      parentSession: "sess-A",
      label: "cross-session",
    });
    // A different session reads the same store with no shared in-memory state.
    const { jobs, problems } = await listJobs(root);
    assert.deepEqual(problems, []);
    const found = jobs.find((job) => job.id === started.id);
    assert.ok(found, "the job started under sess-A is visible to any reader");
    assert.equal(found.parentSession, "sess-A");
    assert.equal(found.status, "running");
    await killJob(root, started, { graceMs: 50 });
  });

  it("records the real exit code: 0 is done, non-zero is failed", async () => {
    const ok = await startJob({ root, command: "exit 0", cwd: process.cwd(), parentSession: "s" });
    const bad = await startJob({ root, command: "exit 3", cwd: process.cwd(), parentSession: "s" });

    const okFinal = await waitForTerminal(ok.id);
    const badFinal = await waitForTerminal(bad.id);

    assert.equal(okFinal.status, "done");
    assert.equal(okFinal.exitCode, 0);
    assert.equal(badFinal.status, "failed");
    assert.equal(badFinal.exitCode, 3);
  });

  it("captures stdout and stderr into separate logs", async () => {
    const job = await startJob({
      root,
      command: "echo out-line; echo err-line 1>&2",
      cwd: process.cwd(),
      parentSession: "s",
    });
    await waitForTerminal(job.id);
    const out = await readFile(join(jobDir(root, job.id), "stdout.log"), "utf8");
    const err = await readFile(join(jobDir(root, job.id), "stderr.log"), "utf8");
    assert.match(out, /out-line/);
    assert.match(err, /err-line/);
  });

  it("runs the command from cmd.sh, so quoting in it cannot escape the wrapper", async () => {
    const nasty = `printf '%s\\n' "it's a 'quoted' \\$mess"; exit 0`;
    const job = await startJob({ root, command: nasty, cwd: process.cwd(), parentSession: "s" });
    const final = await waitForTerminal(job.id);
    assert.equal(final.status, "done");
    const out = await readFile(join(jobDir(root, job.id), "stdout.log"), "utf8");
    assert.match(out, /it's a 'quoted' \$mess/);
    assert.equal((await readFile(join(jobDir(root, job.id), "cmd.sh"), "utf8")).trim(), nasty);
  });

  it("wrapCommand single-quotes every path it interpolates", () => {
    const wrapped = wrapCommand("/tmp/it's here");
    assert.ok(wrapped.includes(`'/tmp/it'\\''s here/cmd.sh'`), wrapped);
  });

  it("D4: the depth guard fails loudly", () => {
    assert.deepEqual(parseJobDepth({}), { parent: undefined, depth: 0 });
    assert.deepEqual(parseJobDepth({ PI_JOB_ID: "j1" }), { parent: "j1", depth: 1 });
    assert.equal(parseJobDepth({ PI_JOB_DEPTH: "2" }).depth, 3);
    assert.throws(
      () => parseJobDepth({ PI_JOB_DEPTH: "not-a-number" }),
      /not a non-negative integer/,
    );
    assert.throws(() => assertDepthAllowed(MAX_DEPTH + 1), /exceeds MAX_DEPTH=2/);
    assert.doesNotThrow(() => assertDepthAllowed(MAX_DEPTH));
  });

  it("D4: startJob refuses when the inherited depth is already at the limit", async () => {
    await assert.rejects(
      startJob({
        root,
        command: "echo hi",
        cwd: process.cwd(),
        parentSession: "s",
        env: { ...process.env, PI_JOB_DEPTH: "2" },
      }),
      /exceeds MAX_DEPTH=2/,
    );
  });

  it("stamps PI_JOB_ID and PI_JOB_DEPTH into the child environment", async () => {
    const job = await startJob({
      root,
      command: 'echo "id=$PI_JOB_ID depth=$PI_JOB_DEPTH"',
      cwd: process.cwd(),
      parentSession: "s",
    });
    await waitForTerminal(job.id);
    const out = await readFile(join(jobDir(root, job.id), "stdout.log"), "utf8");
    assert.match(out, new RegExp(`id=${job.id} depth=0`));
  });

  it("D5: kill reaches the whole process group, not just the leader", async () => {
    const marker = join(sandbox, `group-${Date.now()}`);
    const job = await startJob({
      root,
      // The grandchild is what a kill(pid) would orphan.
      command: `sleep 300 & echo $! > ${JSON.stringify(marker)}; sleep 300`,
      cwd: process.cwd(),
      parentSession: "s",
    });
    await until(async () => {
      const text = await readFile(marker, "utf8").catch(() => "");
      return text.trim().length > 0;
    });
    const grandchild = Number((await readFile(marker, "utf8")).trim());
    assert.ok(isProcessAlive(grandchild), "the grandchild is running before the kill");

    const { state, signalled } = await killJob(root, job, { graceMs: 100 });
    assert.equal(signalled, true);
    assert.equal(state.status, "killed");
    await until(() => !isProcessAlive(job.pid) && !isProcessAlive(grandchild));
  });

  it("D6: ten concurrent starts produce ten dirs, ten pids and no corrupt state", async () => {
    const started = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        startJob({
          root,
          command: `echo job-${index}`,
          cwd: process.cwd(),
          parentSession: `sess-${index % 3}`,
        }),
      ),
    );
    assert.equal(new Set(started.map((job) => job.id)).size, 10);
    assert.equal(new Set(started.map((job) => job.pid)).size, 10);

    for (const job of started) await waitForTerminal(job.id);

    const { jobs, problems } = await listJobs(root);
    assert.deepEqual(problems, [], "every state.json parsed");
    assert.equal(jobs.length, 10);
    assert.equal(jobs.filter((job) => job.status === "done").length, 10);
  });

  it("reports an unreadable or foreign-schema job instead of hiding it", async () => {
    const job = await startJob({ root, command: "exit 0", cwd: process.cwd(), parentSession: "s" });
    await waitForTerminal(job.id);
    await writeFile(
      join(jobDir(root, job.id), "state.json"),
      JSON.stringify({ schema: 99, id: job.id }),
    );
    const { jobs, problems } = await listJobs(root);
    assert.equal(jobs.length, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /schema 99/);
    assert.equal(listJobsSync(root).problems.length, 1);
  });

  it("a vanished process with no exit code is failed and says why", async () => {
    const job = await startJob({ root, command: "sleep 300", cwd: process.cwd(), parentSession: "s" });
    process.kill(-job.pgid, "SIGKILL");
    await until(() => !isProcessAlive(job.pid));
    const final = await reap(root, (await readState(root, job.id))!);
    assert.equal(final.status, "failed");
    assert.equal(final.exitCode, -1);
    assert.match(final.note ?? "", /no exit code was recorded/);
  });

  it("prune removes finished jobs and never a running one", async () => {
    const finished = await startJob({ root, command: "exit 0", cwd: process.cwd(), parentSession: "s" });
    const running = await startJob({ root, command: "sleep 30", cwd: process.cwd(), parentSession: "s" });
    await waitForTerminal(finished.id);

    const nothing = await pruneJobs(root, { olderThanMs: 60_000 });
    assert.deepEqual(nothing.removed, [], "a job that just finished is not old enough");

    const result = await pruneJobs(root, { olderThanMs: 0 });
    assert.deepEqual(result.removed, [finished.id]);
    assert.equal((await readState(root, running.id))?.status, "running");
    await killJob(root, running, { graceMs: 50 });
  });

  it("autoPruneRetentionHours: defaults to DEFAULT_PRUNE_HOURS, is overridable, and fails loud on garbage", () => {
    assert.equal(autoPruneRetentionHours({}), DEFAULT_PRUNE_HOURS);
    assert.equal(autoPruneRetentionHours({ [AUTO_PRUNE_HOURS_ENV]: "1" }), 1);
    assert.equal(autoPruneRetentionHours({ [AUTO_PRUNE_HOURS_ENV]: "0" }), 0);
    assert.throws(() => autoPruneRetentionHours({ [AUTO_PRUNE_HOURS_ENV]: "not-a-number" }), /not a non-negative number/);
    assert.throws(() => autoPruneRetentionHours({ [AUTO_PRUNE_HOURS_ENV]: "-3" }), /not a non-negative number/);
  });

  it("D1: the job outlives the process that started it", async () => {
    // Written into the sandbox rather than under test/, where Node's directory-mode runner
    // would execute it as a test. Its imports still resolve against the repo, because module
    // resolution follows the imported file's own location.
    const helper = join(sandbox, "start-job-helper.ts");
    await writeFile(
      helper,
      [
        `import { startJob } from ${JSON.stringify(join(here, "..", "..", "extensions", "jobs", "store.ts"))};`,
        `const state = await startJob({`,
        `  root: process.argv[2], command: process.argv[3],`,
        `  cwd: process.cwd(), parentSession: "helper-session", label: "helper",`,
        `});`,
        `process.stdout.write(JSON.stringify(state));`,
        "",
      ].join("\n"),
    );
    const { stdout } = await run(process.execPath, [helper, root, "sleep 20"], {
      env: { ...process.env, XDG_STATE_HOME: process.env.XDG_STATE_HOME },
    });
    const started = JSON.parse(stdout) as JobState;

    // The starting node process has exited by now; the job must not have.
    assert.ok(isProcessAlive(started.pid), "the detached child survived its parent's exit");
    const { jobs } = await listJobs(root);
    const found = jobs.find((job) => job.id === started.id);
    assert.ok(found, "and is discoverable from a session that never started it");
    assert.equal(found.status, "running");
    assert.equal(found.parentSession, "helper-session");

    await killJob(root, found, { graceMs: 100 });
    await until(() => !isProcessAlive(started.pid));
  });
});

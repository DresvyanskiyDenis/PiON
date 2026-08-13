/**
 * `bin/pi-run` — the fail-closed headless wrapper V-01's FAIL branch prescribes.
 *
 * Driven entirely by recorded fixture streams (`test/fixtures/pi-run/*.jsonl`) replayed by
 * `test/fixtures/pi-run/fake-pi.mjs`, never by a live `pi`. That is not test convenience: the
 * wrapper's whole claim is that its verdict comes from the event stream and from nothing else, so
 * a suite that needed a network, a model or llama-swap to make that claim would be testing the
 * wrong thing — and would go red for reasons that have nothing to do with the wrapper.
 *
 * `bin/pi-run` is a plain Node script that runs its whole body at load time, so it is exercised
 * as a real OS process, the same way `test/bin/pi-digest-drain.test.ts` exercises its subject.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const PI_RUN = fileURLToPath(new URL("../../bin/pi-run", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/pi-run/", import.meta.url));
const FAKE_PI = join(FIXTURES, "fake-pi.mjs");

const stream = (name: string): string => join(FIXTURES, name);

let root: string;
let emptyState: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-run-test-"));
  emptyState = join(root, "state-empty");
  await mkdir(emptyState, { recursive: true });
  // Self-healing rather than relying on the checked-in mode bit: `fake-pi.mjs` is spawned by
  // path, through its shebang, so it has to be executable on whatever filesystem the repo landed
  // on. Asserting the bit here would turn a checkout detail into 20 unrelated failures.
  await chmod(FAKE_PI, 0o755);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const scratch = (): string => join(root, `s-${counter++}`);

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /** Replayed on the child's stdout. */
  streamFile?: string;
  /** Exit code the fake `pi` returns. */
  piExit?: number;
  /** Signal the fake `pi` kills itself with, instead of exiting. */
  piSignal?: string;
  /** Absolute path recorded with the fake `pi`'s argv, as JSON. */
  argvReport?: string;
  /** Absolute path recorded with what the fake `pi`'s fd 0 turned out to be, as JSON. */
  stdinReport?: string;
  /** Point `PI_RUN_PI_BIN` somewhere else — used for the spawn-failure case. */
  piBin?: string;
  /**
   * Give pi-run a real pipe on its own stdin and write to it without ever closing it. If the
   * wrapper ever stopped forcing the child's stdin to /dev/null, the child would inherit this
   * pipe — which is exactly the shape that makes `pi -p` hang forever under cron.
   */
  poisonStdin?: boolean;
  /** `XDG_STATE_HOME` for the run — where the compaction sentinel is looked for. */
  stateHome?: string;
  /** Sentinel the fake `pi` copies into place mid-run, and where it puts it. */
  sentinelFrom?: string;
  sentinelTo?: string;
  /** Make the fake `pi` refuse to end, so the wrapper has to terminate it. */
  holdMs?: number;
  /** Absolute path where the fake `pi` records every signal it received, as JSON. */
  signalReport?: string;
  /** What the fake `pi` does with a signal. Default (when either knob is set) is `reraise`. */
  onSignal?: "reraise" | "ignore" | "exit";
  /**
   * Signals sent to `pi-run` ITSELF — never to the fake `pi` — `at` ms after it was spawned.
   * `kill(pid)` targets one process, not the group, so the child can only ever learn of a signal
   * because the wrapper forwarded it: if forwarding regressed, the fake outlives the run and exits
   * 70 on its own timer, which is a failure the test can name rather than a hang.
   */
  sendSignals?: { at: number; signal: NodeJS.Signals }[];
}

function runPiRun(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_RUN_PI_BIN: options.piBin ?? FAKE_PI,
      FAKE_PI_EXIT: String(options.piExit ?? 0),
      // Never the developer's own state root: the wrapper polls
      // `$XDG_STATE_HOME/pi-config/compaction-loop/` and a real sentinel left there by a real
      // session would turn unrelated tests red. `state-empty` is created by `before` and stays so.
      XDG_STATE_HOME: options.stateHome ?? emptyState,
    };
    if (options.streamFile) env.FAKE_PI_STREAM = options.streamFile;
    if (options.piSignal) env.FAKE_PI_SIGNAL = options.piSignal;
    if (options.argvReport) env.FAKE_PI_ARGV_REPORT = options.argvReport;
    if (options.stdinReport) env.FAKE_PI_STDIN_REPORT = options.stdinReport;
    if (options.sentinelFrom) env.FAKE_PI_SENTINEL_FROM = options.sentinelFrom;
    if (options.sentinelTo) env.FAKE_PI_SENTINEL_TO = options.sentinelTo;
    if (options.holdMs) env.FAKE_PI_HOLD_MS = String(options.holdMs);
    if (options.signalReport) env.FAKE_PI_SIGNAL_REPORT = options.signalReport;
    if (options.onSignal) env.FAKE_PI_ON_SIGNAL = options.onSignal;

    const child = options.poisonStdin
      ? spawn(process.execPath, [PI_RUN, ...args], { stdio: ["pipe", "pipe", "pipe"], env })
      : spawn(process.execPath, [PI_RUN, ...args], { stdio: ["ignore", "pipe", "pipe"], env });

    // `stdin` is `null` on the "ignore" branch and a stream on the "pipe" one, so the union has
    // to be narrowed once rather than at each use.
    const stdin = child.stdin;
    if (options.poisonStdin && stdin !== null) {
      stdin.on("error", () => {
        // The wrapper never reads its own stdin and may exit first; EPIPE here is expected.
      });
      stdin.write("POISON — this must never reach the child\n");
    }

    const pending = (options.sendSignals ?? []).map(({ at, signal }) =>
      setTimeout(() => child.kill(signal), at),
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A timer still holding a dead pid would signal whatever inherits it next, and would keep
      // `node --test` alive past the assertion.
      for (const timer of pending) clearTimeout(timer);
      stdin?.destroy();
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("pi-run — the verdict comes from the stream, not from pi's exit code", () => {
  it("a good turn: exit 0, and no failure block on stderr", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("success.jsonl") });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
  });

  it("the V-01 401: pi exits 0, pi-run exits 20", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("auth-401.jsonl"), piExit: 0 });
    assert.equal(r.code, 20);
  });

  it("the 401 block names provider, model and the untruncated upstream message", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("auth-401.jsonl") });
    assert.match(r.stderr, /^\[pi-config\] provider call failed: reachable\/unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF/m);
    assert.match(r.stderr, /^ {2}provider {3}: reachable$/m);
    assert.match(r.stderr, /^ {2}model {6}: unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF$/m);
    assert.match(r.stderr, /^ {2}stopReason : error$/m);
    // Verbatim, untruncated — rule 2 of extensions/lib/provider-error.ts.
    assert.ok(
      r.stderr.includes(
        '401: {"message":"Invalid token payload","type":"authentication_error","param":null,"code":null}',
      ),
      `upstream text missing or truncated:\n${r.stderr}`,
    );
    assert.match(r.stderr, /^ {2}policy {5}: abort — no failover, no substitution, no retry/m);
  });

  it("a truncated stream is a failure, not a success: exit 21, naming agent_settled", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("truncated.jsonl") });
    assert.equal(r.code, 21);
    assert.match(r.stderr, /agent_settled/);
  });

  it("a user message_end without stopReason is normal — it is not read as a failure", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("user-message-end-only.jsonl") });
    // Not 20 (turn failed) and not 22 (drift): both user messages lack `stopReason`, and neither
    // may be judged. The run still fails, but only for the reason that is actually true.
    assert.equal(r.code, 21);
    assert.match(r.stderr, /without ever emitting an assistant `message_end`/);
    assert.doesNotMatch(r.stderr, /provider call failed/);
    assert.doesNotMatch(r.stderr, /shape this wrapper parses has drifted/);
  });

  it("an assistant message_end with no stopReason is protocol drift: exit 22, never 0", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("assistant-no-stop-reason.jsonl") });
    assert.equal(r.code, 22);
    assert.match(r.stderr, /carried no stopReason/);
    assert.match(r.stderr, /^ {2}model {6}: unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF$/m);
  });

  it("an aborted turn is exit 24, not 0 — `pi -p` exits 1 on it and the two modes must agree (SYNTHETIC fixture, hand-authored)", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("synthetic-aborted.jsonl") });
    assert.equal(r.code, 24);
    assert.match(r.stderr, /the turn was aborted/);
    assert.match(r.stderr, /^ {2}stopReason : aborted$/m);
    // 24 rather than 20: "the provider failed" and "something stopped the turn" want different
    // responses from whoever is on call, so they must be distinguishable from the exit code.
    assert.doesNotMatch(r.stderr, /provider call failed/);
  });

  it("no `error` event exists in either stream — the parser must not be waiting for one", async () => {
    const failing = await readFile(stream("auth-401.jsonl"), "utf8");
    const good = await readFile(stream("success.jsonl"), "utf8");
    const types = (text: string): string[] =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).type as string);
    assert.deepEqual(types(failing), types(good), "the failed turn's type sequence must match the good one");
    assert.ok(!types(failing).includes("error"));
  });
});

/**
 * Every fixture in this block is HAND-AUTHORED from the source, not recorded — the filenames
 * carry a `synthetic-` prefix and `test/fixtures/pi-run/README.md` says which source lines each
 * claim rests on. That is not laziness: `isRetryableAssistantError`
 * (`@earendil-works/pi-ai/dist/utils/retry.js:165`) only retries `stopReason: "error"` whose text
 * matches a transient-failure pattern (429, 500-504, overloaded, rate limit, socket/DNS/timeout).
 * V-01's `401 Invalid token payload` matches none of them, so the one endpoint that reliably
 * produces a failed turn is exactly the one that can never produce a retry. Recording a real
 * retry stream means an upstream that is overloaded on demand.
 *
 * Unlike `auth-401.jsonl`, whose assistant `message_end` is verbatim from the 2026-08-08 run.
 */
describe("pi-run — the retry discriminator (SYNTHETIC fixtures, hand-authored from the source)", () => {
  it("an error pi retried away is a note, not a failure: exit 0", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-retry-then-succeed.jsonl"),
    });
    // Without this, `settings.json`'s `retry.enabled: true` would make the wrapper exit 20 on
    // runs that succeeded — and a guard that cries wolf in cron gets switched off.
    assert.equal(r.code, 0);
    assert.match(r.stderr, /NOT counted as a failure/);
    assert.match(r.stderr, /willRetry=true/);
    // Reported, but not as a failure: the transient happened and the log must still say so.
    assert.doesNotMatch(r.stderr, /provider call failed/);
  });

  it("a retry that then exhausts is still a failure: exit 20, with the note and the block", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-retry-then-exhaust.jsonl"),
    });
    assert.equal(r.code, 20);
    assert.match(r.stderr, /NOT counted as a failure/, "the suppressed first attempt is still reported");
    assert.match(r.stderr, /provider call failed/, "the final attempt is a failure");
  });

  it("an error with NO following agent_end stays a failure — silence is not evidence of a retry", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-error-then-truncated.jsonl"),
    });
    // The one thing the discriminator must never do is open a fail-open path. The fixture's
    // error text is deliberately retryable-shaped, so an implementation that waited for an
    // `agent_end` and defaulted to "probably retried" would return 0 here.
    assert.equal(r.code, 20);
    assert.match(r.stderr, /provider call failed/);
    assert.doesNotMatch(r.stderr, /NOT counted as a failure/);
    // Both causes are explained even though only one decides the code (precedence 20 > 21).
    assert.match(r.stderr, /agent_settled/);
  });

  it("willRetry suppresses only the LAST pending error, never an earlier one", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-two-errors-one-retried.jsonl"),
    });
    // `_willRetryAfterAgentEnd` walks `event.messages` backwards and returns on the first
    // assistant message it finds, so the flag speaks for exactly one message.
    assert.equal(r.code, 20);
    assert.match(r.stderr, /THE EARLIER ERROR/, "the earlier error must survive as a failure");
    assert.match(r.stderr, /NOT counted as a failure/, "the last one was the retried one");
  });

  it("the retry fixtures really are labelled synthetic on disk, not just in prose", async () => {
    // The label has to survive someone opening the fixture directly, so it lives in the
    // filename. A synthetic fixture that is not marked synthetic is a trap for the next reader.
    for (const name of [
      "synthetic-retry-then-succeed.jsonl",
      "synthetic-retry-then-exhaust.jsonl",
      "synthetic-error-then-truncated.jsonl",
      "synthetic-two-errors-one-retried.jsonl",
      "synthetic-aborted.jsonl",
    ]) {
      await readFile(stream(name), "utf8");
      assert.ok(name.startsWith("synthetic-"));
    }
    const readme = await readFile(stream("README.md"), "utf8");
    assert.match(readme, /Synthetic — hand-authored from the source, never observed/);
    assert.match(readme, /verbatim/, "the recorded fixture's provenance must stay stated too");
  });
});

describe("pi-run — pi's own exit code", () => {
  it("a non-zero code from pi is passed through, not replaced", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("success.jsonl"), piExit: 3 });
    assert.equal(r.code, 3);
  });

  it("pi's code wins over the stream verdict, and the failure block is still printed", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("auth-401.jsonl"), piExit: 1 });
    assert.equal(r.code, 1, "pi said 1; pi-run must not overwrite it with 20");
    assert.match(r.stderr, /provider call failed/);
  });

  it("a pi that cannot be spawned exits 127, not 0", async () => {
    const r = await runPiRun(["-p", "hi"], { piBin: join(root, "definitely-not-a-binary") });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /could not run/);
  });

  it("a pi killed by a signal exits 128+N", async () => {
    const r = await runPiRun(["-p", "hi"], { piSignal: "SIGKILL" });
    assert.equal(r.code, 137, "SIGKILL is 9");
    assert.match(r.stderr, /killed by SIGKILL/);
  });
});

describe("pi-run — --mode json is forced", () => {
  it("appends `--mode json` when the caller did not ask for a mode", async () => {
    const report = `${scratch()}-argv.json`;
    const r = await runPiRun(["-p", "hi", "--model", "local/qwen"], {
      streamFile: stream("success.jsonl"),
      argvReport: report,
    });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), [
      "-p",
      "hi",
      "--model",
      "local/qwen",
      "--mode",
      "json",
    ]);
  });

  it("leaves an explicit `--mode json` alone rather than duplicating it", async () => {
    const report = `${scratch()}-argv.json`;
    await runPiRun(["-p", "hi", "--mode", "json"], {
      streamFile: stream("success.jsonl"),
      argvReport: report,
    });
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), ["-p", "hi", "--mode", "json"]);
  });

  it("accepts the `--mode=json` spelling too", async () => {
    const report = `${scratch()}-argv.json`;
    const r = await runPiRun(["-p", "hi", "--mode=json"], {
      streamFile: stream("success.jsonl"),
      argvReport: report,
    });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), ["-p", "hi", "--mode=json"]);
  });

  it("refuses any other mode with exit 2, and never spawns pi", async () => {
    const report = `${scratch()}-argv.json`;
    const r = await runPiRun(["-p", "hi", "--mode", "text"], {
      streamFile: stream("success.jsonl"),
      argvReport: report,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to run with --mode text/);
    await assert.rejects(() => readFile(report, "utf8"), "pi must not have been spawned at all");
  });

  it("refuses `--mode=rpc` as well", async () => {
    const r = await runPiRun(["-p", "hi", "--mode=rpc"], { streamFile: stream("success.jsonl") });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to run with --mode rpc/);
  });
});

describe("pi-run — the child's stdin is /dev/null", () => {
  it("gives the child a character device even when pi-run's own stdin is an open pipe", async () => {
    const report = `${scratch()}-stdin.json`;
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("success.jsonl"),
      stdinReport: report,
      poisonStdin: true,
    });
    assert.equal(r.code, 0);
    const seen = JSON.parse(await readFile(report, "utf8")) as {
      kind: string;
      bytes: number | null;
      error: string | null;
    };
    // An inherited pipe would be "fifo" here, and `pi -p` on a pipe that never closes hangs
    // forever — measured, V-01. /dev/null is a character device that reads 0 bytes at once.
    assert.equal(seen.kind, "chardev", `child's fd 0 was ${seen.kind}, so stdin was not /dev/null`);
    assert.equal(seen.bytes, 0);
    assert.equal(seen.error, null);
  });
});

describe("pi-run — stdout passthrough and stream parsing", () => {
  it("streams the child's stdout through byte-for-byte", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("auth-401.jsonl") });
    assert.equal(r.stdout, await readFile(stream("auth-401.jsonl"), "utf8"));
  });

  it("judges a final line that has no trailing newline", async () => {
    const dir = scratch();
    const file = `${dir}-no-trailing-newline.jsonl`;
    await writeFile(file, (await readFile(stream("auth-401.jsonl"), "utf8")).trimEnd());
    const r = await runPiRun(["-p", "hi"], { streamFile: file });
    // `agent_settled` is the last line; without the end-of-stream flush this would be 21.
    assert.equal(r.code, 20);
  });

  it("ignores non-JSON stdout noise instead of failing on it", async () => {
    const dir = scratch();
    const file = `${dir}-noisy.jsonl`;
    const good = await readFile(stream("success.jsonl"), "utf8");
    await writeFile(file, `an extension used console.log\n${good}not JSON either\n`);
    const r = await runPiRun(["-p", "hi"], { streamFile: file });
    assert.equal(r.code, 0, "a console.log from an extension must not decide the exit code");
  });
});

/**
 * V-08 was run against a live `pi` 0.84.0 on 2026-08-08 and FAILED: neither `ctx.shutdown()` nor
 * `ctx.abort()` stops a headless run from inside an extension — both returned `undefined` and the
 * session carried on to the next turn and exited 0. So the runbook's FAIL branch applies, and this
 * is the wrapper half of it. The fixtures below are the recorded proof: `compaction-loop.jsonl` is
 * a real `--mode json` stream from a run whose guard tripped, and it ends `agent_settled` with no
 * failing message — i.e. exit 0 — which is precisely what the wrapper has to override.
 */
describe("pi-run — the compaction loop guard (V-08)", () => {
  // Recorded, from the session that produced `compaction-loop.jsonl`.
  const LOOP_SESSION = "019fe051-681f-7907-96a6-b9b8a379a37c";
  // The id the other fixtures carry.
  const FIXTURE_SESSION = "01K2Q7X4W8ZC5N3B6D9F0G2H1J";
  const SENTINEL = stream("compaction-loop.sentinel.json");

  /**
   * `<stateRoot>/compaction-loop/<file>.json`. `file` is the sanitised stem, spelled out by the
   * caller rather than derived here: the sanitiser is one of the things under test, and a helper
   * that applied it too would only prove the test agrees with itself.
   */
  const sentinelAt = (stateHome: string, file: string): string =>
    join(stateHome, "pi-config", "compaction-loop", `${file}.json`);

  const freshState = async (): Promise<string> => {
    const dir = `${scratch()}-state`;
    await mkdir(dir, { recursive: true });
    return dir;
  };

  it("turns pi's exit 0 into 23 when the stream carries the guard's entry", async () => {
    const r = await runPiRun(["-p", "hi"], { streamFile: stream("compaction-loop.jsonl") });
    assert.equal(r.code, 23, "pi returned 0 on a tripped guard — measured, V-08");
    assert.match(r.stderr, /the compaction loop guard tripped/);
    assert.match(r.stderr, new RegExp(`session +: ${LOOP_SESSION}`));
    assert.match(r.stderr, /trigger +: overflow/);
    assert.match(r.stderr, /source +: the pi-config\.compaction-loop entry/);
  });

  it("trips on the sentinel alone, because writing it is best-effort at the other end", async () => {
    const stateHome = await freshState();
    const r = await runPiRun(["-p", "hi"], {
      // The same stream with the `entry_appended` line removed: the wrapper has nothing to read
      // but the file on disk.
      streamFile: stream("synthetic-compaction-loop-sentinel-only.jsonl"),
      stateHome,
      sentinelFrom: SENTINEL,
      sentinelTo: sentinelAt(stateHome, LOOP_SESSION),
    });
    assert.equal(r.code, 23);
    assert.match(r.stderr, /source +: sentinel /);
    assert.match(r.stderr, /passes +: 1 automatic, 1 consecutive non-reducing \(limit 1\)/);
  });

  it("keeps pi's own headlessExitCode when the extension exited by itself, and still reports", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("compaction-loop.jsonl"),
      piExit: 91,
    });
    assert.equal(r.code, 91, "the extension chose 91; 23 is only for a pi that returned 0 anyway");
    assert.match(r.stderr, /the compaction loop guard tripped/);
  });

  it("ignores a sentinel left by an earlier run of the same session", async () => {
    const stateHome = await freshState();
    const path = sentinelAt(stateHome, LOOP_SESSION);
    await mkdir(join(stateHome, "pi-config", "compaction-loop"), { recursive: true });
    await writeFile(path, await readFile(SENTINEL, "utf8"));
    // A session id survives `--resume`, so an hour-old sentinel must not condemn this run.
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(path, anHourAgo, anHourAgo);
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-compaction-loop-sentinel-only.jsonl"),
      stateHome,
    });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /compaction loop/);
  });

  it("ignores another session's sentinel sitting in the same state root", async () => {
    const stateHome = await freshState();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("success.jsonl"),
      stateHome,
      sentinelFrom: SENTINEL,
      sentinelTo: sentinelAt(stateHome, "some-other-session"),
    });
    assert.equal(r.code, 0, "the guard is per-session; a neighbour's sentinel is not this run's");
    assert.doesNotMatch(r.stderr, /compaction loop/);
  });

  it("looks under the sanitised session id, the way the extension writes it", async () => {
    const stateHome = await freshState();
    const r = await runPiRun(["-p", "hi"], {
      // Session id `weird/id one:2026` — `/` would make the extension's own writer escape the
      // directory, so it replaces every character outside [A-Za-z0-9._-] with `_`.
      streamFile: stream("synthetic-session-id-needs-sanitising.jsonl"),
      stateHome,
      sentinelFrom: SENTINEL,
      sentinelTo: sentinelAt(stateHome, "weird_id_one_2026"),
    });
    assert.equal(r.code, 23);
    assert.match(r.stderr, /source +: sentinel /);
  });

  it("outranks the stream's own verdict, and prints both blocks", async () => {
    const stateHome = await freshState();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("auth-401.jsonl"),
      stateHome,
      sentinelFrom: SENTINEL,
      sentinelTo: sentinelAt(stateHome, FIXTURE_SESSION),
    });
    assert.equal(r.code, 23, "20 would blame the provider for a context that stopped shrinking");
    assert.match(r.stderr, /provider call failed/);
    assert.match(r.stderr, /the compaction loop guard tripped/);
  });

  it("kills a pi that carries on after the trip, and says it did", async () => {
    const stateHome = await freshState();
    const started = Date.now();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-compaction-loop-sentinel-only.jsonl"),
      stateHome,
      sentinelFrom: SENTINEL,
      sentinelTo: sentinelAt(stateHome, LOOP_SESSION),
      // Longer than the wrapper's 2 s grace by enough that "the wrapper killed it" and "the fake
      // gave up on its own" cannot be confused. The fake exits 70 if it is never killed.
      holdMs: 15_000,
    });
    assert.equal(r.code, 23, "70 here would mean the child outlived the wrapper's SIGTERM");
    assert.match(r.stderr, /action +: pi was still running 2000 ms after the trip and was sent SIGTERM/);
    assert.ok(Date.now() - started < 10_000, "the kill must not wait for the child's own timer");
  });
});

/**
 * A wrapper that dies on SIGTERM and leaves `pi` running is worse than no wrapper: the caller sees
 * a status, believes the run is over, and a headless `pi` keeps a model, a session file and an
 * unread stdout pipe with nothing left to reap it. launchd and systemd stop a job by signalling
 * the process they started — this one — so this is the ordinary shutdown path.
 *
 * Every test here signals `pi-run` ITSELF, never the fake `pi`: `child.kill()` targets one pid and
 * not the process group, so the child can only learn of a signal by having it forwarded. The fake
 * records what it received (`FAKE_PI_SIGNAL_REPORT`), so "the child observably got SIGTERM" is a
 * fact on disk rather than an inference from the exit code — and a forwarding regression shows up
 * as the fake's own `exit 70` after its hold timer, a nameable failure instead of a hung suite.
 */
describe("pi-run — signals are forwarded, and pi's own fate decides the code", () => {
  /** Longer than every grace in play (2 s loop, 5 s SIGKILL), so `exit 70` can only mean a leak. */
  const HOLD_MS = 20_000;
  // The same recorded session as the compaction block above; restated rather than shared because
  // the two blocks are read separately and a reader must see which sentinel is in play.
  const LOOP_SESSION = "019fe051-681f-7907-96a6-b9b8a379a37c";
  const SENTINEL = stream("compaction-loop.sentinel.json");

  const signalsSeen = async (path: string): Promise<string[]> =>
    JSON.parse(await readFile(path, "utf8")) as string[];

  it("forwards SIGTERM to pi, waits for it, and exits 128+15", async () => {
    const report = `${scratch()}-signals.json`;
    const started = Date.now();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("success.jsonl"),
      holdMs: HOLD_MS,
      signalReport: report,
      sendSignals: [{ at: 400, signal: "SIGTERM" }],
    });
    assert.deepEqual(await signalsSeen(report), ["SIGTERM"], "the child must have received SIGTERM");
    // The bug this closes: with no handler the wrapper dies OF the signal, so this assertion would
    // be `{ code: null, signal: "SIGTERM" }` — and the child would still be running.
    assert.equal(r.signal, null, "pi-run must handle the signal, not die of it");
    assert.equal(r.code, 143, "128+15 — the child's real fate, not the wrapper's");
    assert.match(r.stderr, /got SIGTERM — forwarded it to/);
    assert.match(r.stderr, /exited on the forwarded SIGTERM/);
    assert.ok(Date.now() - started < 10_000, "it must not have waited for the fake's own timer");
  });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    it(`forwards ${signal} as well, and exits ${code}`, async () => {
      const report = `${scratch()}-signals.json`;
      const r = await runPiRun(["-p", "hi"], {
        streamFile: stream("success.jsonl"),
        holdMs: HOLD_MS,
        signalReport: report,
        sendSignals: [{ at: 400, signal }],
      });
      assert.deepEqual(await signalsSeen(report), [signal]);
      assert.equal(r.code, code, `128+N for ${signal}`);
    });
  }

  it("escalates to SIGKILL when pi ignores the signal, rather than waiting on it forever", async () => {
    const report = `${scratch()}-signals.json`;
    const started = Date.now();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("success.jsonl"),
      holdMs: HOLD_MS,
      signalReport: report,
      onSignal: "ignore",
      sendSignals: [{ at: 400, signal: "SIGTERM" }],
    });
    assert.deepEqual(await signalsSeen(report), ["SIGTERM"], "the child got it and survived it");
    // 70 here would mean the fake outlived the wrapper's escalation — the orphan, again.
    assert.equal(r.code, 137, "128+9: SIGKILL is what actually killed pi, and the line says why");
    assert.match(r.stderr, /did not exit 5000 ms after SIGTERM — escalating to SIGKILL/);
    assert.match(r.stderr, /ignored the forwarded SIGTERM for 5000 ms and was killed by SIGKILL/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 5_000, `the grace must actually be served, took ${elapsed} ms`);
    assert.ok(elapsed < 15_000, `the escalation must not wait for the fake's timer, took ${elapsed} ms`);
  });

  it("repeated signals are not re-forwarded and do not push the escalation away", async () => {
    const report = `${scratch()}-signals.json`;
    const started = Date.now();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("success.jsonl"),
      holdMs: HOLD_MS,
      signalReport: report,
      onSignal: "ignore",
      // An operator leaning on Ctrl-C, or a supervisor that retries its stop.
      sendSignals: [400, 900, 1400, 1900].map((at) => ({ at, signal: "SIGTERM" as NodeJS.Signals })),
    });
    assert.deepEqual(await signalsSeen(report), ["SIGTERM"], "the child must be signalled once");
    assert.equal(r.code, 137);
    assert.equal((r.stderr.match(/forwarded it to/g) ?? []).length, 1, "one forward, not four");
    assert.equal(
      (r.stderr.match(/already being shut down/g) ?? []).length,
      1,
      "the repeat is explained once, not once per signal",
    );
    // The point of ignoring repeats: re-arming the timer on each one would move the SIGKILL to
    // 1900+5000 ms and, with a caller that signals in a loop, to never.
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6_500, `the escalation was postponed by the repeats, took ${elapsed} ms`);
  });

  it("a pi that handles the signal and exits with its own code keeps that code, not 128+N", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("success.jsonl"),
      holdMs: HOLD_MS,
      onSignal: "exit",
      piExit: 3,
      sendSignals: [{ at: 400, signal: "SIGTERM" }],
    });
    // The passthrough rule does not get an exception just because a signal was involved: the child
    // did not die of the signal, so 143 would be a fiction and 3 is what pi actually said.
    assert.equal(r.code, 3);
    assert.match(r.stderr, /handled the forwarded SIGTERM and exited with code 3 of its own/);
  });

  it("an interrupted run still cannot report success: pi exits 0 mid-stream, the verdict is 21", async () => {
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("truncated.jsonl"),
      holdMs: HOLD_MS,
      onSignal: "exit",
      piExit: 0,
      sendSignals: [{ at: 400, signal: "SIGTERM" }],
    });
    // This is why the wrapper does not need to invent 128+N for a child that exited 0: a run cut
    // short has no `agent_settled`, so the stream verdict is already a failure.
    assert.equal(r.code, 21);
    assert.match(r.stderr, /agent_settled/);
  });

  it("one killer, not two: a forwarded signal that lands first takes the child, and the loop guard's kill never fires", async () => {
    const stateHome = `${scratch()}-state`;
    await mkdir(stateHome, { recursive: true });
    const started = Date.now();
    const r = await runPiRun(["-p", "hi"], {
      streamFile: stream("synthetic-compaction-loop-sentinel-only.jsonl"),
      stateHome,
      sentinelFrom: SENTINEL,
      sentinelTo: join(stateHome, "pi-config", "compaction-loop", `${LOOP_SESSION}.json`),
      holdMs: HOLD_MS,
      // Inside the guard's 2 s deferral, which is the only window in which the two killers can
      // disagree: the trip is already known, its SIGTERM is scheduled and has not yet been sent.
      sendSignals: [{ at: 700, signal: "SIGTERM" }],
    });
    assert.equal(r.code, 143, "the death is attributed to whoever asked for it, and the guard did not");
    assert.match(r.stderr, /the compaction loop guard tripped/, "the trip is still reported in full");
    assert.match(
      r.stderr,
      /action +: none — the run was already being ended by the forwarded SIGTERM/,
      "the guard must not claim a kill it never made, nor say pi ended on its own",
    );
    assert.doesNotMatch(
      r.stderr,
      /was still running 2000 ms after the trip and was sent SIGTERM/,
      "the second killer must not have fired at all",
    );
    assert.ok(Date.now() - started < 10_000);
  });
});

describe("pi-run — the exit-code precedence the signal path must not have moved", () => {
  it("every verdict and every passthrough still returns exactly what it did before", async () => {
    // Signal forwarding touches the `close` handler, which is where every one of these is decided.
    // Restated here as one table so a regression shows up as a moved number rather than as a
    // scattering of failures in six other blocks.
    const cases: [string, RunOptions, number][] = [
      ["a good run", { streamFile: stream("success.jsonl") }, 0],
      ["a failed turn", { streamFile: stream("auth-401.jsonl") }, 20],
      ["a truncated stream", { streamFile: stream("truncated.jsonl") }, 21],
      ["protocol drift", { streamFile: stream("assistant-no-stop-reason.jsonl") }, 22],
      ["an aborted turn", { streamFile: stream("synthetic-aborted.jsonl") }, 24],
      ["a compaction loop", { streamFile: stream("compaction-loop.jsonl") }, 23],
      ["20 over 21", { streamFile: stream("synthetic-error-then-truncated.jsonl") }, 20],
      ["pi's own code over 20", { streamFile: stream("auth-401.jsonl"), piExit: 1 }, 1],
      ["pi's own code over 23", { streamFile: stream("compaction-loop.jsonl"), piExit: 91 }, 91],
    ];
    for (const [name, options, expected] of cases) {
      const r = await runPiRun(["-p", "hi"], options);
      assert.equal(r.code, expected, `${name}: expected ${expected}, got ${r.code}`);
    }
  });
});

describe("pi-run — its own CLI surface", () => {
  it("no arguments is a usage error, exit 2", async () => {
    const r = await runPiRun([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /nothing to run/);
  });

  it("--help prints the exit-code table and exits 0 without spawning pi", async () => {
    const report = `${scratch()}-argv.json`;
    const r = await runPiRun(["--help"], { argvReport: report });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /exit codes:/);
    await assert.rejects(() => readFile(report, "utf8"));
  });

  it("documents 23 as the compaction-loop code, no longer as a reservation", async () => {
    const r = await runPiRun(["-h"]);
    assert.equal(r.code, 0);
    // It was RESERVED until V-08 had actually been run. It has been, it failed, and the guard
    // above returns 23 for real — so the help text must have stopped promising it to a future.
    assert.match(r.stdout, /^ {3}23 {2}compaction loop/m);
    assert.doesNotMatch(r.stdout, /^ {3}23 {2}RESERVED/m);
  });

  it("documents every exit code the tests pin, so the header cannot drift from the behaviour", async () => {
    const r = await runPiRun(["--help"]);
    for (const code of ["    0 ", "    2 ", "   20 ", "   21 ", "   22 ", "   23 ", "   24 ", "  127 "]) {
      assert.ok(r.stdout.includes(code), `exit code line missing from --help: "${code.trim()}"`);
    }
    assert.match(r.stdout, /precedence: 23 > 20 > 24 > 22 > 21/);
  });
});

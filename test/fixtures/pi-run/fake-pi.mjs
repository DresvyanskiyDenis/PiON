#!/usr/bin/env node
// test/fixtures/pi-run/fake-pi.mjs — the stand-in `pi` that `bin/pi-run`'s tests drive.
//
// `bin/pi-run` decides its exit code from the `--mode json` event stream, so its tests must
// exercise streams, not models: no network, no llama-swap, no credential. This script replays a
// recorded stream from `test/fixtures/pi-run/*.jsonl` and exits with whatever code the test asks
// for. `bin/pi-run` finds it through `PI_RUN_PI_BIN`.
//
// It also records two things the wrapper's contract depends on and that are otherwise invisible
// from outside:
//
//   FAKE_PI_ARGV_REPORT   the argv it was handed, as JSON — proves `--mode json` was forced.
//   FAKE_PI_STDIN_REPORT  what fd 0 actually is, as JSON — proves stdin came from /dev/null.
//
// And two knobs for the V-08 compaction-loop guard, which is about a file appearing WHILE the
// child runs:
//
//   FAKE_PI_SENTINEL_FROM / _TO   copy a recorded sentinel into place, after the stream.
//   FAKE_PI_HOLD_MS               do not exit; stay alive so the wrapper has to kill it.
//
// And two for signal forwarding, which is a claim about what the CHILD sees and therefore cannot
// be tested from the wrapper's side alone:
//
//   FAKE_PI_SIGNAL_REPORT   every signal this process received, in order, as JSON. A child killed
//                           by the default disposition leaves no trace of WHICH signal arrived,
//                           and "it died" is not proof that the right one was forwarded — nor
//                           that a repeat was forwarded only once.
//   FAKE_PI_ON_SIGNAL       what to do with one: `reraise` (the default whenever either knob is
//                           set) dies OF the signal, `ignore` survives it so the wrapper has to
//                           escalate, `exit` returns FAKE_PI_EXIT as its own code.
//
// The stdin probe is `fstatSync(0)`, deliberately, and never a blocking read. /dev/null is a
// character device; an inherited pipe is a FIFO, so the two are distinguishable without reading a
// byte. A read would be the honest test and also a trap: if the wrapper ever regressed to
// inheriting stdin, reading fd 0 would block on the test's own open pipe and the suite would hang
// instead of failing. The `readSync` below therefore runs only once fd 0 is known to be a
// character device, where it is guaranteed to return 0 bytes immediately.

import { fstatSync, mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argvReport = process.env.FAKE_PI_ARGV_REPORT;
if (argvReport) writeFileSync(argvReport, JSON.stringify(process.argv.slice(2)));

const stdinReport = process.env.FAKE_PI_STDIN_REPORT;
if (stdinReport) {
  const report = { kind: "unknown", bytes: null, error: null };
  try {
    const stat = fstatSync(0);
    report.kind = stat.isCharacterDevice()
      ? "chardev"
      : stat.isFIFO()
        ? "fifo"
        : stat.isFile()
          ? "file"
          : stat.isSocket()
            ? "socket"
            : "other";
    if (report.kind === "chardev") {
      report.bytes = readSync(0, Buffer.alloc(64), 0, 64, null);
    }
  } catch (err) {
    report.error = `${err.code ?? "error"}: ${err.message}`;
  }
  writeFileSync(stdinReport, JSON.stringify(report));
}

const stream = process.env.FAKE_PI_STREAM;
if (stream) process.stdout.write(readFileSync(stream));

const stderrText = process.env.FAKE_PI_STDERR;
if (stderrText) process.stderr.write(stderrText);

// The compaction loop guard writes its sentinel from inside the session, while `pi` is still
// running (`extensions/compaction/index.ts` `abortOnLoop`). Reproducing that ordering is the only
// way to test that `bin/pi-run` KILLS a child rather than merely noticing afterwards, so the
// stand-in writes the file at the same point in its life: after the stream, before it ends.
const sentinelTo = process.env.FAKE_PI_SENTINEL_TO;
if (sentinelTo) {
  mkdirSync(dirname(sentinelTo), { recursive: true });
  writeFileSync(sentinelTo, readFileSync(process.env.FAKE_PI_SENTINEL_FROM));
}

const signalReport = process.env.FAKE_PI_SIGNAL_REPORT;
const onSignal = process.env.FAKE_PI_ON_SIGNAL;
if (signalReport || onSignal) {
  const seen = [];
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(name, () => {
      seen.push(name);
      if (signalReport) writeFileSync(signalReport, JSON.stringify(seen));
      if (onSignal === "ignore") return;
      if (onSignal === "exit") process.exit(Number(process.env.FAKE_PI_EXIT ?? "0"));
      // Re-raise. Removing the last listener restores the default disposition, so the process
      // really dies OF the signal and the wrapper's `close` sees a signal rather than a code —
      // a plain `process.exit(128 + n)` would look like an ordinary exit code and would prove
      // the wrapper's 128+N row nothing at all.
      process.removeAllListeners(name);
      process.kill(process.pid, name);
    });
  }
}

const signal = process.env.FAKE_PI_SIGNAL;
const holdMs = Number(process.env.FAKE_PI_HOLD_MS ?? "0");
if (signal) {
  process.kill(process.pid, signal);
} else if (holdMs > 0) {
  // A `pi` that does not end on its own — the case the wrapper has to terminate. If it is still
  // here when the timer fires, the wrapper failed to kill it and the test sees exit 70 rather
  // than a hang it would have to diagnose from a timeout.
  setTimeout(() => process.exit(70), holdMs);
} else {
  process.exitCode = Number(process.env.FAKE_PI_EXIT ?? "0");
}

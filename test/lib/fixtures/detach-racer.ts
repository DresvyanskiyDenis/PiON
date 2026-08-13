/**
 * One "session" in the outage-shape regression test. Waits for a shared start instant so the
 * processes hit `mkdir(2)` genuinely at the same time, then prints its outcome and exits —
 * exactly like a `pi` process at session shutdown, which is the shape that broke the
 * predecessor: the spawner is gone while the worker is still running.
 *
 * argv: <lockDir> <markerFile> <startAtEpochMs> [workerLifetimeMs]
 */
import { runDetached } from "../../../extensions/lib/detach.ts";

const [lockDir, markerFile, startAtRaw, lifetimeRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);
const lifetimeMs = Number(lifetimeRaw ?? "3000");

const wait = startAt - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));

const worker =
  `require("node:fs").appendFileSync(${JSON.stringify(markerFile)}, process.pid + "\\n"); ` +
  `setTimeout(() => {}, ${lifetimeMs})`;

const outcome = await runDetached([process.execPath, "-e", worker], {
  lockDir,
  version: "race-1",
  onError: (line) => process.stderr.write(`${line}\n`),
});

process.stdout.write(`${outcome}\n`);

/**
 * EXT-24 — the bridge from the job store to `pi-subagents`' registries.
 *
 * The regression these lock down: `pi-subagents` 0.57.0 moved external runs from a `v1` *provider*
 * registry to a `v2` *record* registry under a new symbol, and this module went on registering a
 * provider into `v1`. Nothing reads `v1`, nothing errored, and detached jobs simply stopped
 * appearing on the fleet panel below the editor. The version field could not catch it — the
 * version is inside the registry and the registry is addressed by a versioned symbol — so the
 * first test here asserts the key strings against the installed package's own source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, it } from "node:test";

import {
  BACKGROUND_WORK_PROTOCOL_VERSION,
  BACKGROUND_WORK_REGISTRY_KEY,
  EXTERNAL_RUN_REGISTRY_KEY,
  EXTERNAL_RUN_REGISTRY_VERSION,
  PROVIDER_NAME,
  externalRunKey,
  publishExternalRuns,
  registerJobProviders,
  toBackgroundWorkItems,
  toExternalRun,
  toExternalRuns,
  unpublishExternalRuns,
  type ExternalRunRecord,
} from "../../extensions/jobs/registry.ts";
import { JOB_SCHEMA, type JobState } from "../../extensions/jobs/store.ts";

const SESSION_FILE = "/home/user/.local/state/pi/sessions/2026-08-28T10-00-00_abcdef.jsonl";

function job(over: Partial<JobState> = {}): JobState {
  return {
    schema: JOB_SCHEMA,
    id: "abc-1234",
    kind: "bash",
    cwd: "/work",
    cmd: "sleep 5",
    pid: 4242,
    pgid: 4242,
    status: "running",
    startedAt: 1_700_000_000_000,
    parentSession: "sess-A",
    depth: 0,
    ...over,
  };
}

interface ProviderSlot<P> {
  version: number;
  providers: Map<string, P>;
}

interface RunSlot {
  version: number;
  runs: Map<string, ExternalRunRecord>;
}

function slot<T>(key: string): T | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[Symbol.for(key)] as T | undefined;
}

function clearRegistries(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)];
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

/**
 * The installed package's own source for one of its exported subpaths.
 *
 * Read as text rather than imported: these are `.ts` files inside `node_modules`, which Node
 * refuses to type-strip (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — the same wall that makes
 * `registry.ts` re-implement the protocols instead of importing them. Resolved through the export
 * map rather than by a hand-built path, so the assertion survives the package moving its files
 * around and fails only when it moves the *protocol*.
 */
function packageSource(specifier: string): string {
  return readFileSync(createRequire(import.meta.url).resolve(specifier), "utf8");
}

describe("jobs → pi-subagents registries (EXT-24)", () => {
  beforeEach(clearRegistries);

  it("publishes to the keys and versions the installed pi-subagents actually reads", () => {
    const backgroundWork = packageSource("pi-subagents/background-work");
    assert.match(
      backgroundWork,
      new RegExp(`BACKGROUND_WORK_REGISTRY_KEY = "${BACKGROUND_WORK_REGISTRY_KEY}"`),
      "the package moved the background-work registry key",
    );
    assert.match(
      backgroundWork,
      new RegExp(`BACKGROUND_WORK_PROTOCOL_VERSION = ${BACKGROUND_WORK_PROTOCOL_VERSION}\\b`),
      "the package bumped the background-work protocol version",
    );

    const externalRuns = packageSource("pi-subagents/external-runs");
    assert.match(
      externalRuns,
      new RegExp(`EXTERNAL_RUN_REGISTRY_KEY = "${EXTERNAL_RUN_REGISTRY_KEY}"`),
      "the package moved the external-run registry key — our records are going nowhere",
    );
    assert.match(
      externalRuns,
      new RegExp(`EXTERNAL_RUN_REGISTRY_VERSION = ${EXTERNAL_RUN_REGISTRY_VERSION}\\b`),
      "the package bumped the external-run protocol version",
    );
  });

  it("registers the background-work provider and takes exactly it back", () => {
    const dispose = registerJobProviders({ snapshot: () => [], onError: () => {} });
    assert.equal(
      slot<ProviderSlot<unknown>>(BACKGROUND_WORK_REGISTRY_KEY)?.version,
      BACKGROUND_WORK_PROTOCOL_VERSION,
    );
    assert.ok(slot<ProviderSlot<unknown>>(BACKGROUND_WORK_REGISTRY_KEY)?.providers.has(PROVIDER_NAME));
    dispose();
    assert.equal(slot<ProviderSlot<unknown>>(BACKGROUND_WORK_REGISTRY_KEY)?.providers.size, 0);
  });

  it("creates the external-run registry at the version pi-subagents expects", () => {
    publishExternalRuns(SESSION_FILE, []);
    assert.equal(slot<RunSlot>(EXTERNAL_RUN_REGISTRY_KEY)?.version, EXTERNAL_RUN_REGISTRY_VERSION);
  });

  it("joins an existing registry rather than replacing it", () => {
    const foreign = { name: "someone-else", listActiveWork: () => [] };
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)] = {
      version: BACKGROUND_WORK_PROTOCOL_VERSION,
      providers: new Map([["someone-else", foreign]]),
    };
    const dispose = registerJobProviders({ snapshot: () => [], onError: () => {} });
    assert.equal(slot<ProviderSlot<unknown>>(BACKGROUND_WORK_REGISTRY_KEY)?.providers.size, 2);
    dispose();
    assert.equal(slot<ProviderSlot<unknown>>(BACKGROUND_WORK_REGISTRY_KEY)?.providers.get("someone-else"), foreign);
  });

  it("refuses loudly when a registry speaks a different protocol version", () => {
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)] = {
      version: 99,
      providers: new Map(),
    };
    assert.throws(
      () => registerJobProviders({ snapshot: () => [], onError: () => {} }),
      /is version 99, this build speaks version 1/,
    );
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = {
      version: 99,
      runs: new Map(),
    };
    assert.throws(() => publishExternalRuns(SESSION_FILE, []), /is version 99, this build speaks version 2/);
  });

  it("reports only running work, attributed to the session that started it", () => {
    const items = toBackgroundWorkItems([
      job({ id: "run-1", parentSession: "sess-A" }),
      job({ id: "run-2", parentSession: "sess-B" }),
      job({ id: "done-1", status: "done", exitCode: 0 }),
      job({ id: "killed-1", status: "killed" }),
    ]);
    assert.deepEqual(items, [
      { id: "run-1", sessionId: "sess-A" },
      { id: "run-2", sessionId: "sess-B" },
    ]);
  });

  it("carries exactly the fields the v2 record schema knows, and no others", () => {
    const run = toExternalRun(job({ label: "nightly build" }), SESSION_FILE);
    assert.deepEqual(run, {
      id: "abc-1234",
      sessionId: SESSION_FILE,
      source: PROVIDER_NAME,
      label: "nightly build",
      state: "running",
      startedAt: 1_700_000_000_000,
    });
    // `validateRun` rejects a record carrying a key it does not know, and a rejected record is
    // *deleted* on read — so the v1 decorations were not merely unused, they were fatal.
    for (const gone of ["cwd", "command", "exitCode", "completionReason", "pid"]) {
      assert.equal(Object.hasOwn(run!, gone), false, `${gone} would delete the record on read`);
    }
  });

  it("labels a job by its label, falling back to the command", () => {
    assert.equal(toExternalRun(job(), SESSION_FILE)?.label, "sleep 5");
    assert.equal(toExternalRun(job({ label: "ingest" }), SESSION_FILE)?.label, "ingest");
    assert.equal(toExternalRun(job({ cmd: "z".repeat(5_000) }), SESSION_FILE)?.label.length, 160);
  });

  it("publishes only the running jobs, and only the ones the panel could render", () => {
    const runs = toExternalRuns(
      [
        job({ id: "a", status: "running", startedAt: 3 }),
        job({ id: "b", status: "done", exitCode: 0, finishedAt: 5 }),
        job({ id: "c", status: "failed", exitCode: 3, finishedAt: 6 }),
        job({ id: "d", status: "killed", finishedAt: 8 }),
        job({ id: "e", status: "running", startedAt: 1 }),
      ],
      SESSION_FILE,
    );
    // The terminal states exist in the vocabulary but never reach the panel (`isActiveState`), so
    // publishing them would only spend the shared 100-record budget.
    assert.deepEqual(
      runs.map((run) => [run.id, run.state]),
      [
        ["e", "running"],
        ["a", "running"],
      ],
    );
  });

  it("bounds its own contribution to the shared cache at the snapshot width", () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      job({ id: `run-${String(index).padStart(3, "0")}`, startedAt: 1_000 + index }),
    );
    assert.equal(toExternalRuns(many, SESSION_FILE).length, 20);
  });

  it("drops a record the protocol would reject instead of poisoning the snapshot", () => {
    assert.equal(toExternalRun(job(), ""), undefined);
    assert.equal(toExternalRun(job({ id: " untrimmed " }), SESSION_FILE), undefined);
    assert.equal(toExternalRun(job({ id: "x".repeat(161) }), SESSION_FILE), undefined);
    assert.equal(toExternalRun(job({ cmd: "   ", label: "  " }), SESSION_FILE), undefined);
    assert.equal(toExternalRun(job({ startedAt: -1 }), SESSION_FILE), undefined);
    // `identity()` demands the value survive `sanitizeDisplayText` untouched: a tab, a doubled
    // space or an ANSI escape in the path would make the record vanish on read.
    assert.equal(toExternalRun(job(), "/state/a\tb"), undefined);
    assert.equal(toExternalRun(job(), "/state/a  b"), undefined);
    assert.equal(toExternalRun(job(), "/state/a\u001b[0mb"), undefined);
    // A single interior space is preserved by the sanitiser, so it must not be rejected.
    assert.ok(toExternalRun(job(), "/state/My Projects/s.jsonl"));
  });

  it("makes the registry agree with the store on every call, and cleans up only its own rows", () => {
    const foreign: ExternalRunRecord = {
      id: "theirs",
      sessionId: SESSION_FILE,
      source: "some-other-extension",
      label: "not ours",
      state: "running",
      startedAt: 1,
    };
    publishExternalRuns(SESSION_FILE, [job({ id: "a" }), job({ id: "b" })]);
    const runs = slot<RunSlot>(EXTERNAL_RUN_REGISTRY_KEY)!.runs;
    runs.set(externalRunKey(SESSION_FILE, "theirs"), foreign);

    assert.equal(runs.size, 3);
    assert.ok(runs.has(externalRunKey(SESSION_FILE, "a")));

    // `a` finished, `c` started: one call, and no bookkeeping about what changed.
    publishExternalRuns(SESSION_FILE, [
      job({ id: "a", status: "done", exitCode: 0 }),
      job({ id: "b" }),
      job({ id: "c" }),
    ]);
    assert.deepEqual(
      [...runs.keys()].sort(),
      [
        externalRunKey(SESSION_FILE, "b"),
        externalRunKey(SESSION_FILE, "c"),
        externalRunKey(SESSION_FILE, "theirs"),
      ].sort(),
    );

    unpublishExternalRuns();
    assert.deepEqual([...runs.keys()], [externalRunKey(SESSION_FILE, "theirs")], "someone else's row survived");
  });

  it("answers a failing scan with an empty list and a surfaced error", () => {
    const lines: string[] = [];
    const dispose = registerJobProviders({
      snapshot: () => {
        throw new Error("state root exploded");
      },
      onError: (line) => lines.push(line),
    });
    const provider = slot<ProviderSlot<{ listActiveWork: () => unknown[] }>>(BACKGROUND_WORK_REGISTRY_KEY)
      ?.providers.get(PROVIDER_NAME);
    assert.deepEqual(provider?.listActiveWork(), []);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /background-work snapshot failed: Error: state root exploded/);
    dispose();
  });
});

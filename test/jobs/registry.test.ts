import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  BACKGROUND_WORK_PROTOCOL_VERSION,
  BACKGROUND_WORK_REGISTRY_KEY,
  EXTERNAL_RUN_REGISTRY_KEY,
  EXTERNAL_RUN_REGISTRY_VERSION,
  PROVIDER_NAME,
  registerJobProviders,
  toBackgroundWorkItems,
  toExternalRun,
  toExternalRuns,
} from "../../extensions/jobs/registry.ts";
import { JOB_SCHEMA, type JobState } from "../../extensions/jobs/store.ts";

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

interface Registry<P> {
  version: number;
  providers: Map<string, P>;
}

function slot<P>(key: string): Registry<P> | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[Symbol.for(key)] as Registry<P> | undefined;
}

function clearRegistries(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)];
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

describe("jobs → pi-subagents registries (EXT-24)", () => {
  beforeEach(clearRegistries);

  it("creates both registries at the protocol version pi-subagents expects", () => {
    const dispose = registerJobProviders({ snapshot: () => [], onError: () => {} });
    assert.equal(slot(BACKGROUND_WORK_REGISTRY_KEY)?.version, BACKGROUND_WORK_PROTOCOL_VERSION);
    assert.equal(slot(EXTERNAL_RUN_REGISTRY_KEY)?.version, EXTERNAL_RUN_REGISTRY_VERSION);
    assert.ok(slot(BACKGROUND_WORK_REGISTRY_KEY)?.providers.has(PROVIDER_NAME));
    assert.ok(slot(EXTERNAL_RUN_REGISTRY_KEY)?.providers.has(PROVIDER_NAME));
    dispose();
    assert.equal(slot(BACKGROUND_WORK_REGISTRY_KEY)?.providers.size, 0);
    assert.equal(slot(EXTERNAL_RUN_REGISTRY_KEY)?.providers.size, 0);
  });

  it("joins an existing registry rather than replacing it", () => {
    const foreign = { name: "someone-else", listActiveWork: () => [] };
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)] = {
      version: BACKGROUND_WORK_PROTOCOL_VERSION,
      providers: new Map([["someone-else", foreign]]),
    };
    const dispose = registerJobProviders({ snapshot: () => [], onError: () => {} });
    assert.equal(slot(BACKGROUND_WORK_REGISTRY_KEY)?.providers.size, 2);
    dispose();
    assert.equal(slot(BACKGROUND_WORK_REGISTRY_KEY)?.providers.get("someone-else"), foreign);
  });

  it("refuses loudly when the registry speaks a different protocol version", () => {
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)] = {
      version: 99,
      providers: new Map(),
    };
    assert.throws(
      () => registerJobProviders({ snapshot: () => [], onError: () => {} }),
      /is version 99, this build speaks version 1/,
    );
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

  it("maps every job status onto the external-run vocabulary", () => {
    const runs = toExternalRuns([
      job({ id: "a", status: "running" }),
      job({ id: "b", status: "done", exitCode: 0, finishedAt: 5 }),
      job({ id: "c", status: "failed", exitCode: 3, finishedAt: 6 }),
      job({ id: "d", status: "failed", exitCode: -1, finishedAt: 7 }),
      job({ id: "e", status: "killed", finishedAt: 8 }),
    ]);
    assert.deepEqual(
      runs.map((run) => [run.id, run.state, run.completionReason]),
      [
        ["a", "running", undefined],
        ["b", "completed", "exit"],
        ["c", "failed", "exit"],
        ["d", "failed", "crash"],
        ["e", "stopped", "user-kill"],
      ],
    );
    assert.equal(runs[0]!.source, PROVIDER_NAME);
    assert.equal(runs[0]!.cwd, "/work");
    assert.equal(runs[0]!.command, "sleep 5");
  });

  it("drops a record the protocol would reject instead of poisoning the snapshot", () => {
    assert.equal(toExternalRun(job({ parentSession: "" })), undefined);
    assert.equal(toExternalRun(job({ id: " untrimmed " })), undefined);
    assert.equal(toExternalRun(job({ id: "x".repeat(257) })), undefined);
    // Over-long free text is truncated to the protocol's limit, not dropped.
    const long = toExternalRun(job({ cmd: "y".repeat(5_000) }));
    assert.equal(long?.command?.length, 4_096);
    // A command that is only whitespace has no representation, so the field is omitted.
    assert.equal(toExternalRun(job({ cmd: "   " }))?.command, undefined);
  });

  it("answers a failing scan with an empty list and a surfaced error", () => {
    const lines: string[] = [];
    const dispose = registerJobProviders({
      snapshot: () => {
        throw new Error("state root exploded");
      },
      onError: (line) => lines.push(line),
    });
    const provider = slot<{ listActiveWork: () => unknown[] }>(BACKGROUND_WORK_REGISTRY_KEY)
      ?.providers.get(PROVIDER_NAME);
    assert.deepEqual(provider?.listActiveWork(), []);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /background-work snapshot failed: Error: state root exploded/);
    dispose();
  });
});

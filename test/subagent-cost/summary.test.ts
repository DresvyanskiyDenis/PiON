// extensions/subagent-cost/summary.ts — the arithmetic behind the statusline's `+$…` half.
// Every state the display can be in is reachable here without a live agent or a price table,
// which is the point of keeping the summariser pure.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { renderSubagentCost, summarizeSubagentCost } from "../../extensions/subagent-cost/summary.ts";

let seq = 0;

/** A `subagent`/`subagent_wait` tool result entry carrying the `details` shape the subagent package emits. */
function resultEntry(
  toolName: string,
  details: unknown,
  toolCallId = `call-${(seq += 1)}`,
): SessionEntry {
  return {
    type: "message",
    id: `entry-${(seq += 1)}`,
    parentId: null,
    timestamp: seq,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "ok" }],
      details,
      isError: false,
      timestamp: seq,
    },
  } as unknown as SessionEntry;
}

/** An assistant turn that issued tool calls. Only these carry the launch that a pending count
 *  is measured against — a run in flight has no result entry at all yet. */
function callEntry(calls: { name: string; id: string }[]): SessionEntry {
  return {
    type: "message",
    id: `entry-${(seq += 1)}`,
    parentId: null,
    timestamp: seq,
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      timestamp: seq,
    },
  } as unknown as SessionEntry;
}

function run(opts: {
  runId?: string;
  costUsd?: number;
  input?: number;
  output?: number;
  completions?: string[];
  results?: Record<string, unknown>[];
}): Record<string, unknown> {
  const details: Record<string, unknown> = { mode: "sync", results: opts.results ?? [] };
  if (opts.runId !== undefined) details.runId = opts.runId;
  if (opts.costUsd !== undefined) details.totalCost = { inputTokens: 0, outputTokens: 0, costUsd: opts.costUsd };
  if (opts.input !== undefined || opts.output !== undefined) {
    details.totalChildUsage = { input: opts.input ?? 0, output: opts.output ?? 0 };
  }
  if (opts.completions) details.completions = opts.completions.map((runId) => ({ runId }));
  return details;
}

describe("summarizeSubagentCost", () => {
  it("is empty on a session that never spawned anything", () => {
    const s = summarizeSubagentCost([]);
    assert.equal(s.countedRuns, 0);
    assert.equal(s.costUsd, 0);
    assert.equal(s.pendingRuns, 0);
    assert.equal(renderSubagentCost(s), undefined, "an empty slot is the honest display for none");
  });

  it("ignores tool results from tools that are not subagent launches", () => {
    const entries = [resultEntry("bash", run({ runId: "r1", costUsd: 9.99 }))];
    assert.equal(summarizeSubagentCost(entries).countedRuns, 0);
  });

  it("sums the cost of finished runs", () => {
    const entries = [
      resultEntry("subagent", run({ runId: "r1", costUsd: 0.018128, output: 82 })),
      resultEntry("subagent", run({ runId: "r2", costUsd: 0.01, output: 40 })),
    ];
    const s = summarizeSubagentCost(entries);
    assert.equal(s.countedRuns, 2);
    assert.equal(s.costUsd.toFixed(6), "0.028128");
    assert.equal(s.unknownRuns, 0);
    assert.equal(s.pendingRuns, 0);
  });

  it("counts a run once even when a later wait reports the same run id again", () => {
    const entries = [
      resultEntry("subagent", run({ runId: "r1", costUsd: 0.5, output: 10 })),
      resultEntry("subagent_wait", run({ costUsd: 0.5, output: 10, completions: ["r1"] })),
    ];
    const s = summarizeSubagentCost(entries);
    assert.equal(s.countedRuns, 1, "the wait is a view of a run already paid for, not a second bill");
    assert.equal(s.costUsd, 0.5);
  });

  it("lets a wait land the cost of a launch that reported none", () => {
    // The detached-async shape, measured: the launch result carries `details` with no `totalCost`
    // key at all, so its money only ever arrives through a later collection.
    const entries = [
      resultEntry("subagent", run({ runId: "r1" })),
      resultEntry("subagent_wait", run({ costUsd: 0.42, output: 30, completions: ["r1"] })),
    ];
    const s = summarizeSubagentCost(entries);
    assert.equal(s.countedRuns, 1);
    assert.equal(s.costUsd, 0.42);
    assert.equal(s.pendingRuns, 0, "the run is no longer owed once its cost lands");
  });

  it("keeps a detached run pending forever when nothing ever collects it", () => {
    const s = summarizeSubagentCost([resultEntry("subagent", run({ runId: "r1" }))]);
    assert.equal(s.countedRuns, 0);
    assert.equal(s.pendingRuns, 1);
    assert.equal(renderSubagentCost(s), "~1", "nothing landed, so no dollar figure is claimed");
  });

  it("counts an in-flight launch as pending from its tool call alone", () => {
    const entries = [callEntry([{ name: "subagent", id: "c1" }])];
    assert.equal(summarizeSubagentCost(entries).pendingRuns, 1);
  });

  it("stops counting an in-flight launch once its result arrives", () => {
    const entries = [
      callEntry([{ name: "subagent", id: "c1" }]),
      resultEntry("subagent", run({ runId: "r1", costUsd: 0.2, output: 5 }), "c1"),
    ];
    const s = summarizeSubagentCost(entries);
    assert.equal(s.pendingRuns, 0);
    assert.equal(s.countedRuns, 1);
  });

  it("does not treat an in-flight wait as a launched run", () => {
    // A `subagent_wait` in flight is a view of runs that are already counted or already pending.
    const entries = [callEntry([{ name: "subagent_wait", id: "c1" }])];
    assert.equal(summarizeSubagentCost(entries).pendingRuns, 0);
  });

  it("reads a zero cost against non-zero tokens as unknown, not as free", () => {
    const s = summarizeSubagentCost([
      resultEntry("subagent", run({ runId: "r1", costUsd: 0, input: 8572, output: 82 })),
    ]);
    assert.equal(s.unknownRuns, 1);
    assert.equal(s.countedRuns, 1);
    assert.equal(renderSubagentCost(s), "+$?");
  });

  it("reads a zero cost against zero tokens as a genuine zero", () => {
    const s = summarizeSubagentCost([
      resultEntry("subagent", run({ runId: "r1", costUsd: 0, input: 0, output: 0 })),
    ]);
    assert.equal(s.unknownRuns, 0);
    assert.equal(renderSubagentCost(s), "+$0.000");
  });

  it("counts a dead child's cost and marks it", () => {
    const s = summarizeSubagentCost([
      resultEntry(
        "subagent",
        run({
          runId: "r1",
          costUsd: 1.5,
          output: 10,
          results: [{ exitCode: 1, error: "child crashed" }, { exitCode: 0 }],
        }),
      ),
    ]);
    assert.equal(s.costUsd, 1.5, "a run that failed still spent the money it spent");
    assert.equal(s.deadChildren, 1);
    assert.equal(renderSubagentCost(s), "+$1.50 ✗1");
  });

  it("treats a timeout, a stop and an interrupt as dead the same way a bad exit code is", () => {
    const s = summarizeSubagentCost([
      resultEntry(
        "subagent",
        run({
          runId: "r1",
          costUsd: 0.1,
          output: 10,
          results: [{ exitCode: 0, timedOut: true }, { exitCode: 0, stopped: true }, { exitCode: 0, interrupted: true }],
        }),
      ),
    ]);
    assert.equal(s.deadChildren, 3);
  });

  it("marks children on a subscription-backed provider", () => {
    const s = summarizeSubagentCost(
      [
        resultEntry(
          "subagent",
          run({
            runId: "r1",
            costUsd: 2.5,
            output: 10,
            results: [{ exitCode: 0, model: "github-copilot/gpt-5.6" }, { exitCode: 0, model: "litellm/x" }],
          }),
        ),
      ],
      (ref) => ref.startsWith("github-copilot/"),
    );
    assert.equal(s.subscriptionChildren, 1);
    assert.equal(renderSubagentCost(s), "+$2.50 (sub 1)");
  });

  it("survives details of an unexpected shape by owing the run rather than crashing", () => {
    const entries = [resultEntry("subagent", { mode: "sync" }), resultEntry("subagent", null)];
    const s = summarizeSubagentCost(entries);
    assert.equal(s.countedRuns, 0);
    assert.equal(s.costUsd, 0);
  });
});

describe("renderSubagentCost", () => {
  const base = {
    costUsd: 0,
    countedRuns: 0,
    unknownRuns: 0,
    pendingRuns: 0,
    deadChildren: 0,
    subscriptionChildren: 0,
  };

  it("mirrors the package's precision rule so the pair lines up", () => {
    assert.equal(renderSubagentCost({ ...base, costUsd: 0.267, countedRuns: 1 }), "+$0.267");
    assert.equal(renderSubagentCost({ ...base, costUsd: 1.94, countedRuns: 1 }), "+$1.94");
  });

  it("shows a partial total's unknown runs as a suffix rather than swallowing the figure", () => {
    assert.equal(
      renderSubagentCost({ ...base, costUsd: 1.94, countedRuns: 3, unknownRuns: 2 }),
      "+$1.94 ?2",
    );
  });

  it("orders the marks so the money reads first", () => {
    assert.equal(
      renderSubagentCost({
        ...base,
        costUsd: 1.94,
        countedRuns: 4,
        unknownRuns: 1,
        pendingRuns: 2,
        deadChildren: 1,
        subscriptionChildren: 3,
      }),
      "+$1.94 ?1 ~2 ✗1 (sub 3)",
    );
  });

  it("never renders an unknown total as a reassuring zero", () => {
    assert.notEqual(renderSubagentCost({ ...base, countedRuns: 1, unknownRuns: 1 }), "+$0.000");
  });
});

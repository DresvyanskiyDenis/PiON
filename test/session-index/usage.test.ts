import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  accumulateSessionStats,
  isUnpricedProvider,
  UNPRICED_PROVIDERS,
} from "../../extensions/session-index/usage.ts";

let seq = 0;
function userEntry(text: string, timestamp: string): SessionEntry {
  seq += 1;
  return {
    type: "message",
    id: `u${seq}`,
    parentId: null,
    timestamp,
    message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
  } as SessionEntry;
}

function assistantEntry(
  timestamp: string,
  opts: {
    provider?: string;
    model?: string;
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    costTotal?: number;
    noUsage?: boolean;
  } = {},
): SessionEntry {
  seq += 1;
  const usage = opts.noUsage
    ? undefined
    : {
        input: opts.input ?? 0,
        output: opts.output ?? 0,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        reasoning: opts.reasoning,
        totalTokens: (opts.input ?? 0) + (opts.output ?? 0),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: opts.costTotal ?? 0,
        },
      };
  return {
    type: "message",
    id: `a${seq}`,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: opts.provider ?? "anthropic",
      model: opts.model ?? "claude-x",
      usage,
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
    },
  } as SessionEntry;
}

describe("accumulateSessionStats", () => {
  it("returns the zero value for an empty session", () => {
    const stats = accumulateSessionStats([]);
    assert.equal(stats.turns, 0);
    assert.equal(stats.provider, null);
    assert.equal(stats.startedAt, null);
    assert.equal(stats.endedAt, null);
  });

  it("sums token families and cost across assistant turns only", () => {
    const entries = [
      userEntry("hi", "2026-08-01T10:00:00.000Z"),
      assistantEntry("2026-08-01T10:00:01.000Z", {
        input: 100,
        output: 20,
        reasoning: 5,
        cacheRead: 10,
        cacheWrite: 3,
        costTotal: 0.01,
      }),
      userEntry("again", "2026-08-01T10:01:00.000Z"),
      assistantEntry("2026-08-01T10:01:02.000Z", {
        input: 50,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0,
        costTotal: 0.02,
      }),
    ];
    const stats = accumulateSessionStats(entries);
    assert.equal(stats.turns, 2, "only assistant messages count as turns, not user messages");
    assert.equal(stats.tokensInput, 150);
    assert.equal(stats.tokensOutput, 50);
    assert.equal(stats.tokensReasoning, 5);
    assert.equal(stats.tokensCacheRead, 10);
    assert.equal(stats.tokensCacheWrite, 3);
    assert.ok(Math.abs(stats.costUsd - 0.03) < 1e-9);
    assert.equal(stats.provider, "anthropic");
    assert.equal(stats.model, "claude-x");
  });

  it("tracks the min/max entry timestamp regardless of array order", () => {
    const entries = [
      assistantEntry("2026-08-01T10:05:00.000Z"),
      userEntry("hi", "2026-08-01T10:00:00.000Z"),
      assistantEntry("2026-08-01T10:02:00.000Z"),
    ];
    const stats = accumulateSessionStats(entries);
    assert.equal(stats.startedAt, Date.parse("2026-08-01T10:00:00.000Z"));
    assert.equal(stats.endedAt, Date.parse("2026-08-01T10:05:00.000Z"));
  });

  it("model_change entries update provider/model even with no following assistant turn", () => {
    const entries: SessionEntry[] = [
      userEntry("hi", "2026-08-01T10:00:00.000Z"),
      {
        type: "model_change",
        id: "mc1",
        parentId: null,
        timestamp: "2026-08-01T10:00:30.000Z",
        provider: "github-copilot",
        modelId: "gpt-x",
      } as SessionEntry,
    ];
    const stats = accumulateSessionStats(entries);
    assert.equal(stats.provider, "github-copilot");
    assert.equal(stats.model, "gpt-x");
    assert.equal(stats.turns, 0);
  });

  it("a later assistant turn's provider/model wins over an earlier model_change", () => {
    const entries: SessionEntry[] = [
      {
        type: "model_change",
        id: "mc1",
        parentId: null,
        timestamp: "2026-08-01T10:00:00.000Z",
        provider: "openai",
        modelId: "gpt-old",
      } as SessionEntry,
      assistantEntry("2026-08-01T10:01:00.000Z", { provider: "anthropic", model: "claude-new" }),
    ];
    const stats = accumulateSessionStats(entries);
    assert.equal(stats.provider, "anthropic");
    assert.equal(stats.model, "claude-new");
  });

  it("an assistant message with no usage field contributes zero tokens without throwing", () => {
    const entries = [assistantEntry("2026-08-01T10:00:00.000Z", { noUsage: true })];
    const stats = accumulateSessionStats(entries);
    assert.equal(stats.turns, 1);
    assert.equal(stats.tokensInput, 0);
    assert.equal(stats.costUsd, 0);
  });
});

describe("isUnpricedProvider (REQ-PRV-74)", () => {
  it("flags Copilot and local as unpriced, by name", () => {
    assert.equal(isUnpricedProvider("github-copilot"), true);
    assert.equal(isUnpricedProvider("local"), true);
    assert.deepEqual([...UNPRICED_PROVIDERS].sort(), ["github-copilot", "local"]);
  });

  it("treats a known provider as priced", () => {
    assert.equal(isUnpricedProvider("anthropic"), false);
    assert.equal(isUnpricedProvider("openai"), false);
  });

  it("treats an unknown (null) provider as unpriced — never claim a price for nothing", () => {
    assert.equal(isUnpricedProvider(null), true);
  });
});

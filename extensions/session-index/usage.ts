/**
 * Pure aggregation over a session's entries. No I/O, so it is the same code path for the live
 * `session_start`/`session_shutdown` hook (`ctx.sessionManager.getEntries()`) and for offline
 * `backfill.ts` (entries parsed from a JSONL file) — one accumulator, not two.
 *
 * Deviation from an earlier draft's sample: it reads `ctx.getContextUsage()` for
 * tokens/cost and `ctx.modelRegistry.getAvailable().find(...).pricing` for pricing. Neither
 * matches the actual `@earendil-works/pi-coding-agent` 0.84.0 types:
 *   - `ContextUsage` is `{ tokens: number | null; contextWindow: number; percent: number | null }`
 *     — a context-window estimate, not a token/cost breakdown.
 *   - `Model.pricing` does not exist; the field is `Model.cost: ModelCost`, and it is not
 *     optional, so the spec's `price != null` guard can't distinguish "unpriced" from "priced".
 * The token/cost breakdown that actually exists is per assistant turn, on
 * `AssistantMessage.usage: Usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning?`,
 * `cost.total`) inside each session entry — so this module sums that directly instead.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SessionStats {
  readonly provider: string | null;
  readonly model: string | null;
  /** Earliest entry timestamp (ms), or null when the session has no entries yet. */
  readonly startedAt: number | null;
  /** Latest entry timestamp (ms), or null when the session has no entries yet. */
  readonly endedAt: number | null;
  readonly turns: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensReasoning: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
  /** Sum of `usage.cost.total` across assistant turns. Meaningless when the provider is unpriced
   * — callers check `isUnpricedProvider(provider)` before trusting this as a display value. */
  readonly costUsd: number;
}

const EMPTY_STATS: SessionStats = {
  provider: null,
  model: null,
  startedAt: null,
  endedAt: null,
  turns: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costUsd: 0,
};

/** REQ-PRV-74: providers that report no price. Not derived from `Model.cost` because that
 * requires a live `ctx.modelRegistry` lookup and is unavailable during offline backfill; a
 * provider-id denylist works identically for both call sites.
 *
 * The requirement's wording is "Copilot, local", but `local` was dropped here on 2026-08-15:
 * owner decision, the provider set is exactly `github-copilot`, an OpenAI-compatible gateway and
 * `databricks`, so a `local` member could only ever match a provider id that no longer resolves.
 * A gateway with no `cost` block is a different case and is deliberately not added here — it
 * reports a real, configured price of zero, and inventing an "unpriced" label for it would hide
 * that its operator set no price rather than that no price exists. */
export const UNPRICED_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot"]);

export function isUnpricedProvider(provider: string | null): boolean {
  return provider === null || UNPRICED_PROVIDERS.has(provider);
}

export function accumulateSessionStats(entries: readonly SessionEntry[]): SessionStats {
  if (entries.length === 0) return EMPTY_STATS;

  let provider: string | null = null;
  let model: string | null = null;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let turns = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensReasoning = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let costUsd = 0;

  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp);
    if (Number.isFinite(ts)) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }

    if (entry.type === "model_change") {
      provider = entry.provider;
      model = entry.modelId;
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role !== "assistant") continue;

    turns += 1;
    provider = message.provider ?? provider;
    model = message.model ?? model;

    const usage = message.usage;
    if (!usage) continue;
    tokensInput += usage.input ?? 0;
    tokensOutput += usage.output ?? 0;
    tokensReasoning += usage.reasoning ?? 0;
    tokensCacheRead += usage.cacheRead ?? 0;
    tokensCacheWrite += usage.cacheWrite ?? 0;
    costUsd += usage.cost?.total ?? 0;
  }

  return {
    provider,
    model,
    startedAt,
    endedAt,
    turns,
    tokensInput,
    tokensOutput,
    tokensReasoning,
    tokensCacheRead,
    tokensCacheWrite,
    costUsd,
  };
}

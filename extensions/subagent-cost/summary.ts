/**
 * The arithmetic behind the subagent half of the statusline's money pair. Pure on purpose: it
 * takes session entries and a predicate and returns numbers, so every state below is reachable
 * from a test without a live agent, a live provider or a price table.
 *
 * WHY THIS EXISTS. `@narumitw/pi-statusline`'s `cost` segment sums
 * `summarizeFooterUsage(ctx.sessionManager.getEntries())`, which reads `usage` off assistant,
 * toolResult, compaction and branch_summary entries. A subagent's spend is in none of those: a
 * `subagent` tool result carries no `message.usage` at all — measured across 1263 of them, the
 * field was populated on exactly zero. The child's money lives one level down, in the tool
 * result's `details` (`totalCost` / `totalChildUsage`), which the statusline package neither
 * knows about nor should. So on a fan-out session the footer figure is short by most of the
 * bill — and short, not over, which is the direction nobody double-checks.
 *
 * WHY A PAIR AND NOT ONE TOTAL: the `cost` segment is a number people have been reading for a
 * long time. Folding children into it would silently redefine it. A separate figure beside it
 * adds information without rewriting the meaning of what was already there.
 *
 * WHY THIS READS `getEntries()` AND NOT AN IN-PROCESS COUNTER: it is the same call, over the same
 * set, the package uses for the parent number — so the two halves of the pair cannot drift, and
 * both survive a resume or a fork, where a counter accumulated since `register()` would start
 * again at zero beside a parent total that did not.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { GLYPH } from "../lib/glyphs.ts";

/** The two subagent tools whose results can carry run cost. */
const COST_BEARING_TOOLS = new Set(["subagent", "subagent_wait"]);
/** Only a launch is a run. A pending `subagent_wait` is a *view* of runs already counted below. */
const LAUNCH_TOOL = "subagent";

/** The subagent package's result details, read structurally rather than imported. See `readDetails`. */
interface RunDetails {
  runId?: string;
  totalCost?: { costUsd?: number };
  totalChildUsage?: { input?: number; output?: number };
  completions?: { runId?: string }[];
  results?: {
    model?: string;
    error?: string;
    timedOut?: boolean;
    stopped?: boolean;
    interrupted?: boolean;
    exitCode?: number;
  }[];
}

export interface SubagentCostSummary {
  /** Dollars reported by runs whose cost has landed. */
  costUsd: number;
  /** Runs whose cost figure we took. `0` here means there is nothing to show at all. */
  countedRuns: number;
  /**
   * Runs that reported tokens and a cost of exactly zero. That is not "free" — it is the
   * signature of a missing or expired price table. A model with no declared rates, or a gateway
   * that starts metering after its rates were recorded, prices every call at exactly $0.00 and
   * keeps doing so silently. Kept as its own state even when today's rates are known good: it is
   * what keeps the display honest the *next* time they expire.
   */
  unknownRuns: number;
  /**
   * Launched runs whose cost has not landed: still executing, or detached. Detached is not a
   * transient — a `subagent` call that returns after launching a background run reports details
   * with no `totalCost` key at all, and unless a later `subagent_wait` collects it, that run's
   * money never reaches this session file. Those stay pending forever, correctly.
   */
  pendingRuns: number;
  /** Counted children that failed, timed out, were stopped or were interrupted. They still cost. */
  deadChildren: number;
  /** Counted children on an OAuth/subscription-backed provider: those dollars are an as-if
   *  estimate against a seat, not an invoice line. Mirrors the package's own `(sub)` marker. */
  subscriptionChildren: number;
}

const EMPTY: SubagentCostSummary = {
  costUsd: 0,
  countedRuns: 0,
  unknownRuns: 0,
  pendingRuns: 0,
  deadChildren: 0,
  subscriptionChildren: 0,
};

/**
 * `details` is typed `unknown` on the tool result event and on the session entry alike, and the
 * subagent package is a runtime dependency of this harness rather than a type dependency of this
 * module. Reading it structurally keeps a shape change in that package a degraded number here
 * (fields missing → the run reads as pending) instead of a compile error or a crash in a footer.
 */
function readDetails(value: unknown): RunDetails | undefined {
  return value && typeof value === "object" ? (value as RunDetails) : undefined;
}

/** Every run identity a result speaks for: its own, plus each terminal completion it observed. */
function runIdsOf(details: RunDetails): string[] {
  const ids = [details.runId, ...(details.completions ?? []).map((c) => c.runId)];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Sums subagent spend over a session's entries.
 *
 * `isSubscriptionModel` is injected rather than read from a registry so this stays pure; the
 * extension backs it with `ctx.modelRegistry`, tests with a literal.
 */
export function summarizeSubagentCost(
  entries: readonly SessionEntry[],
  isSubscriptionModel: (modelRef: string) => boolean = () => false,
): SubagentCostSummary {
  const totals: SubagentCostSummary = { ...EMPTY };
  /** Run ids whose money is already in `totals.costUsd`. Guards against a `subagent_wait`
   *  re-reporting a run its own launch already accounted for. */
  const counted = new Set<string>();
  /** Every run id seen anywhere. `launched \ counted` is what is still owed. */
  const launched = new Set<string>();
  /** Tool call ids of launches, and of the results that answered them. */
  const launchCalls = new Set<string>();
  const answeredCalls = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall" && part.name === LAUNCH_TOOL) launchCalls.add(part.id);
      }
      continue;
    }
    if (message.role !== "toolResult" || !COST_BEARING_TOOLS.has(message.toolName)) continue;
    if (message.toolName === LAUNCH_TOOL) answeredCalls.add(message.toolCallId);

    const details = readDetails(message.details);
    if (!details) continue;
    const ids = runIdsOf(details);
    for (const id of ids) launched.add(id);

    const cost = details.totalCost?.costUsd;
    // No `totalCost` key at all: nothing landed. The run stays owed via `launched`.
    if (typeof cost !== "number") continue;
    // Every run this result speaks for is already paid for. Seeing it again is a view, not a bill.
    if (ids.length > 0 && ids.every((id) => counted.has(id))) continue;

    totals.costUsd += cost;
    totals.countedRuns += 1;
    for (const id of ids) counted.add(id);

    const usage = details.totalChildUsage;
    const tokens = (usage?.input ?? 0) + (usage?.output ?? 0);
    if (cost === 0 && tokens > 0) totals.unknownRuns += 1;

    for (const child of details.results ?? []) {
      if (
        child.error !== undefined ||
        child.timedOut === true ||
        child.stopped === true ||
        child.interrupted === true ||
        (typeof child.exitCode === "number" && child.exitCode !== 0)
      ) {
        totals.deadChildren += 1;
      }
      if (child.model !== undefined && isSubscriptionModel(child.model)) {
        totals.subscriptionChildren += 1;
      }
    }
  }

  for (const id of launched) if (!counted.has(id)) totals.pendingRuns += 1;
  for (const id of launchCalls) if (!answeredCalls.has(id)) totals.pendingRuns += 1;
  return totals;
}

/**
 * Dollars at the package's own precision, so every figure this tree prints lines up with the one
 * the footer prints beside it: two decimals from $1, three below.
 */
export function formatUsd(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 3)}`;
}

/**
 * Renders the summary, or `undefined` when this session has spawned nothing — an empty statusline
 * slot is the honest display for "no children", and it keeps the segment out of the package's
 * five-status cap on sessions that never fan out.
 *
 * The dollar figure mirrors the package's own precision rule so the two halves of the pair line
 * up: two decimals from $1, three below it. Suffixes appear only when they are non-zero, because
 * a wrong number here is worse than an absent one and a noisy one is worse than a quiet one.
 */
export function renderSubagentCost(summary: SubagentCostSummary): string | undefined {
  const { costUsd, countedRuns, unknownRuns, pendingRuns, deadChildren, subscriptionChildren } =
    summary;
  if (countedRuns === 0 && pendingRuns === 0) return undefined;

  const marks: string[] = [];
  if (pendingRuns > 0) marks.push(`~${pendingRuns}`);
  if (deadChildren > 0) marks.push(`${GLYPH.failed}${deadChildren}`);
  if (subscriptionChildren > 0) marks.push(`(sub ${subscriptionChildren})`);

  // Nothing has landed yet: say so, rather than showing a $0.00 that reads as "cheap".
  if (countedRuns === 0) return marks.join(" ");

  // `$?` is the whole-total form of the unknown state; `?N` is its partial form. A total that is
  // both zero and unknown must never render as `+$0.00`.
  let money: string;
  if (costUsd === 0 && unknownRuns > 0) {
    money = "+$?";
  } else {
    money = `+${formatUsd(costUsd)}`;
    if (unknownRuns > 0) marks.unshift(`?${unknownRuns}`);
  }
  return [money, ...marks].join(" ");
}

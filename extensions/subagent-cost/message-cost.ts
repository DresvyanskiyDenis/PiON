/**
 * The per-message half of the cost picture: the price next to the message that spent it.
 *
 * `index.ts`/`summary.ts` answer "what has this session cost so far" — a running total in the
 * footer. That total cannot answer the question that actually comes up mid-session: *which*
 * message cost that. A 400-line file read back into context, a large search result, one long
 * reasoning turn — all of it lands in a figure that only moves upward, and by the time the number
 * looks wrong the turn that moved it has scrolled off screen.
 *
 * So: when a single assistant message is billed for more than `TOKEN_THRESHOLD` tokens at full
 * rate, one card goes in right after it with what that message cost, the model that charged it,
 * and the same `(sub)` marker the footer already uses for spend billed against a seat rather than
 * a card. Below the threshold nothing is emitted — a price tag on every reply is noise, and noise
 * is how a number stops being read.
 *
 * WHAT COUNTS AS BILLED. `cacheRead` is excluded from the threshold on purpose. It is the largest
 * number on almost every message and by far the cheapest — on a long session it can be most of
 * the context on every turn — and counting it would put a card on nearly every reply once a
 * session has run for a while, which would defeat the point: "this message was expensive" would
 * stop being what the card means. `input + cacheWrite + output` is what was paid at full rate, and
 * is what the threshold is measured against. The expanded card still shows the cached read, so the
 * obvious follow-up question ("billed 24k, but the model just read 200k tokens of context?") has
 * an answer on screen instead of being left to guesswork.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent, Theme } from "@earendil-works/pi-coding-agent";
import { formatUsd } from "./summary.ts";
import { describeError } from "../lib/once.ts";

/** Custom entry type, namespaced by module id — matches the convention `guard.ts` uses for its own entries. */
export const MESSAGE_COST_ENTRY = "subagent-cost.message";

/**
 * Tokens billed at full rate above which a message earns a card of its own. Roughly the point
 * where a message costs an order of magnitude more than the ones around it rather than a little —
 * an ordinary reply on this stack bills a few hundred to a few thousand tokens.
 */
export const TOKEN_THRESHOLD = 20_000;

export interface MessageCostEntry {
  /** Tokens billed at full rate: what actually crossed the threshold. */
  readonly billed: number;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly costUsd: number;
  /** `provider/model`, the same shape the footer pair uses for a child's model reference. */
  readonly modelRef: string;
  /** Spend against a seat rather than a metered card — mirrors the footer's own `(sub)` marker. */
  readonly subscription: boolean;
}

/** `24.1k`, `1.2M`, `840` — the count matters to two significant digits, never down to the token. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * The card, as one already-themed string.
 *
 * Collapsed: what the message cost and what it was billed for. Expanded: the four token classes,
 * including the cached read that was deliberately left out of the threshold and the total — so
 * the question a reader would otherwise have to ask ("billed 24k, but the context is 200k?") is
 * already answered on screen.
 */
export function formatMessageCost(data: MessageCostEntry, theme: Theme, expanded: boolean): string {
  const money = data.subscription ? `${formatUsd(data.costUsd)} (sub)` : formatUsd(data.costUsd);
  const head =
    theme.fg("accent", theme.bold(`\u{1F4B8} ${money}`)) +
    theme.fg("muted", ` · ${formatTokens(data.billed)} billed · `) +
    theme.fg("dim", data.modelRef);
  if (!expanded) return head;

  const rows = [
    `in ${formatTokens(data.input)}`,
    `out ${formatTokens(data.output)}`,
    `cache write ${formatTokens(data.cacheWrite)}`,
    `cache read ${formatTokens(data.cacheRead)} (not billed at full rate)`,
  ];
  return [head, theme.fg("muted", `  ${rows.join(" · ")}`)].join("\n");
}

/**
 * Registers the entry renderer and the `message_end` handler that feeds it.
 *
 * `isSubscriptionModel` is passed in rather than imported so this module does not import back
 * from `index.ts`, which is the one that composes the two together.
 */
export function registerMessageCost(
  pi: ExtensionAPI,
  isSubscriptionModel: (ctx: ExtensionContext, modelRef: string) => boolean,
): void {
  pi.registerEntryRenderer<MessageCostEntry>(MESSAGE_COST_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data;
    // Malformed or foreign data on this custom type: say nothing rather than render garbage. The
    // host already catches a renderer that throws, so this is a data check, not exception safety.
    if (!data || typeof data.costUsd !== "number") return undefined;
    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(formatMessageCost(data, theme, expanded), 0, 0));
    return box;
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    try {
      const entry = costEntry(event, (ref) => isSubscriptionModel(ctx, ref));
      if (entry) pi.appendEntry(MESSAGE_COST_ENTRY, entry);
    } catch (err) {
      // Same posture as the footer half: a display bug must not cost a turn.
      process.stderr.write(`[pi-config] subagent-cost: message cost card failed: ${describeError(err)}\n`);
    }
    return undefined;
  });
}

/**
 * The entry a message earns, or `undefined` when it earns none. Exported for tests: this is the
 * threshold decision, and it is the half that decides whether anything is shown at all.
 */
export function costEntry(
  event: MessageEndEvent,
  isSubscriptionModel: (modelRef: string) => boolean,
): MessageCostEntry | undefined {
  const message = event.message;
  if (message.role !== "assistant") return undefined;
  const usage = message.usage;
  // A message that failed before the provider answered can carry no usage at all.
  if (!usage) return undefined;

  const billed = (usage.input ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
  if (billed < TOKEN_THRESHOLD) return undefined;

  const modelRef = `${message.provider}/${message.model}`;
  return {
    billed,
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    costUsd: usage.cost?.total ?? 0,
    modelRef,
    subscription: isSubscriptionModel(modelRef),
  };
}

// extensions/subagent-cost/message-cost.ts — the threshold decision (what earns a card, and what
// counts as billed), and that the renderer registers and paints rather than throws.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, MessageEndEvent, Theme } from "@earendil-works/pi-coding-agent";

import {
  MESSAGE_COST_ENTRY,
  TOKEN_THRESHOLD,
  costEntry,
  formatMessageCost,
  formatTokens,
  registerMessageCost,
  type MessageCostEntry,
} from "../../extensions/subagent-cost/message-cost.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

interface FakeUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total: number };
}

function assistant(usage: FakeUsage): MessageEndEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "github-copilot",
      model: "gpt-5.6",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 }, ...usage },
    },
  } as unknown as MessageEndEvent;
}

const entry: MessageCostEntry = {
  billed: 24_100,
  input: 20_000,
  output: 3_100,
  cacheWrite: 1_000,
  cacheRead: 190_000,
  costUsd: 0.421,
  modelRef: "github-copilot/gpt-5.6",
  subscription: false,
};

describe("per-message cost card", () => {
  it("says nothing about a message that was not expensive", () => {
    assert.equal(costEntry(assistant({ input: 500, output: 900 }), () => false), undefined);
  });

  it("earns a card once full-rate tokens cross the threshold", () => {
    const e = costEntry(assistant({ input: TOKEN_THRESHOLD, output: 12, cost: { total: 0.42 } }), () => false);
    assert.ok(e);
    assert.equal(e.billed, TOKEN_THRESHOLD + 12);
    assert.equal(e.costUsd, 0.42);
    assert.equal(e.modelRef, "github-copilot/gpt-5.6");
  });

  it("does not count the cached read towards the threshold", () => {
    // The largest number on almost every message, and the cheapest. Counting it would put a
    // card on every reply late in a session.
    assert.equal(costEntry(assistant({ cacheRead: 500_000, input: 400, output: 100 }), () => false), undefined);
  });

  it("carries the cached read anyway, so the expanded card can answer for it", () => {
    const e = costEntry(assistant({ cacheRead: 500_000, input: 30_000, cost: { total: 1.5 } }), () => false);
    assert.equal(e?.cacheRead, 500_000);
  });

  it("marks spend that bills against a seat", () => {
    const e = costEntry(assistant({ input: 30_000 }), (ref) => ref === "github-copilot/gpt-5.6");
    assert.equal(e?.subscription, true);
    assert.match(formatMessageCost({ ...entry, subscription: true }, theme, false), /\(sub\)/);
  });

  it("ignores a message that is not the assistant's, and one with no usage at all", () => {
    const user = { type: "message_end", message: { role: "user", content: [] } } as unknown as MessageEndEvent;
    assert.equal(costEntry(user, () => false), undefined);
    const failed = { type: "message_end", message: { role: "assistant", content: [] } } as unknown as MessageEndEvent;
    assert.equal(costEntry(failed, () => false), undefined);
  });

  it("leads with the money and the billed count, at the footer's own precision", () => {
    const head = formatMessageCost(entry, theme, false).split("\n")[0]!;
    assert.match(head, /\$0\.421/);
    assert.match(head, /24\.1k billed/);
    assert.match(head, /github-copilot\/gpt-5\.6/);
  });

  it("collapsed, spends one row; expanded, breaks the tokens out including the cached read", () => {
    assert.equal(formatMessageCost(entry, theme, false).split("\n").length, 1);
    const out = formatMessageCost(entry, theme, true);
    assert.match(out, /in 20\.0k/);
    assert.match(out, /out 3\.1k/);
    assert.match(out, /cache write 1\.0k/);
    assert.match(out, /cache read 190\.0k/);
  });

  it("formats token counts to two digits, never to the token", () => {
    assert.equal(formatTokens(840), "840");
    assert.equal(formatTokens(24_100), "24.1k");
    assert.equal(formatTokens(1_200_000), "1.2M");
  });

  it("registers a renderer and a message_end handler that appends only above the threshold", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
    const entries: Array<[string, unknown]> = [];
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
      on(event: string, handler: (e: unknown, c: unknown) => unknown) {
        if (event === "message_end") handlers.push(handler);
      },
      appendEntry(customType: string, data: unknown) {
        entries.push([customType, data]);
      },
    } as unknown as ExtensionAPI;

    registerMessageCost(pi, () => false);
    assert.equal(handlers.length, 1);

    handlers[0]!(assistant({ input: 100, output: 10 }), {});
    assert.deepEqual(entries, []);
    handlers[0]!(assistant({ input: 30_000, cost: { total: 0.9 } }), {});
    assert.equal(entries.length, 1);
    assert.equal(entries[0]![0], MESSAGE_COST_ENTRY);

    const component = renderers.get(MESSAGE_COST_ENTRY)!({ data: entry }, { expanded: false }, theme) as
      | { render(width: number): string[] }
      | undefined;
    assert.ok(component, "renderer returned nothing for a well-formed entry");
    assert.match(component.render(120).join("\n"), /\$0\.421/);
  });

  it("renders nothing, rather than throwing, for an entry that is not a cost card", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
      on: () => {},
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    registerMessageCost(pi, () => false);
    assert.equal(renderers.get(MESSAGE_COST_ENTRY)!({ data: { billed: 1 } }, { expanded: false }, theme), undefined);
  });
});

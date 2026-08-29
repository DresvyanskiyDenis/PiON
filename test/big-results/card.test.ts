// extensions/big-results/card.ts — what the externalisation card says, and that registering it
// and rendering it produces a component rather than an exception. The formatter is pure, so most
// assertions are on the exact string it returns; the renderer half is exercised through a fake
// `pi` that only implements `registerEntryRenderer`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import {
  CARD_ENTRY,
  PREVIEW_LINES,
  formatExternalisedCard,
  registerCardRenderer,
  type ExternalisedCard,
} from "../../extensions/big-results/card.ts";

/** A theme that tags instead of colouring, so a test can see which slot a fragment landed in. */
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

const card: ExternalisedCard = {
  handle: "a1b2c3d4e5f6",
  toolName: "bash",
  path: "/scratch/results/a1b2c3d4e5f6.txt",
  lines: 14203,
  totalBytes: 1_234_567,
  preview: ["first line", "second line", "third line"],
};

describe("big-results card", () => {
  it("names the tool, the size, the line count and the handle on the header row", () => {
    const head = formatExternalisedCard(card, theme, false).split("\n")[0]!;
    assert.match(head, /externalised/);
    assert.match(head, /bash/);
    assert.match(head, /14203 lines/);
    assert.match(head, /1\.2MB/);
    assert.match(head, /handle "a1b2c3d4e5f6"/);
  });

  it("shows exactly the preview lines it was given, in order", () => {
    const lines = formatExternalisedCard(card, theme, false).split("\n");
    assert.equal(lines.length, 1 + PREVIEW_LINES + 1); // header, preview, expand hint
    assert.match(lines[1]!, /first line/);
    assert.match(lines[2]!, /second line/);
    assert.match(lines[3]!, /third line/);
  });

  it("collapsed, offers the expand hint and does not spend a row on the path", () => {
    const out = formatExternalisedCard(card, theme, false);
    assert.match(out, /expand/);
    assert.ok(!out.includes(card.path), "the path belongs to the expanded view");
    assert.ok(!out.includes("expand_result("), "the read-back call belongs to the expanded view");
  });

  it("expanded, gives the full path and the call that reads the rest back", () => {
    const out = formatExternalisedCard(card, theme, true);
    assert.match(out, /full output: \/scratch\/results\/a1b2c3d4e5f6\.txt/);
    assert.match(out, /expand_result\(handle="a1b2c3d4e5f6"/);
  });

  it("neutralises control characters in preview text rather than printing them", () => {
    const hostile = { ...card, preview: ["\x1b[31mred\x1b[0m\x07"] };
    const out = formatExternalisedCard(hostile, theme, false);
    assert.ok(!out.includes("\x1b"), "an escape sequence reached the terminal");
    assert.ok(!out.includes("\x07"), "a bell reached the terminal");
    assert.match(out, /red/);
  });

  it("truncates a preview line that would not fit on a row", () => {
    const out = formatExternalisedCard({ ...card, preview: ["x".repeat(400)] }, theme, false);
    const previewRow = out.split("\n")[1]!;
    assert.ok(previewRow.includes("…"), "no ellipsis on an over-long row");
    assert.ok(previewRow.length < 200, `preview row was ${previewRow.length} chars`);
  });

  it("registers a renderer for its entry type that renders the handle", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
    } as unknown as ExtensionAPI;

    registerCardRenderer(pi);
    const renderer = renderers.get(CARD_ENTRY);
    assert.ok(renderer, `no renderer registered for ${CARD_ENTRY}`);

    const component = renderer({ data: card }, { expanded: false }, theme) as
      | { render(width: number): string[] }
      | undefined;
    assert.ok(component, "renderer returned nothing for a well-formed entry");
    assert.match(component.render(120).join("\n"), /a1b2c3d4e5f6/);
  });

  it("renders nothing, rather than throwing, for an entry with no data", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
    } as unknown as ExtensionAPI;

    registerCardRenderer(pi);
    assert.equal(renderers.get(CARD_ENTRY)!({ data: undefined }, { expanded: false }, theme), undefined);
  });
});

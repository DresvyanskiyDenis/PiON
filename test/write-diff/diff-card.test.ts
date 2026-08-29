// extensions/write-diff/ — what an overwrite card says, when one is earned at all, and that the
// handlers take the pre-image before the write rather than after it. The last of those is the
// only thing here that can fail silently in production: a pre-image read one moment too late
// produces an empty diff that claims nothing changed, which is worse than no card.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import {
  COLLAPSED_DIFF_LINES,
  DIFF_ENTRY,
  MAX_DIFF_LINES,
  buildWriteDiff,
  formatWriteDiff,
  registerWriteDiffRenderer,
} from "../../extensions/write-diff/diff-card.ts";
import { register } from "../../extensions/write-diff/index.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; entries: Array<[string, unknown]> } {
  const handlers = new Map<string, Handler[]>();
  const entries: Array<[string, unknown]> = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerEntryRenderer: () => {},
    appendEntry(customType: string, data: unknown) {
      entries.push([customType, data]);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, entries };
}

describe("write-diff card", () => {
  it("counts what the overwrite added and removed", () => {
    const card = buildWriteDiff("/x/a.ts", "one\ntwo\nthree\n", "one\ntwo changed\nthree\n");
    assert.ok(card);
    assert.equal(card.added, 1);
    assert.equal(card.removed, 1);
    assert.equal(card.path, "/x/a.ts");
  });

  it("earns no card when the write changed nothing", () => {
    assert.equal(buildWriteDiff("/x/a.ts", "same\n", "same\n"), undefined);
  });

  it("caps the diff it keeps, and says how much it dropped", () => {
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 400 }, (_, i) => `changed ${i}`).join("\n");
    const card = buildWriteDiff("/x/big.ts", before, after)!;
    assert.equal(card.diff.split("\n").length, MAX_DIFF_LINES);
    assert.ok(card.droppedLines > 0, "a 400-line rewrite must report dropped rows");
    assert.match(formatWriteDiff(card, theme, true), /more diff lines/);
  });

  it("leads with the path and the two counts", () => {
    const card = buildWriteDiff("/x/a.ts", "one\n", "two\n")!;
    const head = formatWriteDiff(card, theme, false).split("\n")[0]!;
    assert.match(head, /overwrote/);
    assert.match(head, /\/x\/a\.ts/);
    assert.match(head, /\+1/);
    assert.match(head, /-1/);
  });

  it("colours added, removed and context rows through the slots PI's own diff uses", () => {
    const card = buildWriteDiff("/x/a.ts", "keep\ndrop\n", "keep\nadd\n")!;
    const out = formatWriteDiff(card, theme, true);
    assert.match(out, /<toolDiffAdded>\+/);
    assert.match(out, /<toolDiffRemoved>-/);
    assert.match(out, /<toolDiffContext>/);
  });

  it("collapsed, shows at most ten diff rows and offers the rest", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const card = buildWriteDiff("/x/a.ts", before, before.replace(/line/g, "row"))!;
    const rows = formatWriteDiff(card, theme, false).split("\n");
    assert.equal(rows.length, 1 + COLLAPSED_DIFF_LINES + 1); // header, ten diff rows, one "more" row
    assert.match(rows.at(-1)!, /more/);
  });

  it("renders nothing, rather than throwing, for an entry that is not a diff", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
    } as unknown as ExtensionAPI;
    registerWriteDiffRenderer(pi);
    const renderer = renderers.get(DIFF_ENTRY);
    assert.ok(renderer, `no renderer registered for ${DIFF_ENTRY}`);
    assert.equal(renderer({ data: { path: "/x" } }, { expanded: false }, theme), undefined);

    const card = buildWriteDiff("/x/a.ts", "one\n", "two\n")!;
    const component = renderer({ data: card }, { expanded: false }, theme) as
      | { render(width: number): string[] }
      | undefined;
    assert.ok(component, "renderer returned nothing for a well-formed card");
    assert.match(component.render(120).join("\n"), /overwrote/);
  });
});

describe("write-diff handlers", () => {
  it("captures the file before the write and cards the change after it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-write-diff-"));
    const path = join(dir, "a.ts");
    await writeFile(path, "one\ntwo\n", "utf8");

    const { pi, handlers, entries } = fakePi();
    register(pi);
    const ctx = { cwd: dir } as unknown as ExtensionContext;

    const call = { type: "tool_call", toolName: "write", toolCallId: "tc-1", input: { path: "a.ts", content: "one\nTWO\n" } };
    await handlers.get("tool_call")![0]!(call, ctx);
    // The pre-image has to be in hand before the file changes; stand in for the write itself.
    await writeFile(path, "one\nTWO\n", "utf8");
    await handlers.get("tool_result")![0]!(
      { type: "tool_result", toolName: "write", toolCallId: "tc-1", isError: false, input: call.input, content: [] },
      ctx,
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0]![0], DIFF_ENTRY);
    const card = entries[0]![1] as { path: string; added: number; removed: number };
    assert.equal(card.path, path);
    assert.equal(card.added, 1);
    assert.equal(card.removed, 1);
  });

  it("resolves a relative path against the session cwd, as write itself does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-write-diff-"));
    const path = join(dir, "rel.ts");
    await writeFile(path, "before\n", "utf8");

    const { pi, handlers, entries } = fakePi();
    register(pi);
    const ctx = { cwd: dir } as unknown as ExtensionContext;

    const call = { type: "tool_call", toolName: "write", toolCallId: "tc-rel", input: { path: "rel.ts", content: "after\n" } };
    await handlers.get("tool_call")![0]!(call, ctx);
    await handlers.get("tool_result")![0]!(
      { type: "tool_result", toolName: "write", toolCallId: "tc-rel", isError: false, input: call.input, content: [] },
      ctx,
    );

    assert.equal(entries.length, 1, "a relative path must resolve, not be skipped");
    assert.equal((entries[0]![1] as { path: string }).path, path);
  });

  it("cards nothing for a new file, a failed write, or another tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-write-diff-"));
    const { pi, handlers, entries } = fakePi();
    register(pi);
    const ctx = { cwd: dir } as unknown as ExtensionContext;

    const newFile = { type: "tool_call", toolName: "write", toolCallId: "tc-new", input: { path: "new.ts", content: "hello\n" } };
    await handlers.get("tool_call")![0]!(newFile, ctx);
    await handlers.get("tool_result")![0]!(
      { type: "tool_result", toolName: "write", toolCallId: "tc-new", isError: false, input: newFile.input, content: [] },
      ctx,
    );
    assert.deepEqual(entries, [], "a new file has no before to diff against");

    const path = join(dir, "b.ts");
    await writeFile(path, "one\n", "utf8");
    const failed = { type: "tool_call", toolName: "write", toolCallId: "tc-2", input: { path, content: "two\n" } };
    await handlers.get("tool_call")![0]!(failed, ctx);
    await handlers.get("tool_result")![0]!(
      { type: "tool_result", toolName: "write", toolCallId: "tc-2", isError: true, input: failed.input, content: [] },
      ctx,
    );
    assert.deepEqual(entries, [], "a failed write left the file alone");

    await handlers.get("tool_call")![0]!({ type: "tool_call", toolName: "edit", toolCallId: "tc-3", input: { path } }, ctx);
    await handlers.get("tool_result")![0]!(
      { type: "tool_result", toolName: "edit", toolCallId: "tc-3", isError: false, input: {}, content: [] },
      ctx,
    );
    assert.deepEqual(entries, [], "edit renders its own diff already, so this module must not touch it");
  });

  it("never blocks the call it observes", async () => {
    const { pi, handlers } = fakePi();
    register(pi);
    const ctx = { cwd: "/nonexistent-dir-for-write-diff" } as unknown as ExtensionContext;
    const result = await handlers.get("tool_call")![0]!(
      { type: "tool_call", toolName: "write", toolCallId: "tc-x", input: { path: "a.ts", content: "x" } },
      ctx,
    );
    assert.equal(result, undefined);
  });
});

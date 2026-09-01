// extensions/big-results/expand-render.ts — `expand_result`'s own `renderResult`, so it stops
// falling into PI's generic "first 10 raw lines" fallback. The formatters are pure, so the
// assertions are on exact strings; `renderExpandResult` is exercised through a fake render call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

import {
  countTestDeclarations,
  firstInformativeLine,
  formatExpandResult,
  renderExpandResult,
  type ExpandResultArgs,
  type ExpandResultDetails,
} from "../../extensions/big-results/expand-render.ts";

/** A theme that tags instead of colouring, so a test can see which slot a fragment went into. */
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

const args: ExpandResultArgs = { handle: "a1b2c3d4e5f6" };
const details: ExpandResultDetails = {
  handle: "a1b2c3d4e5f6",
  matched: 5,
  sourcePath: "/scratch/results/a1b2c3d4e5f6.txt",
};
const collapsed: ToolRenderResultOptions = { expanded: false, isPartial: false };
const expanded: ToolRenderResultOptions = { expanded: true, isPartial: false };

const sourceBody = [
  "/**",
  " * A module doing a thing.",
  " */",
  'import { readFile } from "node:fs/promises";',
  "",
  "export function doTheThing(x: number): number {",
  "  return x + 1;",
  "}",
].join("\n");

describe("firstInformativeLine", () => {
  it("skips a leading block comment and an import, keeps the first real line", () => {
    assert.equal(firstInformativeLine(sourceBody.split("\n")), "export function doTheThing(x: number): number {");
  });

  it("skips a python-style docstring and its imports", () => {
    const lines = ['"""Module docstring."""', "import os", "", "def run():", "    pass"];
    assert.equal(firstInformativeLine(lines), "def run():");
  });

  it("returns undefined when every line is skippable", () => {
    assert.equal(firstInformativeLine(["", "// just a comment", "import x from \"y\";"]), undefined);
  });
});

describe("countTestDeclarations", () => {
  it("counts it()/describe()/test() call sites", () => {
    const lines = ['describe("suite", () => {', '  it("does a thing", () => {})', '  it("does another", () => {})', "});"];
    assert.equal(countTestDeclarations(lines), 3);
  });

  it("is zero for non-test source", () => {
    assert.equal(countTestDeclarations(sourceBody.split("\n")), 0);
  });
});

describe("formatExpandResult", () => {
  it("collapsed: header carries the handle, relative path, line count, and the informative line — not the docstring/imports", () => {
    const out = formatExpandResult(args, sourceBody, details, "/scratch", collapsed, theme);
    const [head, preview] = out.split("\n");
    assert.match(head!, /handle "a1b2c3d4e5f6"/);
    assert.match(head!, /results\/a1b2c3d4e5f6\.txt/);
    assert.match(head!, /8 lines/);
    assert.match(preview!, /export function doTheThing/);
    assert.ok(!out.includes("Module docstring"), "docstring line leaked into the collapsed preview");
    assert.ok(!out.includes('import { readFile }'), "import line leaked into the collapsed preview");
  });

  it("collapsed, offers the expand hint", () => {
    const out = formatExpandResult(args, sourceBody, details, "/scratch", collapsed, theme);
    assert.match(out, /expand/);
  });

  it("expanded: shows the full body, not just a head slice", () => {
    const out = formatExpandResult(args, sourceBody, details, "/scratch", expanded, theme);
    assert.match(out, /A module doing a thing/);
    assert.match(out, /return x \+ 1;/);
  });

  it("names the language when the source path's extension is recognised", () => {
    const out = formatExpandResult(
      args,
      sourceBody,
      { ...details, sourcePath: "/scratch/results/foo.ts" },
      "/scratch",
      collapsed,
      theme,
    );
    assert.match(out.split("\n")[0]!, /TypeScript/);
  });

  it("omits the language when it is not derivable (a generic externalised .txt)", () => {
    const out = formatExpandResult(args, sourceBody, details, "/scratch", collapsed, theme);
    assert.ok(!out.split("\n")[0]!.includes("TypeScript"));
  });

  it("names the test count when the body has test declarations", () => {
    const testBody = 'describe("x", () => { it("y", () => {}); });';
    const out = formatExpandResult(args, testBody, details, "/scratch", collapsed, theme);
    assert.match(out.split("\n")[0]!, /1 test/);
  });

  it("falls back to a no-preview note when every line is skippable", () => {
    const out = formatExpandResult(args, '"""just a docstring"""', details, "/scratch", collapsed, theme);
    assert.match(out, /no informative line/);
  });

  it("has no path segment on the header when details are absent (e.g. an error path)", () => {
    const out = formatExpandResult(args, sourceBody, undefined, "/scratch", collapsed, theme);
    assert.ok(!out.split("\n")[0]!.includes("results/"));
  });
});

describe("renderExpandResult", () => {
  it("returns a component whose rendered text carries the header and preview", () => {
    const result: AgentToolResult<ExpandResultDetails> = { content: [{ type: "text", text: sourceBody }], details };
    const context = { args, cwd: "/scratch", lastComponent: undefined };
    const component = renderExpandResult(result, collapsed, theme, context) as { render(width: number): string[] };
    const out = component.render(120).join("\n");
    assert.match(out, /handle "a1b2c3d4e5f6"/);
    assert.match(out, /export function doTheThing/);
  });

  it("reuses the previous component instance instead of allocating a new one every render", () => {
    const result: AgentToolResult<ExpandResultDetails> = { content: [{ type: "text", text: sourceBody }], details };
    const prior = renderExpandResult(
      result,
      collapsed,
      theme,
      { args, cwd: "/scratch", lastComponent: undefined },
    );
    const again = renderExpandResult(result, expanded, theme, { args, cwd: "/scratch", lastComponent: prior });
    assert.equal(again, prior);
  });
});

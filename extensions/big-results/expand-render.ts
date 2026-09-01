/**
 * `expand_result` gets its own `renderResult` so the TUI stops truncating its output from the top.
 *
 * WITHOUT THIS. A tool with no `renderResult` falls into PI's generic fallback
 * (`createResultFallback()` in `@earendil-works/pi-coding-agent`'s
 * `dist/modes/interactive/components/tool-execution.js`): the first `FALLBACK_PREVIEW_LINES` (10)
 * raw lines of the result, collapsed, ctrl+o for the rest. For prose that is a reasonable head. For
 * source text it is close to the least informative slice available — a file's top ten lines are
 * its imports and its docstring, and the truncation notice hides everything that would tell an
 * operator glancing at the transcript what actually happened.
 *
 * WHY `expand_result` AND NOT THE OTHER SIX CUSTOM TOOLS in this tree (`job`, `teammate`,
 * `ask_question`, `fact`, `message_agent`, `web_answer` — none of them define `renderResult`
 * either). Every one of those returns short, human-authored status/report text with no equivalent
 * of "path, line count, language" to summarise. `expand_result` is the one whose whole job is
 * reading back a slice of externalised source or tool output (`index.ts`'s module doc) — it is the
 * one that actually reproduces the problem, and the one this repo can fix without inventing a
 * structural summary for content that has none.
 *
 * WHY NOT PATCH `createResultFallback()` ITSELF. That function lives in
 * `@earendil-works/pi-coding-agent`, an npm dependency this repo could `patch-package` — but (a) a
 * patch there is inert under the default `--mode binary`/`--mode auto` install, the same caveat
 * `docs/known-harness-limits.md` already documents for the existing dependency patch, and (b) it is
 * the shared fallback for every tool without a renderer, built-in or MCP — this repo owns none of
 * those, so fixing it there would be reaching outside repo-owned surface for the one case
 * (`expand_result`) that is actually ours. `pi.registerTool({ renderResult })` is the repo-owned
 * side channel: it applies unconditionally, in both install modes, because it is called by this
 * repo's own extension code, not by a patched dependency.
 */
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { keyHintOr } from "../lib/render.ts";

export interface ExpandResultArgs {
  readonly handle: string;
  readonly grep?: string;
  readonly fromLine?: number;
  readonly lines?: number;
}

export interface ExpandResultDetails {
  readonly handle: string;
  readonly matched: number;
  readonly sourcePath: string;
}

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  rb: "Ruby",
  sh: "shell",
  bash: "shell",
  json: "JSON",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
};

/** Best-effort — the externalised file is usually a scratch `.txt` with no meaningful extension of
 *  its own, so this is `undefined` more often than not. */
function guessLanguage(path: string): string | undefined {
  const ext = path.split(".").pop();
  return ext ? LANGUAGE_BY_EXT[ext.toLowerCase()] : undefined;
}

const IMPORT_RE = /^\s*(import\b|from\s+\S+\s+import\b|#include\b|require\(|use\s+\S+::)/;
const TEST_DECL_RE = /\b(?:it|test|describe)\s*\(|^\s*(?:async\s+)?def\s+test_|#\[test\]/;

/** Tracks whether a multi-line block comment/docstring opened by an earlier line is still open. */
interface CommentState {
  active: boolean;
}

function isSkippable(line: string, state: CommentState): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (state.active) {
    if (trimmed.includes("*/") || trimmed.endsWith('"""') || trimmed.endsWith("'''")) state.active = false;
    return true;
  }
  if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
    if (!trimmed.includes("*/")) state.active = true;
    return true;
  }
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    const marker = trimmed.slice(0, 3);
    if (trimmed.length <= 3 || !trimmed.endsWith(marker)) state.active = true;
    return true;
  }
  if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("#")) return true;
  return IMPORT_RE.test(line);
}

/** First line that is not blank, a comment/docstring line, or an import — the collapsed preview
 * when nothing more structural (path, language) is derivable. */
export function firstInformativeLine(lines: readonly string[]): string | undefined {
  const state: CommentState = { active: false };
  for (const line of lines) {
    if (!isSkippable(line, state)) return line.trim();
  }
  return undefined;
}

/** A cheap regex count over the returned slice, not the whole file — `expand_result` may only have
 *  returned a fragment, and the count should describe what is shown. */
export function countTestDeclarations(lines: readonly string[]): number {
  return lines.reduce((n, line) => (TEST_DECL_RE.test(line) ? n + 1 : n), 0);
}

function clipLine(line: string, max = 96): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Collapsed: header (handle, path relative to cwd when derivable, line count, language, test
 * count) plus the first informative line as a one-line gist. Expanded (ctrl+o): the full body,
 * already bounded upstream by `truncateTail`'s `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` in
 * `index.ts` — this renderer does not re-truncate it.
 */
export function formatExpandResult(
  args: ExpandResultArgs,
  bodyText: string,
  details: ExpandResultDetails | undefined,
  cwd: string,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  const lines = bodyText.split("\n");
  const rel = details?.sourcePath ? relative(cwd, details.sourcePath) : undefined;
  const language = details?.sourcePath ? guessLanguage(details.sourcePath) : undefined;
  const testCount = countTestDeclarations(lines);

  let head = theme.fg("accent", theme.bold("▤ expand_result ")) + theme.fg("toolTitle", `handle "${args.handle}"`);
  if (rel) head += theme.fg("muted", ` · ${rel}`);
  head += theme.fg("muted", ` · ${lines.length} line${lines.length === 1 ? "" : "s"}`);
  if (language) head += theme.fg("muted", `, ${language}`);
  if (testCount > 0) head += theme.fg("muted", `, ${testCount} test${testCount === 1 ? "" : "s"}`);

  if (options.expanded) {
    const body = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
    return `${head}\n${body}`;
  }

  const preview = firstInformativeLine(lines);
  const previewLine = theme.fg("dim", `  ${preview ? clipLine(preview) : "(no informative line to preview)"}`);
  const foot = `  ${keyHintOr("app.tools.expand", "for the full body", theme, "ctrl+o for the full body")}`;
  return [head, previewLine, foot].join("\n");
}

/**
 * `renderResult` for the `expand_result` tool definition.
 *
 * `context` is typed structurally (the three fields this renderer reads) rather than against
 * `ToolRenderContext` — that type is not re-exported from this package's public entry point at
 * 0.84.0 (present in `core/extensions/types.d.ts`, dropped from `dist/index.d.ts`'s re-export
 * list), the same gap `index.ts` notes for `ToolResultEventResult`/`ContextEventResult`.
 */
export function renderExpandResult(
  result: AgentToolResult<ExpandResultDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { readonly args: ExpandResultArgs; readonly cwd: string; readonly lastComponent: unknown },
): Text {
  const bodyText = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  text.setText(formatExpandResult(context.args, bodyText, result.details, context.cwd, options, theme));
  return text;
}

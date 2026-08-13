/**
 * `/context` — what actually occupies the context window, and why `/compact` may refuse.
 *
 * No wave spec exists for this item; this docstring is that spec
 * ("write each spec in the session that builds it ... commit the spec with the code").
 *
 * ---------------------------------------------------------------------------------------------
 * **The gap this closes, measured before it was written.**
 *
 * PI 0.84.0 has no `/context`. Every slash-command literal in the shipped binary was enumerated;
 * the set is `/compact /debug /export /fork /hotkeys /import /model /models /name /new /path
 * /quit /reload /resume /session /settings /share /skills /tree /trust` and a handful of provider
 * route names. Context occupancy is therefore visible in exactly two places, and one of them is
 * routinely misread:
 *
 *   - The TUI footer (`dist/modes/interactive/…` footer `render()`), which appends
 *     `${percent}%/${window}` to the stats line. This number is honest — `getContextUsage()`
 *     resolves through `estimateContextTokens(this.messages)`, which prefers the last assistant
 *     `usage` from the provider and therefore already includes the system prompt, the tool
 *     schemas and the skill catalogue. It is also dim, one line, and expressed as a percentage of
 *     a window that may be 1 050 000 — a full fifth of a 200 000-token budget renders as "4.0%".
 *   - `/session`, which prints `Tokens → Total`. That is `addUsageToTotals` summed over **every**
 *     assistant entry in the session — a cumulative billing figure, not occupancy. On the session
 *     that motivated this module it read 626 374 while the live context was 41 637: a 15× gap
 *     between the number on screen and the number the operator thought they were reading.
 *
 * Neither surface decomposes anything. The question "how large is the preamble" — system prompt,
 * tool schemas, `AGENTS.md`/`CLAUDE.md`, the skill catalogue — has no answer in the product, and
 * the model cannot answer it either: it never sees its own prompt as a measurable object.
 *
 * **What makes an answer possible from an extension.** `ExtensionCommandContext` (the context
 * passed to `registerCommand` handlers, `dist/core/extensions/types.d.ts:254`) exposes
 * `getSystemPromptOptions()`, which returns the live `BuildSystemPromptOptions` — `contextFiles`
 * with their full content, the loaded `skills`, `customPrompt`, `appendSystemPrompt`,
 * `selectedTools`, `toolSnippets`, `promptGuidelines`. Combined with `getSystemPrompt()` (the
 * rendered string), `getAllTools()` (each tool's JSON-Schema `parameters`) and
 * `getContextUsage()`, every component can be measured rather than guessed at.
 *
 * ---------------------------------------------------------------------------------------------
 * **Two honesty rules this module lives by.**
 *
 * 1. *Measured and estimated are labelled differently.* Character counts are exact. Token counts
 *    are `ceil(chars / 4)` — deliberately PI's own heuristic (`estimateTokens`,
 *    `dist/core/compaction/compaction.js`), so our numbers are comparable with the ones PI uses
 *    for its cut-point decision, not with a tokenizer PI does not run. The one exception is the
 *    live total, which comes from the provider's `usage` and is exact; it is reported as such.
 * 2. *The dialogue figure is a subtraction and says so.* PI does not expose session entries to
 *    extensions, so "how much of the context is conversation" can only be `live - preamble`. On
 *    the motivating session that subtraction gave 20 418 against PI's own entry-walk of 17 896 —
 *    a ~14 % spread, which is the accuracy this line has and the accuracy it claims.
 *
 * ---------------------------------------------------------------------------------------------
 * **Why `/compact` refuses on a session that is visibly not small.** This is the question that
 * produced the module, and the report answers it inline rather than making the operator derive it.
 *
 * `prepareCompaction()` (`dist/core/compaction/compaction.js`) does not look at the context
 * window at all. It walks session entries backwards accumulating `estimateTokens` until it
 * reaches `settings.keepRecentTokens`; if the walk ends before reaching it, the cut point stays at
 * the first valid boundary, `messagesToSummarize` comes out empty, the function returns
 * `undefined`, and the caller raises `Nothing to compact (session too small)`.
 *
 * So the threshold `/compact` measures against is `keepRecentTokens` — ours, from
 * `config/settings.json` — applied to the *dialogue only*. The preamble is excluded twice over:
 * it is not a session entry, and it is rebuilt on every request, so compaction could not shrink it
 * even in principle. A session sitting at 41 637 live tokens can hold 17 896 compactable ones and
 * be, by PI's definition, "too small". The message is true and reads as false.
 * ------------------------------------------------------------------------------------------- */

/** PI's own estimator: `ceil(chars / 4)`, used so our numbers compare with PI's cut-point maths. */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface ContextFileInput {
  readonly path: string;
  readonly content: string;
}

export interface SkillInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

export interface ToolInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters?: unknown;
}

export interface SystemPromptOptionsInput {
  readonly contextFiles?: ReadonlyArray<ContextFileInput> | undefined;
  readonly skills?: ReadonlyArray<SkillInput> | undefined;
  readonly customPrompt?: string | undefined;
  readonly appendSystemPrompt?: string | undefined;
  readonly promptGuidelines?: ReadonlyArray<string> | undefined;
  readonly selectedTools?: ReadonlyArray<string> | undefined;
}

export interface UsageInput {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

export interface ContextReportInput {
  readonly systemPrompt: string;
  readonly options: SystemPromptOptionsInput;
  readonly tools: ReadonlyArray<ToolInput>;
  readonly usage: UsageInput | undefined;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly compactionEnabled: boolean;
}

export interface Component {
  readonly label: string;
  readonly chars: number;
  readonly tokens: number;
}

export interface ContextReport {
  /** Rendered system prompt — exact chars, estimated tokens. */
  readonly systemPrompt: Component;
  /** Named parts of the system prompt. Never presented as a complete partition — see `remainder`. */
  readonly systemPromptParts: ReadonlyArray<Component>;
  /**
   * The part of the system prompt not attributable to a named part: PI's base instructions, the
   * guidelines block, the tool one-liners, the cwd line. Non-negative by construction.
   */
  readonly remainder: Component;
  /** Tool JSON schemas. Sent as a separate provider field, NOT inside the system prompt. */
  readonly toolSchemas: Component;
  readonly toolCount: number;
  /** System prompt + tool schemas: rebuilt every request, never removed by compaction. */
  readonly preambleTokens: number;
  /** Provider-reported live occupancy, or null when no usage has been seen yet. */
  readonly liveTokens: number | null;
  readonly contextWindow: number;
  readonly livePercent: number | null;
  /** `live - preamble`, floored at 0. An estimate; see the module docstring. */
  readonly dialogueTokens: number | null;
  /** `contextWindow - reserveTokens` — where `shouldCompact` fires. 0 when compaction is off. */
  readonly compactionTrigger: number;
  readonly headroomTokens: number | null;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly compactionEnabled: boolean;
  /**
   * True when the estimated dialogue is below `keepRecentTokens`, i.e. `/compact` is expected to
   * refuse with "session too small". Null when there is no live figure to judge from.
   */
  readonly compactWouldRefuse: boolean | null;
}

function component(label: string, chars: number): Component {
  return { label, chars, tokens: estimateTokens(chars) };
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((a, b) => a + b, 0);
}

export function buildContextReport(input: ContextReportInput): ContextReport {
  const opts = input.options;

  const contextFileChars = sum((opts.contextFiles ?? []).map((f) => f.content.length));
  const skillChars = sum(
    (opts.skills ?? []).map((s) => (s.name ?? "").length + (s.description ?? "").length),
  );
  const appendChars = (opts.appendSystemPrompt ?? "").length;
  const customChars = (opts.customPrompt ?? "").length;

  const parts: Component[] = [];
  if (customChars > 0) parts.push(component("custom base prompt", customChars));
  if (contextFileChars > 0) parts.push(component("context files", contextFileChars));
  if (skillChars > 0) parts.push(component("skill catalogue", skillChars));
  if (appendChars > 0) parts.push(component("appended prompt", appendChars));

  const systemPrompt = component("system prompt", input.systemPrompt.length);
  const attributed = sum(parts.map((p) => p.chars));
  // Floored: `formatSkillsForPrompt` adds framing around each entry, so an attributed part can
  // measure larger than its slice of the rendered prompt. A negative remainder would be a lie
  // about a partition this report never claims to be exact.
  const remainder = component("base + guidelines", Math.max(0, systemPrompt.chars - attributed));

  const toolChars = sum(
    input.tools.map(
      (t) =>
        t.name.length +
        (t.description ?? "").length +
        (t.parameters === undefined ? 0 : JSON.stringify(t.parameters).length),
    ),
  );
  const toolSchemas = component("tool schemas", toolChars);

  const preambleTokens = systemPrompt.tokens + toolSchemas.tokens;

  // A zero is not an occupancy reading, it is the absence of one. `getContextUsage()` returns
  // `estimateContextTokens(messages).tokens`, and that estimator only reports a real figure once
  // an assistant message carries provider `usage`; before the first response of a session it walks
  // an empty message list and returns 0. PI signals the other "no reading" case explicitly with
  // `tokens: null` (immediately after a compaction). Treating 0 as measured would print
  // "0 tokens, provider-reported, exact" for a session whose preamble is already 21 000 tokens —
  // precisely the false reassurance this module exists to remove.
  const rawTokens = input.usage?.tokens ?? null;
  const liveTokens = rawTokens === null || rawTokens <= 0 ? null : rawTokens;
  const contextWindow = input.usage?.contextWindow ?? 0;
  const livePercent = liveTokens === null ? null : (input.usage?.percent ?? null);

  const dialogueTokens = liveTokens === null ? null : Math.max(0, liveTokens - preambleTokens);

  const compactionTrigger = input.compactionEnabled
    ? Math.max(0, contextWindow - input.reserveTokens)
    : 0;
  const headroomTokens =
    liveTokens === null || !input.compactionEnabled ? null : compactionTrigger - liveTokens;

  const compactWouldRefuse =
    dialogueTokens === null ? null : dialogueTokens < input.keepRecentTokens;

  return {
    systemPrompt,
    systemPromptParts: parts,
    remainder,
    toolSchemas,
    toolCount: input.tools.length,
    preambleTokens,
    liveTokens,
    contextWindow,
    livePercent,
    dialogueTokens,
    compactionTrigger,
    headroomTokens,
    reserveTokens: input.reserveTokens,
    keepRecentTokens: input.keepRecentTokens,
    compactionEnabled: input.compactionEnabled,
    compactWouldRefuse,
  };
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

/** One report row before alignment: the indent it sits at, its label, and what follows the colon. */
interface Row {
  readonly indent: number;
  readonly label: string;
  readonly value: string;
}

/**
 * Aligns every colon to the same column, counting the indent as part of the label width so a
 * nested row's colon lines up with its parent's rather than drifting right. Computed from the rows
 * actually present — a fixed width silently truncates the moment a label grows.
 */
function renderRows(rows: ReadonlyArray<Row>): string[] {
  const width = Math.max(...rows.map((r) => r.indent + r.label.length));
  return rows.map((r) => {
    const lead = " ".repeat(r.indent) + r.label;
    return `${lead}${" ".repeat(width - lead.length)} : ${r.value}`;
  });
}

/** The report as the operator sees it. One block, no colour — `emitNotice` picks the channel. */
export function formatContextReport(report: ContextReport, contextFileCount: number): string {
  const rows: Row[] = [];

  if (report.liveTokens === null) {
    rows.push({
      indent: 2,
      label: "live",
      value:
        `unknown — no provider usage yet this session; the first request already carries ` +
        `~${n(report.preambleTokens)} (window ${n(report.contextWindow)})`,
    });
  } else {
    const pct = report.livePercent === null ? "?" : report.livePercent.toFixed(1);
    rows.push({
      indent: 2,
      label: "live",
      value: `${n(report.liveTokens)} of ${n(report.contextWindow)} (${pct} %) — provider-reported, exact`,
    });
  }

  rows.push({
    indent: 2,
    label: "preamble",
    value: `${n(report.preambleTokens)} tokens, rebuilt every request`,
  });
  rows.push({
    indent: 4,
    label: report.systemPrompt.label,
    value: `${n(report.systemPrompt.tokens)} (${n(report.systemPrompt.chars)} chars)`,
  });
  for (const part of report.systemPromptParts) {
    const detail = part.label === "context files" ? ` [${contextFileCount} file(s)]` : "";
    rows.push({ indent: 6, label: part.label, value: `${n(part.tokens)}${detail}` });
  }
  rows.push({ indent: 6, label: report.remainder.label, value: n(report.remainder.tokens) });
  rows.push({
    indent: 4,
    label: report.toolSchemas.label,
    value: `${n(report.toolSchemas.tokens)} (${report.toolCount} tool(s), sent outside the prompt)`,
  });

  if (report.dialogueTokens !== null) {
    rows.push({
      indent: 2,
      label: "dialogue",
      value: `~${n(report.dialogueTokens)} — estimated as live minus preamble`,
    });
  }

  if (!report.compactionEnabled) {
    rows.push({ indent: 2, label: "compaction", value: "disabled" });
  } else {
    const headroom =
      report.headroomTokens === null
        ? ""
        : report.headroomTokens >= 0
          ? `, ${n(report.headroomTokens)} to go`
          : `, exceeded by ${n(-report.headroomTokens)}`;
    rows.push({
      indent: 2,
      label: "compaction",
      value:
        `fires above ${n(report.compactionTrigger)} ` +
        `(window ${n(report.contextWindow)} - reserve ${n(report.reserveTokens)})${headroom}`,
    });
    if (report.compactWouldRefuse === true) {
      rows.push({
        indent: 2,
        label: "/compact now",
        value:
          `would refuse — "session too small". It measures the dialogue ` +
          `(~${n(report.dialogueTokens ?? 0)}) against keepRecentTokens ` +
          `(${n(report.keepRecentTokens)}), not the context. The preamble is never compactable.`,
      });
    } else if (report.compactWouldRefuse === false) {
      rows.push({
        indent: 2,
        label: "/compact now",
        value:
          `would run — dialogue ~${n(report.dialogueTokens ?? 0)} exceeds keepRecentTokens ` +
          `${n(report.keepRecentTokens)}`,
      });
    }
  }

  return ["[pi-config] context", ...renderRows(rows)].join("\n");
}

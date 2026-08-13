/**
 * Pattern-based reference extraction for `D-01` (tools), `D-02` (skills), `D-03` (agents) and
 * `D-07` (MCP servers) — every name the instruction text mentions, so it can be resolved against
 * the declared roster (`declared.ts`) instead of trusted blindly.
 *
 * ## What is actually scanned — read this before touching a pattern
 *
 * `doctor.ts` feeds these patterns `ctx.getSystemPrompt()`, and that string is **not** the ported
 * instruction text. `dist/core/system-prompt.js` assembles it, in order, from:
 *
 *   1. PI's preamble — "You are an expert coding assistant operating inside pi…", then the
 *      `Available tools:` list (`- <name>: <promptSnippet>` per registered tool) and the
 *      `Guidelines:` list (every tool's `promptGuidelines`), both assembled by
 *      `system-prompt.js:43`/`:47` out of **tool-registration metadata**. Some of that metadata is
 *      written in this repo — `big-results/index.ts:72,74` supplies `expand_result`'s — but it is
 *      registration data, not instruction text, and every tool named in it is by construction a
 *      tool that just registered. Scanning it to ask "does this tool exist" is circular; scanning
 *      its English descriptions *of* tools with a `(the|a|an) <word> tool` pattern is guaranteed to
 *      misfire, because prose about tools is exactly what a tool description is.
 *   2. `<project_context>` wrapping one `<project_instructions path="…">` block per context file:
 *      this repo's `AGENTS.md`, plus the installed copy PI reads as the global one
 *      (`~/.pi/agent/AGENTS.md`, a symlink back to it). **This is the only part this repo owns.**
 *      `context-imports.ts`'s `@path` expansions land inside these blocks, so `PRIVATE.md` and
 *      every other import is covered here too once a turn has run.
 *   3. `<available_skills>` — PI's own render of the *live skill registry*, one `<skill>` entry per
 *      discovered skill carrying `<name>`, `<description>` and an absolute `<location>` path.
 *   4. `Current working directory: …`, and — after the first turn, because `before_agent_start`
 *      replacements are written back to `agent.state.systemPrompt` (`agent-session.js:901`) —
 *      `session-context.ts`'s `MARK_OPEN`/`MARK_CLOSE` block, which is repo-authored.
 *
 * Running the patterns over the whole prompt therefore scans two large regions that are not
 * instruction text at all, and on 2026-08-07 that produced eight false `/doctor` errors: `D-01`
 * `externalised` + `original` off `expand_result`'s own snippet and guideline ("Read back part of
 * an externalised tool result", "instead of re-running the original tool"), and `D-02` six skill
 * names off `<available_skills>`'s `<location>` paths — skills installed outside the repo
 * (`~/.agents/skills/…`) or shipped inside a package
 * (`pi-packages/pi-mcp-adapter/skills/…`, `node_modules/<pkg>/skills/…`), which
 * `discoverDeclaredSkills`'s three repo roots can never contain. `<available_skills>` is the
 * registry of what *exists*; treating it as a set of *references* inverted the check.
 *
 * `authoredInstructionText()` below is the fix: narrow the input to regions 2 and 4 before any
 * pattern runs. See its own docstring for what happens when neither marker is found.
 *
 * What that gives up, stated so nobody rediscovers it as a bug: a tool's own `promptSnippet` or
 * `promptGuidelines` string is region 1 and is no longer scanned, so a guideline that named a tool
 * that does not exist would no longer be caught by `D-01`. That is a narrow and deliberate trade —
 * those strings are registered from TypeScript alongside the tool they describe, `pi-check`'s rules
 * and `tsc` see them, and the alternative is a check that cannot tell a tool description from a
 * tool reference.
 *
 * ## The patterns
 *
 * This is a heuristic, not a parser — there is no formal syntax in `AGENTS.md` for "this word
 * names a tool". Every pattern below was chosen and pruned against the *real* ported text plus
 * the acceptance test ("use the frobnicate tool"), empirically:
 *
 *   - Backtick-formatted mentions (`` `sofa` skill ``, `` `playwright` MCP server ``,
 *     `` skills/pr-describe/SKILL.md ``) are the reliable case — deliberate code-formatting is a
 *     strong signal and these patterns do not misfire anywhere in the authored text.
 *   - The one **un**-formatted pattern — `(the|a|an) <word> tool` — exists only because the
 *     acceptance test's example is bare prose ("use the frobnicate tool"). Run unfiltered against
 *     the real text it also matches "a **known** tool's config file" and "a **third-party**
 *     tool" — false positives, not drift. It is therefore narrowed to a snake_case-shaped
 *     candidate (real tool ids in this tree are `web_search`, `expand_result`, … — never
 *     hyphenated prose) plus a stopword list of the generic adjectives that show up in running
 *     English before the word "tool". That list is whack-a-mole by construction and is deliberately
 *     *not* the defence against the false positives described above — scoping the input is. It only
 *     still has to hold for English written inside this repo's own `AGENTS.md`.
 *
 * Verified empirically (not asserted from memory) on 2026-08-07 against the **live**
 * `ctx.getSystemPrompt()` of a `PI_OFFLINE=1 pi -p '/doctor --json'` run in this repo, dumped with
 * `/ctx-dump`: `extractReferences(authoredInstructionText(prompt))` returns `{tools: [], skills:
 * ["sofa", "agent-swarm-workflow"], agents: [12 names], servers: ["playwright", "context7"]}`.
 * Applied to `AGENTS.md` + `PRIVATE.md` read straight off disk — text with no assembled-prompt
 * markers, so `authoredInstructionText` is a pass-through — it returns the same, plus
 * `"pr-describe"` and `"databricks"` from `PRIVATE.md`. `test/doctor/extract.test.ts` pins both.
 */

/** Common English adjectives/determiners seen (or plausible) directly before "tool" in prose
 *  that is talking *about* tools generically, not naming one. Extend this list before ever
 *  suppressing a real finding by hand. */
const TOOL_WORD_STOPLIST: ReadonlySet<string> = new Set([
  "known", "new", "old", "given", "existing", "custom", "external", "internal", "other",
  "specific", "particular", "single", "certain", "right", "wrong", "this", "that", "some", "any",
  "no", "every", "each", "another", "similar", "relevant", "appropriate", "native", "standard",
  "common", "generic", "missing", "broken", "unfamiliar", "unknown", "following", "diagnostic",
  "useful", "additional", "extra", "our", "their", "whichever", "real", "actual", "proper",
  "better", "best", "worse", "same", "different", "various", "several", "multiple", "individual",
  "respective", "underlying", "corresponding", "matching", "requested", "required", "necessary",
  "suitable", "valid", "invalid", "correct", "good", "bad", "helpful", "dangerous", "unsafe",
  "safe", "unavailable", "available", "active", "inactive", "enabled", "disabled", "hidden",
  "visible", "primary", "secondary", "main", "core", "basic", "advanced", "simple", "complex",
]);

/** Real tool ids in this tree are snake_case (`web_search`, `expand_result`) or a single bare
 *  core-tool word (`bash`, `read`) — never hyphenated running-text. */
const SNAKE_CASE_ISH = /^[a-z][a-z0-9_]*$/;

export interface ExtractedReferences {
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly servers: readonly string[];
}

/** PI's per-context-file wrapper (`system-prompt.js`: `<project_instructions path="${filePath}">`).
 *  Non-greedy body, so N context files yield N regions rather than one spanning region. */
const PROJECT_INSTRUCTIONS_RE = /<project_instructions\b[^>]*>\n?([\s\S]*?)\n?<\/project_instructions>/g;

/** `session-context.ts`'s `MARK_OPEN` … `MARK_CLOSE`. Matched by shape rather than imported: this
 *  module must stay free of any module with side effects, and the marker is a stable contract that
 *  file's own tests pin. */
const SESSION_CONTEXT_RE = /<!--\s*pi-config:session-context\b[^>]*-->([\s\S]*?)<!--\s*\/pi-config:session-context\b[^>]*-->/g;

/** Three independent fingerprints of "this string came out of PI's system-prompt builder" — the
 *  preamble's opening clause, the skills block, and the trailing cwd line. Any one is enough, so a
 *  PI release that reworks one of the three does not silently reclassify the text. */
const ASSEMBLED_PROMPT_MARKERS: readonly string[] = [
  "operating inside pi, a coding agent harness",
  "\n<available_skills>",
  "\nCurrent working directory: ",
];

/**
 * Narrows an assembled system prompt to the text this repo actually authors, so the patterns below
 * are never run over PI's preamble or PI's `<available_skills>` registry render. See the module
 * docstring for the full anatomy of the prompt and for the eight false positives this removes.
 *
 * Three cases, in order:
 *
 *   1. **At least one authored region found** — `<project_instructions>` bodies and/or a
 *      `session-context` block: return their concatenation. This is the live-session case.
 *   2. **No region, but the text is recognisably an assembled prompt**: return `""`. PI produced a
 *      prompt with no context files in it (`AGENTS.md` absent from a colleague's clone, or context
 *      loading switched off), so there is no authored instruction text and nothing can be drifting.
 *      Reporting `D-01` on PI's own guideline prose would be a pure false positive.
 *   3. **Neither** — a raw `AGENTS.md`, a `PRIVATE.md`, a unit-test fixture: pass through
 *      unchanged. Every byte of such a string is authored text by definition.
 *
 * The one blind spot, stated plainly: if a future PI release renames `<project_instructions>` while
 * keeping any of `ASSEMBLED_PROMPT_MARKERS`, case 2 wins and `D-01`/`D-02`/`D-03`/`D-07` go quiet
 * instead of loud. That is why `test/doctor/extract.test.ts` asserts the tag against the *installed*
 * `@earendil-works/pi-coding-agent` prompt builder — the upgrade that would blind the check fails
 * `node --test` at the moment the dependency moves, which is the moment a human is looking.
 */
export function authoredInstructionText(text: string): string {
  const regions: string[] = [];
  for (const m of matchAll(text, PROJECT_INSTRUCTIONS_RE)) regions.push(m[1]);
  for (const m of matchAll(text, SESSION_CONTEXT_RE)) regions.push(m[1]);
  if (regions.length > 0) return regions.join("\n\n");
  return ASSEMBLED_PROMPT_MARKERS.some((marker) => text.includes(marker)) ? "" : text;
}

export function extractReferences(text: string): ExtractedReferences {
  return {
    tools: dedupe(extractTools(text)),
    skills: dedupe(extractSkills(text)),
    agents: dedupe(extractAgents(text)),
    servers: dedupe(extractServers(text)),
  };
}

function extractTools(text: string): string[] {
  const out: string[] = [];
  for (const m of matchAll(text, /`([\w.-]+)`\s+tool\b/g)) out.push(m[1]);
  for (const m of matchAll(text, /\b(?:the|an?)\s+([A-Za-z][\w-]{2,})\s+tool\b/g)) {
    const cand = m[1].toLowerCase();
    if (SNAKE_CASE_ISH.test(cand) && !TOOL_WORD_STOPLIST.has(cand)) out.push(cand);
  }
  return out;
}

function extractSkills(text: string): string[] {
  const out: string[] = [];
  for (const m of matchAll(text, /`([\w-]+)`\s+skill\b/gi)) out.push(m[1]);
  for (const m of matchAll(text, /(?:скилл|skill)\s+`([\w-]+)`/gi)) out.push(m[1]);
  for (const m of matchAll(text, /skills(?:-work|-private)?\/([\w-]+)\/SKILL\.md/g)) out.push(m[1]);
  return out;
}

/**
 * `agents/` isn't referenced name-by-name in the ported text — it is a `namea, nameb, namec.`
 * list following a colon, in the same paragraph as a mention of `agents/` or `agent`. The list
 * shape (3+ comma-separated lowercase-hyphen tokens, ending in a period) is what is matched; a
 * short list or one containing a non-identifier token (e.g. "language semantics", two words) is
 * deliberately not matched — see the module docstring for why a looser pattern misfires.
 */
function extractAgents(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    if (!/\bagents?\b/i.test(para)) continue;
    for (const m of matchAll(para, /:\s*([a-z][a-z0-9-]*(?:,\s*[a-z][a-z0-9-]*){2,})\./g)) {
      out.push(...m[1].split(",").map((s) => s.trim()));
    }
  }
  return out;
}

function extractServers(text: string): string[] {
  const out: string[] = [];
  for (const m of matchAll(text, /`([\w-]+)`\s+(?:server\b|MCP\s+(?:server|tools?)\b)/g)) out.push(m[1]);
  return out;
}

function* matchAll(text: string, re: RegExp): Generator<RegExpExecArray> {
  const r = new RegExp(re); // fresh lastIndex per call, callers reuse the same literal safely
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    yield m;
    if (m.index === r.lastIndex) r.lastIndex++; // guard against zero-width matches looping forever
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

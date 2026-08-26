import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { authoredInstructionText, extractReferences } from "../../extensions/doctor/extract.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

describe("extractReferences — synthetic fixtures", () => {
  it("finds a backtick-formatted tool name followed by the word tool", () => {
    const refs = extractReferences("Use the `frobnicate` tool for this.");
    assert.deepEqual(refs.tools, ["frobnicate"]);
  });

  it("finds the bare-prose tool pattern from wave1-specs.md's own acceptance test", () => {
    const refs = extractReferences("use the frobnicate tool");
    assert.deepEqual(refs.tools, ["frobnicate"]);
  });

  it("does not false-positive on stopword adjectives before 'tool'", () => {
    const refs = extractReferences(
      "a known tool's config file; a custom tool; an existing tool; the given tool",
    );
    assert.deepEqual(refs.tools, []);
  });

  it("does not false-positive on hyphenated running prose before 'tool'", () => {
    // "third-party" is two tokens joined by a hyphen — SNAKE_CASE_ISH must reject it even though
    // it is not on the stopword list, because real tool ids never contain a hyphen in this tree.
    const refs = extractReferences("a third-party tool");
    assert.deepEqual(refs.tools, []);
  });

  it("finds a SKILL.md path under the skills root", () => {
    const refs = extractReferences(
      "See skills/search-web/SKILL.md, skills/wiki/SKILL.md and skills/csv-import/SKILL.md.",
    );
    assert.deepEqual(refs.skills.toSorted(), ["csv-import", "search-web", "wiki"]);
  });

  it("finds a backtick skill name followed by the word skill, English and Russian", () => {
    const refs = extractReferences("Load the `sofa` skill. Скилл `agent-swarm-workflow` тоже.");
    assert.deepEqual(refs.skills.toSorted(), ["agent-swarm-workflow", "sofa"]);
  });

  it("finds a comma-separated agent list in a paragraph mentioning agents/", () => {
    const refs = extractReferences(
      "Choose a role from `agents/`: researcher, debugger, ai-engineer, prompt-engineer.",
    );
    assert.deepEqual(refs.agents, ["researcher", "debugger", "ai-engineer", "prompt-engineer"]);
  });

  it("does not extract a short list or one containing a non-identifier token", () => {
    const refs = extractReferences("about agents: math, algorithms, language semantics.");
    assert.deepEqual(refs.agents, []);
  });

  it("finds an MCP server named with the server or MCP-server/tools phrasing", () => {
    const refs = extractReferences("the `playwright` MCP server, or the `context7` MCP tools, or the `foo` server");
    assert.deepEqual(refs.servers.toSorted(), ["context7", "foo", "playwright"]);
  });

  it("dedupes repeated mentions", () => {
    const refs = extractReferences("`sofa` skill ... later again the `sofa` skill");
    assert.deepEqual(refs.skills, ["sofa"]);
  });
});

describe("authoredInstructionText — narrowing the assembled prompt", () => {
  const ASSEMBLED = [
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "- expand_result: Read back part of an externalised tool result",
    "",
    "<project_context>",
    "",
    '<project_instructions path="/home/x/.pi/agent/AGENTS.md">',
    "GLOBAL BODY",
    "</project_instructions>",
    "",
    '<project_instructions path="/repo/AGENTS.md">',
    "PROJECT BODY",
    "</project_instructions>",
    "",
    "</project_context>",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>yopass</name>",
    "    <location>/Users/x/.agents/skills/yopass/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
    "Current working directory: /repo",
  ].join("\n");

  it("keeps every <project_instructions> body and drops everything PI generated", () => {
    const authored = authoredInstructionText(ASSEMBLED);
    assert.equal(authored, "GLOBAL BODY\n\nPROJECT BODY");
  });

  it("keeps session-context.ts's injected block, which getSystemPrompt() carries after a turn", () => {
    const withBlock =
      `${ASSEMBLED}\n\n<!-- pi-config:session-context v1 -->\nOPERATOR BODY\n<!-- /pi-config:session-context v1 -->`;
    const authored = authoredInstructionText(withBlock);
    assert.match(authored, /OPERATOR BODY/);
    assert.match(authored, /PROJECT BODY/);
    assert.doesNotMatch(authored, /yopass/);
  });

  it("returns nothing for an assembled prompt that carries no context file at all", () => {
    // A colleague's clone with no AGENTS.md: PI emits no <project_context>, so there is no authored
    // instruction text and nothing can be drifting. Scanning PI's own prose instead would report
    // "externalised"/"original" as missing tools — the 2026-08-07 D-01 false positives.
    const noContext = [
      "You are an expert coding assistant operating inside pi, a coding agent harness.",
      "- Use expand_result with the handle from an externalised result instead of re-running the original tool.",
      "Current working directory: /repo",
    ].join("\n");
    assert.equal(authoredInstructionText(noContext), "");
    assert.deepEqual(extractReferences(authoredInstructionText(noContext)).tools, []);
  });

  it("passes raw instruction text through untouched — every byte of it is authored", () => {
    const raw = "Load the `sofa` skill and use the `playwright` MCP server.";
    assert.equal(authoredInstructionText(raw), raw);
  });

  it("pins <project_instructions> against the installed PI prompt builder", async () => {
    // The one blind spot of the narrowing (see authoredInstructionText's docstring): a PI release
    // that renames this tag while keeping any assembled-prompt marker would make D-01/02/03/07 go
    // quiet instead of loud. This assertion turns that upgrade into a red test at the moment the
    // dependency moves, rather than a silent loss of the check.
    const piCore = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core");
    // Not installed (a clone that never ran `npm install`) — nothing to pin against, skip cleanly.
    const readOptional = async (file: string): Promise<string | undefined> =>
      readFile(join(piCore, file), "utf8").catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      });

    const builder = await readOptional("system-prompt.js");
    if (builder === undefined) return;
    assert.match(builder, /<project_instructions path="/, "PI still wraps each context file in this tag");
    assert.match(builder, /<project_context>/, "PI still wraps the context files as a whole");

    // `<available_skills>` is emitted by skills.js's formatSkillsForPrompt, which system-prompt.js
    // calls — it is one of ASSEMBLED_PROMPT_MARKERS, so pin it where it actually lives.
    const skills = await readOptional("skills.js");
    if (skills === undefined) return;
    assert.match(skills, /"<available_skills>"/, "PI still renders the live skill registry into the prompt");
  });
});

// REMOVED: describe("extractReferences — the real ported instruction text").
//
// It read `AGENTS.md` + `PRIVATE.md` together and pinned the extractor against the exact skill,
// agent and server names in the author's own instruction text. `PRIVATE.md` is the git-ignored
// personal overlay — it is deliberately not part of this repository, so the assertion could only
// ever run on one machine, and the names it pinned were that machine's. The tracked `AGENTS.md`
// alone extracts to `{tools: [], skills: [], agents: [], servers: []}` (measured), so retargeting
// it would have left an assertion that four empty arrays are empty.
//
// Nothing is lost: every extraction rule it exercised is covered by the synthetic fixtures above,
// each naming the pattern it is there for. If you want the check back for YOUR instruction text,
// run `pi-doctor` — that is the tool this module exists to serve.

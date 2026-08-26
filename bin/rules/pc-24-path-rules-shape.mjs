/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { parseFrontmatter } from "../lib/frontmatter.mjs";

// The offline, plain-JS restatement of the checks `extensions/path-rules/config.ts`'s
// `parseRuleFile()`/`compileFrontmatter()` and `extensions/path-rules/glob.ts`'s `compileGlob()`
// already enforce at runtime — duplicated deliberately, the same way PC-20 duplicates
// path-defaults' validator, because pi-check has zero dependencies, this repo's own TypeScript
// included.
//
// Scope, deliberately narrow: `test/path-rules/fixtures/*.md` ONLY. Your real rule files live at
// `~/.pi/agent/rules` (or `$PI_CONFIG_RULES_DIR`) — deliberately OUTSIDE this repo, so the one
// directory can be symlinked into another harness too — and pi-check never reads outside the
// scanned repo tree (`bin/lib/context.mjs`'s own header: no read of `~/.pi/agent`). The fixtures
// directory is the one place a rule-shaped file legitimately lives in-repo; an absent or empty
// directory is a normal, unconfigured state (PC-20's posture towards a missing config file), not
// a finding — this rule is a regression guard on the committed fixture(s), not a validator of a
// live configuration it cannot see.

export const id = "PC-24";
export const title = "test/path-rules/fixtures/*.md rule files have valid path-rules frontmatter";
export const closes = [];

const FIXTURES_DIR = "test/path-rules/fixtures";

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const files = ctx.listFiles({ dir: FIXTURES_DIR, exts: [".md"] });
  if (files.length === 0) return [];

  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    const text = ctx.readText(file);
    if (text === null) continue;
    findings.push(...checkOne(file, text));
  }
  return findings;
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Finding[]}
 */
function checkOne(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  const fail = (message, line) => findings.push({ rule: id, file, message, ...(line ? { line } : {}) });

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const openedFrontmatter = lines[0]?.trim() === "---";
  const fm = parseFrontmatter(normalized);

  if (openedFrontmatter && !fm.ok) {
    fail('unterminated frontmatter block (opened with "---" but never closed)', 1);
    return findings; // the body cannot be reliably extracted either — nothing further to check
  }

  const body = fm.ok ? lines.slice(fm.endLine).join("\n").trim() : normalized.trim();
  if (body.length === 0) {
    fail("rule body is empty — a rule must have injectable content");
  }
  if (!fm.ok) return findings; // no frontmatter at all: an unconditional rule, valid as-is

  const pathsPresent = fm.entries.has("paths");
  if (!pathsPresent) return findings; // "paths" absent: unconditional, valid

  const closeIdx0 = fm.endLine - 1; // 0-indexed line of the closing "---"
  const list = readListItems(lines, "paths", 1, closeIdx0);
  if (list === null || list.items.length === 0) {
    fail('"paths" must be a non-empty list of glob strings', list?.keyLine ?? fm.entries.get("paths").line);
    return findings;
  }
  for (const item of list.items) {
    const err = checkGlobSyntax(item.value);
    if (err) fail(`"paths": ${err}`, item.line);
  }
  return findings;
}

/**
 * Reads a `key:`'s list value out of a frontmatter block, either block style
 * (`key:` followed by indented `- item` lines) or flow style (`key: [a, b]`) — the two shapes the
 * `yaml` package (used by the real, non-duplicated validator) accepts for a list. Not a YAML
 * parser: quoting and escaping beyond a single matching pair of `"`/`'` are not handled, the same
 * deliberate trade `bin/lib/frontmatter.mjs` itself documents.
 *
 * @param {string[]} lines full file, split on "\n"
 * @param {string} key
 * @param {number} startIdx0 first frontmatter body line, 0-indexed, inclusive
 * @param {number} endIdx0 the closing "---" line, 0-indexed, exclusive
 * @returns {{ keyLine: number, items: { value: string, line: number }[] } | null} null if `key:` is not found
 */
function readListItems(lines, key, startIdx0, endIdx0) {
  const keyRe = new RegExp(`^${key}:\\s?(.*)$`);
  let keyIdx = -1;
  let inlineValue = "";
  for (let i = startIdx0; i < endIdx0; i++) {
    if (/^\s/.test(lines[i])) continue; // indented continuation line, not a top-level key
    const m = keyRe.exec(lines[i]);
    if (m) {
      keyIdx = i;
      inlineValue = m[1].trim();
      break;
    }
  }
  if (keyIdx === -1) return null;
  const keyLine = keyIdx + 1;

  if (inlineValue.length > 0) {
    if (!inlineValue.startsWith("[") || !inlineValue.endsWith("]")) return { keyLine, items: [] };
    const inner = inlineValue.slice(1, -1).trim();
    if (inner.length === 0) return { keyLine, items: [] };
    const items = splitFlowList(inner).map((raw) => ({ value: unquote(raw.trim()), line: keyLine }));
    return { keyLine, items };
  }

  const items = [];
  for (let i = keyIdx + 1; i < endIdx0; i++) {
    const m = /^\s*-\s+(.+)$/.exec(lines[i]);
    if (!m) break; // first non-list line ends the block
    items.push({ value: unquote(m[1].trim()), line: i + 1 });
  }
  return { keyLine, items };
}

/** @param {string} inner @returns {string[]} */
function splitFlowList(inner) {
  return inner.split(",").filter((s) => s.trim().length > 0);
}

/** @param {string} value @returns {string} */
function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.length >= 2 ? value.slice(1, -1) : value;
  }
  return value;
}

/**
 * Mirrors `extensions/path-rules/glob.ts`'s `expandBraces` + `segmentToRegexSource` support
 * exactly: `**`, `*`, `?`, `{a,b,c}` (one level), plain identifier characters, `.` and `-`.
 * Anything else is the same "unsupported glob pattern" failure the runtime matcher throws.
 *
 * @param {string} pattern
 * @returns {string | null} an error message, or null if the pattern is supported
 */
function checkGlobSyntax(pattern) {
  let variants;
  try {
    variants = expandBraces(pattern);
  } catch (err) {
    return err.message;
  }
  const SEGMENT_LITERAL = /[A-Za-z0-9_]/;
  for (const variant of variants) {
    for (const segment of variant.split("/")) {
      if (segment === "**") continue;
      for (const ch of segment) {
        if (ch === "*" || ch === "?" || ch === "." || ch === "-" || SEGMENT_LITERAL.test(ch)) continue;
        return `unsupported glob pattern "${pattern}": unsupported character "${ch}" in pattern`;
      }
    }
  }
  return null;
}

/** @param {string} pattern @returns {string[]} */
function expandBraces(pattern) {
  const openIdx = pattern.indexOf("{");
  if (openIdx === -1) return [pattern];

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < pattern.length; i++) {
    if (pattern[i] === "{") {
      depth++;
      if (depth > 1) throw new Error(`unsupported glob pattern "${pattern}": nested { } groups are not supported`);
    } else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) throw new Error(`unsupported glob pattern "${pattern}": unmatched "{" with no closing "}"`);

  const prefix = pattern.slice(0, openIdx);
  const body = pattern.slice(openIdx + 1, closeIdx);
  const suffix = pattern.slice(closeIdx + 1);
  const alternatives = body.split(",");
  if (alternatives.length < 2) {
    throw new Error(
      `unsupported glob pattern "${pattern}": "{${body}}" has no comma — a brace group needs at least two alternatives to expand`,
    );
  }

  const out = [];
  for (const alt of alternatives) {
    for (const rest of expandBraces(prefix + alt + suffix)) out.push(rest);
  }
  return out;
}

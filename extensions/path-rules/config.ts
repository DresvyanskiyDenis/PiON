/**
 * `rules/*.md` — one file per path-scoped rule, deliberately in Claude Code's own authoring
 * format rather than this repo's usual one-JSON-per-feature convention. That deviation is the
 * point: `paths:` YAML frontmatter over a Markdown body is what lets an operator symlink the same
 * `rules/` directory into both harnesses (symlink your existing rules directory to
 * `~/.pi/agent/rules`) instead of maintaining the same rule text twice. See `extensions/skill-mask.ts`'s header comment for the
 * precedent of documenting a deliberate format deviation this bluntly.
 *
 * Frontmatter semantics:
 *   - no `paths:` key (or no frontmatter block at all) -> unconditional, always injected.
 *   - `paths:` present -> a list of globs (`./glob.ts`); the rule activates when the project has
 *     at least one file matching any of them. Pure concatenation across matched rules — no
 *     precedence engine, no "most specific wins". Order is filename order.
 *
 * Failure isolation is per FILE, not per directory: one rule file with a bad `---` block, invalid
 * YAML, or an unsupported glob pattern is dropped with a loud warning (`loadRules`'s `warnings`);
 * every other file in the directory still loads. This is `extensions/hooks/schema.ts`'s
 * "a colleague's typo in one rule must not disable every other rule" reasoning, applied at the
 * file granularity that fits this format (one rule = one file here, unlike hooks.yaml's many
 * rules per file).
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { compileGlob, type PathMatcher, UnsupportedGlobError } from "./glob.ts";

/** No TypeScript parameter properties — see `extensions/path-defaults/config.ts`'s own note:
 *  Node's `--test` runs `.ts` through type-stripping only, and `constructor(readonly x: T)` is a
 *  real syntax transform, not an erasure; it throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on Node
 *  22.22.3. `tsc --noEmit` alone would not catch this. */
export class PathRuleShapeError extends Error {
  readonly source: string;

  constructor(message: string, source: string, options?: { cause?: unknown }) {
    super(`${source}: ${message}`, options);
    this.name = "PathRuleShapeError";
    this.source = source;
  }
}

export interface PathRule {
  /** The filename without its `.md` extension. */
  readonly id: string;
  /** Absolute path to the source file, for diagnostics. */
  readonly source: string;
  /** The Markdown body, trimmed — what gets injected verbatim when this rule is active. */
  readonly body: string;
  /** `null` means unconditional. Otherwise at least one compiled matcher. */
  readonly matchers: readonly PathMatcher[] | null;
}

const FRONTMATTER_DELIM = "---";

/**
 * Splits `text` into a frontmatter document (if any) and a body. Pure — no disk, no glob
 * compilation — so it is unit-testable on its own and mirrors `validatePathDefaults`'s split
 * between "parse the shape" and "load the file" in `path-defaults/config.ts`.
 *
 * @throws PathRuleShapeError if a frontmatter block is opened but never closed.
 */
export function splitFrontmatter(text: string, source: string): { readonly frontmatter: unknown; readonly body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_DELIM}\n`)) {
    return { frontmatter: undefined, body: normalized.trim() };
  }
  const closeIdx = normalized.indexOf(`\n${FRONTMATTER_DELIM}`, FRONTMATTER_DELIM.length + 1);
  if (closeIdx === -1) {
    throw new PathRuleShapeError(`unterminated frontmatter block (no closing "${FRONTMATTER_DELIM}" line)`, source);
  }
  const raw = normalized.slice(FRONTMATTER_DELIM.length + 1, closeIdx);
  const body = normalized.slice(closeIdx + 1 + FRONTMATTER_DELIM.length).trim();
  let frontmatter: unknown;
  try {
    frontmatter = raw.trim().length === 0 ? undefined : parseYaml(raw);
  } catch (err) {
    throw new PathRuleShapeError(`frontmatter is not valid YAML: ${(err as Error).message}`, source, { cause: err });
  }
  return { frontmatter, body };
}

/**
 * Validates a parsed frontmatter document and compiles its `paths:` list, if any.
 *
 * @throws PathRuleShapeError on a malformed shape, or `UnsupportedGlobError` (wrapped as
 *   `PathRuleShapeError`, naming the offending pattern and the source file) on a `paths:` entry
 *   this matcher does not support.
 */
export function compileFrontmatter(frontmatter: unknown, source: string): readonly PathMatcher[] | null {
  if (frontmatter === undefined || frontmatter === null) return null;
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new PathRuleShapeError("frontmatter must be a YAML mapping", source);
  }
  const obj = frontmatter as Record<string, unknown>;
  if (!("paths" in obj)) return null;
  if (!Array.isArray(obj.paths) || obj.paths.length === 0) {
    throw new PathRuleShapeError('"paths" must be a non-empty list of glob strings', source);
  }
  return obj.paths.map((raw, i) => {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new PathRuleShapeError(`"paths[${i}]" must be a non-empty string, got ${JSON.stringify(raw)}`, source);
    }
    try {
      return compileGlob(raw);
    } catch (err) {
      if (err instanceof UnsupportedGlobError) {
        throw new PathRuleShapeError(`"paths[${i}]": ${err.message}`, source, { cause: err });
      }
      throw err;
    }
  });
}

/** Parses one rule file's text into a `PathRule`. Pure — the file I/O lives in `loadRules`. */
export function parseRuleFile(text: string, source: string): PathRule {
  const { frontmatter, body } = splitFrontmatter(text, source);
  if (body.length === 0) {
    throw new PathRuleShapeError("rule body is empty — a rule must have injectable content", source);
  }
  const matchers = compileFrontmatter(frontmatter, source);
  return { id: basename(source, ".md"), source, body, matchers };
}

export interface LoadRulesResult {
  readonly rules: readonly PathRule[];
  /** One human-readable line per file that failed to load and was dropped. Never thrown. */
  readonly warnings: readonly string[];
}

/**
 * Loads every `*.md` file directly under `dir`, in filename order.
 *
 * A missing `dir` is a normal, unconfigured install — same posture as `path-defaults`'s ENOENT
 * handling — and returns `{ rules: [], warnings: [] }`, not an error. A file that fails to parse
 * or validate is dropped with a warning; the directory load itself never throws.
 */
export function loadRules(dir: string): LoadRulesResult {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], warnings: [] };
    return { rules: [], warnings: [`${dir}: could not list rule files: ${(err as Error).message}`] };
  }

  const rules: PathRule[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const source = join(dir, name);
    try {
      const text = readFileSync(source, "utf8");
      rules.push(parseRuleFile(text, source));
    } catch (err) {
      warnings.push(`${source}: dropped — ${(err as Error).message}`);
    }
  }
  return { rules, warnings };
}

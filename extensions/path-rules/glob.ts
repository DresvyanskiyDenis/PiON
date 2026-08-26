/**
 * Hand-rolled glob matching for `rules/*.md` frontmatter `paths:` lists.
 *
 * No dependency: `minimatch`/`glob` are not reachable from this tree (recon confirmed neither is
 * hoisted to top-level `node_modules`), and pulling one in for four bullet-point glob operators is
 * not proportionate. Supported syntax, deliberately no more: `**` (globstar — zero or more path
 * segments), `*` (single-segment wildcard), `?` (single character), `{a,b,c}` (brace expansion,
 * one level, no nesting). Anything else — character classes (`[...]`), extglob (`!(...)`,
 * `+(...)`), negation, nested braces — throws `UnsupportedGlobError` at compile time, naming the
 * offending pattern. A pattern that silently failed to match would be worse than one that refuses
 * to load: the operator would never notice their rule stopped firing.
 *
 * Brace expansion happens once here, at compile time, into a flat list of literal-ish patterns —
 * confirmed against real Claude Code session transcripts to be the same internal shape that
 * harness uses (`paths:` -> an engine-derived, brace-expanded `globs:` list).
 * `PathMatcher.expanded` exposes that flat list for diagnostics; `paths:` is the only authored
 * field — no `globs:` compatibility alias, the two names have never both meant something here.
 */

export class UnsupportedGlobError extends Error {
  readonly pattern: string;

  constructor(pattern: string, reason: string) {
    super(`unsupported glob pattern "${pattern}": ${reason}`);
    this.name = "UnsupportedGlobError";
    this.pattern = pattern;
  }
}

export interface PathMatcher {
  /** The pattern as authored, before brace expansion — for diagnostics and error messages. */
  readonly source: string;
  /** The brace-expanded flat pattern list actually compiled into regexes. */
  readonly expanded: readonly string[];
  /** Tests a `/`-separated path, relative to the project root. */
  test(relativePath: string): boolean;
}

/** True if any matcher in the list matches `relativePath`. */
export function matchesAny(matchers: readonly PathMatcher[], relativePath: string): boolean {
  return matchers.some((m) => m.test(relativePath));
}

/**
 * Compiles one authored glob string into a `PathMatcher`.
 *
 * @throws UnsupportedGlobError naming `pattern` when it uses syntax this matcher does not support.
 */
export function compileGlob(pattern: string): PathMatcher {
  const expanded = expandBraces(pattern);
  const regexes = expanded.map((variant) => new RegExp(buildRegexSource(variant, pattern)));
  return {
    source: pattern,
    expanded,
    test(relativePath: string): boolean {
      const normalized = relativePath.split("\\").join("/").replace(/^\.\//, "");
      return regexes.some((re) => re.test(normalized));
    },
  };
}

/**
 * Expands `{a,b,c}` groups into every combination, left to right. One level only: a `{` found
 * while already inside an open group throws rather than silently treating the inner braces as
 * literal text. A group with fewer than two comma-separated alternatives throws too — `{foo}`
 * with no comma is not brace expansion in any shell this matcher is trying to agree with, and
 * shipping it as a silent no-op would be exactly the "quietly stopped matching" failure this
 * module exists to prevent.
 */
export function expandBraces(pattern: string): string[] {
  const openIdx = pattern.indexOf("{");
  if (openIdx === -1) return [pattern];

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < pattern.length; i++) {
    if (pattern[i] === "{") {
      depth++;
      if (depth > 1) throw new UnsupportedGlobError(pattern, "nested { } groups are not supported");
    } else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    throw new UnsupportedGlobError(pattern, 'unmatched "{" with no closing "}"');
  }

  const prefix = pattern.slice(0, openIdx);
  const body = pattern.slice(openIdx + 1, closeIdx);
  const suffix = pattern.slice(closeIdx + 1);
  const alternatives = body.split(",");
  if (alternatives.length < 2) {
    throw new UnsupportedGlobError(
      pattern,
      `"{${body}}" has no comma — a brace group needs at least two alternatives to expand`,
    );
  }

  const out: string[] = [];
  for (const alt of alternatives) {
    // Recurse on the rebuilt string, not on `suffix` alone: `prefix + alt` cannot contain a `{`
    // (prefix is brace-free by construction, alt was checked above), so the next call finds
    // exactly the next group, if any — this is what makes multiple non-nested groups in one
    // pattern (e.g. "{a,b}/*.{c,d}") expand correctly via a single recursive walk.
    for (const rest of expandBraces(prefix + alt + suffix)) out.push(rest);
  }
  return out;
}

/** Characters a segment (a single `/`-delimited piece, brace-free) is allowed to contain. */
const SEGMENT_LITERAL = /[A-Za-z0-9_]/;

/**
 * Builds a full, anchored regex source for one brace-expanded pattern variant.
 *
 * A globstar segment is handled via a placeholder token, substituted back to the correct
 * zero-or-more-directories regex once the segments are joined — doing this on the joined string
 * rather than per-segment is what lets a leading globstar match zero directories (so a globstar
 * segment followed by "foo" matches plain "foo" at the root) as well as many ("a/b/foo"), and lets
 * a bare globstar pattern match everything.
 */
function buildRegexSource(variant: string, originalPattern: string): string {
  const GLOBSTAR = "\u0000GLOBSTAR\u0000";
  const segments = variant.split("/").map((seg) => (seg === "**" ? GLOBSTAR : segmentToRegexSource(seg, originalPattern)));
  let joined = segments.join("/");
  joined = joined.replace(new RegExp(`/${GLOBSTAR}/`, "g"), "/(?:.*/)?");
  joined = joined.replace(new RegExp(`^${GLOBSTAR}/`), "(?:.*/)?");
  joined = joined.replace(new RegExp(`/${GLOBSTAR}$`), "(?:/.*)?");
  joined = joined.replace(new RegExp(`^${GLOBSTAR}$`), ".*");
  return `^${joined}$`;
}

/** Converts one non-"**" path segment into a regex source fragment, throwing on anything unsupported. */
function segmentToRegexSource(segment: string, originalPattern: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === ".") {
      out += "\\.";
    } else if (ch === "-") {
      out += "\\-";
    } else if (SEGMENT_LITERAL.test(ch)) {
      out += ch;
    } else {
      throw new UnsupportedGlobError(originalPattern, `unsupported character "${ch}" in pattern`);
    }
  }
  return out;
}

/**
 * The tokeniser — `REQ-PRV-39`.
 *
 * Thirty OpenCode deny patterns collapse to ~8 intents only because matching happens on **words
 * in pipeline segments**, not on prefix globs. `Bash(sudo *)` never matched
 * `env X=1 sudo rm -rf /`; a tokeniser does.
 *
 * This is NOT a shell. It never expands variables or globs and never executes anything. Anything
 * it cannot parse confidently is marked `opaque`, and gates treat opaque segments as MORE
 * suspicious, never less.
 */

export type SegmentOp = "|" | "&&" | "||" | ";" | "&" | "\n" | null;

export interface Segment {
  /** Words after quote removal, env-assignment stripping and wrapper unwrapping. */
  readonly argv: readonly string[];
  /**
   * Every word of the segment BEFORE env-assignment stripping and wrapper peeling.
   * `collectTargets()` needs these: `sudo cat ~/.ssh/id_rsa` must still surrender the path.
   * (Addition to the spec's `Segment`; nothing in the spec could reach the pre-peel words.)
   */
  readonly words: readonly string[];
  /** Verbatim text of this segment, for regex gates that need the raw form. */
  readonly raw: string;
  /** The operator that TERMINATED this segment. */
  readonly op: SegmentOp;
  /** Redirection targets found in this segment, e.g. ["/dev/sda"] for `> /dev/sda`. */
  readonly redirects: readonly string[];
  /** Wrappers peeled off the front, in order, e.g. ["env", "sudo", "xargs"]. */
  readonly wrappers: readonly string[];
  /** True when the segment contains $( ), ` `, a subshell or a bare `eval`. */
  readonly opaque: boolean;
}

/**
 * Wrapper peeling is what makes `sudo rm -rf /` and `xargs rm -rf` reach the same rule as
 * `rm -rf /`, and `wrappers.includes("sudo")` is itself a signal a gate can use.
 */
export const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "xargs",
  "timeout",
]);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `timeout 5s` / `nice 10` carry one non-flag argument of their own before the real program. */
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/** Splits a command line into pipeline segments and words. */
export function tokenize(command: string): Segment[] {
  const src = command;
  const segments: Segment[] = [];

  let i = 0;
  let segStart = 0;
  let word = "";
  let hasWord = false;
  let words: string[] = [];
  let redirects: string[] = [];
  let opaque = false;
  let pendingRedirect = false;

  const pushWord = (): void => {
    if (!hasWord) return;
    if (pendingRedirect) {
      redirects.push(word);
      pendingRedirect = false;
    } else {
      words.push(word);
    }
    word = "";
    hasWord = false;
  };

  const endSegment = (op: SegmentOp, endIdx: number): void => {
    pushWord();
    if (words.length > 0 || redirects.length > 0) {
      segments.push(makeSegment(words, src.slice(segStart, endIdx), op, redirects, opaque));
    }
    words = [];
    redirects = [];
    opaque = false;
    pendingRedirect = false;
  };

  while (i < src.length) {
    const c = src[i]!;

    if (c === "\\") {
      const next = src[i + 1];
      if (next === undefined) {
        word += "\\";
        hasWord = true;
        i += 1;
        continue;
      }
      if (next === "\n") {
        i += 2; // line continuation
        continue;
      }
      word += next;
      hasWord = true;
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        word += src.slice(i + 1);
        hasWord = true;
        i = src.length;
        continue;
      }
      word += src.slice(i + 1, end);
      hasWord = true;
      i = end + 1;
      continue;
    }

    if (c === '"') {
      i += 1;
      let buf = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          buf += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "(") {
          opaque = true;
          const j = skipBalanced(src, i + 1, "(", ")");
          buf += src.slice(i, j);
          i = j;
          continue;
        }
        if (src[i] === "`") {
          opaque = true;
          const j = skipBacktick(src, i);
          buf += src.slice(i, j);
          i = j;
          continue;
        }
        buf += src[i];
        i += 1;
      }
      i += 1; // closing quote, or past the end when unterminated
      word += buf;
      hasWord = true;
      continue;
    }

    if (c === "`") {
      opaque = true;
      const j = skipBacktick(src, i);
      word += src.slice(i, j);
      hasWord = true;
      i = j;
      continue;
    }

    if (c === "$" && src[i + 1] === "(") {
      opaque = true;
      const j = skipBalanced(src, i + 1, "(", ")");
      word += src.slice(i, j);
      hasWord = true;
      i = j;
      continue;
    }

    // Process substitution: <( … ) / >( … ). Checked before the redirect branch.
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      opaque = true;
      const j = skipBalanced(src, i + 1, "(", ")");
      word += src.slice(i, j);
      hasWord = true;
      i = j;
      continue;
    }

    // A `#` only opens a comment at the start of a word — `foo#bar` is one word.
    if (c === "#" && !hasWord) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i += 1;
      continue;
    }

    if (c === "\n") {
      endSegment("\n", i);
      i += 1;
      segStart = i;
      continue;
    }

    // Redirections. `&>` is a redirect, not the background operator, so it is tested first.
    if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      if (hasWord && /^\d+$/.test(word)) {
        // A bare file descriptor (`2>`), not an argument.
        word = "";
        hasWord = false;
      } else {
        pushWord();
      }
      if (c === "&") i += 1;
      i += 1;
      while (src[i] === ">" || src[i] === "<" || src[i] === "&" || src[i] === "|") i += 1;
      pendingRedirect = true;
      continue;
    }

    if (c === "|" && src[i + 1] === "|") {
      endSegment("||", i);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === "&" && src[i + 1] === "&") {
      endSegment("&&", i);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === "|") {
      endSegment("|", i);
      i += 1;
      segStart = i;
      continue;
    }
    if (c === ";") {
      endSegment(";", i);
      i += 1;
      segStart = i;
      continue;
    }
    if (c === "&") {
      endSegment("&", i);
      i += 1;
      segStart = i;
      continue;
    }

    // A subshell hides its contents from word-level matching.
    if (c === "(" || c === ")") {
      pushWord();
      opaque = true;
      i += 1;
      continue;
    }
    // Group braces separate words; `${HOME}` does not, because the `$` already started a word.
    if ((c === "{" || c === "}") && !hasWord) {
      i += 1;
      continue;
    }

    word += c;
    hasWord = true;
    i += 1;
  }

  endSegment(null, src.length);
  return segments;
}

/** The effective program of a segment after peeling env-assignments and wrappers. */
export function program(seg: Segment): string | undefined {
  const first = seg.argv[0];
  if (first === undefined || first.length === 0) return undefined;
  return basename(first);
}

/** Every effective program in a command line, in order. Opaque segments contribute nothing. */
export function programs(command: string): string[] {
  const out: string[] = [];
  for (const seg of tokenize(command)) {
    const p = program(seg);
    if (p !== undefined) out.push(p);
  }
  return out;
}

function makeSegment(
  words: readonly string[],
  raw: string,
  op: SegmentOp,
  redirects: readonly string[],
  opaque: boolean,
): Segment {
  const { argv, wrappers } = peel(words);
  return {
    argv,
    words: [...words],
    raw,
    op,
    redirects: [...redirects],
    wrappers,
    // `eval` re-parses its argument at runtime, so nothing after it can be trusted statically.
    opaque: opaque || basename(argv[0] ?? "") === "eval",
  };
}

function peel(words: readonly string[]): { argv: string[]; wrappers: string[] } {
  const wrappers: string[] = [];
  let i = 0;

  for (;;) {
    while (i < words.length && ENV_ASSIGN.test(words[i]!)) i += 1;
    const current = words[i];
    if (current === undefined) break;
    const name = basename(current);
    if (!WRAPPERS.has(name)) break;

    wrappers.push(name);
    i += 1;
    while (i < words.length && words[i]!.startsWith("-") && words[i] !== "--") i += 1;
    if (words[i] === "--") i += 1;
    if ((name === "timeout" || name === "nice") && i < words.length && DURATION.test(words[i]!)) {
      i += 1;
    }
  }

  return { argv: words.slice(i), wrappers };
}

function basename(word: string): string {
  const idx = word.lastIndexOf("/");
  return idx === -1 ? word : word.slice(idx + 1);
}

function skipBalanced(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

function skipBacktick(src: string, startIdx: number): number {
  let i = startIdx + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") return i + 1;
    i += 1;
  }
  return src.length;
}

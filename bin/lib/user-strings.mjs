// bin/lib/user-strings.mjs — finds the string literals this repo actually shows a person,
// and reports which call each one was handed to.
//
// WHY A SCANNER AND NOT A GREP
//
// `grep -rn '—' extensions/ --include='*.ts'` returns 1351 hits in this tree. Twenty-three of
// them are output. The rest are docstrings, and this repo writes long ones on purpose. Any
// house-style rule built on the grep number would fire on commits that added an explanation,
// which is precisely the behaviour it should be encouraging.
//
// So this module separates the two properly. It walks the source one character at a time,
// tracking whether it is inside a line comment, a block comment, a single- or double-quoted
// string, a template literal (including nested `${}` expressions, which may hold further
// strings), or a regular-expression literal. Each literal it emits carries the name of the
// call it was passed to and the object key it is the value of. Those are what make the result
// mean something: `ui.notify("…")` is a sentence somebody reads and `readFileSync("…")` is a
// path, and they are the same shape of token on the same shape of line.
//
// WHAT IT IS NOT
//
// It is not a TypeScript parser and must not pretend to be one. `bin/pi-check` is a
// zero-dependency offline gate — see its header — so there is no AST to consult, and adding
// one would change what that tool is. The consequences are bounded, and stating them is part
// of the contract rather than a hedge:
//
//   - The callee is the dotted identifier immediately before the innermost enclosing `(`. A
//     string reached through a variable (`const msg = "…"; ui.notify(msg)`) is attributed to
//     nothing and is invisible to a sink filter. This scanner UNDERCOUNTS user-facing prose;
//     it never overcounts it.
//   - A sink reached through an alias (`const say = ui.notify; say("…")`) is invisible for the
//     same reason.
//   - Regex detection is the usual heuristic: a `/` opens a regex unless the previous
//     significant character could have ended an expression. Correct on ordinary code,
//     defeatable by pathological input.
//
// Anything quoting a number this produces is quoting a floor.

/** Characters after which a `/` is division, not the start of a regex literal. */
const REGEX_STOPS = /[A-Za-z0-9_$)\]]/;

/** @typedef {{ callee: string, argIndex: number, groupDepth: number }} CallFrame */

/**
 * @typedef {object} UserString
 * @property {number} line       1-based line of the opening quote
 * @property {number} column     1-based column of the opening quote
 * @property {"'" | "\"" | "`"} quote  the delimiter this literal was written with
 * @property {string} value      the literal's source text, delimiters stripped, escapes NOT resolved
 * @property {string} callee     dotted name of the enclosing call, or "" when there is none
 * @property {string} key        object key this literal is the value of, or "" when it is not one
 * @property {number} argIndex   0-based argument position within that call, or -1 with no call
 */

/**
 * Scan one TypeScript/JavaScript source file for string literals.
 *
 * @param {string} source
 * @returns {UserString[]} every string literal in the file, comments and regexes excluded
 */
export function scanStrings(source) {
  /** @type {UserString[]} */
  const out = [];
  /** @type {CallFrame[]} */
  const calls = [];
  /** Brace/bracket depths opened since the innermost call frame, so `,` inside an object
   *  literal or an array does not advance that call's argument index. */
  const groups = [];

  let i = 0;
  let line = 1;
  let lineStart = 0;
  let lastSignificant = "";

  const n = source.length;

  /** @param {number} at */
  function columnAt(at) {
    return at - lineStart + 1;
  }

  /**
   * If this literal is the value of an object property (`message: "…"`, `"title": "…"`),
   * return that key's name. Prose reaches a user through a property at least as often as
   * through a call argument in this repo — every `pi-check` finding is a `{ message }`, every
   * registered tool and command carries a `description` — and a scanner that only looked at
   * call arguments would report those surfaces as clean because they are clean of *calls*.
   *
   * @param {number} at index of the literal's opening delimiter
   */
  function keyBefore(at) {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j])) j--;
    if (source[j] !== ":") return "";
    j--;
    while (j >= 0 && /\s/.test(source[j])) j--;
    if (source[j] === '"' || source[j] === "'") {
      const close = source[j];
      let k = j - 1;
      while (k >= 0 && source[k] !== close) k--;
      return source.slice(k + 1, j);
    }
    const end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j])) j--;
    return source.slice(j + 1, end);
  }

  /** Read backwards from `at` over whitespace, then collect a dotted identifier. */
  function calleeBefore(at) {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j])) j--;
    let end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_$.]/.test(source[j])) j--;
    return source.slice(j + 1, end);
  }

  /**
   * Consume a string or template literal. `i` points at the opening delimiter, or — when
   * resuming a template after a `${…}` expression closed — at the first character of the
   * template's continuing text.
   *
   * @param {"'" | "\"" | "`"} quote
   * @param {boolean} resuming true when picking a template back up after an interpolation
   */
  function readStringLiteral(quote, resuming) {
    const startLine = line;
    const startColumn = columnAt(i);
    const key = resuming ? "" : keyBefore(i);
    const valueStart = resuming ? i : i + 1;
    if (!resuming) i++;
    while (i < n) {
      const ch = source[i];
      if (ch === "\\") {
        if (source[i + 1] === "\n") {
          line++;
          lineStart = i + 2;
        }
        i += 2;
        continue;
      }
      if (ch === "\n") {
        line++;
        lineStart = i + 1;
        // A single- or double-quoted literal cannot span a raw newline. Unterminated input
        // is malformed source, not something this scanner should guess at, so stop the
        // literal here rather than swallowing the rest of the file.
        if (quote !== "`") {
          i++;
          break;
        }
        i++;
        continue;
      }
      if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        // Interpolation: the literal continues after a balanced `}`, and the expression
        // inside may hold further strings, comments and calls. Recording the piece we have
        // and re-entering the main loop is simpler and more honest than a sub-parser.
        break;
      }
      if (ch === quote) {
        i++;
        break;
      }
      i++;
    }
    const isInterpolation = source[i] === "$" && source[i + 1] === "{";
    const valueEnd = isInterpolation ? i : i - 1;
    const frame = calls[calls.length - 1];
    out.push({
      line: startLine,
      column: startColumn,
      quote,
      value: source.slice(valueStart, Math.max(valueStart, valueEnd)),
      callee: frame ? frame.callee : "",
      key,
      argIndex: frame ? frame.argIndex : -1,
    });
    if (isInterpolation) {
      // Step over `${` and let the main loop handle the expression. The matching `}` is
      // recognised by the marker pushed here, and resumes this template's text where it
      // left off — see the `closed === "`"` branch below.
      groups.push("`");
      i += 2;
    }
  }

  while (i < n) {
    const ch = source[i];

    if (ch === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      i += 2;
      continue;
    }

    if (ch === "/" && !REGEX_STOPS.test(lastSignificant)) {
      // Regex literal. Skip it whole, including character classes, where `/` is literal.
      i++;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") break; // unterminated — malformed source, stop guessing
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      lastSignificant = "/";
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      readStringLiteral(/** @type {UserString["quote"]} */ (ch), false);
      lastSignificant = "'";
      continue;
    }

    if (ch === "(") {
      calls.push({ callee: calleeBefore(i), argIndex: 0, groupDepth: groups.length });
      i++;
      lastSignificant = "(";
      continue;
    }

    if (ch === ")") {
      calls.pop();
      i++;
      lastSignificant = ")";
      continue;
    }

    if (ch === "{" || ch === "[") {
      groups.push(ch);
      i++;
      lastSignificant = ch;
      continue;
    }

    if (ch === "}" || ch === "]") {
      const closed = groups.pop();
      i++;
      lastSignificant = ch;
      // A `}` that closes a `${` hands control back to the template it interrupted: what
      // follows is literal text, not code, and reading it as code would mistake the template's
      // own closing backtick for the start of a fresh literal.
      if (closed === "`") {
        readStringLiteral("`", true);
        lastSignificant = "'";
      }
      continue;
    }

    if (ch === ",") {
      const frame = calls[calls.length - 1];
      if (frame && groups.length === frame.groupDepth) frame.argIndex++;
      i++;
      lastSignificant = ",";
      continue;
    }

    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }

  return out;
}

/**
 * Does this literal reach a human — either as an argument to an output call, or as the value
 * of a property whose name means prose?
 *
 * Matching is on the FINAL segment of the dotted name, because the same sink is reached as
 * `ui.notify`, `ctx.ui.notify` and `pi.ui.notify` in this repo and all three are the same
 * surface. `Error` and its subclasses count: under this repo's fail-loud rule an abort
 * message is not diagnostic exhaust, it is the last thing the operator is told, and it is
 * held to the same standard as anything printed in calmer circumstances.
 *
 * @param {UserString} record
 * @param {string[]} sinks final-segment callee names to accept
 * @param {string[]} proseKeys object-key names whose values are prose
 */
export function isUserFacing(record, sinks, proseKeys) {
  if (record.key && proseKeys.includes(record.key)) return true;
  if (!record.callee) return false;
  const segments = record.callee.split(".");
  return sinks.includes(segments[segments.length - 1]);
}

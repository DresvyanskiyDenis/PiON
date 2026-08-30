// bin/lib/structural-gates.mjs — the four structural detectors behind `bin/pi-gate`, as PURE
// functions over plain data.
//
// Nothing in this file reads a file, spawns `git`, or looks at `process`. `bin/pi-gate` is the
// only module that gathers facts from a real tree; everything below takes those facts as
// arguments. That split is the same one `extensions/doctor/checks.ts` makes for the same reason:
// a detector that can only be exercised through a live repository is a detector nobody writes
// the negative test for, and the negative test ("silent on a normal tree") is the half that
// decides whether the gate survives its first week.
//
// WHY THIS EXISTS
//
// The audited harness had exactly one gate — format, lint, test — and it was blind to everything
// about HOW a change was arrived at. 52 of 72 commits on the branch were `fix:`; one file was
// touched in 17 separate commits; 15 near-duplicate job files differed only by a model name; and
// the suite was green at 321 tests the whole time, including while the pipeline could not be run
// end-to-end below full production cost. Green tests plus a `fix:` commit read as "done", so
// nothing ever asked whether the approach was wrong. These four detectors ask.
//
// SEVERITY, AND WHY EVERYTHING DEFAULTS TO `warn`
//
// A structural gate is a judgement about process, not a fact about correctness, and it will be
// wrong sometimes. Shipping it as blocking on day one buys one week of trust and then a
// permanent `--no-verify`. So the shipped default is `warn` for all four — visible, counted,
// exit 0 — and blocking is one explicit act: `--block` on the command line (or
// `PI_GATE_BLOCK=1`), or `"severity": "error"` written into `config/structural-gates.json` for a
// gate whose false-positive rate has been measured and found acceptable. `"off"` is also
// available per gate, because a gate that cannot be turned off gets routed around instead.
//
// The `Severity` vocabulary — `"ok" | "warn" | "error"` — and the rule that `ok` means "checked,
// nothing to do here" are taken from `extensions/doctor/types.ts` so the two reporting surfaces
// in this repo do not invent two spellings of the same idea.

/** @typedef {"ok" | "warn" | "error"} Severity */

/**
 * @typedef {Object} GateFinding
 * @property {string} gate      - the gate id that produced it, e.g. "SG-01"
 * @property {Severity} severity
 * @property {string} subject   - the offending path, file pair or job id
 * @property {string} message   - what is wrong, in one line
 * @property {string} action    - what the human does about it; never empty
 */

/**
 * @typedef {Object} Commit
 * @property {string} sha
 * @property {string} subject
 * @property {string} body
 * @property {string[]} files  - paths touched, relative to the repo root
 */

export const GATE_IDS = ["SG-01", "SG-02", "SG-03", "SG-04"];

export const GATE_TITLES = {
  "SG-01": "fix-streak: consecutive fix: commits on one file mean the approach is wrong, not the code",
  "SG-02": "parallel-module: a new file that differs from an existing one only by a variant token",
  "SG-03": "file-count budget: a wave that adds N top-level modules needs an explicit sign-off",
  "SG-04": "bounded-run: a job that cannot run on a subset makes every validation a paid one",
};

/**
 * Shipped defaults. Every value here is overridable from `config/structural-gates.json`; the
 * defaults are what an unconfigured tree is held to.
 *
 * Deliberately absent from the defaults: any model name, vendor name or project-specific token.
 * SG-02's vocabulary is DERIVED (see `buildVariantVocabulary`) from the model ids the target
 * repo's own config declares and from the variation already present in its filenames, so that
 * porting this gate to another codebase does not begin with an edit to a hardcoded list of one
 * tenant's model names.
 */
export const DEFAULT_CONFIG = {
  "SG-01": {
    severity: "warn",
    /** Report when this many consecutive `fix:` commits have landed on one file. 2 means the
     *  next fix to that file is the third, which is the one the audit says to stop. */
    streak: 2,
    /** Paths this gate never counts (globs). Generated or append-only files churn by design. */
    ignore: ["**/*.lock", "**/*.lock.json", "package-lock.json", "**/ledger.tsv"],
  },
  "SG-02": {
    severity: "warn",
    /** Extra variant tokens, merged with the derived ones. Empty by default on purpose. */
    variantTokens: [],
    /** Files whose quoted strings are mined for model-id tokens. Missing files are skipped. */
    deriveTokensFrom: [
      "config/models.json",
      "config/routing.json",
      "config/models.default.json",
      "config/routing.default.json",
      "models.json",
      "config/models.yaml",
    ],
    /** New paths this gate never inspects (globs). */
    ignore: ["**/test/**", "**/tests/**", "**/fixtures/**", "**/__snapshots__/**"],
    /** A position where this many existing files already differ is an established numbering
     *  series (`pc-01-...`, `pc-02-...`), not a variant axis: a pure-digit difference there is
     *  ordinary, and firing on it would make the gate noise in every numbered rule set. */
    numericSeriesMin: 3,
    /** How many tokens two names must SHARE before the derived-axis trigger will call them near
     *  duplicates. `bin/pi-check` and `bin/pi-gate` share exactly one token and are two different
     *  programs; `chunk_sonnet_job` and `chunk_gemma_job` share two and are one program written
     *  twice. One shared token is a prefix convention, not a duplication. The vocabulary trigger
     *  is not held to this: `pipeline_v2.py` beside `pipeline.py` names its own problem. */
    minSharedTokens: 2,
  },
  "SG-03": {
    severity: "warn",
    /** Fire at or above this many new top-level modules in one diff. */
    signoffThreshold: 4,
    /** How deep a path may be and still count as "top-level". `src/pipeline.py` is 2 segments. */
    maxDepth: 2,
    /** Extensions that count as a module. A new README is not sprawl. */
    sourceExts: [".py", ".ts", ".tsx", ".mjs", ".js", ".go", ".rs", ".java", ".rb", ".sql"],
    ignore: ["**/test/**", "**/tests/**", "**/fixtures/**"],
  },
  "SG-04": {
    severity: "warn",
    /** What counts as a declared job or pipeline. Narrow on purpose: see the doc's "what this
     *  does not catch". A glob that swept in every file would report every module as a job. */
    jobGlobs: [
      "**/*_job.py",
      "**/*_job.yml",
      "**/*_job.yaml",
      "**/*_pipeline.py",
      "jobs/**/*.py",
      "jobs/**/*.yml",
      "jobs/**/*.yaml",
      "pipelines/**/*.py",
      "pipelines/**/*.yml",
      "pipelines/**/*.yaml",
      "resources/**/*.job.yml",
    ],
    /** Names that, appearing as a parameter or a key, mean "this job can be asked for less". */
    subsetParams: [
      "limit",
      "max_pages",
      "max_records",
      "max_items",
      "max_rows",
      "n_rows",
      "sample",
      "sample_size",
      "subset",
      "page_range",
      "slice",
      "head",
      "first_n",
      "scope",
    ],
    /** An `== 701`-shaped comparison against a literal at least this large reads as a hard
     *  full-scale invariant. 500 rather than a smaller number because the dominant false
     *  positive is an HTTP status compare (`status == 200`, `== 404`), and the two cannot be
     *  told apart by value. The cost is stated in the doc: a full-scale constant BELOW 500 —
     *  a 300-page corpus — is missed. `identifierIgnore` covers the status names that survive
     *  the threshold (`== 500`, `== 503`). */
    fullScaleLiteralMin: 500,
    /** Left-hand names whose large literal is never a production magnitude. Matched against the
     *  last dotted/underscored segment, so `response.status_code` and `errno` are both covered. */
    identifierIgnore: ["status", "status_code", "code", "errno", "port", "timeout_ms", "port_number"],
    ignore: [],
  },
};

const SEVERITIES = new Set(["off", "ok", "warn", "error"]);

/**
 * Merges a parsed `config/structural-gates.json` over `DEFAULT_CONFIG`, one gate at a time.
 *
 * Throws on anything it cannot honour: an unknown gate id, an unknown severity, a string where a
 * threshold belongs. A structural gate that silently ignored a typo in its own config would
 * report "0 findings" for a gate that never ran, which is the one failure mode a gate must not
 * have.
 *
 * @param {unknown} raw parsed JSON, or `null` when the file is absent
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveGateConfig(raw) {
  /** @type {any} */
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (raw === null || raw === undefined) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("structural-gates config must be a JSON object");
  }
  const gates = /** @type {any} */ (raw).gates;
  if (gates === undefined) return out;
  if (typeof gates !== "object" || gates === null || Array.isArray(gates)) {
    throw new Error('structural-gates config: "gates" must be an object');
  }
  for (const [id, patch] of Object.entries(gates)) {
    if (!Object.prototype.hasOwnProperty.call(out, id)) {
      throw new Error(`structural-gates config: unknown gate "${id}" (known: ${GATE_IDS.join(", ")})`);
    }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error(`structural-gates config: "gates.${id}" must be an object`);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.prototype.hasOwnProperty.call(out[id], key)) {
        throw new Error(`structural-gates config: unknown key "gates.${id}.${key}"`);
      }
      if (key === "severity") {
        if (typeof value !== "string" || !SEVERITIES.has(value)) {
          throw new Error(`structural-gates config: "gates.${id}.severity" must be one of off, warn, error`);
        }
      } else if (Array.isArray(out[id][key])) {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          throw new Error(`structural-gates config: "gates.${id}.${key}" must be an array of strings`);
        }
      } else if (typeof value !== typeof out[id][key]) {
        throw new Error(`structural-gates config: "gates.${id}.${key}" must be a ${typeof out[id][key]}`);
      }
      out[id][key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// glob matching: enough of it, and no more
// ---------------------------------------------------------------------------------------------

/**
 * `**`, `*`, `?` and `{a,b}` over POSIX-separated repo-relative paths. Written here rather than
 * taken from a dependency because `bin/` has zero of those by contract (REQ-PRV-12a).
 *
 * `**` crosses `/`, `*` does not. A `**` followed by `/` also matches the empty prefix, so
 * `**` + `/x.py` matches `x.py` at the root as well as `src/x.py`.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        i += slash ? 2 : 1;
        re += slash ? "(?:.*/)?" : ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** @param {string} path @param {readonly string[]} patterns */
export function matchesAny(path, patterns) {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/** @param {string} gate @param {Severity} severity @param {string} subject @param {string} message @param {string} action @returns {GateFinding} */
function finding(gate, severity, subject, message, action) {
  return { gate, severity, subject, message, action };
}

// ---------------------------------------------------------------------------------------------
// SG-01 - fix-streak
// ---------------------------------------------------------------------------------------------

const FIX_SUBJECT = /^fix(\([^)]*\))?!?:/i;
/** Both must be present for a commit to count as "the hypothesis was stated". */
const ROOT_CAUSE_TRAILER = /^\s*root[- ]cause\s*:/im;
const ALTERNATIVE_TRAILER = /^\s*alternative\s*:/im;

/** @param {Commit} c */
function isFix(c) {
  return FIX_SUBJECT.test(c.subject.trim());
}

/** @param {Commit} c */
function statesHypothesis(c) {
  const text = `${c.subject}\n${c.body}`;
  return ROOT_CAUSE_TRAILER.test(text) && ALTERNATIVE_TRAILER.test(text);
}

/**
 * `SG-01` - for every file, how many `fix:` commits in a row have landed on it.
 *
 * "In a row" is measured over THE COMMITS THAT TOUCH THAT FILE, newest first, not over the whole
 * branch. An unrelated `chore:` commit that never touches the file does not reset its streak (it
 * says nothing about this file's trouble), but a non-`fix:` commit that DOES touch it (a `feat:`,
 * a `refactor:`) does, because that is a change of intent on the same code. This is the reading
 * that survives a branch where several files are worked at once, which is the normal case and the
 * one a raw "consecutive in history" reading gets wrong.
 *
 * A commit whose message carries both a `Root-cause:` and an `Alternative:` trailer resets the
 * streak at that commit. That is the whole escape hatch, and it is deliberately the same act the
 * gate asks for: the third fix is allowed once someone has written down why the first two did not
 * work and what else could be done instead. No flag, no env var — the answer lives in the
 * history, where the next person reading `git log` will find it.
 *
 * @param {{ commits: readonly Commit[] }} facts commits on the branch, NEWEST FIRST
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {GateFinding[]}
 */
export function detectFixStreak(facts, cfg) {
  const c = cfg["SG-01"];
  if (c.severity === "off") return [];

  /** @type {Map<string, { streak: number, shas: string[], closed: boolean }>} */
  const perFile = new Map();
  for (const commit of facts.commits) {
    for (const file of commit.files) {
      if (matchesAny(file, c.ignore)) continue;
      let state = perFile.get(file);
      if (state === undefined) {
        state = { streak: 0, shas: [], closed: false };
        perFile.set(file, state);
      }
      if (state.closed) continue;
      if (isFix(commit)) {
        state.streak += 1;
        state.shas.push(commit.sha);
        if (statesHypothesis(commit)) state.closed = true;
      } else {
        state.closed = true;
      }
    }
  }

  /** @type {GateFinding[]} */
  const findings = [];
  for (const [file, state] of [...perFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (state.streak < c.streak) continue;
    const shas = state.shas.map((s) => s.slice(0, 8)).join(", ");
    findings.push(
      finding(
        "SG-01",
        c.severity,
        file,
        `${state.streak} consecutive fix: commits on this file (${shas}) — the next one is number ${state.streak + 1}`,
        'state a root-cause hypothesis and one alternative approach in the commit message ("Root-cause:" and "Alternative:" lines), or change approach instead of patching again',
      ),
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// SG-02 - parallel-module
// ---------------------------------------------------------------------------------------------

/** Tokens that are structure, not variation: they appear in every model id and would otherwise
 *  turn half the derived vocabulary into false positives. */
const DERIVE_STOPLIST = new Set([
  "api", "base", "chat", "completions", "config", "context", "default", "endpoint", "env",
  "fallback", "http", "https", "ids", "json", "key", "max", "model", "models", "name", "path",
  "provider", "providers", "routing", "tier", "tiers", "token", "tokens", "type", "url", "window",
  "wire", "yaml",
]);

const GENERIC_VARIANT_WORDS = new Set([
  "alt", "alternate", "backup", "copy", "experimental", "final", "fixed", "legacy", "new", "old",
  "orig", "original", "temp", "tmp", "variant", "version",
]);

/**
 * Splits a filename into comparable tokens: lowercased, split on every non-alphanumeric run, with
 * a trailing digit group split off any word of three letters or more (`job2` -> `job`, `2`), so
 * `pipeline_v2.py` and `pipeline.py` differ by exactly one token rather than by a whole word.
 *
 * @param {string} basename filename WITHOUT its extension
 * @returns {string[]}
 */
export function tokenizeName(basename) {
  /** @type {string[]} */
  const out = [];
  for (const raw of basename.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    const m = /^([a-z]{3,})(\d+)$/.exec(raw);
    if (m) out.push(m[1], m[2]);
    else out.push(raw);
  }
  return out;
}

/**
 * The variant vocabulary, derived rather than declared.
 *
 * Three sources, in the order they matter:
 *   1. `deriveTokensFrom` — the target repo's OWN model configuration. Every quoted identifier in
 *      those files is split into words and the structural ones are dropped by `DERIVE_STOPLIST`.
 *      On this repo that yields `sonnet`, `haiku`, `luna`, `terra`, `sol`, `oss`, `claude`, `gpt`,
 *      `databricks`, `litellm` — the exact class of token the audited codebase encoded into
 *      filenames, without any of them being written down here.
 *   2. Generic variant words plus the `v2`/`a1` shape, which are naming conventions rather than
 *      anyone's tenancy. The shape is handled by `isGenericVariantToken`, not by this set.
 *   3. `variantTokens` from config, for the case the first two miss.
 *
 * @param {{ deriveText: readonly string[], configTokens: readonly string[] }} sources
 * @returns {Set<string>}
 */
export function buildVariantVocabulary(sources) {
  /** @type {Set<string>} */
  const tokens = new Set(GENERIC_VARIANT_WORDS);
  for (const text of sources.deriveText) {
    for (const quoted of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._\-/]{2,})["']/g)) {
      for (const word of quoted[1].toLowerCase().split(/[^a-z0-9]+/)) {
        if (word.length < 3) continue;
        if (/^\d+$/.test(word)) continue;
        if (DERIVE_STOPLIST.has(word)) continue;
        tokens.add(word);
      }
    }
  }
  for (const t of sources.configTokens) tokens.add(t.toLowerCase());
  return tokens;
}

/** `v2`, `a1`, `b3`: a letter followed by one or two digits is a variant marker in every naming
 *  scheme this gate has met, and belongs to no tenant. @param {string} token */
export function isGenericVariantToken(token) {
  return /^[a-z]\d{1,2}$/.test(token);
}

/** @param {string} path */
function splitPath(path) {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const ext = dot <= 0 ? "" : file.slice(dot);
  const stem = dot <= 0 ? file : file.slice(0, dot);
  return { dir, ext, stem };
}

/**
 * The one position at which two token lists differ, or `null` if they differ anywhere else.
 * `{ kind: "swap", index, a, b }` for equal-length lists; `{ kind: "extra", index, token }` when
 * one list is the other plus exactly one token.
 *
 * @param {readonly string[]} a @param {readonly string[]} b
 */
function singleTokenDifference(a, b) {
  if (a.length === b.length) {
    let index = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (index !== -1) return null;
      index = i;
    }
    return index === -1 ? null : { kind: "swap", index, a: a[index], b: b[index], token: b[index] };
  }
  const [shortList, longList] = a.length < b.length ? [a, b] : [b, a];
  if (longList.length !== shortList.length + 1) return null;
  let skipped = -1;
  for (let i = 0, j = 0; i < longList.length; i++) {
    if (j < shortList.length && longList[i] === shortList[j]) {
      j++;
      continue;
    }
    if (skipped !== -1) return null;
    skipped = i;
  }
  if (skipped === -1) return null;
  return { kind: "extra", index: skipped, a: null, b: longList[skipped], token: longList[skipped] };
}

/**
 * `SG-02` - a new file whose name differs from an existing file's name only by a variant token.
 *
 * Two independent triggers, because the pathology has two stages:
 *
 *   DERIVED AXIS. If the existing tree already contains two or more files that differ only at
 *   token position `i` (`chunk_sonnet_job.py`, `chunk_gemma_job.py`), then position `i` is an
 *   established variant axis and a new file that extends it is the sixteenth near-duplicate. This
 *   trigger needs no vocabulary at all: the tree names its own axis.
 *
 *   VOCABULARY. The first duplication has no axis yet, so the differing token is matched against
 *   `buildVariantVocabulary` — the model ids the repo's own config declares, plus the generic
 *   `v2`/`copy`/`old` shapes. This is the trigger that fires on file number two.
 *
 * Two guards keep the axis trigger from firing on ordinary naming. `numericSeriesMin`: `pc-26-...`
 * next to twenty-five siblings is a numbered rule set, not a variant axis, and a gate that fired
 * there would be noise in every repository that numbers its files. `minSharedTokens`: two names
 * that share only one token (`pi-check`, `pi-gate`) are a prefix convention; the axis evidence is
 * positional and needs at least two tokens of agreement before it means anything.
 *
 * @param {{ newPaths: readonly string[], existingPaths: readonly string[], deriveText: readonly string[] }} facts
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {GateFinding[]}
 */
export function detectParallelModules(facts, cfg) {
  const c = cfg["SG-02"];
  if (c.severity === "off") return [];

  const vocabulary = buildVariantVocabulary({
    deriveText: facts.deriveText,
    configTokens: c.variantTokens,
  });

  const newSet = new Set(facts.newPaths);
  const existing = facts.existingPaths
    .filter((p) => !newSet.has(p) && !matchesAny(p, c.ignore))
    .map((p) => {
      const parts = splitPath(p);
      return { path: p, ext: parts.ext, tokens: tokenizeName(parts.stem) };
    });

  // How many DISTINCT tokens the tree already carries at each (ext, masked-token-list) position.
  // Two or more means the axis exists; the same map, keyed on a digit position, is what
  // `numericSeriesMin` reads to tell a numbered series from a variant axis.
  /** @type {Map<string, Set<string>>} */
  const axis = new Map();
  for (const e of existing) {
    for (let i = 0; i < e.tokens.length; i++) {
      const key = `${e.ext} ${e.tokens.map((t, j) => (j === i ? "*" : t)).join(" ")}`;
      let seen = axis.get(key);
      if (seen === undefined) axis.set(key, (seen = new Set()));
      seen.add(e.tokens[i]);
    }
  }

  /** @param {string} ext @param {readonly string[]} tokens @param {number} i */
  function axisWidth(ext, tokens, i) {
    const key = `${ext} ${tokens.map((t, j) => (j === i ? "*" : t)).join(" ")}`;
    return axis.get(key)?.size ?? 0;
  }

  /** @type {GateFinding[]} */
  const findings = [];
  for (const newPath of [...facts.newPaths].sort()) {
    if (matchesAny(newPath, c.ignore)) continue;
    const n = splitPath(newPath);
    const nTokens = tokenizeName(n.stem);
    if (nTokens.length === 0) continue;

    for (const e of existing) {
      if (e.ext !== n.ext) continue;
      const diff = singleTokenDifference(e.tokens, nTokens);
      if (diff === null) continue;

      const newToken = diff.token;
      const oldToken = diff.a;
      const bothDigits = /^\d+$/.test(newToken) && (oldToken === null || /^\d+$/.test(oldToken));
      const width = axisWidth(e.ext, e.tokens, diff.index);
      if (bothDigits && width >= c.numericSeriesMin) continue;

      const sharedTokens = Math.min(e.tokens.length, nTokens.length) - (diff.kind === "swap" ? 1 : 0);
      const byAxis = diff.kind === "swap" && width >= 2 && sharedTokens >= c.minSharedTokens;
      const inVocabulary = (/** @type {string} */ t) =>
        vocabulary.has(t) || isGenericVariantToken(t);
      const byVocabulary = inVocabulary(newToken) || (oldToken !== null && inVocabulary(oldToken));
      if (!byAxis && !byVocabulary) continue;

      const why = byAxis
        ? `${width} existing files already vary at this same position, so it is an axis, not a name`
        : `"${newToken}" is a variant token (from this repo's declared model ids and the generic v2/copy shapes)`;
      findings.push(
        finding(
          "SG-02",
          c.severity,
          newPath,
          `new file differs from "${e.path}" by exactly one token: ${why}`,
          "parameterize instead: keep one module and pass the varying token in as an argument, a config key or a fixture",
        ),
      );
      break; // one finding per new file — the nearest neighbour is the whole point
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// SG-03 - file-count budget per wave
// ---------------------------------------------------------------------------------------------

/**
 * `SG-03` - how many new top-level modules this diff adds, and whether anyone said yes to that.
 *
 * "Top-level" is depth, not a directory allowlist: a path of `maxDepth` segments or fewer whose
 * extension is a source extension. `src/pipeline.py` counts, `src/chunking/util/text.py` does not
 * — the latter is work inside a module that already exists, which is not the sprawl this gate is
 * about.
 *
 * THE SIGN-OFF IS EXPLICIT OR IT DOES NOT EXIST. Silence never clears this gate. A reason must be
 * supplied — `--signoff "<why>"`, `PI_GATE_SIGNOFF=<why>`, or a `Sprawl-signoff: <why>` line in
 * the HEAD commit message — and an empty or whitespace-only reason is not one. When a reason is
 * present the gate still reports, at severity `ok`, quoting it back: the record that a decision
 * was made is the point, and an approval nobody can find later is the same as no approval at all.
 *
 * @param {{ newPaths: readonly string[], signoff: string | null }} facts
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {GateFinding[]}
 */
export function detectFileCountBudget(facts, cfg) {
  const c = cfg["SG-03"];
  if (c.severity === "off") return [];

  const modules = facts.newPaths
    .filter((p) => !matchesAny(p, c.ignore))
    .filter((p) => c.sourceExts.some((ext) => p.endsWith(ext)))
    .filter((p) => p.split("/").length <= c.maxDepth)
    .sort();

  if (modules.length < c.signoffThreshold) return [];

  const reason = facts.signoff === null ? "" : facts.signoff.trim();
  const list = modules.join(", ");
  if (reason.length > 0) {
    return [
      finding(
        "SG-03",
        "ok",
        `${modules.length} new top-level modules`,
        `${modules.length} new top-level modules (${list}) — signed off: ${reason}`,
        "no action; this line is the record that the sprawl was a decision",
      ),
    ];
  }
  return [
    finding(
      "SG-03",
      c.severity,
      `${modules.length} new top-level modules`,
      `${modules.length} new top-level modules in one diff (${list}), budget is ${c.signoffThreshold}`,
      'get an explicit lead sign-off and record it — --signoff "<why these are separate modules>", PI_GATE_SIGNOFF=<why>, or a "Sprawl-signoff: <why>" line in the commit message — or fold them into fewer modules',
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// SG-04 - bounded-run (a WEAK check, and it says so)
// ---------------------------------------------------------------------------------------------

/**
 * Is `name` used as a parameter or a key anywhere in `text`? Matches `name=`, `name:`, `"name"`,
 * `'name'` and `--name`, which covers a Python signature, a YAML key, a JSON key and a CLI flag.
 *
 * @param {string} text @param {string} name
 */
function declaresParam(text, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w-])(?:--)?${n}\\s*[:=]|["']${n}["']`, "m").test(text);
}

/**
 * `SG-04` - every declared job accepts a subset scope.
 *
 * WHAT THIS ACTUALLY MEASURES, STATED HONESTLY. It is a NAME check over the files matched by
 * `jobGlobs`. It asks two questions of the text and nothing else:
 *
 *   1. Does any of `subsetParams` appear as a parameter or a key? If not, there is no documented
 *      way to ask this job for less than everything.
 *   2. Does the file compare something for equality against a literal of at least
 *      `fullScaleLiteralMin`, under a name that is not in `identifierIgnore`?
 *      `expected_page_count == 701` is the shape that makes a bounded run impossible even when a
 *      `limit` parameter exists, which is exactly the defect that cost four paid runs to discover
 *      in the audited session. The threshold and the name list exist because an HTTP status
 *      compare has the identical shape and is far more common; the price of keeping that quiet is
 *      that a full-scale constant below the threshold is missed, and the doc says so.
 *
 * WHAT IT CANNOT DO, AND MUST NOT BE QUOTED AS DOING. It never runs anything, so it does not know
 * whether a declared `limit` is honoured, ignored, or overwritten three frames down. It cannot
 * see a job whose scope is set by an external orchestrator, whose parameters arrive through
 * `**kwargs`, or whose entry point does not match `jobGlobs`. It reads text, not semantics: a
 * variable named `limit` in a comment satisfies it. A green SG-04 therefore means "no job
 * ADVERTISES full-scale-only operation", never "every job has been shown to run on a subset". The
 * only strong form of this check is an actual bounded run; this gate exists to make the absence
 * of one visible, not to substitute for it.
 *
 * @param {{ jobFiles: readonly { path: string, text: string }[] }} facts
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {GateFinding[]}
 */
export function detectBoundedRun(facts, cfg) {
  const c = cfg["SG-04"];
  if (c.severity === "off") return [];

  /** @type {GateFinding[]} */
  const findings = [];
  for (const job of [...facts.jobFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    if (matchesAny(job.path, c.ignore)) continue;

    if (!c.subsetParams.some((p) => declaresParam(job.text, p))) {
      findings.push(
        finding(
          "SG-04",
          c.severity,
          job.path,
          `job declares no subset parameter (looked for: ${c.subsetParams.join(", ")}) — it can only be run at full scale`,
          "add a limit/subset parameter and honour it end to end, so the job can be validated below production cost",
        ),
      );
      continue;
    }

    for (const m of job.text.matchAll(/([A-Za-z_][\w.]*)\s*[!=]==?\s*(\d+)\b/g)) {
      const literal = Number(m[2]);
      if (literal < c.fullScaleLiteralMin) continue;
      const lastSegment = m[1].toLowerCase().split(/[.\s]/).pop() ?? "";
      if (c.identifierIgnore.some((name) => lastSegment === name || lastSegment.endsWith(`_${name}`))) continue;
      findings.push(
        finding(
          "SG-04",
          c.severity,
          job.path,
          `hard equality against a full-scale constant (${m[1]} vs ${literal}) — a subset run fails this check by construction, whatever the limit parameter says`,
          "compare against the scope actually requested, not against the production magnitude",
        ),
      );
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------------------------

/**
 * `--block` promotes every `warn` to `error` for this run. It does NOT touch `ok` (a recorded
 * sign-off is not a failure) and does not lower a finding a config already raised to `error`.
 *
 * @param {readonly GateFinding[]} findings
 * @returns {GateFinding[]}
 */
export function applyBlockMode(findings) {
  return findings.map((f) => (f.severity === "warn" ? { ...f, severity: "error" } : f));
}

/** @param {readonly GateFinding[]} findings */
export function hasBlockingFinding(findings) {
  return findings.some((f) => f.severity === "error");
}

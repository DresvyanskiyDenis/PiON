/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */

export const id = "PC-29";
export const closes = [];
export const title =
  "The subagent contract keeps the sections config/dispatch.json declares, and states no line/file threshold that config disagrees with";

// THE DEFECT THIS RULE EXISTS FOR
// -------------------------------
// Two failures of the same shape, found in one audit of a long autonomous run.
//
//   1. The contract handed to a dispatched child was mechanics only — tiers, call shape, slot
//      accounting — and said nothing about architecture. Every child was therefore a fresh mind
//      with no design of record: one added an adapter beside an adapter that already existed,
//      another encoded the experiment axis in a file name instead of a parameter, and a single
//      idea then had to be re-applied in N places. The sprawl is also a context tax, because
//      understanding one thing means reading N near-identical files.
//   2. Dispatch policy was mechanics only as well. Nothing said WHETHER a dispatch was worth its
//      cost, so children were spawned for edits of a few dozen lines.
//
// Both fixes are prose, and prose fixes decay in a specific way: the section is deleted in a
// tidy-up, or hollowed out to a heading, or the number in it drifts from the number the config
// carries. That is the class this rule is aimed at — SAFE BEHAVIOUR HELD AS A HABIT RATHER THAN
// AS STATE. A rule the model must remember per call is eventually not remembered; a section that
// cannot be removed, emptied or contradicted without a failing check is state.
//
// WHAT IT CHECKS, AND WHAT IT REFUSES TO CHECK
// --------------------------------------------
// `config/dispatch.json`'s `subagentContract` block is the ONLY authority. It names the contract
// document, the headings that document must carry, how much body each needs, and the two
// worthiness numbers. This rule reads all of that from the config and hardcodes none of it.
//
// It never checks a WORDING. Asserting that a sentence still says what someone meant in 2026 is
// how a rule becomes a thing people route around, and the prose here is meant to be rewritten as
// the harness learns. What it asserts instead:
//
//   - the declared document exists;
//   - every declared section has a heading, at any level;
//   - every declared section carries at least `minSectionLines` non-blank body lines, so a
//     heading left standing over nothing fails exactly like a deleted one;
//   - every `<n> ... lines` / `<n> ... files` claim anywhere in the document equals the matching
//     `worthiness` value, and each declared value is stated at least once — the doc may not drop
//     the threshold and may not carry a second, different one.
//
// TOLERANCES
// ----------
// No `config/dispatch.json`, unparseable JSON, or no `subagentContract` block: nothing declared,
// nothing to check, no findings — the same posture PC-27 takes toward a missing `models.json`.
// A tree that has not adopted this contract (a `--repo` pointed elsewhere, the acceptance
// fixture) is silent rather than noisy. Spelled-out numbers ("five files") are invisible to the
// numeric check by design: it compares digits with digits, and a claim written in words is caught
// by the section checks and by review, not by a word-list this rule would then have to maintain.

const DISPATCH = "config/dispatch.json";

/** `50 changed lines`, `at most 3 files` — a count, up to two qualifiers, then the unit. */
const COUNT_RE = /(\d+)\s+(?:[A-Za-z][A-Za-z-]*\s+){0,2}(lines?|files?)\b/gi;

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/** Heading text and declared section names compare on this form: no case, no backticks, no trailing punctuation. */
function normalise(text) {
  return text
    .replace(/`/g, "")
    .replace(/[.:;,!?]+$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Every heading in `records`, with the count of non-blank body lines it owns. A section ends at
 * the next heading of the same or a higher level, so a subsection's body counts toward its parent.
 *
 * @param {Array<{ line: number, text: string }>} records
 * @returns {Array<{ name: string, line: number, bodyLines: number }>}
 */
function sections(records) {
  const found = [];
  /** @type {Array<{ level: number, index: number }>} */
  const open = [];
  for (const { line, text } of records) {
    const m = HEADING_RE.exec(text);
    if (m === null) {
      if (text.trim() !== "") for (const o of open) found[o.index].bodyLines += 1;
      continue;
    }
    const level = m[1].length;
    while (open.length > 0 && open[open.length - 1].level >= level) open.pop();
    open.push({ level, index: found.length });
    found.push({ name: normalise(m[2]), line, bodyLines: 0 });
  }
  return found;
}

/** @param {unknown} value @returns {number | undefined} */
function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  if (!ctx.exists(DISPATCH)) return findings;

  let dispatch;
  try {
    dispatch = ctx.readJSON(DISPATCH);
  } catch {
    // Malformed dispatch.json is another rule's finding; this one has no authority to read.
    return findings;
  }
  const contract = dispatch && typeof dispatch === "object" ? dispatch.subagentContract : undefined;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return findings;

  const doc = typeof contract.doc === "string" && contract.doc ? contract.doc : undefined;
  if (doc === undefined) return findings;

  if (!ctx.exists(doc)) {
    findings.push({
      rule: id,
      file: DISPATCH,
      message: `subagentContract.doc names "${doc}" as the subagent contract, and that file does not exist — the obligations it carries reach no dispatched child.`,
    });
    return findings;
  }

  const records = ctx.lines(doc);
  const present = sections(records);
  const minBody = positiveInt(contract.minSectionLines) ?? 1;
  const required = Array.isArray(contract.requiredSections) ? contract.requiredSections : [];

  for (const name of required) {
    if (typeof name !== "string" || name.trim() === "") continue;
    const want = normalise(name);
    const hit = present.find((s) => s.name === want);
    if (hit === undefined) {
      findings.push({
        rule: id,
        file: doc,
        message: `has no "${name}" section, and config/dispatch.json's subagentContract.requiredSections declares one — restore the section or stop declaring it.`,
      });
      continue;
    }
    if (hit.bodyLines < minBody) {
      findings.push({
        rule: id,
        file: doc,
        line: hit.line,
        message: `section "${name}" carries ${hit.bodyLines} non-blank line(s), below the ${minBody} config/dispatch.json's subagentContract.minSectionLines declares — a heading over nothing is a deleted obligation with a signpost.`,
      });
    }
  }

  const worthiness = contract.worthiness;
  if (!worthiness || typeof worthiness !== "object" || Array.isArray(worthiness)) return findings;
  const declared = [
    { unit: "lines", key: "leadHandlesChangedLinesUnder", value: positiveInt(worthiness.leadHandlesChangedLinesUnder) },
    { unit: "files", key: "leadHandlesFilesTouchedAtMost", value: positiveInt(worthiness.leadHandlesFilesTouchedAtMost) },
  ].filter((d) => d.value !== undefined);
  if (declared.length === 0) return findings;

  /** @type {Map<string, Set<number>>} */
  const stated = new Map(declared.map((d) => [d.unit, new Set()]));
  for (const { line, text } of records) {
    COUNT_RE.lastIndex = 0;
    let m;
    while ((m = COUNT_RE.exec(text)) !== null) {
      const unit = m[2].toLowerCase().replace(/s$/, "") + "s";
      const seen = stated.get(unit);
      if (seen === undefined) continue;
      const count = Number(m[1]);
      seen.add(count);
      const want = declared.find((d) => d.unit === unit);
      if (want !== undefined && count !== want.value) {
        findings.push({
          rule: id,
          file: doc,
          line,
          message: `states "${m[0]}", but config/dispatch.json's subagentContract.worthiness.${want.key} is ${want.value} — one of the two is stale, and the config is the authority.`,
        });
      }
    }
  }

  for (const d of declared) {
    if (!stated.get(d.unit).has(d.value)) {
      findings.push({
        rule: id,
        file: doc,
        message: `never states the worthiness bound of ${d.value} ${d.unit} that config/dispatch.json declares as subagentContract.worthiness.${d.key} — a threshold the contract does not carry is one no dispatching model can apply.`,
      });
    }
  }

  return findings;
}

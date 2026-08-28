#!/usr/bin/env node
// providers.mjs — read config/providers/*.json and turn them into config/models.json and
// config/routing.json.
//
// THE CONTRACT THIS IMPLEMENTS IS config/providers/README.md. That file is normative: "if the two
// disagree, this file is right and the installer is wrong." Everything below — the fragment
// schema, the four substitution rules, the merge algorithm — is an implementation of it, and a
// change there is a bug report against this file.
//
// Why a Node helper rather than doing it in install.sh: this is JSON surgery (typed substitution,
// key deletion, array compaction) and doing it in bash would mean sed on JSON, which is how config
// files get silently corrupted. The shell asks the questions; this applies them.
//
// Subcommands, all line-oriented TSV so bash can read them with `while IFS=$'\t' read`:
//
//   list     <dir>                        ID  DISPLAY  EGRESS  DEFAULT  SUMMARY   (one per fragment)
//   describe <dir> <id>                   META / NOTE / REQ / PROMPT — what to ask
//   resolve  <dir> <id> <answers>         MODEL / TIER / CRED / ENV / VERIFY — needs the answers
//   match    <pattern> <value>            exit 0 if the ECMAScript regex matches (prompt validate)
//   tiers    <routing.default.json>       NAME  OPTIONAL  PURPOSE  MODEL  THINKING
//   generate --providers-dir D --select a,b --answers F
//            [--models-default F] [--routing-default F]
//            (--out-models F --out-routing F | --print-only)
//
// Exit: 0 fine, 1 a well-formed question whose answer is absent, 2 this tool could not run — which
// includes every schema violation, because a fragment the installer half-understands is worse than
// one it refuses.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

// `node providers.mjs list ... | head -3` closes the pipe early, and an unhandled EPIPE would turn
// that into a stack trace and a non-zero exit that a shell caller reads as a real failure.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

const SCHEMA_VERSION = 1;
const TIER_NAMES = ["strong", "light", "confidential"];
// A fragment carrying a key that is not here is rejected outright. README §2: "a typo'd key that
// is silently ignored is how a prompt stops being asked without anyone noticing."
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "id", "displayName", "summary", "builtIn", "default", "egress", "concurrency",
  "requires", "prompts", "derived", "tiers", "provider", "notes", "verify",
]);
const REQUIRED_KEYS = ["schemaVersion", "id", "displayName", "summary", "builtIn", "default",
  "egress", "concurrency", "requires", "prompts", "provider", "notes"];

const EGRESS_CLASSES = ["public", "internal", "confidential"];

// A value the fragment defers to an answer: the string is EXACTLY one {{token}}.
// Only `egress`, `concurrency` and `requires[].name` may do this, and only because for a gateway
// provider the honest answer to all three is "we cannot know". Everything else stays literal:
// a fragment whose every field is deferred stops being a reviewable template.
const WHOLE_TOKEN_RE = /^\{\{([A-Za-z0-9_]+)\}\}$/;
/** @param {unknown} v @returns {string|null} the prompt id, or null if `v` is not a whole token */
function deferredTo(v) {
  const m = typeof v === "string" ? WHOLE_TOKEN_RE.exec(v) : null;
  return m ? m[1] : null;
}

/** @param {string} msg @returns {never} */
function fatal(msg) {
  process.stderr.write(`providers.mjs: ${msg}\n`);
  process.exit(2);
}

/** @param {string} file @returns {any} */
function loadJSON(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return fatal(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Records are separated by US (0x1f), NOT by a tab. A tab is IFS *whitespace*, so bash's `read`
// collapses a run of them into one delimiter and an empty column silently shifts every later
// field one position left — which is exactly how a prompt's blank default became its "required"
// flag during testing. A non-whitespace IFS character delimits one field each, empty or not.
const SEP = "\x1f";

/** A field may not contain the separator, a tab or a newline; any of them desynchronises bash. */
function tsv(...fields) {
  return fields.map((f) => String(f ?? "").replace(/[\t\n\r\x1f]+/g, " ")).join(SEP);
}

/** @param {string} dir @returns {string[]} */
function fragmentFiles(dir) {
  if (!existsSync(dir)) fatal(`the provider directory ${dir} does not exist`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Load one fragment and validate it hard. Every check here has a failure it prevents, and every
 * message names the file, so a broken fragment gets fixed rather than worked around.
 * @param {string} file @returns {any}
 */
function loadFragment(file) {
  const frag = loadJSON(file);
  const where = basename(file);
  if (typeof frag !== "object" || frag === null || Array.isArray(frag)) {
    fatal(`${where}: a fragment must be a JSON object`);
  }
  if (frag.schemaVersion !== SCHEMA_VERSION) {
    fatal(
      `${where}: schemaVersion ${JSON.stringify(frag.schemaVersion)} is not ${SCHEMA_VERSION}, the only version this installer understands. ` +
        "Upgrade the installer rather than editing the fragment.",
    );
  }
  const expectedId = basename(file, ".json");
  if (frag.id !== expectedId) {
    fatal(`${where}: id "${frag.id}" must equal the filename without .json ("${expectedId}") — the id is the key in models.json`);
  }
  for (const k of Object.keys(frag)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      fatal(`${where}: unknown top-level key "${k}". Allowed: ${[...TOP_LEVEL_KEYS].join(", ")}`);
    }
  }
  for (const k of REQUIRED_KEYS) {
    if (frag[k] === undefined) fatal(`${where}: required key "${k}" is missing`);
  }
  const promptIds = new Set((frag.prompts ?? []).map((p) => p.id));
  const egressToken = deferredTo(frag.egress);
  if (egressToken) {
    // Deferred, so it cannot be checked here — but the CHOICES can be, and that is the whole
    // value: a choice prompt whose options are exactly the three classes makes an out-of-range
    // egress unreachable at install time instead of caught after generation.
    const p = (frag.prompts ?? []).find((q) => q.id === egressToken);
    if (!p) fatal(`${where}: egress defers to {{${egressToken}}}, which is not a prompt of this fragment`);
    if (p.type !== "choice") fatal(`${where}: egress defers to prompt "${egressToken}", which must be type choice`);
    for (const c of p.choices ?? []) {
      if (!EGRESS_CLASSES.includes(c.value)) {
        fatal(`${where}: prompt "${egressToken}" offers egress "${c.value}", which is not ${EGRESS_CLASSES.join(", ")}`);
      }
    }
  } else if (!EGRESS_CLASSES.includes(frag.egress)) {
    fatal(`${where}: egress "${frag.egress}" must be public, internal or confidential`);
  }
  const concurrencyToken = deferredTo(frag.concurrency);
  if (concurrencyToken) {
    const p = (frag.prompts ?? []).find((q) => q.id === concurrencyToken);
    if (!p) fatal(`${where}: concurrency defers to {{${concurrencyToken}}}, which is not a prompt of this fragment`);
    if (p.type !== "number") fatal(`${where}: concurrency defers to prompt "${concurrencyToken}", which must be type number`);
  } else if (!Number.isInteger(frag.concurrency) || frag.concurrency < 1) {
    fatal(`${where}: concurrency must be an integer >= 1`);
  }
  for (const r of frag.requires ?? []) {
    const nameToken = deferredTo(r.name);
    if (nameToken && !promptIds.has(nameToken)) {
      fatal(`${where}: a requirement's name defers to {{${nameToken}}}, which is not a prompt of this fragment`);
    }
  }
  for (const t of Object.keys(frag.tiers ?? {})) {
    if (!TIER_NAMES.includes(t)) {
      fatal(`${where}: tier "${t}" is outside the fixed vocabulary ${TIER_NAMES.join(", ")} — see providers/README.md §2.4`);
    }
  }
  const seen = new Set();
  for (const p of frag.prompts ?? []) {
    if (!p.id) fatal(`${where}: a prompt has no id`);
    if (seen.has(p.id)) fatal(`${where}: duplicate prompt id "${p.id}"`);
    if (!["string", "number", "decimal", "port", "boolean", "choice"].includes(p.type)) {
      fatal(`${where}: prompt "${p.id}" has type "${p.type}", which is not string|number|decimal|port|boolean|choice`);
    }
    if (p.type === "choice" && !Array.isArray(p.choices)) {
      fatal(`${where}: prompt "${p.id}" is type choice and must carry choices[]`);
    }
    // README §2.2: "A `when` may only reference a prompt that appears earlier." Checked, because a
    // forward reference evaluates against an unanswered prompt and silently skips a question.
    for (const dep of Object.keys(p.when ?? {})) {
      if (!seen.has(dep)) fatal(`${where}: prompt "${p.id}" has when:{${dep}} but "${dep}" is not an earlier prompt`);
    }
    // README §2.2: one condition, because the installer and this file would otherwise read a
    // two-condition `when` differently — install.sh's `describe` row carries a single whenId/whenValue
    // pair, so it would ask on the first condition alone while the table below skips on both. The
    // divergence is silent and costs the user the answer they typed: asked, then discarded.
    if (Object.keys(p.when ?? {}).length > 1) {
      fatal(`${where}: prompt "${p.id}" has a when with ${Object.keys(p.when).length} conditions; exactly one is supported`);
    }
    seen.add(p.id);
  }
  for (const d of frag.derived ?? []) {
    if (!d.id || !d.from || typeof d.map !== "object") {
      fatal(`${where}: every derived entry needs id, from and map`);
    }
    if (!seen.has(d.from)) fatal(`${where}: derived "${d.id}" reads from "${d.from}", which is not a prompt of this fragment`);
  }
  return frag;
}

/** @param {string} dir */
function loadAll(dir) {
  return fragmentFiles(dir).map(loadFragment);
}

// ------------------------------------------------------------------------------- answers ------
// The answers file is `key=value`, one per line; keys are `providers`, `tier.<name>` and
// `<providerId>.<promptId>`. It is PARSED, never sourced — a value containing $(...) is data.
/** @param {string} file @returns {Map<string,string>} */
function loadAnswers(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

const TOKEN_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

/** @param {any} frag @param {string} str @param {Map<string,unknown>} tokens @returns {string} */
function substituteString(frag, str, tokens) {
  return str.replace(TOKEN_RE, (_m, id) => {
    // Rule 1: "An unknown id is an error, not an empty string."
    if (!tokens.has(id)) {
      fatal(`${frag.id}: the template references {{${id}}}, which is neither a prompt nor a derived value in ${frag.id}.json`);
    }
    const v = tokens.get(id);
    return v === null || v === undefined ? "" : String(v);
  });
}

/**
 * Turn the raw string answers into typed values, applying `when` skips and prompt defaults, then
 * resolve `derived`. The result is the token table every substitution reads.
 * @param {any} frag @param {Map<string,string>} answers @returns {Map<string, unknown>}
 */
function tokenTable(frag, answers) {
  /** @type {Map<string, unknown>} */
  const tokens = new Map();
  /** @type {Map<string, string>} */
  const rawById = new Map();

  for (const p of frag.prompts ?? []) {
    let raw = answers.get(`${frag.id}.${p.id}`);

    // README §2.2: a prompt whose `when` is not satisfied is not asked; its answer is the declared
    // default if the fragment gives one, otherwise "".
    let skipped = false;
    for (const [dep, want] of Object.entries(p.when ?? {})) {
      const depVal = String(rawById.get(dep) ?? "");
      const satisfied = want === "*" ? depVal !== "" : depVal === String(want);
      if (!satisfied) skipped = true;
    }
    if (skipped || raw === undefined) raw = p.default !== undefined ? String(p.default) : "";
    // A required prompt that was ASKED and has no answer is refused here rather than substituted
    // blank. install.sh dies on the same condition when it does the asking, but it is not the only
    // way answers reach this file: `--repair` and `--section <other>` skip the provider interview
    // entirely and generate from a saved answers file, which on a tree that gained a prompt is a
    // file missing exactly that key. The blank would then substitute as "" — a model priced
    // `"cost": {"input": ""}`, or one with an empty id — and every later check reads it as a
    // decision somebody made.
    if (!skipped && raw === "" && p.required !== false) {
      fatal(
        `${frag.id}: "${p.id}" is required and unanswered (${p.label}). ` +
          `Add "${frag.id}.${p.id}=<value>" to the answers file, or re-run the installer and answer it.`,
      );
    }
    rawById.set(p.id, raw);

    // Rule 2: number/decimal/port/boolean substitute unquoted. PI does not coerce, so a context
    // window arriving as the string "200000" is a config that silently never compacts, and a cost
    // rate arriving as the string "2.5" is a `cost` object PI reads as unpriced (see
    // bin/rules/pc-27-declared-models-are-priced.mjs) on a provider that is charging real money.
    // `decimal` exists as its own type only because the installer validates by type and a price is
    // the one answer here that is legitimately fractional; the coercion is the same Number().
    let value = raw;
    if (raw === "") value = "";
    else if (p.type === "number" || p.type === "decimal" || p.type === "port") {
      const n = Number(raw);
      if (!Number.isFinite(n)) fatal(`${frag.id}: the answer for "${p.id}" is "${raw}", which is not a number`);
      value = n;
    } else if (p.type === "boolean") {
      value = raw === "true" || raw === "1" || raw === "yes";
    }
    tokens.set(p.id, value);
  }

  for (const d of frag.derived ?? []) {
    const key = String(tokens.get(d.from) ?? "");
    if (!(key in d.map)) {
      fatal(`${frag.id}: derived "${d.id}" has no mapping for ${d.from}="${key}" (mapped keys: ${Object.keys(d.map).join(", ")})`);
    }
    let mapped = d.map[key];
    // A map value may itself carry {{tokens}}, resolved against the answers already computed —
    // and rule 2 applies to it exactly as it does inside `provider`: a map value that is EXACTLY
    // one token takes that answer's NATIVE type. Without this, every derived value would be a
    // string, and "the rate you typed, or zero if you said this endpoint is unmetered" could only
    // ever be spelled "2.5", which PI reads as no price at all.
    const whole = typeof mapped === "string" ? deferredTo(mapped) : null;
    if (whole !== null) {
      if (!tokens.has(whole)) {
        fatal(`${frag.id}: derived "${d.id}" maps ${d.from}="${key}" to {{${whole}}}, which is not a prompt or an earlier derived value`);
      }
      mapped = tokens.get(whole);
    } else if (typeof mapped === "string") mapped = substituteString(frag, mapped, tokens);
    tokens.set(d.id, mapped);
  }
  return tokens;
}

/**
 * The fragment's egress class, resolved if it defers to an answer and re-checked either way.
 * @param {any} frag @param {Map<string,unknown>} tokens @returns {string}
 */
function resolveEgress(frag, tokens) {
  const token = deferredTo(frag.egress);
  const value = token ? String(tokens.get(token) ?? "") : frag.egress;
  if (!EGRESS_CLASSES.includes(value)) {
    fatal(`${frag.id}: egress resolved to "${value}", which is not ${EGRESS_CLASSES.join(", ")} — routing.json decides confidential dispatch from this value, so it is never guessed`);
  }
  return value;
}

/**
 * The fragment's concurrency cap, resolved the same way. A cap of 0 would stall every dispatch to
 * the provider on a semaphore that never opens, which presents as a hang rather than an error.
 * @param {any} frag @param {Map<string,unknown>} tokens @returns {number}
 */
function resolveConcurrency(frag, tokens) {
  const token = deferredTo(frag.concurrency);
  const value = token ? Number(tokens.get(token)) : frag.concurrency;
  if (!Number.isInteger(value) || value < 1) {
    fatal(`${frag.id}: concurrency resolved to "${String(value)}", which is not an integer >= 1`);
  }
  return value;
}

const DELETE_ME = Symbol("delete-this-key");

/**
 * Walk a fragment's `provider` payload applying README §3 rules 1-4.
 * @param {any} frag @param {any} node @param {Map<string,unknown>} tokens @returns {any}
 */
function substitute(frag, node, tokens) {
  if (typeof node === "string") {
    // Rule 2: a string that is EXACTLY one token takes the token's native type, so a number stays
    // a number and a boolean stays a boolean.
    const whole = node.match(/^\{\{([A-Za-z0-9_]+)\}\}$/);
    if (whole) {
      const id = whole[1];
      if (!tokens.has(id)) fatal(`${frag.id}: the template references {{${id}}}, which is not a prompt or derived value`);
      const v = tokens.get(id);
      // Rule 3: a token resolving to null deletes the key holding it. A fragment whose endpoint is
      // the vendor's own default relies on this — "no proxy in front of it" must mean baseUrl is
      // ABSENT, which is not the same as null or "".
      return v === null ? DELETE_ME : v;
    }
    return substituteString(frag, node, tokens);
  }
  if (Array.isArray(node)) {
    const out = [];
    for (const el of node) {
      const v = substitute(frag, el, tokens);
      // Rule 4: an omitted array element is removed and the array closed up, not left as a hole.
      if (v !== DELETE_ME) out.push(v);
    }
    return out;
  }
  if (node && typeof node === "object") {
    // Rule 4: "$omitIfBlank": "<promptId>" removes the whole object when that answer is blank.
    if (typeof node.$omitIfBlank === "string") {
      const v = tokens.get(node.$omitIfBlank);
      if (v === "" || v === null || v === undefined) return DELETE_ME;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$omitIfBlank") continue; // the marker itself is always stripped from the output
      const sub = substitute(frag, v, tokens);
      if (sub === DELETE_ME) continue;
      out[k] = sub;
    }
    return out;
  }
  return node;
}

// ------------------------------------------------------------------------------- commands -----
const [cmd, ...argv] = process.argv.slice(2);

/** @param {string[]} args @returns {Record<string,string>} */
function parseFlags(args) {
  /** @type {Record<string,string>} */
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) fatal(`unexpected argument "${a}"`);
    const key = a.slice(2);
    if (key === "print-only") { out[key] = "1"; continue; }
    const val = args[i + 1];
    if (val === undefined || val.startsWith("--")) fatal(`--${key} needs a value`);
    out[key] = val;
    i += 1;
  }
  return out;
}

switch (cmd) {
  // ---------------------------------------------------------------------------------- list ---
  case "list": {
    const [dir] = argv;
    if (!dir) fatal("list needs <dir>");
    const frags = loadAll(dir);
    if (frags.length === 0) process.exit(1);
    // `default: true` sorts first, so the recommended provider is offer number 1.
    frags.sort((a, b) => Number(b.default === true) - Number(a.default === true) || a.id.localeCompare(b.id));
    for (const f of frags) {
      // The picker prints this as "where the data goes". A fragment that defers the class has no
      // honest answer until the user gives one, and printing the raw {{token}} would be worse than
      // saying so — the menu is where someone decides whether to trust the provider at all.
      const egress = deferredTo(f.egress) ? "you choose" : f.egress;
      process.stdout.write(`${tsv(f.id, f.displayName, egress, f.default === true ? "1" : "0", f.summary)}\n`);
    }
    break;
  }

  // ------------------------------------------------------------------------------ describe ---
  // Everything the installer needs in order to ASK. Deliberately separate from `resolve`, which
  // needs answers that do not exist yet at this point in the interview.
  case "describe": {
    const [dir, id] = argv;
    if (!dir || !id) fatal("describe needs <dir> <id>");
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) fatal(`no fragment for provider "${id}" (looked for ${file})`);
    const f = loadFragment(file);

    // Same reasoning as `list`: a deferred class or cap is announced as a question, not printed raw.
    process.stdout.write(`${tsv(
      "META", f.displayName, f.summary,
      deferredTo(f.egress) ? "asked below" : f.egress,
      deferredTo(f.concurrency) ? "asked below" : f.concurrency,
      f.builtIn ? "1" : "0",
    )}\n`);
    for (const n of f.notes ?? []) process.stdout.write(`${tsv("NOTE", n)}\n`);
    for (const r of f.requires ?? []) {
      // A requirement whose NAME depends on an answer cannot be described here: `describe` runs
      // before the first question is asked. `resolve` re-emits it as a CRED row once the answer
      // exists. Printing it now would put a literal "{{apiKeyEnv}}" on screen as a variable name.
      if (deferredTo(r.name)) continue;
      process.stdout.write(
        `${tsv("REQ", r.kind, r.name, r.required ? "1" : "0", r.secret ? "1" : "0", r.description, r.howTo)}\n`,
      );
    }
    for (const p of f.prompts ?? []) {
      const choices = (p.choices ?? []).map((c) => c.value).join(",");
      const labels = (p.choices ?? []).map((c) => `${c.value} = ${c.label}`).join("  |  ");
      const whenId = Object.keys(p.when ?? {})[0] ?? "";
      const whenVal = whenId ? String(p.when[whenId]) : "";
      process.stdout.write(
        `${tsv(
          "PROMPT", p.id, p.type, p.label,
          p.default === undefined ? "" : String(p.default),
          p.required === false ? "0" : "1",
          choices, labels, whenId, whenVal,
          p.validate?.pattern ?? "", p.validate?.message ?? "",
          p.help ?? "", p.example ?? "",
        )}\n`,
      );
    }
    break;
  }

  // ------------------------------------------------------------------------------- resolve ---
  // What the fragment MEANS once the answers are in: which models exist, which tiers it can back,
  // and which shell environment variables have to be exported for any of it to work.
  case "resolve": {
    const [dir, id, answersFile] = argv;
    if (!dir || !id) fatal("resolve needs <dir> <id> [answers-file]");
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) fatal(`no fragment for provider "${id}"`);
    const f = loadFragment(file);
    const tokens = tokenTable(f, loadAnswers(answersFile));
    const block = substitute(f, f.provider, tokens);
    if (block === DELETE_ME) fatal(`${id}: the entire provider block resolved away, which cannot be right`);

    for (const m of block.models ?? []) {
      process.stdout.write(`${tsv("MODEL", `${id}/${m.id}`, m.name ?? m.id)}\n`);
    }
    // A built-in provider ships its own model list; the fragment only overrides parts of it, so
    // modelOverrides is the closest thing to a roster available without starting PI.
    for (const k of Object.keys(block.modelOverrides ?? {})) {
      process.stdout.write(`${tsv("MODEL", `${id}/${k}`, `${f.displayName} ${k}`)}\n`);
    }
    for (const [tier, template] of Object.entries(f.tiers ?? {})) {
      const bound = substituteString(f, String(template), tokens);
      // README §2.4: a binding whose substitution leaves a blank segment is DROPPED, not written
      // with a hole in it — "databricks/" parses fine and fails at the first request.
      if (bound.split("/").some((seg) => seg.trim() === "")) continue;
      process.stdout.write(`${tsv("TIER", tier, bound)}\n`);
    }

    // Non-secret environment variables the provider needs exported. Their VALUE cannot be read out
    // of the schema — there is no declarative link from DATABRICKS_HOST to the workspaceHost
    // answer — so a suggestion is derived from the resolved endpoint and the installer asks the
    // user to confirm it. A documented heuristic, not magic: a name ending in _URL/_BASE_URL gets
    // the baseUrl verbatim, one ending in _HOST gets its origin, anything else is offered blank.
    // The counterpart to describe's skip: a requirement whose name was deferred to an answer is
    // reported HERE, where the answer exists. The name is the user's own variable name, so it is
    // the one thing about this requirement the fragment could not have known.
    for (const r of f.requires ?? []) {
      if (!deferredTo(r.name)) continue;
      const name = substituteString(f, r.name, tokens);
      if (!name) continue; // the prompt was skipped or left blank — there is no credential to ask for
      process.stdout.write(
        `${tsv("CRED", r.kind, name, r.required ? "1" : "0", r.secret ? "1" : "0", r.description, r.howTo)}\n`,
      );
    }

    // README §2.7: the verification one-liners. They are emitted HERE rather than by `describe`
    // because a fragment writes them against its own tokens ({{baseUrl}}, the credential variable
    // the user named), and describe runs before the first question — printing them there would
    // hand the operator a command with {{placeholders}} still in it.
    for (const v of f.verify ?? []) {
      process.stdout.write(
        `${tsv("VERIFY", substituteString(f, String(v.label), tokens), substituteString(f, String(v.command), tokens))}\n`,
      );
    }

    for (const r of f.requires ?? []) {
      if (r.kind !== "env" || r.secret || deferredTo(r.name)) continue;
      let suggestion = "";
      const baseUrl = typeof block.baseUrl === "string" ? block.baseUrl : "";
      if (baseUrl) {
        if (/_(BASE_)?URL$/.test(r.name)) suggestion = baseUrl;
        else if (/_HOST$/.test(r.name)) {
          try { suggestion = new URL(baseUrl).origin; } catch { suggestion = ""; }
        }
      }
      process.stdout.write(`${tsv("ENV", r.name, suggestion, r.required ? "1" : "0", r.description)}\n`);
    }
    break;
  }

  // --------------------------------------------------------------------------------- match ---
  // Prompt validation. Fragments carry ECMAScript regexes, which bash cannot evaluate; rather than
  // approximating them with `case` globs, ask the engine that owns the dialect.
  case "match": {
    const [pattern, value] = argv;
    if (pattern === undefined) fatal("match needs <pattern> <value>");
    let re;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      fatal(`invalid validate.pattern ${JSON.stringify(pattern)}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    process.exit(re.test(value ?? "") ? 0 : 1);
    break;
  }

  // --------------------------------------------------------------------------------- tiers ---
  case "tiers": {
    const [routingDefault] = argv;
    if (!routingDefault) fatal("tiers needs <routing.default.json>");
    if (!existsSync(routingDefault)) process.exit(1);
    const routing = loadJSON(routingDefault);
    const tiers = routing.tiers ?? {};
    for (const name of TIER_NAMES) {
      const t = tiers[name];
      if (!t) continue;
      // `confidential` is the one a given machine may legitimately be unable to back at all — it
      // needs an endpoint inside the operator's own boundary, and the shipped table leaves it in
      // `tiersUnbound` for exactly that reason. `strong` and `light` are what every agent and skill
      // dispatches on, so leaving either unbound is a broken install rather than a choice.
      const optional = name === "confidential" ? "1" : "0";
      process.stdout.write(`${tsv(name, optional, t.purpose ?? "", t.model ?? "", t.thinkingLevel ?? "")}\n`);
    }
    break;
  }

  // ------------------------------------------------------------------------------ generate ---
  case "generate": {
    const flags = parseFlags(argv);
    const dir = flags["providers-dir"];
    if (!dir) fatal("generate needs --providers-dir");
    const selected = (flags.select ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (selected.length === 0) fatal("generate needs --select with at least one provider id");
    const answers = loadAnswers(flags.answers ?? "");

    const models = flags["models-default"] && existsSync(flags["models-default"])
      ? loadJSON(flags["models-default"]) : {};
    const routing = flags["routing-default"] && existsSync(flags["routing-default"])
      ? loadJSON(flags["routing-default"]) : {};

    models.providers = models.providers ?? {};
    routing.tiers = routing.tiers ?? {};
    routing.egress = routing.egress ?? {};
    routing.concurrency = routing.concurrency ?? {};

    /** @type {Map<string, any>} */
    const frags = new Map();
    for (const id of selected) {
      const file = join(dir, `${id}.json`);
      if (!existsSync(file)) {
        fatal(`selected provider "${id}" has no fragment at ${file} — available: ${fragmentFiles(dir).map((p) => basename(p, ".json")).join(", ")}`);
      }
      frags.set(id, loadFragment(file));
    }

    // README §4: a selected fragment REPLACES the default's block for the same id; it does not
    // deep-merge. A half-merged modelOverrides map would be worse than either version.
    for (const [id, f] of frags) {
      const tokens = tokenTable(f, answers);
      models.providers[id] = substitute(f, f.provider, tokens);
      // egress and concurrency are normally literals in the fragment. A gateway provider is the
      // one case where neither can be known in advance — the same base URL may be a public
      // aggregator or an in-house proxy — so both may defer to an answer. The resolved value is
      // re-validated: a bad answer must not reach routing.json, where egress decides whether a
      // confidential session may dispatch here at all.
      routing.egress[id] = resolveEgress(f, tokens);
      routing.concurrency[id] = resolveConcurrency(f, tokens);
    }

    // README §4: "If the user deselects github-copilot, remove it: an unused provider block is
    // inert, but a tier bound to a provider nobody configured is not."
    for (const id of Object.keys(models.providers)) {
      if (frags.has(id)) continue;
      delete models.providers[id];
      delete routing.egress[id];
      delete routing.concurrency[id];
    }
    if (Object.keys(models.providers).length === 0) {
      fatal("the generated models.json would contain no providers at all — nothing would be able to run");
    }

    // Every model this file declares leaves here with a price, or does not leave here at all.
    //
    // `cost` is optional in models.json and required on PI's runtime model type, and PI closes the
    // gap by substituting {input:0,output:0,cacheRead:0,cacheWrite:0} — after which a rate somebody
    // wrote and a rate nobody wrote are the same object, the status line reads a flat $0.000 for
    // the whole session, and `extensions/cost-gate` ends the first BILLED turn rather than let it
    // stand. Catching it here costs a re-run of the interview; catching it there costs the turn.
    //
    // Two declarations are accepted, the same two the gate and `bin/pi-check` rule PC-27 accept:
    // the rates, in dollars per million tokens, or four written zeros for an endpoint that is
    // unmetered on purpose. An omission says neither, and neither does a blank answer — which is
    // the case this actually catches, an --answers file that names a metered model and no rate.
    // Providers declaring no `models` array are skipped, exactly as both of those gates skip them:
    // `modelOverrides` corrects a catalogue PI already prices, and `cost` is not overridable there.
    for (const [id, block] of Object.entries(models.providers)) {
      if (!block || typeof block !== "object" || !Array.isArray(block.models)) continue;
      for (const m of block.models) {
        if (!m || typeof m !== "object") continue;
        const missing = ["input", "output", "cacheRead", "cacheWrite"]
          .filter((f) => typeof m.cost?.[f] !== "number" || !Number.isFinite(m.cost[f]));
        if (missing.length === 0) continue;
        fatal(
          `${id}/${m.id}: ${missing.map((f) => `cost.${f}`).join(", ")} is not a number, so PI would ` +
            "substitute zeros and every session on this model would report $0.000 no matter what it " +
            `charges. Answer ${id}'s pricing question with the rates in DOLLARS PER MILLION TOKENS, ` +
            "or with the unmetered option, which writes four explicit zeros. Nothing was written.",
        );
      }
    }

    // --- tier bindings ------------------------------------------------------------------------
    // Two different failures, deliberately treated differently:
    //   * a tier the user explicitly bound to a provider they did NOT install is an ERROR: it is a
    //     contradiction in what they just asked for, and quietly rewriting it would be exactly the
    //     silent substitution this harness refuses.
    //   * a tier that nobody selected can back is removed and recorded in `tiersUnbound` with a
    //     reason, per README §4. install.sh reports each one by name.
    /** @type {Record<string,string>} */
    const unbound = {};
    /** @type {string[]} */
    const problems = [];
    for (const name of Object.keys(routing.tiers)) {
      const answer = (answers.get(`tier.${name}`) ?? "").trim();
      const entry = routing.tiers[name];
      if (answer === "") {
        delete routing.tiers[name];
        unbound[name] = `no installed provider was bound to the "${name}" tier`;
        continue;
      }
      const slash = answer.indexOf("/");
      const provider = slash > 0 ? answer.slice(0, slash) : "";
      const model = slash > 0 ? answer.slice(slash + 1) : "";
      if (!provider || !model) {
        problems.push(`tier "${name}" is bound to "${answer}", which is not in provider/model-id form`);
        continue;
      }
      if (!frags.has(provider)) {
        problems.push(`tier "${name}" points at provider "${provider}", which was NOT installed (installed: ${selected.join(", ")})`);
        continue;
      }
      routing.tiers[name] = {
        model: answer,
        ...(entry && entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
        ...(entry && entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
      };
    }
    // A tier the answers bind that the routing template does not mention: a fragment may suggest
    // one the generic default left unbound (`confidential` is the usual case).
    for (const [k, v] of answers) {
      if (!k.startsWith("tier.")) continue;
      const name = k.slice(5);
      const val = v.trim();
      if (!val || routing.tiers[name]) continue;
      if (!TIER_NAMES.includes(name)) {
        problems.push(`tier "${name}" is outside the fixed vocabulary ${TIER_NAMES.join(", ")}`);
        continue;
      }
      const slash = val.indexOf("/");
      const provider = slash > 0 ? val.slice(0, slash) : "";
      if (!frags.has(provider)) {
        problems.push(`tier "${name}" points at provider "${provider || val}", which was NOT installed (installed: ${selected.join(", ")})`);
        continue;
      }
      delete unbound[name];
      routing.tiers[name] = { model: val };
    }

    if (problems.length > 0) {
      fatal(
        `the tier bindings do not hold:\n  - ${problems.join("\n  - ")}\n` +
          "  Nothing was written. Re-run and bind each tier to a provider you actually installed; there is no fallback in this harness, by design.",
      );
    }
    if (Object.keys(unbound).length > 0) routing.tiersUnbound = unbound;
    else delete routing.tiersUnbound;

    // README §4: onProviderError is copied through untouched, and no prompt may offer to change
    // it. Asserting it here means a hand-edited default cannot quietly reintroduce failover.
    if (routing.onProviderError && routing.onProviderError.policy !== "abort") {
      fatal(`routing.default.json sets onProviderError.policy="${routing.onProviderError.policy}"; only "abort" is allowed — this harness has no provider failover`);
    }

    const modelsOut = `${JSON.stringify(models, null, 2)}\n`;
    const routingOut = `${JSON.stringify(routing, null, 2)}\n`;

    // Rule 5: a surviving {{token}} is a bug in this file, not something to paper over.
    for (const [what, text] of [["models.json", modelsOut], ["routing.json", routingOut]]) {
      const left = text.match(TOKEN_RE);
      if (left) fatal(`the generated ${what} still contains ${left.join(", ")} — refusing to write it`);
    }

    if (flags["print-only"]) {
      process.stdout.write(modelsOut);
      process.stdout.write(routingOut);
      break;
    }
    const outModels = flags["out-models"];
    const outRouting = flags["out-routing"];
    if (!outModels || !outRouting) fatal("generate needs --out-models and --out-routing, or --print-only");
    mkdirSync(dirname(outModels), { recursive: true });
    writeFileSync(outModels, modelsOut);
    writeFileSync(outRouting, routingOut);
    process.stdout.write(`${tsv("WROTE", outModels)}\n`);
    process.stdout.write(`${tsv("WROTE", outRouting)}\n`);
    for (const [name, t] of Object.entries(routing.tiers)) {
      process.stdout.write(`${tsv("TIER", name, typeof t === "string" ? t : t.model)}\n`);
    }
    for (const [name, why] of Object.entries(unbound)) {
      process.stdout.write(`${tsv("UNBOUND", name, why)}\n`);
    }
    break;
  }

  default:
    fatal(`unknown subcommand '${cmd ?? ""}' — see the header of this file`);
}

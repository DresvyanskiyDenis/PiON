#!/usr/bin/env node
// json.mjs — the shell scripts' JSON reader. Replaces `jq`, which this repo may NOT assume.
//
// Why this file exists at all: every shell script here used to open with `command -v jq ||
// exit 2`. On a locked-down corporate machine `jq` is frequently absent and frequently
// un-installable, while Node is a hard prerequisite of the harness anyway (PI's npm install
// path needs it, and `bin/pi-check` is written in it). So the one JSON dependency the shell
// layer is allowed to have is the one that is already mandatory.
//
// Deliberately tiny and deliberately not a jq clone: it implements the eight shapes the shell
// scripts actually ask for, each as a named subcommand, so a reader can tell what a call site
// wants without learning a query language.
//
//   get <file> <dotted.path>      print a scalar, or one array element / object key per line
//   keys <file> [dotted.path]     print the keys of an object, one per line
//   has <file> <dotted.path>      exit 0 if the path exists and is not null, 1 otherwise
//   string <text>                 print <text> as a JSON string literal (jq -Rn --arg $v '$v')
//   apikey-refs <models.json>     TAB-separated "provider<TAB>apiKeyRef" for $ENV / !command refs
//   rows <file> <path> <f>...     one line per array element, fields separated by US (0x1f)
//   find-key <file> <key>         every value of <key> anywhere in the tree, one per line
//   doctor-field <field...>       read a `--mode json` stream on stdin, print one doctor field
//
// Exit codes: 0 success, 1 "asked a well-formed question, answer is absent/false", 2 the tool
// itself could not run (bad args, unreadable/unparseable file). Callers distinguish 1 from 2.

import { readFileSync } from "node:fs";

// A shell caller that pipes this into `head` closes the pipe early; an unhandled EPIPE would turn
// that into a stack trace and an exit code the caller reads as a real failure.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

/** @param {string} msg */
function fatal(msg) {
  process.stderr.write(`json.mjs: ${msg}\n`);
  process.exit(2);
}

/** @param {string} file @returns {unknown} */
function loadJSON(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    fatal(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fatal(`cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Walk a dotted path. A path segment is matched literally against object keys first, so a key
 * that itself contains a dot (a model id like "qwen/qwen3-coder" never does, but a provider key
 * could) still resolves when it is the whole remaining path.
 * @param {unknown} root @param {string} path @returns {unknown}
 */
function pick(root, path) {
  if (!path || path === "." || path === "") return root;
  let cur = root;
  for (const seg of path.replace(/^\./, "").split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      cur = cur[Number(seg)];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[seg];
  }
  return cur;
}

/** One value per line; objects print their keys, arrays their elements. @param {unknown} v */
function emit(v) {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) {
    for (const el of v) process.stdout.write(`${scalar(el)}\n`);
    return;
  }
  if (typeof v === "object") {
    for (const k of Object.keys(v)) process.stdout.write(`${k}\n`);
    return;
  }
  process.stdout.write(`${scalar(v)}\n`);
}

/** @param {unknown} v @returns {string} */
function scalar(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "get": {
    const [file, path] = rest;
    if (!file) fatal("get needs <file> [path]");
    const v = pick(loadJSON(file), path ?? "");
    if (v === undefined || v === null) process.exit(1);
    emit(v);
    break;
  }

  case "keys": {
    const [file, path] = rest;
    if (!file) fatal("keys needs <file> [path]");
    const v = pick(loadJSON(file), path ?? "");
    if (v === null || typeof v !== "object") process.exit(1);
    for (const k of Object.keys(v)) process.stdout.write(`${k}\n`);
    break;
  }

  case "has": {
    const [file, path] = rest;
    if (!file || path === undefined) fatal("has needs <file> <path>");
    const v = pick(loadJSON(file), path);
    process.exit(v === undefined || v === null || v === false ? 1 : 0);
    break;
  }

  case "string": {
    // rest.join(" ") rather than rest[0]: the shell splits an unquoted detail string into many
    // argv entries, and every caller here wants them back as one line.
    process.stdout.write(`${JSON.stringify(rest.join(" "))}\n`);
    break;
  }

  case "apikey-refs": {
    // REQ-PRV-12b's input: which providers declare a credential *reference* (never its value).
    const [file] = rest;
    if (!file) fatal("apikey-refs needs <models.json>");
    const providers = pick(loadJSON(file), "providers");
    if (!providers || typeof providers !== "object") process.exit(1);
    for (const [name, block] of Object.entries(providers)) {
      const key = block && typeof block === "object" ? /** @type {any} */ (block).apiKey : undefined;
      if (typeof key === "string" && /^[$!]/.test(key)) {
        process.stdout.write(`${name}\t${key}\n`);
      }
    }
    break;
  }

  case "rows": {
    // Projects an array of objects into a record stream the shell can `while read` — the shape
    // config/providers/<id>.json's `requires[]` needs.
    //
    // The separator is US (0x1f), NOT tab. Tab is an IFS *whitespace* character, so
    // `IFS=$'\t' read -r a b c` silently collapses two consecutive tabs into one and shifts every
    // field after an empty one. US is not whitespace, so an absent field stays an empty field.
    const [file, path, ...fields] = rest;
    if (!file || path === undefined || fields.length === 0) fatal("rows needs <file> <path> <field>...");
    const arr = pick(loadJSON(file), path);
    if (!Array.isArray(arr)) process.exit(1);
    for (const el of arr) {
      process.stdout.write(`${fields.map((f) => scalar(pick(el, f))).join("\u001f")}\n`);
    }
    break;
  }

  case "find-key": {
    // jq's `.. | .someKey? // empty`. Used against streams whose nesting is not ours to predict —
    // PI's `--mode json` transcript, where the depth of a field like `fullOutputPath` is an
    // implementation detail of whichever tool emitted it.
    //
    // The file may be one JSON document OR a newline-delimited stream of them (that is what
    // `pi --mode json` writes), so a whole-file parse failure is not an error here — it just means
    // "try again line by line". Anything that parses as neither is reported as no match, exit 1.
    const [file, key] = rest;
    if (!file || !key) fatal("find-key needs <file> <key>");
    const docs = [];
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      fatal(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      docs.push(JSON.parse(text));
    } catch {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t === "" || !(t.startsWith("{") || t.startsWith("["))) continue;
        try {
          docs.push(JSON.parse(t));
        } catch {
          /* a non-JSON line in a JSON stream is normal noise */
        }
      }
    }
    const hits = [];
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const el of node) walk(el);
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === key && v !== null && v !== undefined) hits.push(scalar(v));
        walk(v);
      }
    };
    for (const d of docs) walk(d);
    if (hits.length === 0) process.exit(1);
    for (const h of hits) process.stdout.write(`${h}\n`);
    break;
  }

  case "doctor-field": {
    // `pi --mode json` emits one JSON object per line plus non-JSON noise. Find the last line
    // that looks like a /doctor report and print the first field name that resolves in it.
    // Both the top level and a `.data` envelope are accepted — EXT-10 owns that schema and has
    // changed it once already, so this stays a forward-compatible best-effort matcher.
    const wanted = rest;
    if (wanted.length === 0) fatal("doctor-field needs at least one field path");
    const stdin = readFileSync(0, "utf8");
    /** @type {any} */
    let report = null;
    for (const line of stdin.split("\n")) {
      if (!line.startsWith("{")) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const probe = obj && typeof obj === "object" ? obj : null;
      if (!probe) continue;
      const looksLikeReport = ["modules", "skills", "tools"].some(
        (k) => probe[k] !== undefined || (probe.data && probe.data[k] !== undefined),
      );
      if (looksLikeReport) report = probe;
    }
    if (!report) process.exit(1);
    for (const path of wanted) {
      let v = pick(report, path);
      if (v === undefined) v = pick(report.data ?? {}, path);
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        // Elements may be plain strings or {name} objects; the shell only ever wants the names.
        process.stdout.write(
          `${v.map((el) => (el && typeof el === "object" ? scalar(/** @type {any} */ (el).name) : scalar(el))).join(",")}\n`,
        );
      } else {
        process.stdout.write(`${scalar(v)}\n`);
      }
      process.exit(0);
    }
    process.exit(1);
    break;
  }

  default:
    fatal(`unknown subcommand '${cmd ?? ""}' — see the header of this file`);
}

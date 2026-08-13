#!/usr/bin/env node
// configure.mjs — apply the installer's answers to one JSON config file, in place.
//
// scripts/install.sh asks the questions; this applies them. It exists because editing JSON from
// bash means sed, and sed on JSON is how config files get corrupted. Every write here goes
// through JSON.parse -> mutate -> JSON.stringify, so a malformed result is impossible: either
// the file parses and is rewritten whole, or nothing is written at all.
//
//   init  <file> [template]        create <file> from <template> if it does not exist yet
//   set   <file> <path=value>...   patch dotted paths, preserving every other key
//   show  <file> <path>...         print "path<TAB>value" for each, for the review screen
//
// Value typing, because a config file cares about the difference between "3" and 3:
//   true|false            -> boolean          120000            -> number
//   [a, b, c]             -> array of strings (trimmed, empty entries dropped)
//   str:...               -> forced string    json:{"a":1}      -> parsed as JSON
//   (empty)               -> deletes the key entirely, rather than writing null
//
// Exit: 0 written (or already correct), 1 nothing to do, 2 could not run.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** @param {string} msg */
function fatal(msg) {
  process.stderr.write(`configure.mjs: ${msg}\n`);
  process.exit(2);
}

/** @param {string} file @returns {any} */
function load(file) {
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf8").trim();
    return raw === "" ? {} : JSON.parse(raw);
  } catch (err) {
    fatal(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — refusing to rewrite it`);
  }
}

/** @param {string} raw @returns {unknown} */
function coerce(raw) {
  const v = raw.trim();
  if (v === "") return undefined;
  if (v.startsWith("str:")) return v.slice(4);
  if (v.startsWith("json:")) {
    try {
      return JSON.parse(v.slice(5));
    } catch (err) {
      fatal(`json: value is not valid JSON: ${v.slice(5)}`);
    }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return v;
}

/** @param {any} root @param {string} path @param {unknown} value */
function setPath(root, path, value) {
  const segs = path.split(".");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i];
    // An array stays an array: `roots.0.path` on an existing array must index into it, not
    // replace it with {"0": ...}. Doing the latter turns a valid config into one whose owning
    // module rejects it ("roots must be an array") — measured, not theorised.
    if (Array.isArray(cur[s]) && /^\d+$/.test(segs[i + 1])) { cur = cur[s]; continue; }
    if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  // An empty answer deletes rather than writing null: a key that is absent falls back to the
  // module's own documented default, whereas an explicit null usually does not.
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/** @param {any} root @param {string} path @returns {unknown} */
function getPath(root, path) {
  let cur = root;
  for (const s of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[s];
  }
  return cur;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "init": {
    const [file, template] = rest;
    if (!file) fatal("init needs <file> [template]");
    if (existsSync(file)) process.exit(1);
    mkdirSync(dirname(file), { recursive: true });
    if (template && existsSync(template)) copyFileSync(template, file);
    else writeFileSync(file, "{}\n");
    process.stdout.write(`${file}\n`);
    break;
  }

  case "set": {
    const [file, ...pairs] = rest;
    if (!file || pairs.length === 0) fatal("set needs <file> <path=value>...");
    const data = load(file);
    let touched = 0;
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq === -1) fatal(`'${pair}' is not path=value`);
      const path = pair.slice(0, eq);
      const value = coerce(pair.slice(eq + 1));
      const before = JSON.stringify(getPath(data, path));
      setPath(data, path, value);
      if (JSON.stringify(getPath(data, path)) !== before) touched += 1;
    }
    if (touched === 0) process.exit(1); // already correct — the caller prints "ok", not "changed"
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    process.stdout.write(`${touched}\n`);
    break;
  }

  case "show": {
    const [file, ...paths] = rest;
    if (!file) fatal("show needs <file> <path>...");
    const data = load(file);
    for (const p of paths) {
      const v = getPath(data, p);
      process.stdout.write(`${p}\t${v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)}\n`);
    }
    break;
  }

  default:
    fatal(`unknown subcommand '${cmd ?? ""}'`);
}

// bin/lib/packages.mjs — shared readers for the package-ledger rules (PC-17, PC-18, PC-19).
//
// Zero dependencies beyond node:fs/node:path, matching pi-check's own constraint (§5.1). Pure
// filesystem reads only — no process spawn, no network — so every consumer of this file stays
// eligible for the offline "--all"/"--only packages" default path. PC-19 is the sole exception
// in the rule tree, and it does its own network I/O directly, not through here.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** @typedef {import("../types.mjs").RuleContext} RuleContext */

/**
 * @typedef {Object} LockEntry
 * @property {string} name
 * @property {string} version
 * @property {string} [license]
 * @property {boolean} [vendor]
 * @property {string} [status]
 * @property {boolean} [licenseTextShipped] explicit ledger acknowledgement read by PC-17: `false`
 *   means "reviewed, the tarball ships no licence text, and that was accepted".
 * @property {string} [licenseTextNote]
 */

export const LOCK_PATH = "config/packages.lock.json";
export const PACKAGES_MD_PATH = "docs/PACKAGES.md";

/**
 * @param {RuleContext} ctx
 * @returns {{ entries: LockEntry[] } | { error: string }}
 */
export function readPackagesLock(ctx) {
  if (!ctx.exists(LOCK_PATH)) return { entries: [] }; // no lock file yet is not this tool's problem
  let parsed;
  try {
    parsed = ctx.readJSON(LOCK_PATH);
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
  const entries = Array.isArray(parsed?.packages) ? parsed.packages : [];
  return { entries };
}

// Per-package section header convention, restated in docs/PACKAGES.md's own "How to read a
// row" note: "## `name` version". This is a different table shape from the ROW regex in
// pc-09 (which reads the *summary* table's `| \`name\` | ...` rows) — this one reads section
// headers, which is what carries the per-package pinned version this repo actually maintains.
const HEADER_RE = /^## `([^`]+)`\s+(\S+)\s*$/;

/**
 * @param {RuleContext} ctx
 * @returns {Map<string, { version: string, line: number }>}
 */
export function readPackagesMdVersions(ctx) {
  const map = new Map();
  for (const { line, text } of ctx.lines(PACKAGES_MD_PATH)) {
    const m = HEADER_RE.exec(text);
    if (m) map.set(m[1], { version: m[2], line });
  }
  return map;
}

/**
 * The directory a package was actually installed into, preferring a deep-copied `vendor/`
 * tree (credential-path packages, PACKAGES.md §1.6 rule 4) over the ordinary `node_modules/`
 * install. Returns null when neither exists — a lock entry can legitimately be reviewed and
 * pinned before it lands on disk (another item's job), so "not installed yet" is not a finding.
 * @param {RuleContext} ctx @param {string} name
 * @returns {{ relDir: string, absDir: string } | null}
 */
export function installedPackageDir(ctx, name) {
  for (const base of ["vendor", "node_modules"]) {
    const relDir = `${base}/${name}`;
    if (ctx.exists(relDir)) {
      const absDir = join(ctx.repoRoot, relDir);
      if (statSync(absDir).isDirectory()) return { relDir, absDir };
    }
  }
  return null;
}

/**
 * The npm id behind one `config/settings.json` `packages[]` entry.
 *
 * PI's `packages` array accepts npm ids, git urls AND local paths (see
 * docs/getting-started/install.md), and this harness deliberately wires every package by
 * **local path** — `~/pi-config/node_modules/<id>` for the npm-resolved ones and
 * `~/pi-config/pi-packages/<id>` for the vendored one. That is what keeps a session start from
 * making a network call on a locked-down machine: an npm-sourced id makes PI install it at
 * startup once the project is trusted.
 *
 * The ledgers (`docs/PACKAGES.md`, `config/packages.lock.json`) are keyed by npm id, so every
 * ledger rule has to map the path back to the id before it can say anything true. Without this,
 * PC-09 and PC-18 report all seven wired packages as unreviewed and unpinned when in fact every
 * one of them has a row — a false red that would train a reader to ignore the gate.
 *
 * @param {unknown} entry one element of settings.packages
 * @returns {string | null} the npm id, or null when the entry has no derivable id
 */
export function packageIdFromSettingsEntry(entry) {
  let raw = entry;
  if (raw && typeof raw === "object") {
    const obj = /** @type {Record<string, unknown>} */ (raw);
    raw = obj.source ?? obj.name ?? obj.path;
  }
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/\/+$/, "");
  if (value === "") return null;

  const segments = value.split("/");
  // A local path (or a git url) — take the id that follows the install root, so both
  // `.../node_modules/@scope/name` and `.../pi-packages/name` resolve.
  const isPath = /^[~./]/.test(value) || segments.includes("node_modules") || segments.includes("pi-packages");
  if (isPath) {
    let start = -1;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i] === "node_modules" || segments[i] === "pi-packages") {
        start = i + 1;
        break;
      }
    }
    // No recognised install root: fall back to the trailing one-or-two segments.
    if (start === -1) start = segments[segments.length - 2]?.startsWith("@") ? segments.length - 2 : segments.length - 1;
    const tail = segments.slice(start).filter((s) => s !== "");
    if (tail.length === 0) return null;
    return tail[0].startsWith("@") ? tail.slice(0, 2).join("/") : tail[0];
  }

  // A plain npm id, possibly version-suffixed (`name@1.2.3`, `@scope/name@1.2.3`).
  if (value.startsWith("@")) {
    const at = value.indexOf("@", 1);
    return at === -1 ? value : value.slice(0, at);
  }
  const at = value.indexOf("@");
  return at === -1 ? value : value.slice(0, at);
}

const LICENSE_NAME_RE = /^licen[sc]e/i;

/**
 * Mirrors docs/PACKAGES.md's own review method verbatim ("find package -maxdepth 2 -iname
 * 'licen[sc]e*'" — note the doc's own trap 1: never a shell glob, always a real directory
 * read): a licence file directly in the package root, or one level below it.
 * @param {string} absDir
 * @returns {string | null} the relative file name found (possibly "subdir/LICENSE"), or null
 */
export function findLicenseFile(absDir) {
  if (!existsSync(absDir)) return null;
  let topEntries;
  try {
    topEntries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return null; // unreadable directory — not this tool's problem to fail on
  }
  for (const entry of topEntries) {
    if (entry.isFile() && LICENSE_NAME_RE.test(entry.name)) return entry.name;
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const sub = join(absDir, entry.name);
    let subEntries;
    try {
      subEntries = readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subEntries) {
      if (s.isFile() && LICENSE_NAME_RE.test(s.name)) return `${entry.name}/${s.name}`;
    }
  }
  return null;
}

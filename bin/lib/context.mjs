// bin/lib/context.mjs — the RuleContext factory for pi-check.
//
// Zero dependencies (no `node:child_process`, no network module, no read of `~/.pi/agent`).
// Every rule module gets its filesystem access through this context so the "never resolves
// a credential, never touches the network, never invokes another binary" guarantee
// (REQ-PRV-12a) is enforced in one place rather than trusted per-rule.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories that are never shipped code and are always skipped by a repo-wide walk. */
const ALWAYS_EXCLUDED = new Set(["node_modules", ".git", "dist"]);

/**
 * @param {string} dir absolute path
 * @param {string} repoRoot absolute path
 * @param {{ exts?: string[], excludeDirs?: string[] }} opts
 * @returns {string[]} paths relative to repoRoot, POSIX-separated
 */
function walk(dir, repoRoot, opts) {
  const exts = opts.exts ?? null;
  const excluded = new Set([...ALWAYS_EXCLUDED, ...(opts.excludeDirs ?? [])]);
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;

  /** @param {string} current */
  function recurse(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race) — not this tool's problem to fail on
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        recurse(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (exts && !exts.some((ext) => entry.name.endsWith(ext))) continue;
      const rel = relative(repoRoot, join(current, entry.name)).split(sep).join("/");
      out.push(rel);
    }
  }
  recurse(dir);
  return out;
}

/**
 * @param {string} repoRoot absolute path to the tree under validation
 * @param {{ live?: boolean }} [opts]
 *   `live: true` grants PC-19 (and only PC-19 — every other rule ignores this flag entirely)
 *   permission to spawn `npm` and touch the network. Default false keeps every rule offline.
 * @returns {import("../types.mjs").RuleContext}
 */
export function createContext(repoRoot, opts = {}) {
  const live = Boolean(opts.live);
  /** @param {string} relPath */
  function abs(relPath) {
    return join(repoRoot, relPath);
  }

  /** @param {string} relPath */
  function exists(relPath) {
    return existsSync(abs(relPath));
  }

  /** @param {string} relPath */
  function readText(relPath) {
    const p = abs(relPath);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  }

  /** @param {string} relPath */
  function readJSON(relPath) {
    const text = readText(relPath);
    if (text === null) {
      throw new Error(`pi-check: cannot read "${relPath}" — file does not exist under ${repoRoot}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`pi-check: "${relPath}" is not valid JSON — ${String(err.message ?? err)}`);
    }
  }

  /** @param {string} relPath */
  function lines(relPath) {
    const text = readText(relPath);
    if (text === null) return [];
    return text.split("\n").map((text, i) => ({ line: i + 1, text }));
  }

  /** @param {{ dir: string, exts?: string[], excludeDirs?: string[] }} opts */
  function listFiles(opts) {
    const isFile = existsSync(abs(opts.dir)) && statSync(abs(opts.dir)).isFile();
    if (isFile) {
      const rel = opts.dir.split(sep).join("/");
      if (!opts.exts || opts.exts.some((ext) => rel.endsWith(ext))) return [rel];
      return [];
    }
    return walk(abs(opts.dir), repoRoot, opts);
  }

  /**
   * @param {string} text
   * @param {number} matchIndex
   */
  function isProviderQualified(text, matchIndex) {
    // Walk backwards from the match looking for a '/' before we hit a boundary character
    // that could not appear inside a bare identifier or a "provider/id" token.
    let i = matchIndex - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "/") return true;
      if (/["'`,:\{\}\[\]\s]/.test(ch)) return false;
      i--;
    }
    return false;
  }

  return { repoRoot, live, exists, readText, readJSON, lines, listFiles, isProviderQualified };
}

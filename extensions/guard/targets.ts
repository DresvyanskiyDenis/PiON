/**
 * Harvests every plausible filesystem target from a tool call, whatever the tool is.
 *
 * F3: this used to scan only a fixed key allowlist (`file_path` / `filePath` / `path` / `files[]`
 * / …), which made any other argument shape — `uri`, `args`, a nested `params.path` — default
 * ALLOW for `secretPathsGate`. An unknown MCP server or community package can name its path
 * argument anything, so target harvesting now walks every string leaf of `event.input`
 * recursively, depth-bounded and leaf-capped so a pathological input cannot hang the gate. Bash
 * commands still contribute their tokenized word list, so `cat ~/.ssh/id_rsa` is caught as a path.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { tokenize } from "./shell.ts";

/** Argument names that carry a shell command. */
const COMMAND_KEYS = ["command", "cmd", "script"] as const;

/** Recursion bound for `collectStringLeaves` — deep enough for any real tool schema. */
const MAX_LEAF_DEPTH = 6;

/** Leaf cap for `collectStringLeaves` — a pathological input must not hang the gate. */
const MAX_LEAVES = 500;

/**
 * Every non-empty string reachable from `value` by walking objects and arrays, depth- and
 * count-bounded, cycle-safe. This is what replaces the old key allowlist (F3): the SEC deny table
 * is regex-on-string, so running it over every leaf — not just leaves under known key names — is
 * negligible cost and closes the unknown-tool-shape gap.
 */
export function collectStringLeaves(
  value: unknown,
  out: string[] = [],
  depth = 0,
  seen: Set<object> = new Set(),
): string[] {
  if (out.length >= MAX_LEAVES) return out;
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  if (depth >= MAX_LEAF_DEPTH) return out;
  if (seen.has(value)) return out; // cycle guard
  seen.add(value);

  const entries: unknown[] = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    if (out.length >= MAX_LEAVES) return out;
    collectStringLeaves(entry, out, depth + 1, seen);
  }
  return out;
}

/** Every shell command string reachable from a tool call, whatever the tool is called. */
export function commandStrings(event: ToolCallEvent): string[] {
  const input = event.input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) out.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim().length > 0) out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Returns both the literal argument and its `cwd`-resolved absolute form. Gates match on both:
 * `(^|/)\.env$` has to catch a bare `.env` as well as `/repo/.env`, and resolving is the only
 * way `../../.ssh/id_rsa` becomes visible as an `.ssh` path.
 */
export function collectTargets(event: ToolCallEvent, cwd: string): string[] {
  const raw: string[] = collectStringLeaves(event.input);

  // Command extraction stays distinct from the generic leaf walk above (F3): a string harvested
  // from an unknown key is tested against the path/secret table like any other leaf, but only the
  // known command keys (`command` / `cmd` / `script`) are fed to the shell tokenizer as commands.
  for (const command of commandStrings(event)) {
    for (const segment of tokenize(command)) {
      raw.push(...segment.words, ...segment.redirects);
    }
  }

  const out = new Set<string>();
  for (const candidate of raw) {
    const expanded = expandTilde(candidate);
    out.add(expanded);
    if (looksLikeAPath(expanded)) out.add(resolve(cwd, expanded));
  }
  return [...out];
}

/** `~` and `~/x` only. `~user/x` is deliberately left alone: we do not know other users' homes. */
export function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

/**
 * Resolving every word of a command against `cwd` would turn `-rf` into `<cwd>/-rf`. Harmless,
 * but it doubles the candidate list for nothing, so flags and option-values are skipped.
 */
function looksLikeAPath(value: string): boolean {
  if (value.startsWith("-")) return false;
  if (value.includes("\n")) return false;
  if (isAbsolute(value)) return true;
  return !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

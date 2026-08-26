/**
 * The `session_start` fingerprint scan.
 *
 * Closes the gap a purely lazy, on-read design has: without this, "read a file, then edit it,
 * same turn" never sees its rule, because the only PI event that can inject text non-blockingly
 * (`before_agent_start`) has already run before either tool call, and the only event that can see
 * a tool call before it executes (`tool_call`) can only VETO, not inject (see
 * `docs/extensions/path-rules.md` for the traced evidence). Scanning the project once at
 * `session_start` and seeding the durable rule set from files that already exist means the common
 * case — editing a file the operator did not just create — has the rule in the system prompt
 * before the model's first token, not a turn later.
 *
 * Bounded on purpose: `.git`/`node_modules`/`.venv`/`dist`/`__pycache__` are skipped outright, and
 * both depth and total files visited are capped, so a session_start scan cannot become the thing
 * that makes a large repo slow to start. The scan also stops evaluating a rule the moment one of
 * its matchers has hit, and stops walking altogether once every conditional rule has activated —
 * a repo where everything matches early costs nothing to keep scanning.
 */
import { readdirSync, type Dirent } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { matchesAny, type PathMatcher } from "./glob.ts";
import type { PathRule } from "./config.ts";

export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "dist", "__pycache__"]);
export const DEFAULT_MAX_DEPTH = 12;
export const DEFAULT_MAX_FILES_VISITED = 20_000;

export interface ScanOptions {
  readonly maxDepth?: number;
  readonly maxFilesVisited?: number;
}

export interface ScanResult {
  /** Rule ids activated by this scan — unconditional rules, plus every conditional rule matched. */
  readonly activated: ReadonlySet<string>;
  readonly filesVisited: number;
  readonly dirsVisited: number;
  readonly elapsedMs: number;
  /** True if the scan stopped early on `maxDepth`/`maxFilesVisited` rather than exhausting the tree. */
  readonly truncated: boolean;
}

/**
 * Walks `cwd` looking for the first file matching each conditional rule's `paths:`. Unconditional
 * rules are activated without scanning anything.
 */
export function scanProject(cwd: string, rules: readonly PathRule[], opts: ScanOptions = {}): ScanResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFilesVisited = opts.maxFilesVisited ?? DEFAULT_MAX_FILES_VISITED;

  const conditional: Array<{ id: string; matchers: readonly PathMatcher[] }> = [];
  const activated = new Set<string>();
  for (const rule of rules) {
    if (rule.matchers === null) activated.add(rule.id);
    else conditional.push({ id: rule.id, matchers: rule.matchers });
  }

  const start = performance.now();
  let filesVisited = 0;
  let dirsVisited = 0;
  let truncated = false;

  const remaining = (): boolean => conditional.some((r) => !activated.has(r.id));

  function walk(dir: string, relDir: string, depth: number): void {
    if (truncated || !remaining()) return;
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race) — not this scan's problem to fail on
    }
    dirsVisited++;
    for (const entry of entries) {
      if (truncated || !remaining()) return;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      filesVisited++;
      if (filesVisited > maxFilesVisited) {
        truncated = true;
        return;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      for (const rule of conditional) {
        if (activated.has(rule.id)) continue;
        if (matchesAny(rule.matchers, relPath)) activated.add(rule.id);
      }
    }
  }

  walk(cwd, "", 0);
  const elapsedMs = performance.now() - start;
  return { activated, filesVisited, dirsVisited, elapsedMs, truncated };
}

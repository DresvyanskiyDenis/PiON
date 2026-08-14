/**
 * The guard's policy, loaded as **data** from `config/guard.json`.
 *
 * Failure semantics, and they are deliberate: a *missing or malformed* policy file must never
 * disable the guard. It falls back to `DEFAULT_POLICY` — which is the same content
 * `config/guard.default.json` carries — sets `degraded: true`, and reports the problem loudly
 * through `guard.ts`.
 *
 * ## 2026-08-14 — allow-list out, deny-list in
 *
 * This shape used to carry an 83-name `allowlist`, a `nonInteractive` mode, an `escalation`
 * variable, a `confirmTimeoutMs`, an `approvalUi` and a `remoteAllowlist` — the whole machinery
 * behind a gate (`ALW`) that refused any program not on the list, and refused it *outright*
 * headless because there was no one to ask. Removed outright by owner decision, 2026-08-14: only
 * catastrophic commands are blocked now, and none of those fields describes a catastrophic
 * command. What is left is the two things a deny-list still needs from config: which branches are
 * protected from a history-destroying force-push, and which tool names dispatch a sub-agent for
 * the (now audit-only) routing veto.
 *
 * If you are reading this because you want the allowlist back: it was never the boundary. Read
 * `docs/concepts/safety-model.md` for what the boundary actually is (`SEC-*`/`DB-*`/`GIT-*`, by
 * form rather than by program name) before reintroducing a key here.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../lib/paths.ts";

export interface Policy {
  /** Branches on which even `--force-with-lease` is refused. */
  readonly protectedBranches: readonly string[];
  /** Tool names that dispatch a sub-agent, for the (audit-only) routing observer. */
  readonly dispatchTools: readonly string[];
  /** True when the file was missing or unusable and the built-in defaults are in force. */
  readonly degraded: boolean;
  /** Where the policy came from, for `/doctor`. */
  readonly source: string;
  /** Set when something was wrong. `guard.ts` prints it; nothing swallows it. */
  readonly problem?: string;
}

/** Mirrors `config/guard.default.json`. Kept in sync by `test/guard/policy.test.ts`. */
export const DEFAULT_POLICY: Policy = {
  protectedBranches: ["main", "master"],
  dispatchTools: ["task", "agent", "subagent", "dispatch_agent", "subagent_run"],
  degraded: true,
  source: "<built-in defaults>",
};

const KNOWN_KEYS = new Set(["protectedBranches", "dispatchTools"]);

/** Candidate locations, first existing wins. */
export function policyPaths(): string[] {
  const candidates: string[] = [];
  const override = process.env.PI_GUARD_POLICY;
  if (override) candidates.push(override);
  // `extensions/` is symlinked into `~/.pi/agent/extensions`, so `import.meta.url` points at the
  // symlink. realpath() is what gets us back to the repo the file actually lives in.
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    candidates.push(resolve(dirname(here), "..", "..", "config", "guard.json"));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  candidates.push(resolve(repoRoot(), "config", "guard.json"));
  return candidates;
}

/** Synchronous by contract: `register()` must not start async work. */
export function loadPolicy(explicitPath?: string): Policy {
  const candidates = explicitPath ? [explicitPath] : policyPaths();
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    return {
      ...DEFAULT_POLICY,
      problem:
        `guard policy not found (looked in: ${candidates.join(", ")}). ` +
        `Built-in defaults are in force: protected branches ` +
        `${DEFAULT_POLICY.protectedBranches.join("/")}. The SEC/DB/GIT deny-list is in code and ` +
        `is unaffected.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found, "utf8"));
  } catch (err) {
    return {
      ...DEFAULT_POLICY,
      source: found,
      problem:
        `guard policy ${found} is not valid JSON (${(err as Error).message}). ` +
        `Built-in defaults are in force. The SEC/DB/GIT deny-list is in code and is unaffected.`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...DEFAULT_POLICY,
      source: found,
      problem: `guard policy ${found} must be a JSON object. Built-in defaults are in force.`,
    };
  }

  const raw = parsed as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  }

  const policy: Policy = {
    protectedBranches:
      stringArray(raw.protectedBranches, "protectedBranches", problems) ??
      DEFAULT_POLICY.protectedBranches,
    dispatchTools:
      stringArray(raw.dispatchTools, "dispatchTools", problems) ?? DEFAULT_POLICY.dispatchTools,
    degraded: false,
    source: found,
  };

  if (problems.length === 0) return policy;
  return { ...policy, problem: `guard policy ${found}: ${problems.join("; ")}` };
}

function stringArray(value: unknown, key: string, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    problems.push(`"${key}" must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

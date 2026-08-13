/**
 * The guard's policy, loaded as **data** from `config/guard.json`.
 *
 * The policy is explicit that the allowlist ships as data and not as code, so
 * extending it is a config commit rather than an edit to a gate.
 *
 * Failure semantics, and they are deliberate: a *missing or malformed* policy file must never
 * disable the guard. It falls back to `DEFAULT_POLICY` — which is the same content the shipped
 * JSON carries — sets `degraded: true`, and reports the problem loudly through `guard.ts`. Gates
 * read `degraded` and get STRICTER, never looser (see `bash-allowlist.ts`).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../lib/paths.ts";

export type NonInteractiveMode = "deny-all" | "allowlist-only" | "allow-all";
export type ApprovalUi = "select" | "confirm";

export interface Policy {
  /** Program basenames that run without an approval prompt. */
  readonly allowlist: ReadonlySet<string>;
  /** What an allowlist miss means when there is no UI to prompt with. */
  readonly nonInteractive: NonInteractiveMode;
  /** Env var that promotes a headless run to "approved", per invocation. Never a default. */
  readonly escalationEnv: string;
  readonly escalationValue: string;
  /** Dialog timeout. A timed-out dialog is a DENY. */
  readonly confirmTimeoutMs: number;
  /** `select` gives allow-once / allow-session / deny (REQ-PRV-38); `confirm` is the two-way. */
  readonly approvalUi: ApprovalUi;
  /** Branches on which even `--force-with-lease` is refused. */
  readonly protectedBranches: readonly string[];
  /** Remotes `git push` may target. Empty means "any". */
  readonly remoteAllowlist: readonly string[];
  /** Tool names that dispatch a sub-agent, for the routing veto. */
  readonly dispatchTools: readonly string[];
  /** True when the file was missing or unusable and the built-in defaults are in force. */
  readonly degraded: boolean;
  /** Where the policy came from, for `/doctor`. */
  readonly source: string;
  /** Set when something was wrong. `guard.ts` prints it; nothing swallows it. */
  readonly problem?: string;
}

/** Mirrors `config/guard.json`. Kept in sync by `test/guard/policy.test.ts`. */
export const DEFAULT_POLICY: Policy = {
  allowlist: new Set([
    "git", "npm", "npx", "node", "uv", "uvx", "python", "pytest", "ruff", "mypy",
    "sleep", "echo", "cat", "ls", "rg", "fd", "jq", "make", "docker", "gh",
  ]),
  nonInteractive: "allowlist-only",
  escalationEnv: "PI_GUARD_APPROVE",
  escalationValue: "1",
  confirmTimeoutMs: 120_000,
  approvalUi: "select",
  protectedBranches: ["main", "master"],
  remoteAllowlist: [],
  dispatchTools: ["task", "agent", "subagent", "dispatch_agent", "subagent_run"],
  degraded: true,
  source: "<built-in defaults>",
};

const KNOWN_KEYS = new Set([
  "allowlist",
  "nonInteractive",
  "escalation",
  "escalationEnv",
  "escalationValue",
  "confirmTimeoutMs",
  "approvalUi",
  "protectedBranches",
  "remoteAllowlist",
  "dispatchTools",
]);

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
        `Built-in defaults are in force and the bash allowlist is treated as EMPTY.`,
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
        `Built-in defaults are in force and the bash allowlist is treated as EMPTY.`,
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

  const allowlist = stringArray(raw.allowlist, "allowlist", problems);
  const nonInteractive = enumValue<NonInteractiveMode>(
    raw.nonInteractive,
    ["deny-all", "allowlist-only", "allow-all"],
    "nonInteractive",
    DEFAULT_POLICY.nonInteractive,
    problems,
  );
  const approvalUi = enumValue<ApprovalUi>(
    raw.approvalUi,
    ["select", "confirm"],
    "approvalUi",
    DEFAULT_POLICY.approvalUi,
    problems,
  );

  // The policy writes the escalation as one string, "PI_GUARD_APPROVE=1".
  let escalationEnv = DEFAULT_POLICY.escalationEnv;
  let escalationValue = DEFAULT_POLICY.escalationValue;
  if (typeof raw.escalation === "string" && raw.escalation.includes("=")) {
    const idx = raw.escalation.indexOf("=");
    escalationEnv = raw.escalation.slice(0, idx);
    escalationValue = raw.escalation.slice(idx + 1);
  } else if (raw.escalation !== undefined) {
    problems.push(`"escalation" must look like "NAME=value"`);
  }
  if (typeof raw.escalationEnv === "string") escalationEnv = raw.escalationEnv;
  if (typeof raw.escalationValue === "string") escalationValue = raw.escalationValue;

  const policy: Policy = {
    allowlist: new Set(allowlist ?? [...DEFAULT_POLICY.allowlist]),
    nonInteractive,
    escalationEnv,
    escalationValue,
    confirmTimeoutMs:
      typeof raw.confirmTimeoutMs === "number" && Number.isFinite(raw.confirmTimeoutMs)
        ? raw.confirmTimeoutMs
        : DEFAULT_POLICY.confirmTimeoutMs,
    approvalUi,
    protectedBranches:
      stringArray(raw.protectedBranches, "protectedBranches", problems) ??
      DEFAULT_POLICY.protectedBranches,
    remoteAllowlist:
      stringArray(raw.remoteAllowlist, "remoteAllowlist", problems) ??
      DEFAULT_POLICY.remoteAllowlist,
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

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
  fallback: T,
  problems: string[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`"${key}" must be one of ${allowed.join(" | ")}`);
  return fallback;
}

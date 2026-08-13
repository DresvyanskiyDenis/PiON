/**
 * `EXT-05` configuration: `config/routing.json` (owned by integration) overlaid with
 * `config/dispatch.json` (owned by this item).
 *
 * `routing.json` is **the single source of truth for tiers** and
 * for the per-provider `concurrency` map. An earlier draft's `config/model-tiers.json` and
 * `routing.json.dispatch` block do not exist in this repo and this module does not create
 * them — the later decision is authoritative where it disagrees with the earlier draft. The knobs the draft put in a
 * `dispatch` block (depth, timeouts, registry dirs) live in `config/dispatch.json` instead,
 * because `config/routing.json` is a shared file this item may not edit. If integration later
 * adds a `dispatch` block to `routing.json`, it is merged **on top** of `config/dispatch.json`,
 * so the shared file always wins and there is no ambiguity about precedence.
 *
 * Failure semantics, deliberately asymmetric:
 *   - `config/dispatch.json` missing or malformed → built-in defaults, `degraded: true`, loud.
 *     Every default here is safe on its own.
 *   - `config/routing.json` missing, malformed, or without a usable `tiers` map → **dispatch is
 *     refused**, loudly, with the reason. There is no safe default for "which model does
 *     `tier:strong` mean"; guessing one is exactly the silent substitution `REQ-PRV-32` forbids.
 *     Refusing to dispatch degrades to "the parent does the work itself", which is safe.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, repoRoot } from "../lib/paths.ts";
import type { EgressClass } from "../lib/dispatch-veto.ts";

export interface TierDef {
  readonly model: string;
  readonly thinkingLevel?: string;
  readonly purpose?: string;
  readonly optional?: boolean;
}

export interface RoutingConfig {
  readonly tiers: Readonly<Record<string, TierDef>>;
  /**
   * Tier names that are part of the vocabulary but are **deliberately not bound to a model** on this
   * install, mapped to the human reason. The `confidential` tier with no confidential-class provider
   * installed is the motivating case: binding it to a public provider would make the word
   * meaningless, so it is left unbound and naming it fails loudly instead.
   *
   * Never consulted to resolve anything. Its only job is to turn "unknown tier" into a sentence that
   * says which command fixes it.
   */
  readonly unboundTiers?: Readonly<Record<string, string>>;
  readonly egress: Readonly<Record<string, EgressClass>>;
  readonly concurrency: Readonly<Record<string, number>>;
  /** Present only if integration later adds it; merged over `config/dispatch.json`. */
  readonly dispatch?: Partial<DispatchConfig>;
}

export interface DispatchConfig {
  /** Children at this depth may not dispatch further. Mirrored into `PI_SUBAGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
  readonly defaultTier: string;
  readonly defaultEgress: EgressClass;
  readonly defaultTimeoutMs: number;
  /** Cap for a provider with no entry in `routing.json`'s `concurrency` map. */
  readonly concurrencyDefault: number;
  /** `pi-subagents`' own default for a fanout with no `concurrency` argument. */
  readonly packageDefaultConcurrency: number;
  /** Tokens `<repo>`, `<agentDir>`, `<cwd>` are expanded at load time. */
  readonly registryDirs: readonly string[];
  /** Tool names that dispatch a child. Must stay a superset of what the guard's policy lists. */
  readonly dispatchTools: readonly string[];
  /** Agent names that count as "generic" for the `REQ-CTX-47` specialist veto. */
  readonly genericAgents: readonly string[];
  /** How many distinctive words a specialist must share with the prompt before it vetoes. */
  readonly specialistMatchMinScore: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  maxDepth: 2,
  defaultTier: "fast",
  defaultEgress: "internal",
  defaultTimeoutMs: 1_800_000,
  concurrencyDefault: 3,
  packageDefaultConcurrency: 4,
  registryDirs: ["<repo>/agents", "<agentDir>/agents", "<cwd>/.pi/agents"],
  dispatchTools: ["subagent", "subagent_run", "dispatch_agent", "task", "agent"],
  genericAgents: ["general-purpose", "general", "generalist"],
  specialistMatchMinScore: 2,
};

export interface DispatchSettings {
  readonly dispatch: DispatchConfig;
  /** `undefined` when routing could not be loaded — dispatch is refused in that case. */
  readonly routing: RoutingConfig | undefined;
  readonly problems: readonly string[];
  readonly sources: { readonly dispatch: string; readonly routing: string };
}

const EGRESS_CLASSES = new Set(["public", "internal", "confidential"]);

/** Candidate locations for a `config/<name>.json`, first existing wins. */
export function configPaths(name: string, override?: string): string[] {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  // `extensions/` is symlinked into `~/.pi/agent/extensions`, so `import.meta.url` points at the
  // symlink. realpath() is what gets us back to the repo the file actually lives in.
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    candidates.push(resolve(dirname(here), "..", "..", "config", name));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  candidates.push(resolve(repoRoot(), "config", name));
  return candidates;
}

/** Expands `<repo>`, `<agentDir>` and `<cwd>` in a configured registry directory. */
export function expandDir(dir: string, cwd: string): string {
  const expanded = dir
    .replace("<repo>", repoRoot())
    .replace("<agentDir>", configDir())
    .replace("<cwd>", cwd);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

interface ReadResult {
  readonly raw: Record<string, unknown> | undefined;
  readonly source: string;
  readonly problem?: string;
}

/**
 * `config/routing.json` and `config/models.json` are GENERATED by `scripts/install.sh` from the
 * tracked `config/*.default.json` templates plus `config/providers/*.json`, and are git-ignored so
 * that a fork can never publish someone's endpoints. On a fresh clone they are therefore simply
 * absent, and the one useful thing to say is which command creates them — a list of paths that were
 * tried reads like a bug. Deliberately NOT a fallback: silently loading the shipped defaults would
 * run the harness on a routing table nobody chose.
 */
export const GENERATED_CONFIG_FILES = new Set(["routing.json", "models.json"]);

function installHint(name: string): string {
  if (!GENERATED_CONFIG_FILES.has(name)) return "";
  const template = `config/${name.replace(/\.json$/, ".default.json")}`;
  return `. ${name} is generated by scripts/install.sh from ${template} plus config/providers/*.json — run scripts/install.sh`;
}

function readJsonObject(name: string, override?: string): ReadResult {
  // An explicit override that does not exist is a typo, not a hint. Falling through to the repo's
  // own config would silently load a different file than the one that was named.
  if (override !== undefined && override !== "" && !existsSync(override)) {
    return {
      raw: undefined,
      source: override,
      problem: `${name} was pinned to "${override}", which does not exist`,
    };
  }
  const candidates = configPaths(name, override);
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    // `routing.json` and `models.json` are GENERATED by `scripts/install.sh` from the tracked
    // `*.default.json` templates plus `config/providers/*.json`; they are git-ignored so a fork can
    // never publish someone's endpoints. On a fresh clone they are therefore simply absent, and the
    // one useful thing to say is which command creates them — not a list of paths that were tried.
    return {
      raw: undefined,
      source: "<absent>",
      problem: `${name} not found (looked in: ${candidates.join(", ")})${installHint(name)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found, "utf8"));
  } catch (err) {
    return { raw: undefined, source: found, problem: `${found} is not valid JSON: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { raw: undefined, source: found, problem: `${found} must be a JSON object` };
  }
  return { raw: parsed as Record<string, unknown>, source: found };
}

function num(raw: Record<string, unknown>, key: string, fallback: number, problems: string[], min: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    problems.push(`dispatch.json: "${key}" must be a number >= ${min}; using ${fallback}`);
    return fallback;
  }
  return value;
}

function strArray(raw: Record<string, unknown>, key: string, fallback: readonly string[], problems: string[]): readonly string[] {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length === 0)) {
    problems.push(`dispatch.json: "${key}" must be an array of non-empty strings; using the default`);
    return fallback;
  }
  return value as string[];
}

function parseDispatchConfig(raw: Record<string, unknown> | undefined, problems: string[]): DispatchConfig {
  if (raw === undefined) return DEFAULT_DISPATCH_CONFIG;
  const d = DEFAULT_DISPATCH_CONFIG;
  const defaultTier = typeof raw.defaultTier === "string" && raw.defaultTier ? raw.defaultTier : d.defaultTier;
  let defaultEgress = d.defaultEgress;
  if (raw.defaultEgress !== undefined) {
    if (typeof raw.defaultEgress === "string" && EGRESS_CLASSES.has(raw.defaultEgress)) {
      defaultEgress = raw.defaultEgress as EgressClass;
    } else {
      problems.push(`dispatch.json: "defaultEgress" must be one of ${[...EGRESS_CLASSES].join("|")}; using ${d.defaultEgress}`);
    }
  }
  return {
    maxDepth: num(raw, "maxDepth", d.maxDepth, problems, 0),
    defaultTier,
    defaultEgress,
    defaultTimeoutMs: num(raw, "defaultTimeoutMs", d.defaultTimeoutMs, problems, 1),
    concurrencyDefault: num(raw, "concurrencyDefault", d.concurrencyDefault, problems, 1),
    packageDefaultConcurrency: num(raw, "packageDefaultConcurrency", d.packageDefaultConcurrency, problems, 1),
    registryDirs: strArray(raw, "registryDirs", d.registryDirs, problems),
    dispatchTools: strArray(raw, "dispatchTools", d.dispatchTools, problems),
    genericAgents: strArray(raw, "genericAgents", d.genericAgents, problems),
    specialistMatchMinScore: num(raw, "specialistMatchMinScore", d.specialistMatchMinScore, problems, 1),
  };
}

function parseRouting(raw: Record<string, unknown>, source: string, problems: string[]): RoutingConfig | undefined {
  const tiersRaw = raw.tiers;
  if (tiersRaw === null || typeof tiersRaw !== "object" || Array.isArray(tiersRaw)) {
    problems.push(`${source}: "tiers" is missing or is not an object — dispatch is refused`);
    return undefined;
  }
  const tiers: Record<string, TierDef> = {};
  for (const [name, value] of Object.entries(tiersRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${source}: tier "${name}" must be an object`);
      continue;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.model !== "string" || !row.model.includes("/")) {
      problems.push(`${source}: tier "${name}" needs a "model" of the form provider/id`);
      continue;
    }
    tiers[name] = {
      model: row.model,
      ...(typeof row.thinkingLevel === "string" ? { thinkingLevel: row.thinkingLevel } : {}),
      ...(typeof row.purpose === "string" ? { purpose: row.purpose } : {}),
      ...(row.optional === true ? { optional: true } : {}),
    };
  }
  if (Object.keys(tiers).length === 0) {
    problems.push(`${source}: no usable tier survived validation — dispatch is refused`);
    return undefined;
  }

  const egress: Record<string, EgressClass> = {};
  const egressRaw = raw.egress;
  if (egressRaw === null || typeof egressRaw !== "object" || Array.isArray(egressRaw)) {
    problems.push(`${source}: "egress" is missing or is not an object — dispatch is refused`);
    return undefined;
  }
  for (const [provider, cls] of Object.entries(egressRaw as Record<string, unknown>)) {
    if (typeof cls !== "string" || !EGRESS_CLASSES.has(cls)) {
      problems.push(`${source}: egress class for provider "${provider}" must be one of ${[...EGRESS_CLASSES].join("|")}`);
      continue;
    }
    egress[provider] = cls as EgressClass;
  }

  const concurrency: Record<string, number> = {};
  const concRaw = raw.concurrency;
  if (concRaw !== undefined) {
    if (concRaw === null || typeof concRaw !== "object" || Array.isArray(concRaw)) {
      problems.push(`${source}: "concurrency" must be an object of provider -> positive integer`);
    } else {
      for (const [provider, limit] of Object.entries(concRaw as Record<string, unknown>)) {
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
          problems.push(`${source}: concurrency for "${provider}" must be a positive integer`);
          continue;
        }
        concurrency[provider] = limit;
      }
    }
  }

  // A fallback chain is the silent-degradation shape this project rejects outright
  // (EXT-08 cancelled). Refuse to run with one configured.
  if (Array.isArray((raw as { fallback?: unknown }).fallback)) {
    problems.push(`${source}: a "fallback" array is present. Provider failover is cancelled (EXT-08); remove it.`);
  }

  // Documentation-only, so a malformed entry is dropped with a note rather than refusing dispatch:
  // losing an explanatory sentence must not cost the session its router.
  const unboundTiers: Record<string, string> = {};
  const unboundRaw = raw.tiersUnbound;
  if (unboundRaw !== undefined) {
    if (unboundRaw === null || typeof unboundRaw !== "object" || Array.isArray(unboundRaw)) {
      problems.push(`${source}: "tiersUnbound" must be an object of tier -> reason; ignoring it`);
    } else {
      for (const [name, reason] of Object.entries(unboundRaw as Record<string, unknown>)) {
        if (typeof reason !== "string" || reason.length === 0) {
          problems.push(`${source}: tiersUnbound["${name}"] must be a non-empty string; ignoring it`);
          continue;
        }
        if (Object.hasOwn(tiers, name)) {
          problems.push(`${source}: tier "${name}" is both bound in "tiers" and listed in "tiersUnbound"; the binding wins`);
          continue;
        }
        unboundTiers[name] = reason;
      }
    }
  }

  return {
    tiers,
    ...(Object.keys(unboundTiers).length > 0 ? { unboundTiers } : {}),
    egress,
    concurrency,
    ...(raw.dispatch !== undefined ? { dispatch: raw.dispatch as Partial<DispatchConfig> } : {}),
  };
}

export interface LoadOptions {
  readonly dispatchPath?: string;
  readonly routingPath?: string;
}

/** Synchronous by contract: `register()` must not start async work. */
export function loadDispatchSettings(opts: LoadOptions = {}): DispatchSettings {
  const problems: string[] = [];

  const dispatchRead = readJsonObject("dispatch.json", opts.dispatchPath ?? process.env.PI_DISPATCH_CONFIG);
  if (dispatchRead.problem) problems.push(`${dispatchRead.problem}; built-in dispatch defaults are in force`);
  let dispatch = parseDispatchConfig(dispatchRead.raw, problems);

  const routingRead = readJsonObject("routing.json", opts.routingPath ?? process.env.PI_ROUTING_CONFIG);
  let routing: RoutingConfig | undefined;
  if (routingRead.problem) {
    problems.push(`${routingRead.problem}; DISPATCH IS REFUSED until routing.json is readable`);
  } else if (routingRead.raw) {
    routing = parseRouting(routingRead.raw, routingRead.source, problems);
  }

  // The shared file wins where it overlaps, so integration can move these knobs into
  // routing.json later without this module changing.
  if (routing?.dispatch) {
    const overlay: Record<string, unknown> = { ...routing.dispatch } as Record<string, unknown>;
    dispatch = parseDispatchConfig({ ...(dispatchRead.raw ?? {}), ...overlay }, problems);
  }

  return {
    dispatch,
    routing,
    problems,
    sources: { dispatch: dispatchRead.source, routing: routingRead.source },
  };
}

/** Registry directories, expanded and de-duplicated, in override order (later wins). */
export function registryDirs(cfg: DispatchConfig, cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of cfg.registryDirs) {
    const abs = expandDir(dir, cwd);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** Exported for `/agents` and `/doctor`: where the agent files would be looked for. */
export function describeRegistryDirs(cfg: DispatchConfig, cwd: string): string {
  return registryDirs(cfg, cwd)
    .map((dir) => `${dir}${existsSync(dir) ? "" : " (absent)"}`)
    .join(", ");
}

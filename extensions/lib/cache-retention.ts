/**
 * Who decides this harness's prompt-cache retention — `config/models.json`, never the environment.
 *
 * ## The defect this closes
 *
 * `pi-ai` resolves the retention tier per request as `resolveCacheRetention(options.cacheRetention,
 * options.env)`, and both API modules fall back to an env var when the caller passes nothing:
 *
 * ```js
 * if (cacheRetention) return cacheRetention;
 * if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
 * return "short";
 * ```
 *
 * (`openai-completions.js:93-97`, `anthropic-messages.js:18-23`.) Nothing in this repo ever passes
 * an explicit `cacheRetention`, so `PI_CACHE_RETENTION=long` in the environment is the *only* thing
 * deciding the tier — for every provider, on every call — and "long" opens two paid, per-route
 * products that neither module gates on anything an operator here chose:
 *
 *   - `prompt_cache_retention: "24h"` to any OpenAI-shaped route (`openai-completions.js:527`);
 *   - `cache_control: {type:"ephemeral", ttl:"1h"}` to any Anthropic-shaped route that speaks the
 *     `"anthropic"` cache-control format (`anthropic-messages.js:32`, `openai-completions.js:737`).
 *
 * Both are gated on `compat.supportsLongCacheRetention`, and that flag **defaults to true**: absent
 * from a provider's `compat` block, `getAnthropicCompat` reads `model.compat?.supportsLongCacheRetention
 * ?? true` (`anthropic-messages.js:115`) and `detectCompat` returns true for every base URL outside a
 * five-provider exclusion list (`openai-completions.js:1235`). So a route nobody has probed for this —
 * which, for a template shipped to run against whatever gateway an operator points it at, is every
 * route until proven otherwise — gets the long-retention product the moment the env var is set,
 * whether or not `config/models.json` ever considered the question.
 *
 * ## The rule
 *
 * The per-route decision is `providers.<id>.compat.supportsLongCacheRetention` in `config/models.json`
 * — pi-ai's own key, read by both API modules, so no new vocabulary is invented for a decision the
 * wire format already has a name for. This module adds the one thing that key cannot express: whether
 * the *ambient env fallback* is allowed to speak for a route at all.
 *
 * `PI_CACHE_RETENTION=long` is honoured only when the config has an opinion about **every** configured
 * provider (each one carries an explicit boolean) **and at least one of them opts in**. Any other
 * state — a provider that says nothing, a `models.json` that cannot be read, a config where nobody
 * wants the long tier — pins the process to `"short"`, which is pi-ai's own default and the value a
 * fresh install runs on before anyone has probed anything.
 *
 * Two properties are worth stating because they are why the rule is shaped like this:
 *
 *   - **A provider added tomorrow cannot inherit the env.** Installing a new fragment without a
 *     retention decision does not quietly opt it into a paid retention product; it takes the env
 *     switch away from every route that *had* decided, loudly, on the log sink. Silence is not
 *     consent.
 *   - **The pin is a rewrite, not a deletion.** `process.env.PI_CACHE_RETENTION` is set to the value
 *     this harness will actually act on, so a bash tool, a hook, or a dispatched child reading that
 *     variable sees the effective truth rather than a claim the parent overrode.
 *
 * The pin is process-wide because the fallback it neutralises is process-wide: `getProviderEnvValue`
 * reads `process.env` for every provider that does not carry a scoped `env` override, and this
 * template's fragments never write one. Per-route differentiation stays where it belongs, on the
 * compat flag: a route pinned `false` sends no retention product whatever the env says.
 *
 * Everything here is pure or takes its I/O target as an argument, so the rule is testable without
 * loading PI. `extensions/credentials.ts` is the thin wiring on top.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot } from "./paths.ts";

/** The env var pi-ai reads, named once so the pin and the notice cannot drift apart. */
export const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

/** The only ambient value that changes pi-ai's behaviour; everything else already means `short`. */
const LONG = "long";
const SHORT = "short";

export interface ModelsFile {
  /** The parsed object, or `undefined` when the file is absent, unparseable or not an object. */
  readonly raw: Record<string, unknown> | undefined;
  /** The path that was read, or `<absent>`. Named in every notice so a reader can check it. */
  readonly source: string;
  /** Why `raw` is undefined. Absent when the file was read. */
  readonly problem?: string;
}

/**
 * Candidate locations for `config/models.json`, first existing wins — the same order and the same
 * realpath step as `dispatch/config.ts`'s `configPaths`, because `extensions/` is a symlink into
 * `~/.pi/agent/extensions` and `import.meta.url` therefore points at the symlink, not at the repo.
 *
 * `config/models.json` is the file `scripts/install.sh` generates and is what this harness actually
 * talks to; the tracked `config/models.default.json` is deliberately not a fallback here, for the
 * same reason `dispatch/config.ts` refuses one — a harness quietly deciding retention from a
 * template the operator never installed is exactly the silent substitution this rule exists to end.
 */
export function modelsPaths(override?: string): string[] {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    candidates.push(resolve(dirname(here), "..", "..", "config", "models.json"));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  candidates.push(resolve(repoRoot(), "config", "models.json"));
  return candidates;
}

/** `PI_CONFIG_MODELS_JSON` is the same test seam `dispatch/config.ts` honours. */
export function readModelsFile(override = process.env.PI_CONFIG_MODELS_JSON): ModelsFile {
  // An override that does not exist is a typo, not a hint: falling through to the repo's own file
  // would silently load a different one than the one that was named.
  if (override !== undefined && override !== "" && !existsSync(override)) {
    return {
      raw: undefined,
      source: override,
      problem: `models.json was pinned to "${override}", which does not exist`,
    };
  }
  const candidates = modelsPaths(override);
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    // `config/models.json` is generated by `scripts/install.sh` and gitignored, so a fresh clone
    // has none. That is not a decision about retention, it is the absence of one — pin short.
    return {
      raw: undefined,
      source: "<absent>",
      problem: `models.json not found (looked in: ${candidates.join(", ")})`,
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

export interface RetentionDecision {
  /** May `PI_CACHE_RETENTION=long` decide the tier for this config? */
  readonly honourEnv: boolean;
  /** Providers declaring `compat.supportsLongCacheRetention: true`. */
  readonly optedIn: readonly string[];
  /** Providers declaring it `false` — pinned off on the route itself, whatever the env says. */
  readonly pinnedOff: readonly string[];
  /** Providers that declare nothing. One of these is enough to silence the env switch. */
  readonly silent: readonly string[];
  /** Why `honourEnv` came out the way it did, in one clause, for the notice. */
  readonly reason: string;
}

/**
 * Read the per-route decisions out of `models.json` and rule on the env switch.
 *
 * The compat block is read as written, at provider level only. A `modelOverrides.<id>.compat` or a
 * `models[].compat` can pin a single model, and pi-ai will honour it — but a per-model opt-in is not
 * an opinion about the *route*, and this rule is about whether an env var may speak for routes nobody
 * ruled on. Provider level is where a route-wide statement can be made, so provider level is what
 * counts as one.
 */
export function decideEnvCacheRetention(models: ModelsFile): RetentionDecision {
  if (models.raw === undefined) {
    return {
      honourEnv: false,
      optedIn: [],
      pinnedOff: [],
      silent: [],
      reason: models.problem ?? `${models.source} could not be read`,
    };
  }
  const providers = models.raw.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    return {
      honourEnv: false,
      optedIn: [],
      pinnedOff: [],
      silent: [],
      reason: `${models.source} declares no "providers" object`,
    };
  }

  const optedIn: string[] = [];
  const pinnedOff: string[] = [];
  const silent: string[] = [];
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    const declared = providerRetentionFlag(entry);
    if (declared === true) optedIn.push(id);
    else if (declared === false) pinnedOff.push(id);
    else silent.push(id);
  }

  if (silent.length > 0) {
    return {
      honourEnv: false,
      optedIn,
      pinnedOff,
      silent,
      reason:
        `${silent.join(", ")} declare no compat.supportsLongCacheRetention in ${models.source}, ` +
        `so no route-wide decision covers them`,
    };
  }
  if (optedIn.length === 0) {
    return {
      honourEnv: false,
      optedIn,
      pinnedOff,
      silent,
      reason: `every provider in ${models.source} pins compat.supportsLongCacheRetention false`,
    };
  }
  return {
    honourEnv: true,
    optedIn,
    pinnedOff,
    silent,
    reason: `${optedIn.join(", ")} opt in to long cache retention in ${models.source}`,
  };
}

function providerRetentionFlag(entry: unknown): boolean | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const compat = (entry as Record<string, unknown>).compat;
  if (compat === null || typeof compat !== "object" || Array.isArray(compat)) return undefined;
  const flag = (compat as Record<string, unknown>).supportsLongCacheRetention;
  return typeof flag === "boolean" ? flag : undefined;
}

/**
 * Apply the decision to an environment, and return the line to announce — or `undefined` when there
 * was nothing to say.
 *
 * Nothing is announced when the env var is absent or already agrees with the decision: a harness
 * that printed a line on every start about a variable nobody set is noise, and noise is how the one
 * start that *did* override something goes unread.
 */
export function pinCacheRetentionEnv(
  env: NodeJS.ProcessEnv,
  decision: RetentionDecision,
): string | undefined {
  if (env[CACHE_RETENTION_ENV] !== LONG || decision.honourEnv) return undefined;
  env[CACHE_RETENTION_ENV] = SHORT;
  return (
    `[pi-config] cache-retention: ${CACHE_RETENTION_ENV}=${LONG} is ignored and pinned to "${SHORT}": ${decision.reason}. ` +
    `Long prompt-cache retention (prompt_cache_retention "24h" / cache_control ttl "1h") is a paid, ` +
    `per-route product and is opted into in config/models.json, not in the environment.`
  );
}

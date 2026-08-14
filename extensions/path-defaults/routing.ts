/**
 * Resolves a `config/routing.json` **tier** name to a provider-qualified model id and its
 * declared egress class — this item's own copy of the lookup, not a claim on a shared module.
 *
 * This item's dependency on `EXT-05` ("sub-agents inherit the
 * root's tier") means `extensions/dispatch/tiers.ts` already ships `resolveModelSpec`/`egressOf`
 * against the identical file. This module deliberately does not import them: `extensions/dispatch/`
 * is `EXT-05`'s owned tree, being edited concurrently by a different item in this run, and a
 * generic "resolve a tier" utility reading `config/routing.json` is exactly the kind of thing
 * `extensions/digest/tier.ts` already duplicated for the same reason (see its own header comment:
 * "EXT-05 had not landed a `lib/tiers.ts` at the time this module was written... not a claim on
 * that shared module"). This is now the THIRD independent reader of `routing.json`'s tier shape
 * (`dispatch/tiers.ts`, `digest/tier.ts`, this file) — an
 * integration de-duplication task (hoist into `extensions/lib/tiers.ts`), same as `EXT-06` already
 * flagged for itself.
 *
 * `config/README.md` rule 3 ("no bare model id outside `routing.json` and `models.json`; agents,
 * skills and scripts reference a tier") is why `config/path-defaults.json` roots name a *tier*,
 * not a literal `provider`/`model` pair — a deliberate departure from an earlier draft's
 * JSON example, which embeds literal models directly.
 */
import { readFileSync } from "node:fs";
import { THINKING_LEVELS, isThinkingLevel, splitThinkingSuffix, type ThinkingLevel } from "../dispatch/thinking.ts";
import { routingConfigPath } from "./paths.ts";

/** The three classes `config/routing.json`'s `egress` map uses (`extensions/lib/dispatch-veto.ts`). */
export type SessionEgressClass = "public" | "internal" | "confidential";

/** No TypeScript parameter properties on purpose — `extensions/hooks/schema.ts`'s own note:
 *  Node's `--test` runs `.ts` through type-stripping only, and `constructor(readonly x: T)` is a
 *  real syntax transform, not an erasure; it throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at run
 *  time on Node 22.22.3. `tsc --noEmit` alone does not catch this. */
export class UnknownTierError extends Error {
  readonly tier: string;
  readonly routingPath: string;

  constructor(tier: string, routingPath: string) {
    super(`unknown tier "${tier}" in ${routingPath} — refusing to guess (try: pi-tier --list)`);
    this.name = "UnknownTierError";
    this.tier = tier;
    this.routingPath = routingPath;
  }
}

export class UnknownProviderEgressError extends Error {
  readonly provider: string;
  readonly routingPath: string;

  constructor(provider: string, routingPath: string) {
    super(
      `provider "${provider}" has no declared egress class in ${routingPath} — refusing to guess`,
    );
    this.name = "UnknownProviderEgressError";
    this.provider = provider;
    this.routingPath = routingPath;
  }
}

export interface RoutingTierTarget {
  readonly tier: string;
  /** Always `provider/id`, exactly as `routing.json` declares it — so it may carry a `:level`
   *  thinking suffix. */
  readonly model: string;
  readonly provider: string;
  /** `id` with any thinking suffix split off — a level is not part of an id, and this is the key
   *  the model registry is asked about. */
  readonly modelId: string;
  readonly egress: SessionEgressClass;
  /** The tier's reasoning effort, when it declares one. A suffix already on `model` (say
   *  `provider/id:high`) is the more specific statement and outranks the row's `thinkingLevel`
   *  field — the same precedence `extensions/dispatch/tiers.ts` applies. */
  readonly thinkingLevel?: ThinkingLevel;
}

interface RoutingFileShape {
  tiers?: Record<string, { model?: unknown; thinkingLevel?: unknown }>;
  egress?: Record<string, unknown>;
}

/**
 * Parses `raw` (the text of `config/routing.json`) and resolves `tier`.
 *
 * Pure and synchronous so it is unit-testable without touching disk — `loadRoutingTierTarget()`
 * below is the thin fs wrapper. Throws (never guesses) on a missing tier, a tier without a
 * `provider/id`-shaped model, a tier declaring a `thinkingLevel` that is not a known level, or a
 * provider absent from the `egress` map — `REQ-PRV-32`.
 */
export function resolveRoutingTier(raw: string, tier: string, routingPath: string): RoutingTierTarget {
  let parsed: RoutingFileShape;
  try {
    parsed = JSON.parse(raw) as RoutingFileShape;
  } catch (err) {
    throw new Error(`${routingPath} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }

  const row = parsed.tiers?.[tier];
  const model = row?.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new UnknownTierError(tier, routingPath);
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `tier "${tier}" in ${routingPath} has a model "${model}" that is not "provider/id"-shaped`,
    );
  }
  const provider = model.slice(0, slash);
  // The model registry is keyed by a bare `provider/id` and a reasoning effort is not part of an
  // id, so the suffix comes off before the lookup. `../dispatch/thinking.ts` is imported rather
  // than copied: it owns this vocabulary for the whole tree (and only splits a KNOWN level, so
  // `provider/id:typo` keeps its colon and still fails the existence check, as it should). That is
  // the shared *suffix* grammar, not `dispatch/tiers.ts`'s tier resolution, which this module still
  // deliberately keeps its own copy of — see the header.
  const { baseModel: modelId, thinkingSuffix } = splitThinkingSuffix(model.slice(slash + 1));

  const declaredLevel = row?.thinkingLevel;
  if (declaredLevel !== undefined && (typeof declaredLevel !== "string" || !isThinkingLevel(declaredLevel))) {
    throw new Error(
      `tier "${tier}" in ${routingPath} declares thinkingLevel "${String(declaredLevel)}", which is ` +
        `not one of ${THINKING_LEVELS.join("|")}`,
    );
  }
  // A suffix written on the model string is the more specific statement and wins, matching
  // `extensions/dispatch/tiers.ts`'s `applyTierThinkingLevel`.
  const thinkingLevel: ThinkingLevel | undefined =
    thinkingSuffix === "" ? declaredLevel : (thinkingSuffix.slice(1) as ThinkingLevel);

  const egressRaw = parsed.egress?.[provider];
  if (egressRaw !== "public" && egressRaw !== "internal" && egressRaw !== "confidential") {
    throw new UnknownProviderEgressError(provider, routingPath);
  }

  return {
    tier,
    model,
    provider,
    modelId,
    egress: egressRaw,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

/** @throws on a missing/unreadable/malformed `config/routing.json`, or an unresolved `tier`. */
export function loadRoutingTierTarget(
  tier: string,
  routingPath: string = routingConfigPath(),
): RoutingTierTarget {
  let raw: string;
  try {
    raw = readFileSync(routingPath, "utf8");
  } catch (err) {
    // routing.json is generated by scripts/install.sh from config/routing.default.json and is
    // git-ignored, so "absent" is the normal state of a fresh clone rather than a corruption.
    throw new Error(
      `could not read ${routingPath} to resolve tier "${tier}": ${(err as Error).message}. ` +
        `routing.json is generated by scripts/install.sh from config/routing.default.json — run scripts/install.sh`,
      { cause: err },
    );
  }
  return resolveRoutingTier(raw, tier, routingPath);
}

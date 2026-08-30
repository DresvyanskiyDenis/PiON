/**
 * **Compaction's own path to a provider** — the `compaction` block of `config/routing.json`.
 *
 * ## The deadlock this exists to break
 *
 * `summariseWithContract` used to call PI's `compact()` with `ctx.model`: the lead's provider, the
 * lead's model, the lead's per-deployment budget. So the one call that has to succeed *while the
 * session is already failing* was aimed at the thing that was failing. A quota refusal on the
 * lead's deployment therefore killed both the turn and the session's ability to shrink itself out
 * of the corner — the session could neither work nor compact, and the only exit was an operator
 * changing model by hand.
 *
 * A retry budget does not reach this. Retrying re-issues the same request to the same endpoint,
 * which is the right answer to a coin-flip artifact and no answer at all to a budget that is
 * already spent. What compaction needed was a *different endpoint*: an ordered list of candidates,
 * written down in config, tried in order.
 *
 * ## What lives here, and what deliberately does not
 *
 * This module is **resolution and policy, with no I/O and no PI types**: a routing file goes in,
 * an ordered list of {@link RouteTarget}s and a failover predicate come out. The loop that actually
 * calls `compact()` stays in `./index.ts`, because only that module holds `ctx.modelRegistry` and
 * the session's own event. Keeping the split means the interesting half — which candidate is tried
 * when, and which failure justifies moving on — is testable without a live session or a provider.
 *
 * ## Why this is not the provider failover PC-03 forbids
 *
 * `onProviderError` governs the **working** path, where quietly substituting a weaker model hands
 * back worse work under the stronger model's name. That substitution stays cancelled, and PC-03
 * still fails on a `fallback`/`failover`/`egressOrder` key anywhere in the file.
 *
 * Compaction is the **service** path. Its product is a summary of a conversation rather than the
 * work itself, there is no weaker answer for the operator to be fooled by, and the alternative to
 * hopping is not "the operator picks another model" but "the session dies on context". The one
 * property both paths share is the one that matters: nothing here is silent. The route is declared
 * in config, printed at session start, and every hop is announced and persisted.
 */
import { isThinkingLevel, splitThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "../dispatch/thinking.ts";
import type { ProviderErrorClass } from "../lib/provider-error.ts";
import { providerEgress, tierModel, tierThinkingLevel, unboundTier, type RoutingFile } from "../lib/routing-file.ts";

/** The parsed `compaction` block. Every field has a default that ships in this file. */
export interface CompactionRouteSettings {
  /** Ordered candidate specs, each a tier name or a literal `provider/id`. Empty disables the route. */
  readonly route: readonly string[];
  /** Failure classes that move to the NEXT candidate. Any other class ends the route where it is. */
  readonly failoverClasses: readonly ProviderErrorClass[];
}

/**
 * What applies when `routing.json` carries no `compaction` block at all.
 *
 * These are defaults rather than a copy of the shipped file: an install that deleted the block
 * still gets a route, because the alternative is the deadlock. The argument for each shipped value
 * lives next to the values in `config/routing.default.json`, which is where an operator will look.
 */
export const DEFAULT_COMPACTION_ROUTE: CompactionRouteSettings = {
  route: ["light", "confidential"],
  failoverClasses: ["quota", "network", "empty-response", "auth", "model-not-found"],
};

/**
 * `policy` is absent from the defaults and is refused as a configured value.
 *
 * A content filter refusing the transcript is a verdict about the *data*. Walking the route until
 * some tenant accepts it is egress-shopping around a refusal that was made on purpose, and it is
 * the one shape of "try the next one" this module will not let an operator configure.
 */
const FAILOVER_ELIGIBLE: readonly ProviderErrorClass[] = [
  "auth",
  "quota",
  "network",
  "model-not-found",
  "empty-response",
];

export interface ParsedRoute {
  readonly settings: CompactionRouteSettings;
  /** Readable complaints about the config. Surfaced once each; never fatal. */
  readonly problems: readonly string[];
}

/** Parses the `compaction` block. An absent block is the default, not a complaint. */
export function parseCompactionRoute(raw: unknown): ParsedRoute {
  const problems: string[] = [];
  const block = (raw as { compaction?: unknown } | null | undefined)?.compaction;
  if (block === undefined) return { settings: DEFAULT_COMPACTION_ROUTE, problems };
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    problems.push(`routing.json: "compaction" must be an object; the built-in route is used instead`);
    return { settings: DEFAULT_COMPACTION_ROUTE, problems };
  }
  const root = block as Record<string, unknown>;

  let route = DEFAULT_COMPACTION_ROUTE.route;
  if (root.route !== undefined) {
    if (!Array.isArray(root.route) || root.route.some((entry) => typeof entry !== "string")) {
      problems.push(`routing.json: compaction.route must be an array of strings; the built-in route is used instead`);
    } else {
      // An explicit `[]` is a statement, not an omission: "no route, use the session's own model".
      // Replacing it with the default would make the key impossible to switch off. `index.ts`
      // announces the degradation that choice causes.
      route = (root.route as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    }
  }

  let failoverClasses = DEFAULT_COMPACTION_ROUTE.failoverClasses;
  const onFailure = root.onRouteFailure;
  if (onFailure !== undefined) {
    if (onFailure === null || typeof onFailure !== "object" || Array.isArray(onFailure)) {
      problems.push(`routing.json: compaction.onRouteFailure must be an object; the built-in classes are used instead`);
    } else {
      const declared = (onFailure as Record<string, unknown>).failoverClasses;
      if (declared !== undefined) {
        if (!Array.isArray(declared)) {
          problems.push(
            `routing.json: compaction.onRouteFailure.failoverClasses must be an array; the built-in classes are used instead`,
          );
        } else {
          const kept: ProviderErrorClass[] = [];
          for (const cls of declared) {
            if (typeof cls === "string" && (FAILOVER_ELIGIBLE as readonly string[]).includes(cls)) {
              kept.push(cls as ProviderErrorClass);
              continue;
            }
            problems.push(
              `routing.json: compaction.onRouteFailure.failoverClasses lists "${String(cls)}", which is not one of ` +
                `${FAILOVER_ELIGIBLE.join("|")}, and was dropped. ("policy" is deliberately ineligible: a content ` +
                `filter refusing the transcript is a verdict about the data, and re-offering that data to another ` +
                `tenant is egress-shopping around it.)`,
            );
          }
          failoverClasses = kept;
        }
      }
    }
  }

  return { settings: { route, failoverClasses }, problems };
}

/** One resolved candidate: everything `index.ts` needs to ask the model registry for a model. */
export interface RouteTarget {
  /** What the config actually wrote, kept on every notice so a reader can grep the file for it. */
  readonly spec: string;
  /** Set when `spec` named a tier rather than a literal model. */
  readonly tier?: string;
  readonly provider: string;
  /** Bare id, the thinking suffix already split off — this is what `modelRegistry.find` is keyed by. */
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** The routing file's egress label for the provider. `undefined` means it classifies none. */
  readonly egress?: string;
}

export interface ResolvedRoute {
  readonly targets: readonly RouteTarget[];
  readonly problems: readonly string[];
}

/**
 * Turns each spec into a {@link RouteTarget}, in order.
 *
 * A spec that will not resolve is **dropped with a problem**, never fatal. The point of a route is
 * to survive one bad entry, and a compaction path that refuses to run because the second candidate
 * is misspelled has reproduced the outage it exists to prevent. When nothing survives, `index.ts`
 * says so and falls back to the session's own model.
 *
 * Duplicates are dropped for the same reason they are worth naming: `["light", "light"]` looks like
 * a two-hop chain and is a one-hop chain that pays twice for the same refusal.
 */
export function resolveCompactionRoute(routing: RoutingFile, settings: CompactionRouteSettings): ResolvedRoute {
  const problems: string[] = [];
  const targets: RouteTarget[] = [];
  const seen = new Set<string>();

  for (const spec of settings.route) {
    const target = resolveOne(routing, spec, problems);
    if (target === undefined) continue;
    const key = `${target.provider}/${target.modelId}`;
    if (seen.has(key)) {
      problems.push(`compaction route: "${spec}" resolves to ${key}, which is already earlier in the route, and was dropped`);
      continue;
    }
    seen.add(key);
    targets.push(target);
  }
  return { targets, problems };
}

function resolveOne(routing: RoutingFile, spec: string, problems: string[]): RouteTarget | undefined {
  const literal = spec.includes("/");
  const declared = literal ? spec : tierModel(routing, spec);
  if (declared === undefined) {
    // A name this install lists under `tiersUnbound` is a tier the fork knows about and this
    // install has nothing to bind it to. Naming it in the route is a *forward* declaration, not a
    // typo, so it is skipped in silence: the day the installer binds that tier the route grows the
    // hop with no config edit, and until then a stock clone is not nagged once per session about a
    // provider it never chose to install.
    if (!literal && unboundTier(routing, spec) !== undefined) return undefined;
    problems.push(
      `compaction route: "${spec}" has no "/" and was read as a TIER NAME, which ${routing.source} neither ` +
        `declares with a provider-qualified model nor lists under tiersUnbound, and was dropped`,
    );
    return undefined;
  }

  const { baseModel, thinkingSuffix } = splitThinkingSuffix(declared);
  const slash = baseModel.indexOf("/");
  const provider = baseModel.slice(0, slash);
  const modelId = baseModel.slice(slash + 1);
  if (provider.length === 0 || modelId.length === 0) {
    problems.push(
      `compaction route: "${spec}" resolves to "${declared}", which is not of the form provider/id, and was dropped`,
    );
    return undefined;
  }

  // A suffix written on the model string is the more specific statement and outranks the tier's
  // own field, which is exactly how `dispatch/tiers.ts` reads the same pair.
  const raw =
    thinkingSuffix !== "" ? thinkingSuffix.replace(/^:/, "") : literal ? undefined : tierThinkingLevel(routing, spec);
  let thinkingLevel: ThinkingLevel | undefined;
  if (raw !== undefined) {
    if (isThinkingLevel(raw)) {
      thinkingLevel = raw;
    } else {
      // Dropped rather than passed through: `compact()` types this parameter, and an effort level
      // nothing serves is either refused by the provider or ignored. Said out loud, and the
      // candidate still runs at the provider default, which is now a stated fact rather than a
      // surprise.
      problems.push(
        `compaction route: "${spec}" declares thinking level "${raw}", which is not one of ` +
          `${THINKING_LEVELS.join("|")}, so the candidate runs at the provider default instead`,
      );
    }
  }

  const egress = providerEgress(routing, provider);
  return {
    spec,
    ...(literal ? {} : { tier: spec }),
    provider,
    modelId,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(egress !== undefined ? { egress } : {}),
  };
}

/** Whether a failure on one candidate justifies calling the next one. */
export function shouldFailover(klass: ProviderErrorClass, settings: CompactionRouteSettings): boolean {
  return settings.failoverClasses.includes(klass);
}

/* ---------------------------------------------------------------------------------------------
 * Walking the route
 * ------------------------------------------------------------------------------------------- */

/** What one candidate's attempt produced. Exactly one of the three states is meaningful. */
export interface RouteAttemptOutcome<R> {
  readonly ok: boolean;
  readonly result?: R;
  /** Present on every `ok: false` that was not a cancellation. */
  readonly failure?: { readonly klass: ProviderErrorClass };
  /** The attempt was CANCELLED rather than refused. It ends the walk and spends no hop. */
  readonly aborted?: boolean;
}

/** Everything the walk tells its caller. Each is a reporting seam, and none of them may throw. */
export interface RouteWalkHooks<C, F> {
  /** One candidate failed. `willHop` is false on the failure that ends the route. */
  readonly onHop: (candidate: C, failure: F, willHop: boolean, index: number) => void;
  /** The route produced a result, but not on the first candidate. */
  readonly onRecovered?: (candidate: C, index: number, tried: readonly string[]) => void;
  /** Nothing produced a result. `exhausted` separates "ran out" from "stopped on a class". */
  readonly onExhausted: (failure: F, tried: readonly string[], exhausted: boolean) => Promise<void> | void;
}

/**
 * Tries each candidate in order, stopping at the first success, at a cancellation, or at a failure
 * whose class the route is not configured to survive.
 *
 * Generic over candidate, result and failure so it stays free of every PI type. `index.ts` supplies
 * the attempt that actually calls `compact()`; this function owns only the ordering decisions.
 *
 * Cancellation is checked before the failure class, because an aborted compaction is not a verdict
 * about the candidate. Spending the rest of the route on it would turn one operator interrupt into
 * three provider calls.
 */
export async function walkRoute<
  C extends { readonly target: RouteTarget },
  R,
  F extends { readonly klass: ProviderErrorClass },
>(
  candidates: readonly C[],
  settings: CompactionRouteSettings,
  attempt: (candidate: C, index: number) => Promise<RouteAttemptOutcome<R>>,
  hooks: RouteWalkHooks<C, F>,
): Promise<R | undefined> {
  const tried: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const outcome = await attempt(candidate, index);
    if (outcome.ok && outcome.result !== undefined) {
      if (index > 0) hooks.onRecovered?.(candidate, index, tried);
      return outcome.result;
    }
    if (outcome.aborted) return undefined;

    const failure = outcome.failure as F;
    const last = index === candidates.length - 1;
    const willHop = !last && shouldFailover(failure.klass, settings);
    tried.push(`${describeTarget(candidate.target)} (${failure.klass})`);
    hooks.onHop(candidate, failure, willHop, index);
    if (willHop) continue;
    await hooks.onExhausted(failure, tried, last);
    return undefined;
  }
  return undefined;
}

/** `light -> github-copilot/claude-sonnet-5:medium [public]` — the identity every notice carries. */
export function describeTarget(target: RouteTarget): string {
  const model = `${target.provider}/${target.modelId}${target.thinkingLevel ? `:${target.thinkingLevel}` : ""}`;
  const via = target.tier !== undefined ? `tier "${target.tier}" -> ` : "";
  return `${via}${model}${target.egress !== undefined ? ` [${target.egress}]` : ""}`;
}

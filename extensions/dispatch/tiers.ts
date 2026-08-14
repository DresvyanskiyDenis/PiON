/**
 * **tier name → `provider/id`**.
 *
 * Agent frontmatter says `model: strong` (or `tier:strong`, or a literal `provider/id`); a child
 * process needs a provider-qualified id. `config/routing.json` is the single source of truth for
 * that mapping, and this module is the only place the translation happens.
 *
 * Two deviations from an earlier draft, both deliberate:
 *
 *  1. There is no `config/model-tiers.json` and no tier × egress-class matrix. `routing.json`'s
 *     tiers are flat — one model per tier. The spec's matrix would answer "this session is
 *     confidential, so `tier:deep` means databricks instead of copilot", i.e. it would **silently
 *     substitute a different provider and a different model** for the same tier. That is the exact
 *     behaviour `EXT-08` was cancelled for. Here, a tier resolves to one model, always the same one.
 *  2. The egress vocabulary is `EXT-01`'s three classes (`public` / `internal` / `confidential`),
 *     not the spec's four. `routing.json` maps a `local` provider to `confidential`, so a fourth
 *     class would be a second vocabulary for the same fact.
 *
 * The class is a **label**. Egress containment was withdrawn on 2026-08-13 (see
 * `lib/dispatch-veto.ts`), so nothing in this module refuses a target for its class, and a provider
 * `routing.json` does not classify resolves normally with no class attached.
 */
import type { EgressClass } from "../lib/dispatch-veto.ts";
import {
  describeAlternatives,
  describeProviderRefusal,
  type ModelCatalogue,
  type ProviderAdmission,
} from "./catalogue.ts";
import type { RoutingConfig } from "./config.ts";
import { THINKING_LEVELS, isThinkingLevel, splitThinkingSuffix } from "./thinking.ts";

export { splitThinkingSuffix, THINKING_LEVELS } from "./thinking.ts";

export type DispatchErrorKind =
  | "config"
  | "egress"
  | "unknown_agent"
  | "unknown_tier"
  /** A well-formed `provider/id` that the session's model registry does not have. */
  | "unknown_model"
  /**
   * A well-formed `provider/id` whose PROVIDER this install has not set up — absent from
   * `config/models.json`, or unclassified in `config/routing.json`'s `egress` map, or both.
   *
   * Distinct from `unknown_model` on purpose. "That model does not exist" sends the reader looking
   * for a spelling mistake; the model may well exist in PI's registry and still be undispatchable
   * here, and the fix is a config file, not a retry with a different id.
   */
  | "unconfigured_provider"
  | "depth"
  | "schema"
  | "contract"
  | "child_failed"
  | "timeout";

/** Every refusal this module raises names the kind, so a caller can branch without string-matching. */
export class DispatchError extends Error {
  readonly kind: DispatchErrorKind;

  constructor(kind: DispatchErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DispatchError";
    this.kind = kind;
  }
}

export interface ModelTarget {
  /** What the agent file or the tool call actually wrote. */
  readonly spec: string;
  /** Set when `spec` named a tier rather than a concrete model. */
  readonly tier?: string;
  /** Always `provider/id`. This is what goes on the wire. */
  readonly model: string;
  readonly provider: string;
  /** Reporting label. `undefined` means `routing.json` gives this provider no class. */
  readonly egress?: EgressClass;
  readonly thinkingLevel?: string;
  /** A tier flagged `optional` in `routing.json` (the `local` lane needs a local model server running). */
  readonly optional: boolean;
}

/**
 * The provider's declared class, or `undefined` when `routing.json` declares none.
 *
 * It used to throw `kind:"config"` on an unclassed provider. That was egress containment wearing a
 * different costume — "no defensible answer to may this session's data go there" is a refusal — and
 * it went with the rest of the rule on 2026-08-13. An unclassed provider is now **unlabelled**, not
 * forbidden: it dispatches, and the missing class is reported wherever the class is displayed.
 */
export function egressOf(routing: RoutingConfig, provider: string): EgressClass | undefined {
  return routing.egress[provider];
}

/**
 * Resolves `strong` | `tier:strong` | `github-copilot/claude-opus-5` to a `ModelTarget`.
 *
 * Disambiguation is positional and total: a `/` means a literal `provider/id`; a `tier:` prefix
 * means a tier; a bare word is a tier if `routing.json` declares one by that name, and an error
 * otherwise. There is no "try it as a model and see" path — a bare model id would resolve against
 * whatever provider PI happened to prefer, which is routing by accident.
 *
 * `catalogue` is the session's model registry, and passing it turns on the existence check. It is
 * optional for two reasons and neither is convenience: `ctx.modelRegistry` can throw at
 * `session_start` (there is then no authority to check against, and the degradation is announced
 * rather than guessed at), and `registry.ts`'s load-time pass asks a question about *routing*, not
 * about availability, and already reports the availability verdict through its own channel.
 *
 * Every refusal names the value AND how it was read, because the two failure modes are
 * indistinguishable from the message otherwise. A bare word is a *tier* name that does not exist,
 * not a broken model id; a caller told only "unknown model: <word>" retries with a differently
 * spelled bare word instead of doing the one thing that works — qualifying it with a provider.
 */
export function resolveModelSpec(
  routing: RoutingConfig,
  spec: string,
  defaultTier: string,
  catalogue?: ModelCatalogue,
  admission?: ProviderAdmission,
): ModelTarget {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return assertAvailable(resolveTier(routing, defaultTier, defaultTier), catalogue, routing, admission);
  }

  if (trimmed.startsWith("tier:")) {
    return assertAvailable(resolveTier(routing, trimmed.slice("tier:".length), trimmed), catalogue, routing, admission);
  }
  if (trimmed.includes("/")) {
    const provider = trimmed.slice(0, trimmed.indexOf("/"));
    if (!provider) throw new DispatchError("config", `model "${trimmed}" has an empty provider`);
    const egress = egressOf(routing, provider);
    return assertAvailable(
      {
        spec: trimmed,
        model: trimmed,
        provider,
        ...(egress !== undefined ? { egress } : {}),
        optional: false,
      },
      catalogue,
      routing,
      admission,
    );
  }
  if (Object.hasOwn(routing.tiers, trimmed)) {
    return assertAvailable(resolveTier(routing, trimmed, trimmed), catalogue, routing, admission);
  }

  const unbound = unboundReason(routing, trimmed);
  if (unbound !== undefined) throw unboundError(trimmed, unbound);

  throw new DispatchError(
    "unknown_tier",
    `model "${trimmed}" is neither a known tier (${Object.keys(routing.tiers).join(", ")}) ` +
      `nor a provider-qualified id of the form provider/id. It was read as a TIER NAME because it ` +
      `contains no "/". ` +
      (catalogue ? `${didYouMean(trimmed, catalogue)} ` : "") +
      `To pin a concrete model instead, write it provider-qualified.`,
  );
}

/** The reason `routing.json` gives for a tier that exists in the vocabulary but is not bound. */
function unboundReason(routing: RoutingConfig, tier: string): string | undefined {
  return routing.unboundTiers?.[tier];
}

/**
 * A tier that is part of the vocabulary but has no provider installed to back it.
 *
 * This is the one case where "unknown tier" would be actively misleading: `confidential` is not a
 * typo, it is a real tier that this install cannot honour because nothing with that egress class was
 * configured. Naming it — and naming the command that fixes it — is the whole point. Under no
 * circumstances does it resolve to some other tier's model: that would put material the caller
 * declared confidential onto whatever provider happened to be available.
 */
function unboundError(tier: string, reason: string): DispatchError {
  return new DispatchError(
    "unknown_tier",
    `tier "${tier}" is part of this harness's vocabulary but is NOT BOUND to a model on this ` +
      `install. ${reason} Nothing is substituted for it: dispatching onto a different tier's ` +
      `provider would silently change where this work runs. Bind it in config/routing.json, or ` +
      `re-run scripts/install.sh and select a provider for it.`,
  );
}

/** `gpt-5.4` is a real id under two providers here; saying so is more useful than "unknown tier". */
function didYouMean(spec: string, catalogue: ModelCatalogue): string {
  const near = describeAlternatives(spec, catalogue);
  return near.startsWith("Closest available") ? `Did you mean one of these ids? ${near.slice("Closest available: ".length)}` : "";
}

/**
 * The existence check, in two steps: is the PROVIDER one this install has, and then is the MODEL in
 * the registry.
 *
 * ## Step 1 — the provider
 *
 * A provider that is not configured does not exist (owner decision, 2026-08-14). `ctx.modelRegistry`
 * carries providers PI knows natively whether or not this install ever set them up, so gating on
 * the registry alone used to accept `<provider>/<id>` on a machine with no block for that provider
 * in `config/models.json` and no key for one; the dispatch was admitted here and died later, in a
 * child process, on a missing credential. The refusal names the model, the provider and which
 * config file is missing it, because "unknown model" would send the reader hunting for a typo that
 * is not there.
 *
 * This step runs even when `catalogue` is `undefined` — the registry being unreadable says nothing
 * about what the two config files declare — and even for an `optional` tier, because "the local
 * model server is not running right now" and "this provider was never configured" are different
 * facts.
 *
 * ## Step 2 — the model
 *
 * Unchanged, and still skipped for a tier flagged `optional` in `routing.json`: the local lane
 * requires a local model server to be running, and `registry.ts` already treats its absence as a
 * runtime condition rather than a misconfiguration. Everything else that resolves must exist,
 * whether the caller named it directly or a tier did.
 */
function assertAvailable(
  target: ModelTarget,
  catalogue: ModelCatalogue | undefined,
  routing: RoutingConfig,
  admission?: ProviderAdmission,
): ModelTarget {
  if (admission !== undefined && !admission.dispatchable.has(target.provider)) {
    const why = describeProviderRefusal(target.provider, admission) ?? "it is not a dispatchable provider";
    const via =
      target.tier !== undefined
        ? `tier "${target.tier}" resolves to ${target.model} (config/routing.json), whose provider `
        : `model "${target.spec}" names provider `;
    throw new DispatchError(
      "unconfigured_provider",
      `${via}"${target.provider}" is not configured for dispatch: ${why}. ` +
        `Dispatchable providers are: ${[...admission.dispatchable].sort().join(", ") || "(none)"}. ` +
        `Nothing is substituted — name one of those, or add the provider to the config file above. ` +
        `A provider PI knows natively is still not a provider this install has.`,
    );
  }
  if (catalogue === undefined || target.optional) return target;
  // The catalogue is keyed by `provider/id`, and a thinking level is not part of an id. So the
  // existence check asks about the base model while `target.model` keeps its suffix — the suffix
  // is the entire point, being what PI reads to set the child's reasoning effort.
  const { baseModel } = splitThinkingSuffix(target.model);
  if (catalogue.set.has(baseModel)) return target;

  if (target.tier !== undefined) {
    throw new DispatchError(
      "unknown_model",
      `tier "${target.tier}" resolves to ${target.model} (routing.json), which is not in this ` +
        `session's model registry (${catalogue.ids.length} model(s) available). ` +
        `${describeAlternatives(baseModel, catalogue)} ` +
        `This is a routing.json error, not a bad call — fix the tier rather than working around it.`,
    );
  }
  throw new DispatchError(
    "unknown_model",
    `model "${target.spec}" was read as a provider-qualified model id (it contains "/") and is ` +
      `not in this session's model registry (${catalogue.ids.length} model(s) available). ` +
      `${describeAlternatives(baseModel, catalogue)} ` +
      `Or name a tier: ${Object.keys(routing.tiers).join(", ")}.`,
  );
}

/**
 * Makes a tier's declared `thinkingLevel` real by moving it into the model string, which is the
 * only place PI reads effort from (`./thinking.ts`).
 *
 * Until 2026-08-13 the field was parsed, carried onto `ModelTarget` and consumed by nothing, so
 * every tier that declared one had been silently running at the provider default while
 * `routing.json` claimed otherwise — the exact silent-substitution failure this project refuses
 * everywhere else. It is applied here rather than deleted because `config/bin/pi-tier` reads the
 * field, and because a declared level is more legible than a suffix buried in an id.
 *
 * A suffix already on the model string WINS: it is the more specific statement, and writing both
 * is how someone pins one tier's effort without touching the field `pi-tier` reads.
 */
function applyTierThinkingLevel(tier: string, model: string, thinkingLevel: string | undefined): string {
  if (thinkingLevel === undefined) return model;
  if (!isThinkingLevel(thinkingLevel)) {
    throw new DispatchError(
      "config",
      `tier "${tier}" declares thinkingLevel "${thinkingLevel}", which is not one of ` +
        `${THINKING_LEVELS.join("|")}. It would be sent to the provider as part of the model id ` +
        `and the dispatch would abort on an id nothing serves — fix routing.json.`,
    );
  }
  return splitThinkingSuffix(model).thinkingSuffix === "" ? `${model}:${thinkingLevel}` : model;
}

function resolveTier(routing: RoutingConfig, tier: string, spec: string): ModelTarget {
  const row = routing.tiers[tier];
  if (row === undefined) {
    const unbound = unboundReason(routing, tier);
    if (unbound !== undefined) throw unboundError(tier, unbound);
    throw new DispatchError(
      "unknown_tier",
      `unknown tier "${tier}" (known: ${Object.keys(routing.tiers).join(", ")})`,
    );
  }
  const provider = row.model.slice(0, row.model.indexOf("/"));
  if (!provider) throw new DispatchError("config", `tier "${tier}" has a model without a provider: ${row.model}`);
  const egress = egressOf(routing, provider);
  return {
    spec,
    tier,
    model: applyTierThinkingLevel(tier, row.model, row.thinkingLevel),
    provider,
    ...(egress !== undefined ? { egress } : {}),
    ...(row.thinkingLevel !== undefined ? { thinkingLevel: row.thinkingLevel } : {}),
    optional: row.optional === true,
  };
}

export interface SessionEgressInput {
  /** `PI_ROUTING_EGRESS`. An explicit declaration always wins. */
  readonly declared?: string;
  /** Provider of the session's own active model, when one is known. */
  readonly activeProvider?: string;
  readonly defaultEgress: EgressClass;
}

export interface SessionEgressResolution {
  readonly egress: EgressClass;
  readonly source: "declared" | "active-model" | "default";
  readonly note?: string;
}

/**
 * The session's class, in priority order: an explicit `PI_ROUTING_EGRESS`, then the class of the
 * provider the session itself is already talking to, then the configured default. Deriving from
 * the active model is the honest reading of "what has this conversation already touched": a
 * session running on `databricks` is confidential whether or not anybody said so.
 */
export function resolveSessionEgress(routing: RoutingConfig, input: SessionEgressInput): SessionEgressResolution {
  const declared = input.declared?.trim();
  if (declared) {
    if (declared === "public" || declared === "internal" || declared === "confidential") {
      return { egress: declared, source: "declared" };
    }
    return {
      egress: input.defaultEgress,
      source: "default",
      note: `PI_ROUTING_EGRESS="${declared}" is not one of public|internal|confidential; using ${input.defaultEgress}`,
    };
  }
  if (input.activeProvider) {
    const cls = routing.egress[input.activeProvider];
    if (cls !== undefined) return { egress: cls, source: "active-model" };
    return {
      egress: input.defaultEgress,
      source: "default",
      note: `active provider "${input.activeProvider}" has no egress class in routing.json; using ${input.defaultEgress}`,
    };
  }
  return { egress: input.defaultEgress, source: "default" };
}

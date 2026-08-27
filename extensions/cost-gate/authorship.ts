/**
 * "Was this model's price written down, or did PI invent a zero for it?"
 *
 * The defect this exists for: `cost` is REQUIRED on PI's runtime model type and OPTIONAL in
 * `models.json`, and the gap is closed silently. `core/provider-composer.js` substitutes
 * `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` for any model definition that omits it,
 * so by the time a rate reaches `calculateCost` an authored zero and a forgotten field are the
 * same object. The status line then reads a flat `$0.000` for the whole session on a provider
 * that may be charging real money, and nothing anywhere says so.
 *
 * That is not hypothetical, and the way it goes wrong is worse than a typo. A gateway that serves
 * a model group for free can start charging for it later; the four zeros somebody wrote against it
 * were true when they were written and are false afterwards. Nothing in the configuration changes,
 * nothing fails, and there is no surface anywhere on which the change can appear. Sessions keep
 * reporting `$0.000` a turn while a real bill accumulates somewhere nobody is looking.
 *
 * The fix has to preserve the one distinction the runtime destroys, so this module does not look
 * at the runtime model at all — it goes back to `models.json`, which is the only artefact that
 * can still tell an authored zero from an absent one. Everything here is pure: it takes parsed
 * JSON and returns a verdict, so the whole rule is testable without PI, a gateway, or a bill.
 *
 * The rule is deliberately NOT "a zero cost is an error". A zero is a legal, meaningful answer: an
 * endpoint can be genuinely unmetered, or billed somewhere this harness cannot see, and saying so
 * in four explicit zeros plus a `notes[]` entry is exactly right. What is not legal is silence.
 */

/** The four rate fields of PI's `ModelCostRates`. All four, or the object is incomplete. */
export const COST_RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type CostRateField = (typeof COST_RATE_FIELDS)[number];

export type CostAuthorship =
  /** `models.json` declares a complete rate table for this model. Whatever it says is intended. */
  | { readonly verdict: "authored" }
  /** `models.json` declares this model and does NOT price it. The zeros are PI's, not anyone's. */
  | { readonly verdict: "substituted"; readonly missing: readonly CostRateField[] }
  /** Not this module's business. Carries the reason so a surprised reader is not left guessing. */
  | { readonly verdict: "no-opinion"; readonly reason: string };

interface ModelEntry {
  readonly id?: unknown;
  readonly cost?: unknown;
}

/**
 * The verdict for `provider/model` against a parsed `models.json`.
 *
 * `no-opinion` is returned generously and on purpose. This gate may only fire where it is certain,
 * because the thing it does — ending a session — is far worse to do wrongly than to skip:
 *
 *   - unreadable or malformed config: cannot say. A broken `models.json` is somebody else's error
 *     to report, and `/doctor` already does.
 *   - provider absent from `models.json`: PI knows providers this install never configured. Their
 *     catalogues are PI's own and already priced.
 *   - provider present but declaring no `models` array: the `modelOverrides` shape, which corrects
 *     a built-in catalogue rather than replacing it. `cost` is not overridable there, so an
 *     omission is not an omission — it is the only possible spelling. A built-in catalogue is
 *     priced by PI, completely and non-zero, before this repository sees it.
 *   - model absent from the provider's catalogue: a subagent, a `--model` flag or a stale id can
 *     name a model this file never declared. PI resolved it from somewhere else; the price came
 *     from there too.
 */
export function classifyModelCost(raw: unknown, provider: string, model: string): CostAuthorship {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { verdict: "no-opinion", reason: "models.json is not a JSON object" };
  }
  const providers = (raw as { providers?: unknown }).providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    return { verdict: "no-opinion", reason: "models.json declares no providers object" };
  }
  const block = (providers as Record<string, unknown>)[provider];
  if (block === undefined) {
    return { verdict: "no-opinion", reason: `provider "${provider}" is not declared in models.json` };
  }
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return { verdict: "no-opinion", reason: `provider "${provider}" is malformed in models.json` };
  }
  const models = (block as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return {
      verdict: "no-opinion",
      reason: `provider "${provider}" declares no explicit model catalogue (cost is not overridable there)`,
    };
  }
  const entry = models.find(
    (m): m is ModelEntry => m !== null && typeof m === "object" && (m as ModelEntry).id === model,
  );
  if (entry === undefined) {
    return {
      verdict: "no-opinion",
      reason: `model "${model}" is not in provider "${provider}"'s catalogue in models.json`,
    };
  }
  const missing = missingRates(entry.cost);
  return missing.length === 0 ? { verdict: "authored" } : { verdict: "substituted", missing };
}

/**
 * Which of the four rates this `cost` object fails to state as a number.
 *
 * A partial `cost` counts as substituted rather than authored, because the composer's `??` is
 * whole-object: `{ input: 2 }` does not merge with the default, it replaces it, and the three
 * fields nobody wrote become the same invisible zeros as if the whole object were missing. The
 * missing names go into the report so the fix is a field list, not a hunt.
 */
function missingRates(cost: unknown): CostRateField[] {
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    return [...COST_RATE_FIELDS];
  }
  const obj = cost as Record<string, unknown>;
  return COST_RATE_FIELDS.filter((field) => typeof obj[field] !== "number" || !Number.isFinite(obj[field] as number));
}

/**
 * Did this response actually bill anything?
 *
 * Token counters, never `usage.cost` — the cost is zero by construction in exactly the case this
 * gate is looking for, so testing it would disarm the gate on every session it exists to catch.
 *
 * `cacheWrite1h` is deliberately absent: PI documents it as a subset of `cacheWrite`, so adding it
 * would double-count. It cannot change the answer either way — a response with 1h writes has
 * `cacheWrite` above zero already.
 */
export function billedTokens(usage: unknown): number {
  if (usage === null || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  let total = 0;
  for (const field of COST_RATE_FIELDS) {
    const value = u[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

export interface CostSubstitutionReport {
  readonly provider: string;
  readonly model: string;
  /** The `models.json` that was read, so the fix is a path and not a search. */
  readonly source: string;
  readonly missing: readonly CostRateField[];
  readonly tokens: number;
}

/**
 * The block written to the log, in `provider-error.ts`'s shape — same alignment, same
 * `policy` line, because it is the same rule (`REQ-PRV-32`) applied to a different failure.
 *
 * It says "substituted, not authored" in those words on purpose. The one thing a reader must not
 * conclude is that somebody decided this model is free.
 */
export function formatCostSubstitution(report: CostSubstitutionReport): string {
  return [
    summariseCostSubstitution(report),
    `  provider : ${report.provider}`,
    `  model    : ${report.model}`,
    `  class    : cost-undeclared`,
    `  source   : ${report.source}`,
    `  missing  : ${report.missing.join(", ")} (rates are DOLLARS PER MILLION TOKENS)`,
    `  billed   : ${report.tokens} token(s) on this response`,
    `  effect   : PI's provider composer substituted zeros for every missing rate, so this session` +
      ` reports $0.000 for every turn regardless of what the provider charges.`,
    `  fix      : declare "cost" for this model in the file above. A genuinely free or unmetered` +
      ` endpoint declares the zeros explicitly — that is what makes it a decision instead of an omission.`,
    `  policy   : abort — an undeclared price is not a zero price, and a spend nobody can see is` +
      ` the failure this harness refuses to keep quiet about (REQ-PRV-32).`,
  ].join("\n");
}

/** The one-line form, for `ctx.ui.notify` where there is no room for the block. */
export function summariseCostSubstitution(report: CostSubstitutionReport): string {
  return (
    `pi-config: no cost declared for ${report.provider}/${report.model}, which just billed ` +
    `${report.tokens} token(s) — reported spend would be $0.000. Aborting.`
  );
}

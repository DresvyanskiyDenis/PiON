/**
 * Reasoning effort, as PI 0.84.0 actually carries it: **inside the model string**.
 *
 * `provider/id:max` is not a convention of ours. `pi-subagents` splits the suffix off in
 * `resolveEffectiveThinking` (`src/shared/model-info.ts:36`) and applies it on the launch path
 * (`src/runs/foreground/subagent-executor.ts:2146`), where it outranks both the agent file's
 * `thinking:` and any per-call override. It is the only route by which a dispatch can set a
 * child's effort, and it needs no unvalidated tool argument — which is why this repository uses
 * it and leaves the package's top-level `thinking` argument (watchdog-scoped, `schemas.ts:287`)
 * alone.
 *
 * This lives in its own module because both halves of the feature need it and they sit on
 * opposite sides of an import: `tiers.ts` must strip the suffix before the existence check and
 * re-attach a tier's declared level, and `catalogue.ts` must show the effective level in the
 * menu. `tiers.ts` already imports `catalogue.ts`, so the shared piece cannot live in either.
 */

/**
 * A MIRROR of `pi-subagents`' `THINKING_LEVELS` (`src/shared/model-info.ts:1`). Duplicated, not
 * imported, because the package's `exports` map publishes ten entry points and `shared/model-info`
 * is not among them — there is no supported import path for it.
 *
 * Keep it in step on every PI upgrade. The failure mode of drift is narrow and loud rather than
 * silent: a level the package knows and we do not is left attached to the model id, the catalogue
 * lookup misses, and the dispatch is refused by name with `unknown_model`. Nothing is substituted.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((known) => known === value);
}

/**
 * Splits `provider/gpt-nova:max` into its base id and its thinking suffix.
 *
 * The suffix must survive resolution untouched and reach the child; all this does is know that it
 * is not part of the id, so the catalogue — keyed by bare `provider/id` — can still be asked
 * whether the model exists.
 *
 * Only a KNOWN level splits. `provider/id:garbage` keeps its colon and fails the existence check,
 * which is the right outcome: a typo in an effort level must not be quietly read as an id, and
 * must certainly not be quietly read as `max`.
 */
export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
  const colon = model.lastIndexOf(":");
  if (colon === -1) return { baseModel: model, thinkingSuffix: "" };
  const level = model.slice(colon + 1);
  if (!isThinkingLevel(level)) return { baseModel: model, thinkingSuffix: "" };
  return { baseModel: model.slice(0, colon), thinkingSuffix: `:${level}` };
}

/**
 * The level a model string ASKS FOR, or `undefined` when it carries none and the provider's own
 * default applies.
 *
 * This was called `effectiveLevel` until 2026-08-14, and the name was the bug in miniature: the
 * suffix is a REQUEST, and PI clamps it against the model's own vocabulary before the wire
 * (`clampThinkingLevel` below). `provider/gpt-nova:max` reports `max` here and may ship `high`.
 * Use `clampThinkingLevel` for what actually runs; use this only for what was asked.
 */
export function requestedLevel(model: string): ThinkingLevel | undefined {
  const { thinkingSuffix } = splitThinkingSuffix(model);
  if (thinkingSuffix === "") return undefined;
  const level = thinkingSuffix.slice(1);
  return isThinkingLevel(level) ? level : undefined;
}

/**
 * A model's reasoning vocabulary, as the model registry reports it. The two fields are exactly the
 * ones `pi-ai`'s clamp reads (`Model.reasoning`, `Model.thinkingLevelMap`,
 * `@earendil-works/pi-ai/dist/types.d.ts:661-672`); nothing else about a model matters here.
 */
export interface ThinkingCapability {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
}

/**
 * A MIRROR of `pi-ai`'s `getSupportedThinkingLevels`
 * (`@earendil-works/pi-ai/dist/models.js:548-561`), duplicated for the same reason
 * `THINKING_LEVELS` is: the function is not on any published entry point of the package this
 * extension may import, and the child process — not this one — is where PI applies it.
 *
 * The asymmetry in the filter is the package's, not ours, and it is load-bearing: a level mapped to
 * `null` is unsupported, but `xhigh` and `max` are ALSO unsupported when simply absent, while
 * `off`/`minimal`/`low`/`medium`/`high` are assumed present unless explicitly nulled. So a model
 * that declares no map at all serves five levels and refuses the top two.
 */
export function supportedThinkingLevels(cap: ThinkingCapability): ThinkingLevel[] {
  if (!cap.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = cap.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * A MIRROR of `pi-ai`'s `clampThinkingLevel` (`@earendil-works/pi-ai/dist/models.js:562-578`): the
 * level that will actually reach the provider when `level` is requested of this model.
 *
 * The search order is the package's and is NOT "round down". It walks UP from the requested level
 * first and only then down, so `off` against a gateway map that nulls `off` and `minimal` clamps
 * UP to `low` — a request for less thinking that yields more. Reproduced rather than simplified,
 * because a disclosure that disagrees with the wire is worse than no disclosure.
 *
 * Keep it in step on every PI upgrade, together with `THINKING_LEVELS`. Drift here is silent by
 * construction — it would misreport rather than fail — which is why the test asserts the
 * gateway-shaped and Anthropic-shaped cases by name rather than only the algorithm.
 */
export function clampThinkingLevel(cap: ThinkingCapability, level: ThinkingLevel): ThinkingLevel {
  const available = supportedThinkingLevels(cap);
  if (available.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return available[0] ?? "off";
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i];
    if (candidate !== undefined && available.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i];
    if (candidate !== undefined && available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

/**
 * What a dispatch asked for versus what it will get, for one resolved model string.
 *
 * `undefined` is returned when there is nothing to disclose — the string names no level, or the
 * registry does not know the model — and the caller then leaves the model string alone. That is
 * deliberate: this module never invents a level, it only reports one that was already written.
 */
export interface ThinkingDisclosure {
  readonly requested: ThinkingLevel;
  readonly effective: ThinkingLevel;
  readonly clamped: boolean;
  /** Everything this model does serve, so a refusal-shaped message can name the real options. */
  readonly supported: readonly ThinkingLevel[];
  /** The model string with the EFFECTIVE level attached — what belongs on the wire and in the log. */
  readonly effectiveModel: string;
}

export function discloseThinking(model: string, cap: ThinkingCapability | undefined): ThinkingDisclosure | undefined {
  if (cap === undefined) return undefined;
  const { baseModel } = splitThinkingSuffix(model);
  const requested = requestedLevel(model);
  if (requested === undefined) return undefined;
  const effective = clampThinkingLevel(cap, requested);
  return {
    requested,
    effective,
    clamped: effective !== requested,
    supported: supportedThinkingLevels(cap),
    effectiveModel: `${baseModel}:${effective}`,
  };
}

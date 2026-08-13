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
 * The level a model string will actually run at, or `undefined` when it carries none and the
 * provider's own default applies. Used for display; the string itself is the authority.
 */
export function effectiveLevel(model: string): ThinkingLevel | undefined {
  const { thinkingSuffix } = splitThinkingSuffix(model);
  if (thinkingSuffix === "") return undefined;
  const level = thinkingSuffix.slice(1);
  return isThinkingLevel(level) ? level : undefined;
}

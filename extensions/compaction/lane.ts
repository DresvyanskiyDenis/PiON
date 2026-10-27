/**
 * Compaction on the local lane (`extensions/dispatch/local-lane.ts`): the session's own local model
 * summarises, and the threshold is capped to that model's window.
 *
 * The cap exists because a flat `absoluteTokens` can be larger than a small local window.
 * `min(absoluteTokens, 0.75 x contextWindow)` is the value used. It applies on the lane ONLY: the
 * same cap on every session would move remote compaction too (a 200K window would compact at
 * 150K instead of 200K).
 */

/** Fraction of the model's window at which the lane compacts. */
export const LANE_WINDOW_RATIO = 0.75;

/** `min(absolute, 0.75 x contextWindow)`; `absolute: 0` (the operator's opt-out) stays 0. */
export function laneThreshold(absolute: number, contextWindow: number): number {
  if (absolute <= 0) return 0;
  return Math.min(absolute, Math.floor(contextWindow * LANE_WINDOW_RATIO));
}

/** True when the context is past the lane's cap. `tokens` is `null` right after a compaction. */
export function overLaneThreshold(tokens: number | null | undefined, absolute: number, contextWindow: number): boolean {
  const cap = laneThreshold(absolute, contextWindow);
  return cap > 0 && typeof tokens === "number" && tokens > cap;
}

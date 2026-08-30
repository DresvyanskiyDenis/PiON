/**
 * Which classified provider failures are worth trying again, and how many times.
 *
 * ## Why this exists
 *
 * `config/routing.json`'s `onProviderError` block listed six error classes and treated all six
 * identically: kill the turn. That is right for four of them and wrong for two, and the wrongness
 * was observed live twice on 2026-08-30, on two different providers:
 *
 *   - `empty-response — http 200, empty body, 0 content parts` on one provider killed a lead turn;
 *   - the same class on a second provider killed a **dispatched subagent mid-mission**, inside a
 *     bounded fan-out, i.e. it destroyed paid work rather than a turn the operator could retype.
 *
 * An empty completion at HTTP 200 is a provider artifact, not a decision — nothing about the
 * request made it happen and nothing about it will be different next time. The same holds for
 * `network`. It does not hold for `auth`, `quota`, `model-not-found` or `policy`: those are
 * verdicts about the request, and re-sending it unchanged asks the same question of the same
 * endpoint and gets the same answer, one round trip later.
 *
 * ## What this is NOT
 *
 * It is not failover. The retry goes to **the same provider and the same model**, which is the
 * standing rule this repo has held since `EXT-08` was cancelled: no substitution, no fallback
 * chain, no quiet degradation onto a different endpoint. `onProviderError.substituteProvider`
 * stays `false` and `policy` stays `abort` — abort is still where every one of these ends up; the
 * only thing that changed is that two classes get one more attempt before they get there.
 *
 * ## Where the number comes from
 *
 * `routing.json` -> `onProviderError.retry`, a NEW key. The existing `errorClasses` array is left
 * exactly as it was and keeps exactly its old meaning — the classes this harness is able to
 * produce and report. Re-reading that key as "and these are the ones to retry" would change the
 * meaning of a shipped key without touching it, which is the kind of silent semantic drift the
 * config in this repo is documented against. An absent `retry` block is the documented default
 * below, not "no retries".
 */
import type { ProviderErrorClass } from "./provider-error.ts";
import { readRoutingFile, type RoutingFile } from "./routing-file.ts";

/** Every class `classifyProviderError` and `buildEmptyCompletionFailure` can produce. */
const KNOWN_CLASSES: readonly ProviderErrorClass[] = [
  "auth",
  "quota",
  "network",
  "model-not-found",
  "policy",
  "empty-response",
];

/**
 * The two transient classes, and the whole of the argument for each:
 *
 *   - `network` — DNS, TLS, proxy, timeout, 5xx. The request never got an answer from the model,
 *     so nothing about it was refused.
 *   - `empty-response` — a well-formed 200 whose body carried no completion. Observed on
 *     `github-copilot` and on `litellm` on the same day, both times on a request that was fine.
 *
 * The other four are verdicts, not weather. Retrying `auth` re-presents a credential that was just
 * rejected; retrying `quota` spends the next second of a budget that is already spent; retrying
 * `model-not-found` asks for an id the endpoint does not serve; retrying `policy` re-submits text
 * a tenant filter just refused, and doing that on a loop is how an account gets flagged.
 */
export const DEFAULT_RETRY_CLASSES: readonly ProviderErrorClass[] = ["network", "empty-response"];

/**
 * One retry, then abort.
 *
 * One rather than three because the failure this exists for is a coin flip, not a queue: the
 * evidence is a single empty 200 in the middle of otherwise healthy traffic, and if the second
 * attempt is empty too the answer is not "try a third time", it is "this endpoint is broken now
 * and the operator needs to know". A larger budget also silently multiplies the cost of a
 * hard-failing fan-out by the budget, on paid tokens, with nothing in the transcript that looks
 * like an explanation.
 */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 1;

export interface ProviderRetryPolicy {
  readonly classes: ReadonlySet<ProviderErrorClass>;
  /** Retries *after* the first attempt. `0` disables retrying without removing the block. */
  readonly maxAttempts: number;
  /** Where the policy was read from, for the notice. `<default>` when nothing declared one. */
  readonly source: string;
  /** Anything malformed in the declared block. Reported, never thrown, never silently applied. */
  readonly problems: readonly string[];
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  classes: new Set(DEFAULT_RETRY_CLASSES),
  maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
  source: "<default>",
  problems: [],
};

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse `onProviderError.retry` out of an already-read `routing.json`.
 *
 * Every malformed field falls back to its default and says so. A retry policy that refused to load
 * would turn a typo in one key into "no session talks to any provider", which is a far worse
 * failure than the one this module fixes.
 */
export function parseProviderRetryPolicy(routing: RoutingFile): ProviderRetryPolicy {
  const problems: string[] = [];
  if (routing.raw === undefined) {
    return {
      ...DEFAULT_PROVIDER_RETRY_POLICY,
      source: routing.source,
      problems: routing.problem !== undefined ? [`${routing.problem}; using the built-in retry defaults`] : [],
    };
  }
  const block = plainObject(routing.raw.onProviderError);
  const retry = block === undefined ? undefined : plainObject(block.retry);
  if (retry === undefined) {
    // Not a problem: the key is new, and its absence is the documented default rather than an
    // opt-out. `retry: {"maxAttempts": 0}` is how an operator turns retrying off.
    return { ...DEFAULT_PROVIDER_RETRY_POLICY, source: routing.source };
  }

  let classes: ReadonlySet<ProviderErrorClass> = new Set(DEFAULT_RETRY_CLASSES);
  if (retry.classes !== undefined) {
    if (!Array.isArray(retry.classes)) {
      problems.push(`onProviderError.retry.classes must be an array of error classes; using ${DEFAULT_RETRY_CLASSES.join(", ")}`);
    } else {
      const known = new Set<ProviderErrorClass>();
      for (const entry of retry.classes) {
        if (typeof entry === "string" && (KNOWN_CLASSES as readonly string[]).includes(entry)) {
          known.add(entry as ProviderErrorClass);
        } else {
          problems.push(`onProviderError.retry.classes lists "${String(entry)}", which is not one of ${KNOWN_CLASSES.join(", ")}; ignored`);
        }
      }
      classes = known;
    }
  }

  let maxAttempts = DEFAULT_MAX_RETRY_ATTEMPTS;
  if (retry.maxAttempts !== undefined) {
    const value = retry.maxAttempts;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problems.push(`onProviderError.retry.maxAttempts must be an integer >= 0; using ${DEFAULT_MAX_RETRY_ATTEMPTS}`);
    } else {
      maxAttempts = value;
    }
  }

  return { classes, maxAttempts, source: routing.source, problems };
}

/** Read `config/routing.json` and parse the retry policy out of it. */
export function loadProviderRetryPolicy(override?: string): ProviderRetryPolicy {
  return parseProviderRetryPolicy(readRoutingFile(override));
}

/**
 * Should the harness re-issue this turn?
 *
 * `retriesSoFar` counts retries already spent on the CURRENT failure streak, not on the session:
 * a turn that succeeds clears the budget, because the next transient failure is a new coin flip
 * and not the continuation of an old one.
 */
export function shouldRetry(
  policy: ProviderRetryPolicy,
  klass: ProviderErrorClass,
  retriesSoFar: number,
): boolean {
  return policy.classes.has(klass) && retriesSoFar < policy.maxAttempts;
}

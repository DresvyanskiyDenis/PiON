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
 * request made it happen. The same holds for `network`. It does not hold for `auth`, `quota`,
 * `model-not-found` or `policy`: those are verdicts about the request, and re-sending it unchanged
 * asks the same question of the same endpoint and gets the same answer, one round trip later.
 *
 * ## The half of that argument measurement took back
 *
 * The sentence this module used to carry — "and nothing about it will be different next time" —
 * was the justification for re-issuing the request UNCHANGED, and it is false as stated. On an
 * audited session tree the incidence of `empty-response` did not spread evenly across the
 * configured providers: the overwhelming majority landed on a single gateway route, a couple on
 * `github-copilot`, and none at all on a second route through the same gateway. The class
 * correlates with the ROUTE, so on `temperature: 0` a bit-identical resend to that same route is
 * the retry variant with the LOWEST expected recovery rate of any option available. `network` is
 * untouched by this — DNS, TLS, proxy and 5xx genuinely are route-independent, and the original
 * argument still holds there word for word.
 *
 * So `empty-response` gets a second lever, `onProviderError.retry.onEmpty` (below): a retry that
 * is allowed to change the reasoning effort the attempt is issued at, and to say in the re-issue
 * that it did. It changes no provider and no model — see the next section, which is unchanged.
 * The default is still `identical`, because the alternative is a harness that silently reasons
 * less than the operator asked it to; varying is an explicit, config-expressible act.
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
import type { ThinkingLevel } from "@earendil-works/pi-ai";

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

/**
 * How many times a maxed-out streak may be handed a fresh budget for a DIFFERENT class's failure,
 * within the same session, before the pin becomes permanent for the rest of it.
 *
 * `retriesSpent` (`extensions/credentials.ts`) is one counter shared by both transient classes, not
 * one per class. Once it pins at its budget the streak is terminal — see `shouldRetry` — and stays
 * that way through a session switch or a turn that actually worked, which is right for the class
 * that spent it. It is wrong for an unrelated class that failed for the first time an hour later:
 * denying that failure any attempt at all because a different problem exhausted the counter earlier
 * mistakes "this session has seen one bad streak" for "this session no longer gets to retry
 * anything". `maxStreakRestarts` is the bounded answer — a handful of fresh starts across a
 * session's lifetime, not an unlimited one, so two classes trading failures back and forth still
 * cannot retry forever.
 */
export const DEFAULT_MAX_STREAK_RESTARTS = 2;

/**
 * The reasoning-effort vocabulary `pi.setThinkingLevel` accepts, derived from `pi-ai`'s own type
 * rather than retyped beside it.
 *
 * The `satisfies` is the whole point: a level added upstream makes this object miss a required key
 * and the build fails, and a level removed upstream makes it an excess property and the build
 * fails. `extensions/dispatch/thinking.ts` keeps a hand-written mirror because the vocabulary it
 * needs (`off` included) is `pi-subagents`', not `pi-ai`'s; this one has a real type to lean on,
 * so it leans on it.
 */
export const RETRY_THINKING_LEVELS = Object.keys({
  minimal: 0,
  low: 0,
  medium: 0,
  high: 0,
  xhigh: 0,
  max: 0,
} satisfies Record<ThinkingLevel, number>) as readonly ThinkingLevel[];

/** What a retry on `empty-response` is allowed to change about the request. */
export type EmptyResponseStrategy = "identical" | "vary";

/**
 * `onProviderError.retry.onEmpty` — the answer to "and what is different about this attempt?".
 *
 * `identical` is the default and is NOT a shrug: it is the behaviour that shipped with `retry`
 * itself, kept as the default because the alternative silently lowers the reasoning effort an
 * operator asked for. Varying is a decision, so it is written down.
 */
export interface EmptyResponsePolicy {
  readonly strategy: EmptyResponseStrategy;
  /**
   * The reasoning effort the varied attempt is issued at. Absent means the only thing that differs
   * is the re-issue's own instruction — which `planRetryVariation` then says out loud rather than
   * letting "vary" imply a wire-level change that was never configured.
   */
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * Attempts granted to `empty-response` ON TOP of `maxAttempts`, and only while varying.
   *
   * Separate from `maxAttempts` because the argument for a budget of one was about IDENTICAL
   * resends: a second coin flip with the same coin. A varied attempt is a different experiment, so
   * it can honestly be worth more than one — but it costs paid tokens per attempt, so it defaults
   * to `0` and has to be asked for.
   */
  readonly maxExtraAttempts: number;
}

/** No variation, no extra budget. Exactly the behaviour `retry` shipped with. */
export const DEFAULT_EMPTY_RESPONSE_POLICY: EmptyResponsePolicy = {
  strategy: "identical",
  maxExtraAttempts: 0,
};

export interface ProviderRetryPolicy {
  readonly classes: ReadonlySet<ProviderErrorClass>;
  /** Retries *after* the first attempt. `0` disables retrying without removing the block. */
  readonly maxAttempts: number;
  /** What an `empty-response` retry varies, if anything. Never applies to any other class. */
  readonly onEmpty: EmptyResponsePolicy;
  /** See `DEFAULT_MAX_STREAK_RESTARTS`. `0` means a maxed-out streak never restarts for anything. */
  readonly maxStreakRestarts: number;
  /** Where the policy was read from, for the notice. `<default>` when nothing declared one. */
  readonly source: string;
  /** Anything malformed in the declared block. Reported, never thrown, never silently applied. */
  readonly problems: readonly string[];
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  classes: new Set(DEFAULT_RETRY_CLASSES),
  maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
  onEmpty: DEFAULT_EMPTY_RESPONSE_POLICY,
  maxStreakRestarts: DEFAULT_MAX_STREAK_RESTARTS,
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

  let maxStreakRestarts = DEFAULT_MAX_STREAK_RESTARTS;
  if (retry.maxStreakRestarts !== undefined) {
    const value = retry.maxStreakRestarts;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problems.push(`onProviderError.retry.maxStreakRestarts must be an integer >= 0; using ${DEFAULT_MAX_STREAK_RESTARTS}`);
    } else {
      maxStreakRestarts = value;
    }
  }

  return {
    classes,
    maxAttempts,
    onEmpty: parseEmptyResponsePolicy(retry.onEmpty, problems),
    maxStreakRestarts,
    source: routing.source,
    problems,
  };
}

/**
 * Parse `onProviderError.retry.onEmpty`.
 *
 * Fails CLOSED, unlike every other field here: anything malformed falls back to `identical`, i.e.
 * to the old behaviour, and says so. That asymmetry is deliberate. A typo in `classes` costs an
 * extra round trip; a typo in this block silently runs the whole session at a reasoning effort
 * nobody asked for, which is the failure mode `routing.json` exists to make impossible.
 */
function parseEmptyResponsePolicy(value: unknown, problems: string[]): EmptyResponsePolicy {
  if (value === undefined) return DEFAULT_EMPTY_RESPONSE_POLICY;
  const block = plainObject(value);
  if (block === undefined) {
    problems.push("onProviderError.retry.onEmpty must be an object; retrying empty-response unchanged");
    return DEFAULT_EMPTY_RESPONSE_POLICY;
  }

  let strategy: EmptyResponseStrategy = DEFAULT_EMPTY_RESPONSE_POLICY.strategy;
  if (block.strategy !== undefined) {
    if (block.strategy === "identical" || block.strategy === "vary") {
      strategy = block.strategy;
    } else {
      problems.push(`onProviderError.retry.onEmpty.strategy must be "identical" or "vary"; retrying empty-response unchanged`);
      return DEFAULT_EMPTY_RESPONSE_POLICY;
    }
  }

  let thinkingLevel: ThinkingLevel | undefined;
  if (block.thinkingLevel !== undefined) {
    if (typeof block.thinkingLevel === "string" && (RETRY_THINKING_LEVELS as readonly string[]).includes(block.thinkingLevel)) {
      thinkingLevel = block.thinkingLevel as ThinkingLevel;
    } else {
      problems.push(
        `onProviderError.retry.onEmpty.thinkingLevel must be one of ${RETRY_THINKING_LEVELS.join(", ")}; ` +
          `the retry will not change the reasoning effort`,
      );
    }
  }

  let maxExtraAttempts = DEFAULT_EMPTY_RESPONSE_POLICY.maxExtraAttempts;
  if (block.maxExtraAttempts !== undefined) {
    const extra = block.maxExtraAttempts;
    if (typeof extra !== "number" || !Number.isInteger(extra) || extra < 0) {
      problems.push(`onProviderError.retry.onEmpty.maxExtraAttempts must be an integer >= 0; using ${maxExtraAttempts}`);
    } else {
      maxExtraAttempts = extra;
    }
  }

  return { strategy, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}), maxExtraAttempts };
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
 * and not the continuation of an old one. It is deliberately NOT cleared just because the harness
 * decided to abort — see `maxStreakRestarts` on `ProviderRetryPolicy` — so `retriesSoFar` arrives
 * here already pinned at its budget for as long as the same class keeps failing, and `shouldRetry`
 * keeps returning `false` for it without oscillating back to "yes" on the next identical failure.
 *
 * `pinnedClass`, when given, is the class that produced the CURRENT value of `retriesSoFar`. A
 * pin left by a different class does not apply to `klass` — this class has spent nothing yet on
 * its own account — so it gets a fresh look, bounded by `streakRestarts` against
 * `policy.maxStreakRestarts` rather than left open-ended: two classes trading failures back and
 * forth must not be able to retry forever just by alternating.
 */
export function shouldRetry(
  policy: ProviderRetryPolicy,
  klass: ProviderErrorClass,
  retriesSoFar: number,
  streakRestarts = 0,
  pinnedClass?: ProviderErrorClass,
): boolean {
  if (!policy.classes.has(klass)) return false;
  const budget = retryBudget(policy, klass);
  const crossedClass = pinnedClass !== undefined && pinnedClass !== klass && retriesSoFar > 0;
  const effectiveSoFar = crossedClass ? 0 : retriesSoFar;
  if (effectiveSoFar < budget) {
    return !crossedClass || streakRestarts < policy.maxStreakRestarts;
  }
  return false;
}

/**
 * How many retries this class gets — `maxAttempts`, plus `onEmpty.maxExtraAttempts` when the
 * `empty-response` retry is actually varying the request.
 *
 * `maxAttempts: 0` outranks everything and returns `0`. It is the documented opt-out, and an
 * opt-out that a second key could quietly overturn is not one.
 */
export function retryBudget(policy: ProviderRetryPolicy, klass: ProviderErrorClass): number {
  if (policy.maxAttempts === 0) return 0;
  if (klass !== "empty-response" || policy.onEmpty.strategy !== "vary") return policy.maxAttempts;
  return policy.maxAttempts + policy.onEmpty.maxExtraAttempts;
}

/** What the next attempt does differently, and the clause that says so in the re-issue. */
export interface RetryVariation {
  /** `identical` for every class but `empty-response`, and for that one unless configured. */
  readonly strategy: EmptyResponseStrategy;
  /**
   * The reasoning effort to put on the wire, present ONLY when it differs from `currentLevel`.
   * Absent therefore means "change nothing about the request parameters", never "unknown".
   */
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * A factual clause naming what did and did not change, for the re-issue's own text. It states
   * the honest case in all four shapes, including the two where "vary" was asked for and nothing
   * on the wire could actually be varied — an instruction that claims a change that did not happen
   * is worse than no instruction.
   */
  readonly summary: string;
}

const NO_OTHER_PROVIDER = "no other provider was tried";

/**
 * Decide what the re-issue changes, given the policy, the class, and the effort the session is
 * currently on.
 *
 * `currentLevel` is the LIVE level (post-clamp, as `pi.getThinkingLevel()` reports it), not the
 * one the tier declares: comparing against a declared level would announce a change on a model
 * that clamped it away. It is a bare `string` rather than a `ThinkingLevel` because the caller's
 * vocabulary is PI's session vocabulary, which is free to grow a value this block may never be
 * configured to ask for; narrowing the parameter would make such a live value unrepresentable
 * rather than making it safer.
 */
export function planRetryVariation(
  policy: ProviderRetryPolicy,
  klass: ProviderErrorClass,
  currentLevel: string | undefined,
): RetryVariation {
  if (klass !== "empty-response" || policy.onEmpty.strategy !== "vary") {
    return { strategy: "identical", summary: `nothing about the request changed and ${NO_OTHER_PROVIDER}` };
  }
  const wanted = policy.onEmpty.thinkingLevel;
  if (wanted === undefined) {
    return {
      strategy: "vary",
      summary:
        `routing.json onProviderError.retry.onEmpty declares no thinkingLevel, so no request ` +
        `parameter changed (this instruction is the only difference) and ${NO_OTHER_PROVIDER}`,
    };
  }
  if (wanted === currentLevel) {
    return {
      strategy: "vary",
      summary:
        `reasoning effort is already \`${wanted}\`, the level onProviderError.retry.onEmpty asks ` +
        `for, so no request parameter changed and ${NO_OTHER_PROVIDER}`,
    };
  }
  return {
    strategy: "vary",
    thinkingLevel: wanted,
    summary:
      `reasoning effort moves from \`${currentLevel ?? "the session default"}\` to \`${wanted}\` for ` +
      `this attempt (routing.json onProviderError.retry.onEmpty) and ${NO_OTHER_PROVIDER}`,
  };
}

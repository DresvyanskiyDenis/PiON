// EXT-13 — `onProviderError.retry`: which classified failures get one more attempt, WHAT IS
// DIFFERENT ABOUT IT, and how the decision is rendered.
//
// The rule this file pins down is narrow on purpose. Two of the six classes — `network` and
// `empty-response` — are provider artifacts: nothing about the request caused them. The other four
// are verdicts about the request, and re-sending it unchanged asks the same question of the same
// endpoint. The retry goes to the SAME provider and the SAME model; this is not failover arriving
// under a new key, and several assertions below exist only to keep it from becoming that.
//
// THE HALF OF THAT PREMISE THAT WAS FALSIFIED
// --------------------------------------------
// This header used to end the first sentence with "...and nothing about it will be different next
// time", and that clause was the entire justification for re-issuing the request UNCHANGED.
// Measurement took it back for one of the two classes. On an audited session tree `empty-response`
// did not spread evenly across the configured providers: the overwhelming majority landed on a
// single gateway route, a couple on a second provider, and none at all on a third. It correlates
// with the ROUTE, so at `temperature: 0` a bit-identical resend to that same route is the retry
// variant with the LOWEST expected recovery rate of any option available. The clause survives
// verbatim for `network` — DNS, TLS, proxy and 5xx really are route-independent — and the tests
// below hold that asymmetry in place.
//
// `onProviderError.retry.onEmpty` is the answer: an `empty-response` retry may be configured to
// issue the attempt at a different reasoning effort. Still the same provider, still the same
// model. `the request the retry actually issues` below compares the request PARAMETERS of the two
// attempts rather than reading the re-issue's prose, because prose is exactly what a retry can
// change while changing nothing that reaches the provider.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { register } from "../extensions/credentials.ts";
import { buildEmptyCompletionFailure, formatProviderFailure, type ProviderFailure } from "../extensions/lib/provider-error.ts";
import {
  DEFAULT_EMPTY_RESPONSE_POLICY,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_MAX_STREAK_RESTARTS,
  DEFAULT_RETRY_CLASSES,
  loadProviderRetryPolicy,
  parseProviderRetryPolicy,
  planRetryVariation,
  retryBudget,
  RETRY_THINKING_LEVELS,
  shouldRetry,
} from "../extensions/lib/provider-retry.ts";
import type { RoutingFile } from "../extensions/lib/routing-file.ts";

const file = (raw: Record<string, unknown> | undefined, problem?: string): RoutingFile =>
  ({ raw, source: "/fixture/routing.json", ...(problem !== undefined ? { problem } : {}) });

const withRetry = (retry: unknown): RoutingFile => file({ onProviderError: { policy: "abort", retry } });

function fixtureRouting(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "ext13-retry-")), "routing.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

describe("the policy that ships", () => {
  it("retries exactly the two transient classes, exactly once", () => {
    assert.deepEqual([...DEFAULT_RETRY_CLASSES], ["network", "empty-response"]);
    assert.equal(DEFAULT_MAX_RETRY_ATTEMPTS, 1);
  });

  it("is what config/routing.json actually declares — the file and the default cannot drift", () => {
    // The default lives in code so an absent block behaves; the file states it so an operator can
    // see it and change it. If those two ever disagree, one of them is a lie.
    // PiON uses routing.default.json as the shipped config; routing.json is git-ignored.
    const shipped = loadProviderRetryPolicy();
    assert.deepEqual([...shipped.classes].sort(), [...DEFAULT_RETRY_CLASSES].sort());
    assert.equal(shipped.maxAttempts, DEFAULT_MAX_RETRY_ATTEMPTS);
    assert.deepEqual(shipped.problems, []);
    assert.match(shipped.source, /config\/routing\.(json|default\.json)$/);
  });

  it("never retries a verdict about the request", () => {
    const policy = parseProviderRetryPolicy(file(undefined));
    for (const klass of ["auth", "quota", "model-not-found", "policy"] as const) {
      assert.equal(shouldRetry(policy, klass, 0), false, `${klass} must not be retried`);
    }
    for (const klass of ["network", "empty-response"] as const) {
      assert.equal(shouldRetry(policy, klass, 0), true);
    }
  });

  it("spends the budget once and then stops", () => {
    const policy = parseProviderRetryPolicy(file(undefined));
    assert.equal(shouldRetry(policy, "empty-response", 0), true);
    assert.equal(shouldRetry(policy, "empty-response", 1), false);
    assert.equal(shouldRetry(policy, "empty-response", 7), false);
  });

  it("caps how many times a spent streak may be re-armed by a different class", () => {
    // A streak's budget is per-class (`retriesSoFar` resets to 0 the moment the class changes), so
    // switching classes always looks like a fresh budget to `retryBudget` alone. `maxStreakRestarts`
    // is the second, session-wide gate on top of that: it counts how many times THIS streak has
    // already been handed a fresh budget for a class other than the one that first spent it, and
    // shuts the door once that count reaches the cap — independent of which class shows up next.
    const policy = parseProviderRetryPolicy(file(undefined));

    // Same class throughout: never a restart, budget behaves exactly as the single-class test above.
    assert.equal(shouldRetry(policy, "network", 0, 0, undefined), true);

    // The class changes with attempts already spent against a different pin: this is the 1st
    // restart. Under the default cap (2), it is still granted.
    assert.equal(shouldRetry(policy, "empty-response", 1, 1, "network"), true);

    // A 3rd cross-class switch, with `streakRestarts` already AT the default cap (2), is refused —
    // this is the exact gate the original bug was missing, and it fires even though the new class's
    // own per-class budget has not been touched yet.
    assert.equal(shouldRetry(policy, "network", 1, 2, "empty-response"), false, "streakRestarts (2) has reached maxStreakRestarts (2)");

    // The cap only gates a CROSSING: with 0 attempts spent so far against the new class, there is no
    // crossing to gate (`retriesSoFar > 0` is false), so the per-class budget alone decides — even
    // with `streakRestarts` already at the cap.
    assert.equal(shouldRetry(policy, "network", 0, 2, "empty-response"), true, "no attempts spent yet on the new class — nothing to cross");
  });
});

describe("reading onProviderError.retry", () => {
  it("treats an absent block as the documented default, not as 'no retries'", () => {
    const policy = parseProviderRetryPolicy(file({ onProviderError: { policy: "abort" } }));
    assert.equal(policy.maxAttempts, DEFAULT_MAX_RETRY_ATTEMPTS);
    assert.deepEqual(policy.problems, []);
  });

  it("leaves the existing errorClasses key alone — it still means 'classes this harness reports'", () => {
    // Re-reading a shipped key as 'and these are the ones to retry' would change its meaning
    // without touching it. `errorClasses` lists all six; retrying all six is exactly what this
    // change is not.
    const policy = parseProviderRetryPolicy(
      file({ onProviderError: { errorClasses: ["auth", "quota", "network", "model-not-found", "policy", "empty-response"] } }),
    );
    assert.deepEqual([...policy.classes].sort(), [...DEFAULT_RETRY_CLASSES].sort());
  });

  it("honours maxAttempts: 0 as the documented opt-out", () => {
    const policy = parseProviderRetryPolicy(withRetry({ maxAttempts: 0 }));
    assert.equal(policy.maxAttempts, 0);
    assert.deepEqual(policy.problems, []);
    assert.equal(shouldRetry(policy, "empty-response", 0), false);
  });

  it("honours a narrowed class list", () => {
    const policy = parseProviderRetryPolicy(withRetry({ classes: ["network"], maxAttempts: 2 }));
    assert.deepEqual([...policy.classes], ["network"]);
    assert.equal(shouldRetry(policy, "empty-response", 0), false);
    assert.equal(shouldRetry(policy, "network", 1), true);
  });

  it("falls back and says so on every malformed field, and never throws", () => {
    // A typo in one key must not become 'no session talks to any provider' — that failure is far
    // worse than the one this module fixes.
    const bad = parseProviderRetryPolicy(withRetry({ classes: "network", maxAttempts: -1 }));
    assert.deepEqual([...bad.classes].sort(), [...DEFAULT_RETRY_CLASSES].sort());
    assert.equal(bad.maxAttempts, DEFAULT_MAX_RETRY_ATTEMPTS);
    assert.equal(bad.problems.length, 2);

    const unknownClass = parseProviderRetryPolicy(withRetry({ classes: ["network", "sunspots"] }));
    assert.deepEqual([...unknownClass.classes], ["network"]);
    assert.match(unknownClass.problems[0] ?? "", /"sunspots"/);

    for (const shape of [null, 3, "yes", []]) {
      assert.doesNotThrow(() => parseProviderRetryPolicy(withRetry(shape)));
    }
  });

  it("honours a configured maxStreakRestarts, and falls back with a problem on a bad value", () => {
    const policy = parseProviderRetryPolicy(withRetry({ maxStreakRestarts: 5 }));
    assert.equal(policy.maxStreakRestarts, 5);
    assert.deepEqual(policy.problems, []);

    const bad = parseProviderRetryPolicy(withRetry({ maxStreakRestarts: -1 }));
    assert.equal(bad.maxStreakRestarts, DEFAULT_MAX_STREAK_RESTARTS);
    assert.match(bad.problems[0] ?? "", /onProviderError\.retry\.maxStreakRestarts must be an integer >= 0/);
  });

  it("keeps the defaults when routing.json cannot be read, and reports why", () => {
    const policy = parseProviderRetryPolicy(file(undefined, "routing.json not found"));
    assert.equal(policy.maxAttempts, DEFAULT_MAX_RETRY_ATTEMPTS);
    assert.match(policy.problems[0] ?? "", /not found; using the built-in retry defaults/);
  });

  it("reads the file through PI_ROUTING_CONFIG, the same seam dispatch honours", () => {
    const path = fixtureRouting({ onProviderError: { retry: { classes: ["network"], maxAttempts: 3 } } });
    const policy = loadProviderRetryPolicy(path);
    assert.equal(policy.source, path);
    assert.equal(policy.maxAttempts, 3);
  });
});

describe("the policy line in the failure block", () => {
  const base = buildEmptyCompletionFailure({
    provider: "litellm",
    model: "gpt-empty-fixture",
    status: 200,
    stopReason: "stop",
    usage: { input: 0, output: 0 },
  });
  const policyLine = (f: ProviderFailure) =>
    formatProviderFailure(f).split("\n").find((l) => l.trimStart().startsWith("policy   :")) ?? "";

  it("is unchanged, to the byte, when no retry is in play", () => {
    assert.equal(
      policyLine(base),
      "  policy   : abort — no failover, no substitution, no retry against another provider (routing.json onProviderError.policy)",
    );
  });

  it("says which attempt failed and that the next one goes to the same endpoint", () => {
    const line = policyLine({ ...base, retry: { attempt: 1, maxAttempts: 1, willRetry: true } });
    assert.match(line, /retry 1 of 1/);
    assert.match(line, /same provider and model/);
    assert.match(line, /onProviderError\.retry/);
  });

  it("distinguishes 'one empty 200' from 'two in a row' at the abort", () => {
    // This is the line the operator has to be able to recognise: the budget is spent, the class
    // recurred, and no other provider was tried — the word 'retry' in a failover-free harness is
    // exactly the word that invites the opposite reading.
    const line = policyLine({ ...base, retry: { attempt: 2, maxAttempts: 1, willRetry: false } });
    assert.match(line, /abort after 2 attempts/);
    assert.match(line, /budget \(1\) is spent and the class recurred/);
    assert.match(line, /no failover, no substitution/);
  });

  it("says the streak's restarts are maxed out, not that a phantom budget is spent, once any were granted", () => {
    // Once this streak has already been re-armed for another class at least once, the class
    // recurring a second time is not "the same budget spent twice" — it is "every fresh start this
    // session allows has been used". The old wording implied a budget that, by this point, does not
    // exist any more; this line has to say what actually happened instead.
    const line = policyLine({
      ...base,
      retry: { attempt: 2, maxAttempts: 1, willRetry: false, streakRestarts: 2, maxStreakRestarts: 2 },
    });
    assert.match(line, /abort after 2 attempts/);
    assert.match(line, /maxed out \(used all 2 restarts this session gets\)/);
    assert.doesNotMatch(line, /budget \(1\) is spent/);
    assert.match(line, /no failover, no substitution/);
  });
});

describe("onProviderError.retry.onEmpty — what the retry is allowed to change", () => {
  it("defaults to identical with no extra budget — an absent block is the old behaviour, not fail-open", () => {
    // The point of the default is that it is BORING. An absent block must not quietly lower the
    // reasoning effort of a session an operator configured; varying is an act, and acts are written
    // down. `bin/rules/pc-31` is what makes the boring default visible rather than silent.
    const policy = parseProviderRetryPolicy(withRetry({ classes: ["empty-response"] }));
    assert.deepEqual(policy.onEmpty, DEFAULT_EMPTY_RESPONSE_POLICY);
    assert.equal(policy.onEmpty.strategy, "identical");
    assert.equal(policy.onEmpty.maxExtraAttempts, 0);
    assert.equal(policy.onEmpty.thinkingLevel, undefined);
    assert.equal(retryBudget(policy, "empty-response"), DEFAULT_MAX_RETRY_ATTEMPTS);
  });

  it("is what the shipped routing file declares — a shipped file with no strategy is PC-31's warning", () => {
    const shipped = loadProviderRetryPolicy();
    assert.equal(shipped.onEmpty.strategy, "vary");
    assert.ok(
      shipped.onEmpty.thinkingLevel !== undefined,
      "vary with no thinkingLevel varies nothing that reaches the provider",
    );
    assert.deepEqual(shipped.problems, []);
  });

  it("applies to empty-response and to nothing else", () => {
    // `network` is retried identically ON PURPOSE and correctly: DNS, TLS, proxy and 5xx are
    // route-independent, so the original argument survives there untouched. A variation policy that
    // leaked into it would be lowering the reasoning effort for a failure that never reached the
    // model at all.
    const policy = parseProviderRetryPolicy(
      withRetry({ maxAttempts: 1, onEmpty: { strategy: "vary", thinkingLevel: "low", maxExtraAttempts: 2 } }),
    );
    assert.equal(retryBudget(policy, "network"), 1);
    assert.equal(retryBudget(policy, "empty-response"), 3);
    assert.deepEqual(planRetryVariation(policy, "network", "high"), {
      strategy: "identical",
      summary: "nothing about the request changed and no other provider was tried",
    });
  });

  it("grants the extra budget only while varying", () => {
    const identical = parseProviderRetryPolicy(
      withRetry({ maxAttempts: 1, onEmpty: { strategy: "identical", maxExtraAttempts: 5 } }),
    );
    assert.equal(retryBudget(identical, "empty-response"), 1, "extra attempts at the same request are the no-op again");
  });

  it("lets maxAttempts: 0 outrank the extra budget — an opt-out a second key can overturn is not one", () => {
    const off = parseProviderRetryPolicy(
      withRetry({ maxAttempts: 0, onEmpty: { strategy: "vary", thinkingLevel: "low", maxExtraAttempts: 3 } }),
    );
    assert.equal(retryBudget(off, "empty-response"), 0);
    assert.equal(shouldRetry(off, "empty-response", 0), false);
  });

  it("fails CLOSED on every malformed field, unlike the rest of this block", () => {
    // The asymmetry is deliberate and is the whole safety argument. A typo in `classes` costs one
    // round trip; a typo here would run a whole session at an effort nobody asked for.
    const badStrategy = parseProviderRetryPolicy(withRetry({ onEmpty: { strategy: "lower-effort" } }));
    assert.deepEqual(badStrategy.onEmpty, DEFAULT_EMPTY_RESPONSE_POLICY);
    assert.match(badStrategy.problems[0] ?? "", /must be "identical" or "vary"/);

    const badShape = parseProviderRetryPolicy(withRetry({ onEmpty: ["vary"] }));
    assert.deepEqual(badShape.onEmpty, DEFAULT_EMPTY_RESPONSE_POLICY);
    assert.match(badShape.problems[0] ?? "", /must be an object/);

    const badLevel = parseProviderRetryPolicy(withRetry({ onEmpty: { strategy: "vary", thinkingLevel: "off" } }));
    assert.equal(badLevel.onEmpty.strategy, "vary", "the strategy itself parsed; only the level did not");
    assert.equal(badLevel.onEmpty.thinkingLevel, undefined);
    assert.match(badLevel.problems[0] ?? "", /thinkingLevel must be one of/);

    const badExtra = parseProviderRetryPolicy(withRetry({ onEmpty: { strategy: "vary", maxExtraAttempts: 1.5 } }));
    assert.equal(badExtra.onEmpty.maxExtraAttempts, 0);
    assert.match(badExtra.problems[0] ?? "", /maxExtraAttempts must be an integer/);

    for (const shape of [null, 3, "vary", []]) {
      assert.doesNotThrow(() => parseProviderRetryPolicy(withRetry({ onEmpty: shape })));
    }
  });

  it("refuses `off` as a level — reasoning turned off is a different experiment, not a retry", () => {
    assert.deepEqual([...RETRY_THINKING_LEVELS], ["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("says so, rather than implying a change, when varying cannot vary anything", () => {
    // Both shapes below are "vary" configurations under which NOTHING that reaches the provider is
    // different. An instruction claiming a change that did not happen is worse than no instruction,
    // so the summary states the real case and `thinkingLevel` stays absent.
    const noLevel = parseProviderRetryPolicy(withRetry({ onEmpty: { strategy: "vary" } }));
    const declared = planRetryVariation(noLevel, "empty-response", "high");
    assert.equal(declared.thinkingLevel, undefined);
    assert.match(declared.summary, /declares no thinkingLevel, so no request parameter changed/);

    const already = parseProviderRetryPolicy(withRetry({ onEmpty: { strategy: "vary", thinkingLevel: "high" } }));
    const same = planRetryVariation(already, "empty-response", "high");
    assert.equal(same.thinkingLevel, undefined, "setting a level to the level it already is changes no bytes");
    assert.match(same.summary, /already `high`/);
    assert.match(same.summary, /no request parameter changed/);
  });

  it("names both ends of the move when there is one", () => {
    const policy = parseProviderRetryPolicy(withRetry({ onEmpty: { strategy: "vary", thinkingLevel: "low" } }));
    const varied = planRetryVariation(policy, "empty-response", "high");
    assert.equal(varied.strategy, "vary");
    assert.equal(varied.thinkingLevel, "low");
    assert.match(varied.summary, /reasoning effort moves from `high` to `low`/);
    assert.match(varied.summary, /no other provider was tried/, "still not failover, under any strategy");
  });
});

/* ------------------------------------------------------------------------------------------- *
 * The request the retry actually issues
 * ------------------------------------------------------------------------------------------- */

/**
 * Drive `extensions/credentials.ts` against a fixture routing file and record, at the moment of
 * each re-issue, the REQUEST PARAMETERS the next attempt will carry.
 *
 * Recording at send time is the load-bearing detail: `pi.setThinkingLevel` is a session-level lever
 * (PI exposes no per-message override — `pi.sendMessage`'s options are `triggerTurn` and
 * `deliverAs`, nothing else), so the only honest snapshot of "what this attempt is issued at" is
 * the level in force when the message is queued. Reading it afterwards would read the restored
 * value and prove nothing.
 */
function driveRetries(routing: unknown, startLevel: string, turns: Array<"empty" | "ok">) {
  const path = fixtureRouting(routing);
  const previous = process.env.PI_ROUTING_CONFIG;
  process.env.PI_ROUTING_CONFIG = path;

  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  /** One entry per re-issue: the request parameters of the attempt it triggers. */
  const issued: Array<{ thinkingLevel: string; text: string }> = [];
  const state = { thinkingLevel: startLevel };
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: (message: any) => {
      issued.push({ thinkingLevel: state.thinkingLevel, text: message.content?.[0]?.text ?? "" });
    },
    appendEntry: () => {},
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (level: string) => {
      state.thinkingLevel = level;
    },
  };
  const ctx = { hasUI: true, ui: { notify: () => {}, setStatus: () => {} } };
  const empty = {
    message: {
      role: "assistant",
      content: [] as unknown[],
      provider: "litellm",
      model: "gpt-empty-fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      rawStopReason: "stop",
    },
  };
  const ok = { message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } };

  const stderr = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  try {
    register(pi as any);
    for (const turn of turns) {
      for (const handler of handlers.get("message_end") ?? []) handler(turn === "empty" ? empty : ok, ctx);
    }
  } finally {
    (process.stderr as any).write = stderr;
    if (previous === undefined) delete process.env.PI_ROUTING_CONFIG;
    else process.env.PI_ROUTING_CONFIG = previous;
  }
  return { issued, finalLevel: state.thinkingLevel };
}

const VARY = {
  onProviderError: {
    retry: {
      classes: ["network", "empty-response"],
      maxAttempts: 1,
      onEmpty: { strategy: "vary", thinkingLevel: "low", maxExtraAttempts: 1 },
    },
  },
};
const IDENTICAL = {
  onProviderError: { retry: { classes: ["network", "empty-response"], maxAttempts: 2 } },
};

describe("the request the retry actually issues", () => {
  it("issues the retry with DIFFERENT parameters from the attempt that failed", () => {
    // The assertion this exists for, and it deliberately does not read the prose: a retry can
    // rewrite every word of its own instruction while sending the provider exactly the same
    // request. What is compared here is the request shape — the reasoning effort on the wire.
    const failedAt = "high";
    const { issued } = driveRetries(VARY, failedAt, ["empty"]);

    assert.equal(issued.length, 1, "one re-issue");
    assert.notDeepEqual(
      { thinkingLevel: issued[0]!.thinkingLevel },
      { thinkingLevel: failedAt },
      "the retried request must not be the failed request",
    );
    assert.equal(issued[0]!.thinkingLevel, "low");
  });

  it("issues each attempt of a longer streak, and the last one is still not the first request", () => {
    const failedAt = "high";
    const { issued } = driveRetries(VARY, failedAt, ["empty", "empty", "empty"]);

    assert.equal(issued.length, 2, "maxAttempts 1 + maxExtraAttempts 1, then abort");
    for (const attempt of issued) assert.notEqual(attempt.thinkingLevel, failedAt);
  });

  it("leaves the request untouched under the default strategy — the falsified premise, pinned", () => {
    // This is the behaviour the finding is about, kept as an explicit, asserted contrast rather
    // than deleted: under `identical` the retried request is the failed request, parameter for
    // parameter, which at `temperature: 0` is the variant that recovers least often.
    const failedAt = "high";
    const { issued, finalLevel } = driveRetries(IDENTICAL, failedAt, ["empty", "empty"]);

    assert.equal(issued.length, 2);
    assert.deepEqual(
      issued.map((a) => a.thinkingLevel),
      [failedAt, failedAt],
      "identical means identical — this is the measured no-op, not an oversight",
    );
    assert.equal(finalLevel, failedAt, "nothing was borrowed, so there is nothing to give back");
  });

  it("gives the borrowed reasoning effort back at the abort", () => {
    // A harness that lowered the effort for a retry and never restored it would keep reasoning less
    // than the operator asked for, silently, for the rest of the process.
    const { issued, finalLevel } = driveRetries(VARY, "high", ["empty", "empty", "empty"]);
    assert.equal(issued.length, 2);
    assert.equal(finalLevel, "high");
  });

  it("gives it back on a turn that worked, and starts the next streak from the operator's level", () => {
    const { issued, finalLevel } = driveRetries(VARY, "high", ["empty", "ok", "empty"]);
    assert.equal(finalLevel, "low", "the second streak has borrowed it again and not yet ended");
    assert.deepEqual(
      issued.map((a) => a.thinkingLevel),
      ["low", "low"],
      "the second streak's first retry starts from high again, not from the borrowed low",
    );
  });

  it("says in the re-issue what changed, and withdraws 'carry on with exactly what you were doing'", () => {
    // The closing instruction matters as much as the parameter: at `temperature: 0`, telling the
    // model to carry on with exactly what it was doing is itself a pull back toward the answer that
    // did not arrive.
    const varied = driveRetries(VARY, "high", ["empty"]).issued[0]!.text;
    assert.match(varied, /reasoning effort moves from `high` to `low`/);
    assert.match(varied, /Redo the work rather than reproducing the previous attempt\./);
    assert.doesNotMatch(varied, /Carry on with exactly what you were doing/);

    const identical = driveRetries(IDENTICAL, "high", ["empty"]).issued[0]!.text;
    assert.match(identical, /nothing about the request changed and no other provider was tried\./);
    assert.match(identical, /Carry on with exactly what you were doing\./);
  });
});

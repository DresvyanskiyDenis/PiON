// EXT-13 — `onProviderError.retry`: which classified failures get one more attempt, and how the
// decision is rendered.
//
// The rule this file pins down is narrow on purpose. Two of the six classes — `network` and
// `empty-response` — are provider artifacts: nothing about the request caused them and nothing
// about it will be different next time. The other four are verdicts about the request, and
// re-sending it unchanged asks the same question of the same endpoint. The retry goes to the SAME
// provider and the SAME model; this is not failover arriving under a new key, and several
// assertions below exist only to keep it from becoming that.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildEmptyCompletionFailure, formatProviderFailure, type ProviderFailure } from "../extensions/lib/provider-error.ts";
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_CLASSES,
  loadProviderRetryPolicy,
  parseProviderRetryPolicy,
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
    model: "gpt-5.6-luna",
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
});

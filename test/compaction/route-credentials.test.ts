/**
 * The compaction route's credentials: the class they fail with, and when they are checked.
 *
 * Two properties, both of them the same defect seen from different ends — a compaction route whose
 * last lane held a credential that had been refused for the better part of an hour, reported as
 * `network` when it finally mattered:
 *
 *  1. A credential the registry refuses is an `auth` failure by construction. Filed as `network` it
 *     lands in the retry-eligible bucket (`DEFAULT_RETRY_CLASSES`) and tells the operator to look at
 *     the wire instead of at their expired token.
 *  2. The verdict is reachable *before* the route is walked, and a candidate is reported when it
 *     changes state rather than on every pass.
 *
 * Nothing here names a real deployment; the credential helper is a shape, not a vendor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  credentialPreflightReport,
  prepareCandidate,
  type CredentialVerdict,
} from "../../extensions/compaction/index.ts";
import { classifyProviderError } from "../../extensions/lib/provider-error.ts";
import { DEFAULT_RETRY_CLASSES } from "../../extensions/lib/provider-retry.ts";
import type { RouteTarget } from "../../extensions/compaction/route.ts";

const TARGET: RouteTarget = {
  spec: "confidential",
  provider: "provider-b",
  modelId: "in-boundary-model",
} as RouteTarget;

const MODEL = { provider: "provider-b", id: "in-boundary-model" };

/** A candidate carrying its own model, so `prepareCandidate` never reaches the registry's `find`. */
const CANDIDATE = { target: TARGET, model: MODEL } as unknown as Parameters<typeof prepareCandidate>[1];

function ctxWith(registry: Record<string, unknown>): ExtensionContext {
  return {
    modelRegistry: { getRegisteredNativeProvider: () => undefined, ...registry },
    ui: { notify: () => {} },
    hasUI: false,
  } as unknown as ExtensionContext;
}

/**
 * A credential helper that exited non-zero. It carries no HTTP status and no phrase any auth
 * pattern knows, which is the whole point: the class has to come from the fact that a credential
 * was refused, never from reading the refusal.
 */
const HELPER_FAILED = "provider-b: token helper exited 1";

test("a credential the registry refuses is classified auth, not network", async () => {
  // The defect, pinned: classified from its prose alone, this message is `network` — the retryable
  // bucket. That is what the credential exits used to do.
  assert.equal(classifyProviderError({ message: HELPER_FAILED }), "network");

  const ctx = ctxWith({ getApiKeyAndHeaders: async () => ({ ok: false, error: HELPER_FAILED }) });
  const prepared = await prepareCandidate(ctx, CANDIDATE, "a compaction summary");
  assert.ok(!prepared.ok);
  assert.equal(prepared.failure.klass, "auth");
  assert.match(prepared.failure.message, /token helper exited 1/);
  // The consequence the class carries: `auth` is not retried, `network` is. A rejected credential
  // in the retry bucket re-presents the same dead token and calls it weather.
  assert.ok(!DEFAULT_RETRY_CLASSES.includes(prepared.failure.klass));
});

test("a credential resolution that throws is auth too, and keeps its cause", async () => {
  const boom = new Error("spawn token-helper ENOENT");
  const ctx = ctxWith({
    getApiKeyAndHeaders: async () => {
      throw boom;
    },
  });
  const prepared = await prepareCandidate(ctx, CANDIDATE, "a compaction summary");
  assert.ok(!prepared.ok);
  assert.equal(prepared.failure.klass, "auth");
  assert.equal(prepared.failure.cause, boom);
  assert.match(prepared.failure.message, /ENOENT/);
});

test("a usable credential comes back with the model and the resolved auth", async () => {
  const ctx = ctxWith({ getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", baseUrl: "https://gateway" }) });
  const prepared = await prepareCandidate(ctx, CANDIDATE, "a compaction summary");
  assert.ok(prepared.ok);
  assert.equal(prepared.auth.baseUrl, "https://gateway");
  assert.equal(prepared.model, MODEL);
});

test("a target missing from the registry is still model-not-found, not auth", async () => {
  const ctx = ctxWith({ find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) });
  const prepared = await prepareCandidate(ctx, { target: TARGET } as never, "a compaction summary");
  assert.ok(!prepared.ok);
  assert.equal(prepared.failure.klass, "model-not-found");
});

const dead = (spec: string, message: string): CredentialVerdict => ({
  spec,
  failure: { provider: "provider-b", model: "in-boundary-model", klass: "auth", message, midStream: false },
});
const alive = (spec: string): CredentialVerdict => ({ spec });

test("a newly dead credential is announced once, with its class and the registry's reason", () => {
  const report = credentialPreflightReport([alive("strong"), dead("confidential", "token expired")], []);
  assert.deepEqual([...report.dead], ["confidential"]);
  assert.equal(report.changed, true);
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0]?.level, "warning");
  assert.match(report.lines[0]?.text ?? "", /confidential/);
  assert.match(report.lines[0]?.text ?? "", /\[auth\]/);
  assert.match(report.lines[0]?.text ?? "", /token expired/);
});

test("the same dead credential on the next check says nothing — a check is not a reminder", () => {
  const report = credentialPreflightReport([dead("confidential", "token expired")], ["confidential"]);
  assert.deepEqual([...report.dead], ["confidential"]);
  assert.equal(report.changed, false);
  assert.deepEqual(report.lines, []);
});

test("a credential that resolves again is announced as the recovery it is", () => {
  const report = credentialPreflightReport([alive("confidential")], ["confidential"]);
  assert.deepEqual([...report.dead], []);
  assert.equal(report.changed, true);
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0]?.level, "info");
  assert.match(report.lines[0]?.text ?? "", /confidential/);
});

/**
 * Compaction resolves its own path to a provider, and survives one candidate failing.
 *
 * Two kinds of assertion, deliberately kept apart:
 *
 *   - **Behaviour of the resolver and the walk**, against synthetic routing files. That is where
 *     the edge cases live: an unknown tier, a duplicate hop, an effort level nothing serves, an
 *     empty route, a refusal that must not hop.
 *   - **Pins on the SHIPPED `config/routing.default.json`**, which is where the defect actually
 *     was. A resolver that *can* express an independent route proves nothing if the file this
 *     fork commits still sends compaction back to the lead's own model, so the shipped values are
 *     asserted directly rather than through a fixture free to drift away from them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  DEFAULT_COMPACTION_ROUTE,
  describeTarget,
  parseCompactionRoute,
  resolveCompactionRoute,
  shouldFailover,
  walkRoute,
} from "../../extensions/compaction/route.ts";
import type { ProviderErrorClass } from "../../extensions/lib/provider-error.ts";
import type { RoutingFile } from "../../extensions/lib/routing-file.ts";

function routingFile(raw: Record<string, unknown>): RoutingFile {
  return { raw, source: "<test>" };
}

/** A two-provider install, which is what a route is for. Nothing here names a real deployment. */
const TIERS = {
  strong: { model: "provider-a/big-model", thinkingLevel: "high" },
  light: { model: "provider-a/small-model", thinkingLevel: "medium" },
  confidential: { model: "provider-b/in-boundary-model", thinkingLevel: "high" },
};
const EGRESS = { "provider-a": "public", "provider-b": "confidential" };

function resolve(route: readonly string[], overrides: Record<string, unknown> = {}) {
  const file = routingFile({ tiers: TIERS, egress: EGRESS, ...overrides });
  return resolveCompactionRoute(file, { ...DEFAULT_COMPACTION_ROUTE, route });
}

describe("resolving a route", () => {
  test("a tier name resolves to that tier's model, effort and egress class", () => {
    const { targets, problems } = resolve(["light"]);
    assert.deepEqual(problems, []);
    assert.deepEqual(targets, [
      {
        spec: "light",
        tier: "light",
        provider: "provider-a",
        modelId: "small-model",
        thinkingLevel: "medium",
        egress: "public",
      },
    ]);
  });

  test("a provider-qualified id resolves literally and carries no tier", () => {
    const { targets } = resolve(["provider-b/in-boundary-model:high"]);
    assert.equal(targets[0]?.tier, undefined);
    assert.equal(targets[0]?.provider, "provider-b");
    assert.equal(targets[0]?.modelId, "in-boundary-model");
    assert.equal(targets[0]?.egress, "confidential");
  });

  test("an effort suffix written on the model outranks the tier's declared level", () => {
    assert.equal(resolve(["provider-a/small-model:low"]).targets[0]?.thinkingLevel, "low");
  });

  test("a provider the routing file does not classify resolves, unlabelled rather than refused", () => {
    const { targets, problems } = resolve(["provider-c/some-model"]);
    assert.deepEqual(problems, []);
    assert.equal(targets[0]?.egress, undefined);
  });

  test("describeTarget names the tier, the model, the effort and the egress class", () => {
    assert.equal(
      describeTarget(resolve(["light"]).targets[0]!),
      'tier "light" -> provider-a/small-model:medium [public]',
    );
  });
});

describe("one bad entry must not take the route down", () => {
  test("an unknown tier is dropped with a problem, and the rest of the route survives", () => {
    const { targets, problems } = resolve(["nope", "confidential"]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.tier, "confidential");
    assert.match(problems.join(" "), /"nope".*TIER NAME/);
  });

  test("a tier this install lists as unbound is skipped in silence, not complained about", () => {
    // The name is real and the fork knows it; this install simply has nothing to bind it to. Being
    // nagged once per session about a provider the operator never chose to install is how a warning
    // channel gets ignored, and the entry becomes a live hop the day the installer binds the tier.
    const { targets, problems } = resolve(["light", "confidential"], {
      tiers: { light: TIERS.light },
      tiersUnbound: { confidential: "no provider inside the boundary is installed" },
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(targets.map((t) => t.tier), ["light"]);
  });

  test("a duplicate hop is dropped, because it pays twice for the same refusal", () => {
    const { targets, problems } = resolve(["light", "provider-a/small-model", "confidential"]);
    assert.deepEqual(
      targets.map((t) => `${t.provider}/${t.modelId}`),
      ["provider-a/small-model", "provider-b/in-boundary-model"],
    );
    assert.match(problems.join(" "), /already earlier in the route/);
  });

  test("a tier declaring an effort nothing serves still runs, at the provider default, said out loud", () => {
    const { targets, problems } = resolve(["odd"], {
      tiers: { odd: { model: "provider-a/small-model", thinkingLevel: "ludicrous" } },
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.thinkingLevel, undefined);
    assert.match(problems.join(" "), /ludicrous/);
  });

  test("an empty route resolves to nothing, and the caller degrades to the session's model", () => {
    assert.deepEqual(resolve([]).targets, []);
  });
});

describe("parsing the compaction block", () => {
  test("an absent block is the built-in route, not an error", () => {
    const parsed = parseCompactionRoute({ tiers: TIERS });
    assert.deepEqual(parsed.settings, DEFAULT_COMPACTION_ROUTE);
    assert.deepEqual(parsed.problems, []);
  });

  test("an explicit empty route is honoured, because the key has to be switchable off", () => {
    assert.deepEqual(parseCompactionRoute({ compaction: { route: [] } }).settings.route, []);
  });

  test('"policy" cannot be configured as a failover class', () => {
    const parsed = parseCompactionRoute({
      compaction: { onRouteFailure: { failoverClasses: ["quota", "policy"] } },
    });
    assert.deepEqual(parsed.settings.failoverClasses, ["quota"]);
    assert.match(parsed.problems.join(" "), /policy/);
  });

  test("a malformed block falls back to the built-in route, loudly", () => {
    const parsed = parseCompactionRoute({ compaction: ["light"] });
    assert.deepEqual(parsed.settings, DEFAULT_COMPACTION_ROUTE);
    assert.equal(parsed.problems.length, 1);
  });
});

describe("the failover predicate", () => {
  test("the transient and per-candidate classes hop; a content-filter refusal does not", () => {
    for (const klass of ["quota", "network", "empty-response", "auth", "model-not-found"] as const) {
      assert.equal(shouldFailover(klass, DEFAULT_COMPACTION_ROUTE), true, `${klass} should hop`);
    }
    assert.equal(shouldFailover("policy", DEFAULT_COMPACTION_ROUTE), false);
  });
});

describe("walking the route", () => {
  interface Hop {
    readonly spec: string;
    readonly willHop: boolean;
  }

  /**
   * Walks a resolved route with a scripted outcome per candidate and records what the walk did.
   * `outcomes` is read positionally: entry N is what candidate N answers.
   */
  async function walk(route: readonly string[], outcomes: readonly ({ klass: string } | "ok" | "aborted")[]) {
    const { targets } = resolve(route);
    const candidates = targets.map((target) => ({ target }));
    const calls: string[] = [];
    const hops: Hop[] = [];
    let exhausted: { tried: readonly string[]; ranOut: boolean } | undefined;
    let recovered: { spec: string; index: number } | undefined;

    const result = await walkRoute<{ target: (typeof targets)[number] }, string, { klass: ProviderErrorClass }>(
      candidates,
      DEFAULT_COMPACTION_ROUTE,
      async (candidate, index) => {
        calls.push(candidate.target.spec);
        const scripted = outcomes[index] ?? { klass: "quota" as const };
        if (scripted === "ok") return { ok: true, result: `summary from ${candidate.target.spec}` };
        if (scripted === "aborted") return { ok: false, aborted: true };
        return { ok: false, failure: { klass: scripted.klass as ProviderErrorClass } };
      },
      {
        onHop: (candidate, _failure, willHop) => hops.push({ spec: candidate.target.spec, willHop }),
        onRecovered: (candidate, index) => void (recovered = { spec: candidate.target.spec, index }),
        onExhausted: (_failure, tried, ranOut) => void (exhausted = { tried, ranOut }),
      },
    );
    return { result, calls, hops, exhausted, recovered };
  }

  test("a quota refusal on the first candidate is answered by calling the second", async () => {
    // This is the deadlock, broken: the lead's budget being spent no longer decides whether the
    // session can shrink.
    const { result, calls, recovered, exhausted } = await walk(["light", "confidential"], [{ klass: "quota" }, "ok"]);
    assert.deepEqual(calls, ["light", "confidential"]);
    assert.equal(result, "summary from confidential");
    assert.equal(recovered?.index, 1);
    assert.equal(exhausted, undefined);
  });

  test("the first candidate succeeding never calls the second, and is not reported as a recovery", async () => {
    const { calls, recovered } = await walk(["light", "confidential"], ["ok"]);
    assert.deepEqual(calls, ["light"]);
    assert.equal(recovered, undefined);
  });

  test("a content-filter refusal ends the route where it stands", async () => {
    // Walking on until some tenant accepts the transcript is egress-shopping around a refusal that
    // was made on purpose, which is the one hop this module will not make.
    const { calls, hops, exhausted } = await walk(["light", "confidential"], [{ klass: "policy" }]);
    assert.deepEqual(calls, ["light"]);
    assert.deepEqual(hops, [{ spec: "light", willHop: false }]);
    assert.equal(exhausted?.ranOut, false, "stopping on a class is not the same as running out");
  });

  test("every candidate failing reports an exhausted route naming each one it tried", async () => {
    const { result, calls, exhausted } = await walk(
      ["light", "confidential"],
      [{ klass: "quota" }, { klass: "network" }],
    );
    assert.equal(result, undefined);
    assert.deepEqual(calls, ["light", "confidential"]);
    assert.equal(exhausted?.ranOut, true);
    assert.equal(exhausted?.tried.length, 2);
    assert.match(exhausted?.tried.join(" ") ?? "", /quota[\s\S]*network/);
  });

  test("a cancelled compaction ends the walk without spending a hop or reporting a failure", async () => {
    const { result, calls, hops, exhausted } = await walk(["light", "confidential"], ["aborted"]);
    assert.equal(result, undefined);
    assert.deepEqual(calls, ["light"]);
    assert.deepEqual(hops, []);
    assert.equal(exhausted, undefined);
  });
});

describe("the shipped config/routing.default.json", () => {
  // The template, not the generated `routing.json`: the generated file is git-ignored and does not
  // exist on a clone, and the template is what every fork actually commits.
  const shipped = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../config/routing.default.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
  const file = routingFile(shipped);
  const resolved = () => resolveCompactionRoute(file, parseCompactionRoute(shipped).settings);

  test("the shipped route resolves cleanly and has somewhere to go", () => {
    const { targets, problems } = resolved();
    assert.deepEqual(problems, [], "the shipped route must resolve without a complaint");
    assert.ok(targets.length >= 1, "the shipped route resolved to nothing");
  });

  test("no compaction candidate is the strong tier's model, because that deadlock is the whole point", () => {
    const strong = (shipped.tiers as Record<string, { model: string }>).strong.model;
    for (const target of resolved().targets) {
      assert.notEqual(`${target.provider}/${target.modelId}`, strong);
    }
  });

  test("the shipped route names a second candidate outside the first one's provider", () => {
    // A stock install has one provider, so the second hop resolves to nothing until the installer
    // binds a provider for it. Naming it anyway is what makes binding one enough: the route grows
    // the hop with no config edit, and a whole provider going down becomes survivable.
    const declared = parseCompactionRoute(shipped).settings.route;
    const unbound = Object.keys((shipped.tiersUnbound ?? {}) as Record<string, unknown>);
    assert.ok(declared.length >= 2, `the shipped route needs a second candidate: ${declared.join(", ")}`);
    assert.ok(
      declared.some((spec) => unbound.includes(spec)) || new Set(resolved().targets.map((t) => t.provider)).size >= 2,
      "the second candidate is neither on another provider nor an unbound tier waiting to be one",
    );
  });

  test("compaction's route does not reopen provider failover for the working path", () => {
    const onError = shipped.onProviderError as Record<string, unknown>;
    assert.equal(onError.policy, "abort");
    assert.equal(onError.substituteProvider, false);
  });
});

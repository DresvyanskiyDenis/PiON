import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ceiling from "../../extensions/dispatch/ceiling.ts";
import {
  CEILING_SOURCE,
  VETO_SPECIALIST,
  bestSpecialist,
  distinctiveWords,
  installCeiling,
  installVetoes,
  planCeiling,
  specialistVeto,
  type VetoContext,
} from "../../extensions/dispatch/ceiling.ts";
import { loadAgentRegistry, type AgentRegistry } from "../../extensions/dispatch/registry.ts";
import {
  dispatchVetoes,
  evaluateDispatch,
  resetDispatchVetoes,
} from "../../extensions/lib/dispatch-veto.ts";
import { ALL_MODELS, CONFIG, GOOD_SCOUT, ROUTING, scratch, writeAgents, type AgentFile } from "./helpers.ts";

const RESEARCHER: AgentFile = {
  name: "researcher",
  frontmatter: [
    "name: researcher",
    "description: Web research specialist - searches sources, reads pages and returns cited findings.",
    "model: fast",
  ].join("\n"),
};

const GENERAL: AgentFile = {
  name: "general-purpose",
  frontmatter: [
    "name: general-purpose",
    "description: Generic worker with no particular domain. Use only when nothing else fits.",
    "model: fast",
  ].join("\n"),
};

const PUBLIC_BIG: AgentFile = {
  name: "big",
  frontmatter: "name: big\ndescription: Heavyweight reasoning on the strong public tier.\nmodel: strong",
};

/** `local` is deliberately absent from ALL_MODELS: an optional tier whose backend is down. */
const OFFLINE: AgentFile = {
  name: "offline",
  frontmatter: "name: offline\ndescription: Runs on the local lane when llama-swap happens to be up.\nmodel: local",
};

function registryOf(files: readonly AgentFile[]): AgentRegistry {
  const dir = writeAgents(join(scratch(), "agents"), files);
  return loadAgentRegistry({
    dirs: [dir],
    routing: ROUTING,
    config: CONFIG,
    availableModels: ALL_MODELS,
  });
}

function ctxOf(registry: AgentRegistry): VetoContext {
  return {
    registry: () => registry,
    config: CONFIG,
  };
}

const ALL_TOOLS = ["read", "write", "bash", "subagent", "task", "agent", "dispatch_agent"];

describe("planCeiling", () => {
  /**
   * Rewritten 2026-08-13. This used to run at session class `internal` and expect `big` (a
   * github-copilot agent) to be excluded as out of class. Class excludes nothing now, so the two
   * surviving exclusions are asserted instead: a file that does not parse, and a file whose model
   * is not being served.
   */
  it("allows the agents that loaded clean and whose model is actually served", () => {
    const registry = registryOf([
      GOOD_SCOUT,
      PUBLIC_BIG,
      OFFLINE,
      { name: "typo", frontmatter: "name: typo\ndescription: This one names a tier that does not exist.\nmodel: tier:nope" },
    ]);
    const plan = planCeiling({ sessionId: "s1", registry, config: CONFIG, depth: 0, allToolNames: ALL_TOOLS });
    assert.deepEqual(
      plan.ceiling.allowedAgents,
      ["big", "scout"],
      "big is on a public provider and stays dispatchable; offline has no served model, typo is invalid",
    );
    assert.match(plan.notes.join("\n"), /allowedAgents: 2 of 4 \(1 whose model is not currently served, 1 invalid\)/);
  });

  it("leaves the dispatch tools in place while children are still below the cap", () => {
    const registry = registryOf([GOOD_SCOUT]);
    const plan = planCeiling({ sessionId: "s1", registry, config: CONFIG, depth: 0, allToolNames: ALL_TOOLS });
    assert.equal(plan.ceiling.allowedTools, undefined, "no tool ceiling is needed at depth 0 with maxDepth 2");
    assert.match(plan.notes.join("\n"), /children run at depth 1 \(max 2\); dispatch stays available/);
  });

  it("strips the dispatch tools from the child ceiling at the last permitted level", () => {
    const registry = registryOf([GOOD_SCOUT]);
    const plan = planCeiling({ sessionId: "s1", registry, config: CONFIG, depth: 1, allToolNames: ALL_TOOLS });
    assert.deepEqual(plan.ceiling.allowedTools, ["read", "write", "bash"]);
    assert.match(plan.notes.join("\n"), /structurally impossible, not merely counted/);
  });

  it("refuses to register an EMPTY tool allowlist, which would silently cripple every child", () => {
    const registry = registryOf([GOOD_SCOUT]);
    const plan = planCeiling({
      sessionId: "s1",
      registry,
      config: CONFIG,
      depth: 1,
      allToolNames: ["subagent", "task"],
    });
    assert.equal(plan.ceiling.allowedTools, undefined);
    assert.match(plan.notes.join("\n"), /no allowedTools ceiling is registered/);
  });

  it("never sets denyExtensions - a child without this extension has no depth check", () => {
    const registry = registryOf([GOOD_SCOUT]);
    const plan = planCeiling({ sessionId: "s1", registry, config: CONFIG, depth: 1, allToolNames: ALL_TOOLS });
    assert.equal((plan.ceiling as { denyExtensions?: unknown }).denyExtensions, undefined);
  });
});

describe("installCeiling", () => {
  it("either registers or announces the failure - it never swallows it", async () => {
    const registry = registryOf([GOOD_SCOUT]);
    const result = await installCeiling({
      sessionId: "s-install",
      registry,
      config: CONFIG,
      depth: 0,
      allToolNames: ALL_TOOLS,
    });
    assert.equal(CEILING_SOURCE, "pi-config/EXT-05");
    assert.equal(
      (result.handle === undefined) !== (result.failure === undefined),
      true,
      "exactly one of handle/failure must be set",
    );
    if (result.failure !== undefined) {
      // Under `node --test` the package cannot be imported at all: it ships .ts under node_modules
      // and plain node refuses to strip types there. PI loads it through jiti, where it works.
      // The point under test is the shape of the degradation, not which branch this runner takes.
      assert.match(result.failure, /is NOT in force/);
      assert.match(result.failure, /Depth is still enforced|Depth remains enforced/);
    }
    assert.ok(result.notes.length > 0, "the plan is reported either way");
  });
});

describe("distinctiveWords", () => {
  it("drops stopwords and short tokens, keeps domain terms", () => {
    const words = distinctiveWords("Please run the agent that will review our database migration");
    assert.deepEqual([...words].sort(), ["database", "migration", "review"]);
  });

  it("keeps hyphenated and dotted identifiers intact", () => {
    const words = distinctiveWords("edit pyproject.toml in the ci-pipeline");
    assert.ok(words.has("pyproject.toml"), "a filename must not be split on its dot");
    assert.ok(words.has("ci-pipeline"));
  });
});

describe("bestSpecialist", () => {
  const generic = new Set(CONFIG.genericAgents);

  it("finds the specialist whose description shares the most terms with the prompt", () => {
    const registry = registryOf([RESEARCHER, GOOD_SCOUT, GENERAL]);
    const match = bestSpecialist(registry, "Do some web research: search sources and return findings", generic, 2);
    assert.equal(match?.name, "researcher");
    assert.ok(match!.score >= 2);
  });

  it("never proposes a generic agent as the specialist", () => {
    const registry = registryOf([GENERAL]);
    assert.equal(bestSpecialist(registry, "generic worker with no particular domain", generic, 2), undefined);
  });

  /**
   * Rewritten 2026-08-13: the agent used to be unrecommendable because a confidential session could
   * not reach its provider. The surviving reason is the honest one — recommending an agent whose
   * model nothing is serving would send the caller into a refusal.
   */
  it("never proposes an agent this session cannot actually dispatch", () => {
    const offlineResearcher: AgentFile = {
      name: "researcher",
      frontmatter: [
        "name: researcher",
        "description: Web research specialist - searches sources, reads pages and returns cited findings.",
        "model: local",
      ].join("\n"),
    };
    const registry = registryOf([offlineResearcher, GENERAL]);
    assert.equal(registry.byName.get("researcher")?.status, "restricted");
    assert.equal(
      bestSpecialist(registry, "web research: search sources and return cited findings", generic, 2),
      undefined,
      "its model is not being served, so it cannot be the recommendation",
    );
  });

  it("DOES propose a specialist on a provider looser than the session's own class", () => {
    const registry = registryOf([RESEARCHER, GENERAL]);
    assert.equal(registry.byName.get("researcher")?.status, "ok");
    assert.equal(
      bestSpecialist(registry, "web research: search sources and return cited findings", generic, 2)?.name,
      "researcher",
    );
  });

  it("stays silent below the minimum score rather than guessing", () => {
    const registry = registryOf([RESEARCHER]);
    assert.equal(bestSpecialist(registry, "rename a variable", generic, 2), undefined);
  });
});

describe("specialistVeto (REQ-CTX-47)", () => {
  it("vetoes a generic dispatch when a specialist matches, and stays overridable", async () => {
    const registry = registryOf([RESEARCHER, GENERAL]);
    const verdict = await specialistVeto(ctxOf(registry)).evaluate({
      agentType: "general-purpose",
      prompt: "Web research: search sources, read pages, return cited findings",
    });
    assert.equal(verdict.veto, true);
    assert.equal(verdict.veto && verdict.denial.gateId, VETO_SPECIALIST);
    assert.equal(verdict.veto && verdict.denial.overridable, true, "REQ-CTX-06 keeps the written-justification hatch");
    assert.match(verdict.veto ? verdict.denial.what : "", /specialist "researcher" matches this task/);
  });

  it("does not touch a dispatch that already names a specialist", async () => {
    const registry = registryOf([RESEARCHER, GENERAL]);
    const verdict = await specialistVeto(ctxOf(registry)).evaluate({
      agentType: "researcher",
      prompt: "Web research: search sources and return cited findings",
    });
    assert.deepEqual(verdict, { veto: false });
  });

  it("lets a generic dispatch through when nothing specialises in it", async () => {
    const registry = registryOf([RESEARCHER, GENERAL]);
    const verdict = await specialistVeto(ctxOf(registry)).evaluate({
      agentType: "general-purpose",
      prompt: "count the lines in this file",
    });
    assert.deepEqual(verdict, { veto: false });
  });
});

/**
 * WITHDRAWN 2026-08-13. `DV-EGRESS` was the per-request half of egress containment: it refused a
 * dispatch whose resolved model belonged to a provider "looser" than the session, and it repeated
 * the registry's `restricted` verdict at the point of decision. Five tests here asserted those
 * refusals. The whole veto is gone; these assert that each of those five dispatches now succeeds
 * while the class is still resolvable and reported.
 */
describe("egress containment veto (withdrawn)", () => {
  beforeEach(() => resetDispatchVetoes());

  it("exports neither the veto nor its gate id", () => {
    const surface = ceiling as unknown as Record<string, unknown>;
    assert.equal(surface.egressVeto, undefined);
    assert.equal(surface.VETO_EGRESS, undefined);
  });

  it("ACCEPTANCE: a confidential session CAN dispatch a child onto a public provider", async () => {
    const registry = registryOf([PUBLIC_BIG]);
    assert.equal(registry.byName.get("big")?.status, "ok");
    assert.equal(registry.byName.get("big")?.target?.egress, "public", "the class is still reported");

    installVetoes(ctxOf(registry));
    const verdict = await evaluateDispatch({
      agentType: "big",
      prompt: "think hard about this",
      parentEgress: "confidential",
    });
    assert.deepEqual(verdict, { veto: false });
  });

  it("ACCEPTANCE: a call-time model override onto another provider is not vetoed", async () => {
    const registry = registryOf([GOOD_SCOUT]);
    installVetoes(ctxOf(registry));
    const verdict = await evaluateDispatch({
      agentType: "scout",
      prompt: "read a file",
      parentEgress: "internal",
      childTier: "strong",
      childEgress: "public",
    });
    assert.deepEqual(verdict, { veto: false }, "switching provider inside a session is the point");
  });

  it("an unknown tier is still nobody's business here — the dispatch rules refuse it by name", async () => {
    const registry = registryOf([GOOD_SCOUT]);
    installVetoes(ctxOf(registry));
    const verdict = await evaluateDispatch({
      agentType: "scout",
      prompt: "x",
      childTier: "tier:nonsense",
    });
    assert.deepEqual(verdict, { veto: false });
  });
});

describe("installVetoes", () => {
  beforeEach(() => resetDispatchVetoes());

  it("registers the specialist veto and nothing else", async () => {
    const registry = registryOf([RESEARCHER, GENERAL]);
    const ids = installVetoes(ctxOf(registry));
    assert.deepEqual(ids, [VETO_SPECIALIST]);
    assert.deepEqual(dispatchVetoes().map((v) => v.id), [VETO_SPECIALIST]);

    // Rewritten 2026-08-13: this request used to trip containment first and report DV-EGRESS. With
    // containment gone, taste is the only verdict left — and it stays overridable.
    const verdict = await evaluateDispatch({
      agentType: "general-purpose",
      prompt: "Web research: search sources, read pages, return cited findings",
      parentEgress: "confidential",
    });
    assert.equal(verdict.veto, true);
    assert.equal(verdict.veto && verdict.denial.gateId, VETO_SPECIALIST);
    assert.equal(verdict.veto && verdict.denial.overridable, true);
  });
});

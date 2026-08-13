import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CEILING_SOURCE,
  VETO_EGRESS,
  VETO_SPECIALIST,
  bestSpecialist,
  distinctiveWords,
  egressVeto,
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
  type EgressClass,
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

function registryOf(files: readonly AgentFile[], sessionEgress: EgressClass = "public"): AgentRegistry {
  const dir = writeAgents(join(scratch(), "agents"), files);
  return loadAgentRegistry({
    dirs: [dir],
    routing: ROUTING,
    config: CONFIG,
    sessionEgress,
    availableModels: ALL_MODELS,
  });
}

function ctxOf(registry: AgentRegistry, sessionEgress: EgressClass = "public"): VetoContext {
  return {
    registry: () => registry,
    routing: () => ROUTING,
    config: CONFIG,
    sessionEgress: () => sessionEgress,
  };
}

const ALL_TOOLS = ["read", "write", "bash", "subagent", "task", "agent", "dispatch_agent"];

describe("planCeiling", () => {
  it("allows only the agents that loaded clean and are inside the session's egress class", () => {
    const registry = registryOf([
      GOOD_SCOUT,
      PUBLIC_BIG,
      { name: "typo", frontmatter: "name: typo\ndescription: This one names a tier that does not exist.\nmodel: tier:nope" },
    ], "internal");
    const plan = planCeiling({ sessionId: "s1", registry, config: CONFIG, depth: 0, allToolNames: ALL_TOOLS });
    assert.deepEqual(plan.ceiling.allowedAgents, ["scout"], "big is public-only, typo is invalid");
    assert.match(plan.notes.join("\n"), /allowedAgents: 1 of 3 \(1 restricted by egress, 1 invalid\)/);
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

  it("never sets denyExtensions - a child without this extension has no depth or egress check", () => {
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
      assert.match(result.failure, /Depth and egress are still enforced|remain enforced/);
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

  it("never proposes an agent this session may not dispatch", () => {
    const registry = registryOf([RESEARCHER, GENERAL], "confidential");
    assert.equal(
      bestSpecialist(registry, "web research: search sources and return cited findings", generic, 2),
      undefined,
      "researcher is restricted in a confidential session, so it cannot be the recommendation",
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

describe("egressVeto (containment)", () => {
  it("ACCEPTANCE: a confidential session cannot dispatch a child onto a public provider", async () => {
    const registry = registryOf([PUBLIC_BIG], "confidential");
    const verdict = await egressVeto(ctxOf(registry, "confidential")).evaluate({
      agentType: "big",
      prompt: "think hard about this",
    });
    assert.equal(verdict.veto, true);
    assert.equal(verdict.veto && verdict.denial.gateId, VETO_EGRESS);
    assert.equal(verdict.veto && verdict.denial.overridable, false, "egress containment is NOT a matter of taste");
  });

  it("catches a call-time model override the agent file never declared", async () => {
    // scout is perfectly legal in an internal session — its `cheap` tier resolves to databricks,
    // which is `confidential`, a class strictly inside `internal`. The refusal here comes only
    // from the `model:` argument on the call, which the registry never saw.
    const registry = registryOf([GOOD_SCOUT], "internal");
    assert.equal(registry.byName.get("scout")?.status, "ok");
    const verdict = await egressVeto(ctxOf(registry, "internal")).evaluate({
      agentType: "scout",
      prompt: "read a file",
      childTier: "strong",
    });
    assert.equal(verdict.veto, true);
    assert.match(verdict.veto ? verdict.denial.what : "", /github-copilot\/claude-opus-5/);
  });

  it("uses the request's own parentEgress when the caller supplies one", async () => {
    const registry = registryOf([PUBLIC_BIG], "public");
    const verdict = await egressVeto(ctxOf(registry, "public")).evaluate({
      agentType: "big",
      prompt: "x",
      parentEgress: "confidential",
    });
    assert.equal(verdict.veto, true);
  });

  it("permits a same-or-stricter dispatch", async () => {
    const registry = registryOf([GOOD_SCOUT, PUBLIC_BIG], "public");
    assert.deepEqual(await egressVeto(ctxOf(registry)).evaluate({ agentType: "big", prompt: "x" }), { veto: false });
    assert.deepEqual(await egressVeto(ctxOf(registry)).evaluate({ agentType: "scout", prompt: "x" }), { veto: false });
  });

  it("does not double-report an unknown tier - the registry already refused it by name", async () => {
    const registry = registryOf([GOOD_SCOUT]);
    const verdict = await egressVeto(ctxOf(registry)).evaluate({
      agentType: "scout",
      prompt: "x",
      childTier: "tier:nonsense",
    });
    assert.deepEqual(verdict, { veto: false });
  });
});

describe("installVetoes", () => {
  beforeEach(() => resetDispatchVetoes());

  it("registers containment before taste, so the non-overridable rule wins", async () => {
    const registry = registryOf([RESEARCHER, GENERAL], "confidential");
    const ids = installVetoes(ctxOf(registry, "confidential"));
    assert.deepEqual(ids, [VETO_EGRESS, VETO_SPECIALIST]);
    assert.deepEqual(dispatchVetoes().map((v) => v.id), [VETO_EGRESS, VETO_SPECIALIST]);

    // This request trips both rules: it is a generic dispatch with a matching specialist, and its
    // resolved model is out of the session's egress class. Containment must be the reported one.
    const verdict = await evaluateDispatch({
      agentType: "general-purpose",
      prompt: "Web research: search sources, read pages, return cited findings",
    });
    assert.equal(verdict.veto, true);
    assert.equal(verdict.veto && verdict.denial.gateId, VETO_EGRESS);
    assert.equal(verdict.veto && verdict.denial.overridable, false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_KEYS, rules, type State } from "../../extensions/dispatch/index.ts";
import { ProviderSemaphoreSet } from "../../extensions/dispatch/semaphore.ts";
import { loadAgentRegistry, type AgentRegistry } from "../../extensions/dispatch/registry.ts";
import { resetWorktreeProvider } from "../../extensions/dispatch/isolation.ts";
import type { EgressClass } from "../../extensions/lib/dispatch-veto.ts";
import type { GuardRule } from "../../extensions/lib/guarded-handler.ts";
import { ALL_MODELS, CATALOGUE, CONFIG, GOOD_SCOUT, ROUTING, scratch, writeAgents, type AgentFile } from "./helpers.ts";

const AGENTS: readonly AgentFile[] = [
  GOOD_SCOUT,
  { name: "big", frontmatter: "name: big\ndescription: Heavyweight reasoning on the strong public tier.\nmodel: strong" },
  {
    name: "surgeon",
    frontmatter: "name: surgeon\ndescription: Edits code and therefore needs its own worktree.\nmodel: cheap\nisolation: worktree",
  },
  {
    name: "reviewer",
    frontmatter: [
      "name: reviewer",
      "description: Long-running reviewer that reports back over its own channel.",
      "model: cheap",
      "mode: teammate",
      "delivery: SendMessage to the lead",
    ].join("\n"),
  },
  { name: "typo", frontmatter: "name: typo\ndescription: Names a tier that does not exist anywhere.\nmodel: tier:nope" },
];

function registryOf(sessionEgress: EgressClass): AgentRegistry {
  const dir = writeAgents(join(scratch(), "agents"), AGENTS);
  return loadAgentRegistry({
    dirs: [dir],
    routing: ROUTING,
    config: CONFIG,
    sessionEgress,
    availableModels: ALL_MODELS,
  });
}

interface StateOpts {
  readonly depth?: number;
  readonly sessionEgress?: EgressClass;
  readonly withRouting?: boolean;
  readonly withRegistry?: boolean;
  /** `false` models a session_start where `ctx.modelRegistry` threw: existence is not asserted. */
  readonly withCatalogue?: boolean;
}

function stateOf(opts: StateOpts = {}): State {
  const sessionEgress = opts.sessionEgress ?? "public";
  return {
    ...(opts.withCatalogue === false ? {} : { catalogue: CATALOGUE }),
    settings: {
      dispatch: CONFIG,
      routing: opts.withRouting === false ? undefined : ROUTING,
      problems: opts.withRouting === false ? ["routing.json not found; DISPATCH IS REFUSED"] : [],
      sources: { dispatch: "<test>/dispatch.json", routing: "<test>/routing.json" },
    },
    ...(opts.withRegistry === false ? {} : { registry: registryOf(sessionEgress) }),
    sessionEgress,
    egressSource: "test",
    depth: opts.depth ?? 0,
    semaphores: new ProviderSemaphoreSet(ROUTING.concurrency, CONFIG.concurrencyDefault),
    ceilingNotes: [],
    vetoIds: [],
    problems: [],
  };
}

const CTX = { cwd: "/repo" } as unknown as ExtensionContext;

function eventOf(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { toolName, toolCallId: "call-1", input } as unknown as ToolCallEvent;
}

/** Same short-circuit contract as `guardedHandler`: the first blocking rule wins. */
async function run(
  set: readonly GuardRule[],
  event: ToolCallEvent,
): Promise<{ ruleId: string; reason: string } | undefined> {
  for (const rule of set) {
    const verdict = await rule.evaluate(event, CTX);
    if (verdict?.block) return { ruleId: rule.id, reason: verdict.reason };
  }
  return undefined;
}

describe("rule set shape", () => {
  it("refuses before it rewrites", () => {
    assert.deepEqual(
      rules(stateOf()).map((r) => r.id),
      ["DSP-READY", "DSP-DEPTH", "DSP-EGRESS", "DSP-CONTRACT", "DSP-AGENT", "DSP-RESOLVE"],
    );
  });

  it("agrees with EXT-03's gate on where the agent name lives", () => {
    assert.ok(AGENT_KEYS.includes("agent"));
    assert.ok(AGENT_KEYS.includes("subagent_type"));
  });
});

describe("non-dispatch tools", () => {
  it("are not touched by any rule", async () => {
    const input: Record<string, unknown> = { command: "ls", model: "strong", tasks: [1, 2, 3] };
    const blocked = await run(rules(stateOf({ depth: 9, sessionEgress: "confidential" })), eventOf("bash", input));
    assert.equal(blocked, undefined);
    assert.deepEqual(input, { command: "ls", model: "strong", tasks: [1, 2, 3] }, "no rewriting either");
  });
});

describe("DSP-READY", () => {
  it("refuses every dispatch when routing.json is unusable, naming the file", async () => {
    const blocked = await run(
      rules(stateOf({ withRouting: false, withRegistry: false })),
      eventOf("subagent", { agent: "scout", prompt: "x" }),
    );
    assert.equal(blocked?.ruleId, "DSP-READY");
    assert.match(blocked?.reason ?? "", /<test>\/routing\.json could not be used/);
    assert.match(blocked?.reason ?? "", /Do the work in this session instead of delegating it/);
  });
});

describe("DSP-DEPTH (VP-01)", () => {
  it("permits dispatch below the cap", async () => {
    assert.equal(await run(rules(stateOf({ depth: 1 })), eventOf("subagent", { agent: "scout", prompt: "x" })), undefined);
  });

  it("refuses AT the cap, naming both numbers, and blocks before anything is rewritten", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", tasks: [1, 2, 3], concurrency: 8 };
    const blocked = await run(rules(stateOf({ depth: 2 })), eventOf("subagent", input));
    assert.equal(blocked?.ruleId, "DSP-DEPTH");
    assert.match(blocked?.reason ?? "", /depth 2 \(max 2\)/);
    assert.equal(input.concurrency, 8, "a blocked call must not have been rewritten first");
    assert.equal(input.model, undefined);
  });

  it("refuses when the depth env was mangled", async () => {
    const blocked = await run(
      rules(stateOf({ depth: Number.POSITIVE_INFINITY })),
      eventOf("subagent", { agent: "scout", prompt: "x" }),
    );
    assert.equal(blocked?.ruleId, "DSP-DEPTH");
    assert.match(blocked?.reason ?? "", /unreadable/);
  });
});

describe("DSP-EGRESS (call-time model override)", () => {
  it("ACCEPTANCE: a confidential session cannot dispatch a child onto a public provider", async () => {
    const blocked = await run(
      rules(stateOf({ sessionEgress: "confidential" })),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "strong" }),
    );
    assert.equal(blocked?.ruleId, "DSP-EGRESS");
    assert.match(blocked?.reason ?? "", /github-copilot\/claude-opus-5/);
    assert.match(blocked?.reason ?? "", /a confidential session may not dispatch onto a public provider/);
  });

  it("blocks a literal provider/id override just as it blocks a tier name", async () => {
    const blocked = await run(
      rules(stateOf({ sessionEgress: "internal" })),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "openai/gpt-5.4" }),
    );
    assert.equal(blocked?.ruleId, "DSP-EGRESS");
  });

  it("lets an override to a stricter class through", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "confidential" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "public" })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "databricks/databricks-claude-sonnet-4-5", "and it is resolved to provider/id");
  });
});

/**
 * The owner's requirement: the orchestrating model picks the sub-agent's model per dispatch, by
 * concrete `provider/id`, to spend credits deliberately. These tests fix the two halves of that —
 * it must WORK, and it must not have become a way around the gate a tier name has to pass.
 */
describe("call-time provider/id selection", () => {
  it("accepts a concrete provider/id and passes it through untouched", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4-mini" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/gpt-5.4-mini");
  });

  it("REQ-PRV-09: an explicit per-call model wins over the agent file's own", async () => {
    const byFile: Record<string, unknown> = { agent: "big", prompt: "x" };
    await run(rules(stateOf()), eventOf("subagent", byFile));
    assert.equal(byFile.model, "github-copilot/claude-opus-5", "frontmatter `model: strong` still applies when nothing is passed");

    const byCall: Record<string, unknown> = { agent: "big", prompt: "x", model: "databricks/databricks-claude-haiku-4-5" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", byCall)), undefined);
    assert.equal(
      byCall.model,
      "databricks/databricks-claude-haiku-4-5",
      "the same agent, deliberately dropped onto a cheap model for this one call",
    );
  });

  it("mixes the two spellings freely: a tier on one call, an id on the next", async () => {
    const byTier: Record<string, unknown> = { agent: "scout", prompt: "x", model: "strong" };
    await run(rules(stateOf()), eventOf("subagent", byTier));
    assert.equal(byTier.model, "github-copilot/claude-opus-5");

    const byId: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" };
    await run(rules(stateOf()), eventOf("subagent", byId));
    assert.equal(byId.model, "databricks/databricks-claude-sonnet-4-5");
  });

  it("ACCEPTANCE: a concrete provider/id cannot walk around the egress gate a tier has to pass", async () => {
    // Same model, two spellings, one confidential session. Both must be refused, by the same gate,
    // for the same reason — otherwise "name the id instead of the tier" is an egress bypass.
    for (const model of ["strong", "github-copilot/claude-opus-5"]) {
      const input: Record<string, unknown> = { agent: "scout", prompt: "x", model };
      const blocked = await run(rules(stateOf({ sessionEgress: "confidential" })), eventOf("subagent", input));
      assert.equal(blocked?.ruleId, "DSP-EGRESS", model);
      assert.match(blocked?.reason ?? "", /may not dispatch onto a public provider/, model);
      assert.equal(input.model, model, `${model}: a blocked call must not have been rewritten first`);
    }
  });

  it("ACCEPTANCE: the egress refusal holds for every model of a forbidden provider, not just the tier targets", async () => {
    for (const model of ["github-copilot/gpt-5.4-mini", "github-copilot/claude-sonnet-4.6"]) {
      const blocked = await run(
        rules(stateOf({ sessionEgress: "internal" })),
        eventOf("subagent", { agent: "scout", prompt: "x", model }),
      );
      assert.equal(blocked?.ruleId, "DSP-EGRESS", model);
    }
  });

  it("still allows a per-call id that moves the child to a STRICTER class", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "internal" })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "databricks/databricks-claude-sonnet-4-5");
  });

  it("DOCUMENTED LIMIT: a per-call model does not resurrect an agent the session may not dispatch at all", async () => {
    // `big` is `model: strong` -> github-copilot -> public, so an internal session classes it
    // `restricted` at load time and it is absent from the capability ceiling's allowedAgents.
    // A per-call model that WOULD be permitted still cannot lift that: the ceiling is registered
    // once per session and cannot be narrowed or widened per call, so letting this through here
    // would only move the same refusal into `pi-subagents`' preflight, minutes later and with a
    // worse message. Refusing by name at the call site is the honest behaviour, not an oversight.
    const blocked = await run(
      rules(stateOf({ sessionEgress: "internal" })),
      eventOf("subagent", { agent: "big", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" }),
    );
    assert.equal(blocked?.ruleId, "DSP-AGENT");
    assert.match(blocked?.reason ?? "", /A per-call `model` cannot lift this/);
  });

  it("clamps concurrency on the provider the CALL named, not the one the agent file named", async () => {
    // scout is `cheap` (databricks, cap 4); the call moves it onto the `local` lane, cap 1 — the
    // one provider left in routing.json with a cap that actually differs from 4, so a clamp that
    // mistakenly used the file's provider instead of the call's would be caught here.
    const input: Record<string, unknown> = {
      agent: "scout",
      prompt: "x",
      model: "local",
      tasks: [1, 2, 3, 4, 5, 6],
      concurrency: 6,
    };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.concurrency, 1);
  });
});

describe("DSP-CONTRACT (teammate vs subagent)", () => {
  it("refuses to dispatch a teammate through a call that awaits a result", async () => {
    const blocked = await run(rules(stateOf()), eventOf("subagent", { agent: "reviewer", prompt: "review this" }));
    assert.equal(blocked?.ruleId, "DSP-CONTRACT");
    assert.match(blocked?.reason ?? "", /delivered through "SendMessage to the lead"/);
  });

  it("refuses a teammate under an output schema even when the call is async", async () => {
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "reviewer", prompt: "x", async: true, outputSchema: { type: "object" } }),
    );
    assert.equal(blocked?.ruleId, "DSP-CONTRACT");
    assert.match(blocked?.reason ?? "", /structured output schema/);
  });

  it("allows an async, unstructured teammate dispatch", async () => {
    assert.equal(
      await run(rules(stateOf()), eventOf("subagent", { agent: "reviewer", prompt: "x", async: true })),
      undefined,
    );
  });

  it("never gets in a plain subagent's way", async () => {
    assert.equal(
      await run(rules(stateOf()), eventOf("subagent", { agent: "scout", prompt: "x", outputSchema: {} })),
      undefined,
    );
  });
});

describe("DSP-AGENT", () => {
  it("ACCEPTANCE: a typo'd agent file is refused by name at dispatch, not at minute 40", async () => {
    const blocked = await run(rules(stateOf()), eventOf("subagent", { agent: "typo", prompt: "x" }));
    assert.equal(blocked?.ruleId, "DSP-AGENT");
    assert.match(blocked?.reason ?? "", /unknown tier "nope"/);
    assert.match(blocked?.reason ?? "", /Fix .*typo\.md, or dispatch a different agent/);
  });

  it("refuses an agent outside the session's egress class with the other advice", async () => {
    const blocked = await run(
      rules(stateOf({ sessionEgress: "internal" })),
      eventOf("subagent", { agent: "big", prompt: "x" }),
    );
    assert.equal(blocked?.ruleId, "DSP-AGENT");
    assert.match(blocked?.reason ?? "", /Dispatch an agent whose own model stays within this internal session/);
  });

  it("does not block a name we do not own - the package has builtins of its own", async () => {
    assert.equal(
      await run(rules(stateOf()), eventOf("subagent", { agent: "code-reviewer-builtin", prompt: "x" })),
      undefined,
    );
  });

  it("reads the agent name from any of the argument spellings", async () => {
    for (const key of ["agent", "agentType", "subagent_type", "subagentType", "name"]) {
      const blocked = await run(rules(stateOf()), eventOf("subagent", { [key]: "typo", prompt: "x" }));
      assert.equal(blocked?.ruleId, "DSP-AGENT", `key=${key}`);
    }
  });
});

describe("DSP-RESOLVE", () => {
  it("rewrites the agent's tier to a provider-qualified model", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5");
  });

  it("does NOT write routing.json's thinkingLevel onto the call", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    await run(rules(stateOf()), eventOf("subagent", input));
    assert.equal(input.thinking, undefined, "the package's `thinking` argument belongs to watchdog.configure");
    assert.equal(input.thinkingLevel, undefined);
  });

  it("VP-02: lowers a fanout to the provider's cap so the package queues the rest", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", tasks: [1, 2, 3, 4, 5, 6, 7], concurrency: 7 };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.concurrency, 4, "databricks (the cheap tier's provider) is capped at 4 in routing.json");
  });

  it("VP-02: the local lane is serialised to one", async () => {
    const input: Record<string, unknown> = { model: "local", prompt: "x", tasks: [1, 2, 3], concurrency: 3 };
    assert.equal(await run(rules(stateOf({ sessionEgress: "confidential" })), eventOf("subagent", input)), undefined);
    assert.equal(input.concurrency, 1);
    assert.equal(input.model, "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF", "provider is the FIRST segment; the id keeps its own slash");
  });

  it("never raises a fanout the caller deliberately kept small", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", tasks: [1, 2], concurrency: 2 };
    await run(rules(stateOf()), eventOf("subagent", input));
    assert.equal(input.concurrency, 2);
  });

  it("honours isolation: worktree through the package when EXT-23 is absent", async () => {
    resetWorktreeProvider();
    const input: Record<string, unknown> = { agent: "surgeon", prompt: "refactor" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.worktree, true);
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5");
  });

  it("refuses rather than running a worktree agent in the user's checkout", async () => {
    resetWorktreeProvider();
    const input: Record<string, unknown> = { tasks: [{ agent: "surgeon" }], agentType: "surgeon", prompt: "x" };
    const blocked = await run(rules(stateOf()), eventOf("subagent", input));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /only accepts worktree: true together with agent: <name>/);
  });

  it("refuses a call-time tier that does not exist, by name", async () => {
    const input: Record<string, unknown> = { prompt: "x", model: "tier:galaxy" };
    const blocked = await run(rules(stateOf()), eventOf("subagent", input));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /cannot route this dispatch: unknown_tier/);
  });

  it("refuses a call-time provider/id that is not in the model registry, with the closest real ids", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.1" };
    const blocked = await run(rules(stateOf()), eventOf("subagent", input));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /unknown_model/);
    assert.match(blocked?.reason ?? "", /read as a provider-qualified model id/);
    assert.match(blocked?.reason ?? "", /Closest available: github-copilot\/gpt-5\.4/);
    assert.match(blocked?.reason ?? "", /came from the `model` argument of this call/);
    assert.equal(input.model, "github-copilot/gpt-5.1", "a refused call is never rewritten to something that works");
  });

  it("names the agent FILE when the bad id came from frontmatter rather than from the call", async () => {
    const dir = writeAgents(join(scratch(), "agents"), [
      { name: "ghost", frontmatter: "name: ghost\ndescription: Pins a model id that does not exist anywhere.\nmodel: github-copilot/gpt-5.1" },
    ]);
    const state = stateOf();
    state.registry = loadAgentRegistry({ dirs: [dir], routing: ROUTING, config: CONFIG, sessionEgress: "public" });
    const blocked = await run(rules(state), eventOf("subagent", { agent: "ghost", prompt: "x" }));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /came from the `model:` frontmatter of agent "ghost"/);
    assert.match(blocked?.reason ?? "", /ghost\.md/);
  });

  it("refuses a provider the routing map does not classify, rather than guessing its egress", async () => {
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "deepseek/deepseek-v4-flash" }),
    );
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /no declared egress class in routing\.json/);
    assert.match(blocked?.reason ?? "", /classed providers: github-copilot, openai, databricks, local/);
  });

  it("does not assert existence when the model registry was unavailable at session start", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.1" };
    assert.equal(await run(rules(stateOf({ withCatalogue: false })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/gpt-5.1", "unchecked is not the same as substituted");
  });

  it("applies to every configured dispatch tool name, not only `subagent`", async () => {
    for (const tool of CONFIG.dispatchTools) {
      const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
      assert.equal(await run(rules(stateOf()), eventOf(tool, input)), undefined, tool);
      assert.equal(input.model, "databricks/databricks-claude-haiku-4-5", tool);
    }
  });
});

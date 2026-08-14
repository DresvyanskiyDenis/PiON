import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_KEYS, rules, type State } from "../../extensions/dispatch/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { ProviderSemaphoreSet } from "../../extensions/dispatch/semaphore.ts";
import { loadAgentRegistry, type AgentRegistry } from "../../extensions/dispatch/registry.ts";
import { resetWorktreeProvider } from "../../extensions/dispatch/isolation.ts";
import type { EgressClass } from "../../extensions/lib/dispatch-veto.ts";
import type { GuardRule } from "../../extensions/lib/guarded-handler.ts";
import { resetIndexDbCache } from "../../extensions/session-index/db.ts";
import { ALL_MODELS, CATALOGUE, CONFIG, GOOD_SCOUT, ROUTING, scratch, writeAgents, type AgentFile } from "./helpers.ts";

// DSP-RESOLVE writes a `dispatch.resolve:*` event, and `logEvent` opens whatever database
// `PI_INDEX_DB` names — by default the operator's real `index.db`. Point this whole file at a
// throwaway one, so running the suite never appends rows to the index a human reads.
const PREV_INDEX_DB = process.env.PI_INDEX_DB;
before(() => {
  process.env.PI_INDEX_DB = join(scratch("ext05-index-"), "index.db");
  resetIndexDbCache();
});
after(() => {
  if (PREV_INDEX_DB === undefined) delete process.env.PI_INDEX_DB;
  else process.env.PI_INDEX_DB = PREV_INDEX_DB;
  resetIndexDbCache();
});

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
  // ALL_MODELS omits the local lane, so this one loads `restricted`: the file is fine, nothing is
  // serving its model. That is the only remaining producer of `restricted`.
  { name: "offline", frontmatter: "name: offline\ndescription: Runs on the local lane when llama-swap is up.\nmodel: local" },
];

function registryOf(): AgentRegistry {
  const dir = writeAgents(join(scratch(), "agents"), AGENTS);
  return loadAgentRegistry({
    dirs: [dir],
    routing: ROUTING,
    config: CONFIG,
    availableModels: ALL_MODELS,
  });
}

interface StateOpts {
  readonly depth?: number;
  /** Reporting only since 2026-08-13 — it selects no rule and hides no model. */
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
    ...(opts.withRegistry === false ? {} : { registry: registryOf() }),
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

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function eventOf(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { toolName, toolCallId: "call-1", input } as unknown as ToolCallEvent;
}

/** Same short-circuit contract as `guardedHandler`: the first blocking rule wins. */
async function run(
  set: readonly GuardRule[],
  event: ToolCallEvent,
  ctx: ExtensionContext = CTX,
): Promise<{ ruleId: string; reason: string } | undefined> {
  for (const rule of set) {
    const verdict = await rule.evaluate(event, ctx);
    if (verdict?.block) return { ruleId: rule.id, reason: verdict.reason };
  }
  return undefined;
}

/**
 * A ctx whose `ui.notify` is captured. `emitNotice` routes to the UI only when `hasUI === true`
 * (`extensions/lib/announce.ts`), which is why this sets it — the default `CTX` has no UI and its
 * announcements go to stderr instead.
 */
function capturingCtx(): { ctx: ExtensionContext; notices: string[] } {
  const notices: string[] = [];
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  return { ctx, notices };
}

describe("rule set shape", () => {
  it("refuses before it rewrites", () => {
    assert.deepEqual(
      rules(stateOf()).map((r) => r.id),
      // DSP-EGRESS sat between DSP-DEPTH and DSP-CONTRACT until 2026-08-13; it refused a call-time
      // `model` override whose provider was classed looser than the session, which is exactly the
      // switch a session has to be able to make. Withdrawn whole.
      // DSP-SCHEMA is last on purpose: it only ever rewrites, so nothing that can refuse the call
      // runs after it.
      ["DSP-READY", "DSP-DEPTH", "DSP-CONTRACT", "DSP-AGENT", "DSP-RESOLVE", "DSP-SCHEMA"],
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

/**
 * WITHDRAWN 2026-08-13. `DSP-EGRESS` refused a call-time `model` override whose provider was classed
 * looser than the session. Three tests here asserted those refusals; the first two are inverted
 * below into the behaviour that was actually wanted — switch provider inside one session — and the
 * third (an override to a stricter class) survives unchanged, because it always passed.
 */
describe("call-time model override across egress classes (DSP-EGRESS withdrawn)", () => {
  it("ACCEPTANCE: a confidential session CAN dispatch a child onto a public provider", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "strong" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "confidential" })), eventOf("subagent", input)), undefined);
    // 2026-08-13: `strong` declares thinkingLevel: "high", which now rides along on resolution.
    // Used to assert the bare id.
    assert.equal(input.model, "github-copilot/claude-opus-5:high", "and it is resolved to provider/id");
  });

  it("accepts a literal provider/id override across classes, just as it accepts a tier name", async () => {
    // `github-copilot` is classed `public`, looser than this `internal` session, and its id is in
    // the fixture registry — so existence is satisfied and only the class could have refused it.
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "internal" })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/gpt-5.4");
  });

  it("lets an override to a stricter class through", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "confidential" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "public" })), eventOf("subagent", input)), undefined);
    // 2026-08-13: `confidential` declares thinkingLevel: "medium", which now rides along on
    // resolution. Used to assert the bare id.
    assert.equal(input.model, "databricks/databricks-claude-sonnet-4-5:medium", "and it is resolved to provider/id");
  });

  it("REGRESSION: one session dispatches onto every class in turn, labelled or not", async () => {
    // The complaint that ended the rule, as one test: a session classed `internal` fans out to a
    // public provider, an unclassed one and the confidential one without a single refusal.
    //
    // 2026-08-13: the first two rows go through a TIER lookup, so `strong`'s and `cheap`'s declared
    // thinkingLevel now rides along; the last two rows are literal provider/id overrides, which
    // never carry a tier's thinkingLevel (see `applyTierThinkingLevel` in `tiers.ts`), so they still
    // resolve to themselves unchanged. Used to assert the bare id on the first two rows.
    const state = stateOf({ sessionEgress: "internal" });
    for (const [model, resolved] of [
      ["strong", "github-copilot/claude-opus-5:high"],
      ["cheap", "databricks/databricks-claude-haiku-4-5:low"],
      ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
      ["databricks/databricks-claude-sonnet-4-5", "databricks/databricks-claude-sonnet-4-5"],
    ] as const) {
      const input: Record<string, unknown> = { agent: "scout", prompt: "x", model };
      assert.equal(await run(rules(state), eventOf("subagent", input)), undefined, model);
      assert.equal(input.model, resolved, model);
    }
  });
});

/**
 * The requirement this whole rule set exists for: the orchestrating model picks the sub-agent's
 * model per dispatch, by concrete `provider/id`, to spend credits deliberately. These tests fix the
 * two halves of that — it must WORK, and it must stay equivalent to naming the tier.
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
    // 2026-08-13: `strong` declares thinkingLevel: "high", which now rides along on resolution.
    // Used to assert the bare id.
    assert.equal(
      byFile.model,
      "github-copilot/claude-opus-5:high",
      "frontmatter `model: strong` still applies when nothing is passed",
    );

    const byCall: Record<string, unknown> = { agent: "big", prompt: "x", model: "databricks/databricks-claude-haiku-4-5" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", byCall)), undefined);
    // Unchanged: a literal `provider/id` on the call is not a tier lookup, so it never picks up a
    // tier's thinkingLevel — it passes through exactly as written.
    assert.equal(
      byCall.model,
      "databricks/databricks-claude-haiku-4-5",
      "the same agent, deliberately dropped onto a cheap model for this one call",
    );
  });

  it("mixes the two spellings freely: a tier on one call, an id on the next", async () => {
    const byTier: Record<string, unknown> = { agent: "scout", prompt: "x", model: "strong" };
    await run(rules(stateOf()), eventOf("subagent", byTier));
    // 2026-08-13: `strong` declares thinkingLevel: "high". Used to assert the bare id.
    assert.equal(byTier.model, "github-copilot/claude-opus-5:high");

    const byId: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" };
    await run(rules(stateOf()), eventOf("subagent", byId));
    assert.equal(byId.model, "databricks/databricks-claude-sonnet-4-5");
  });

  /**
   * WITHDRAWN 2026-08-13. These two used to assert that the withdrawn egress gate could not be
   * walked around: the same model named as a tier and named as an id was refused both ways, and so
   * was every other id of the same "forbidden" provider. There is no gate to walk around now, so
   * the assertions are inverted — the two spellings stay EQUIVALENT, which is the property that
   * actually mattered, and every id of a provider stays reachable rather than only the tier targets.
   *
   * One caveat the withdrawal exposed: a tier and the bare id it points at are no longer
   * byte-identical on the wire. `strong` declares `thinkingLevel: "high"`, so resolving BY TIER
   * carries that effort into the model string (`applyTierThinkingLevel` in `tiers.ts`) while typing
   * the id it resolves to does not. A tier is shorthand for "this id AND this effort"; a literal id
   * is just the id. Both are accepted, and both name the same provider and id.
   */
  it("ACCEPTANCE: a tier and the concrete id it resolves to are accepted alike; effort is tier-only", async () => {
    const byTier: Record<string, unknown> = { agent: "scout", prompt: "x", model: "strong" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "confidential" })), eventOf("subagent", byTier)), undefined);
    assert.equal(byTier.model, "github-copilot/claude-opus-5:high", "the tier's declared effort rides along");

    const byId: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/claude-opus-5" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "confidential" })), eventOf("subagent", byId)), undefined);
    assert.equal(byId.model, "github-copilot/claude-opus-5", "the literal id carries no effort of its own");
  });

  it("ACCEPTANCE: every id of a provider is reachable, not just the ones a tier points at", async () => {
    for (const model of ["github-copilot/gpt-5.4-mini", "github-copilot/claude-sonnet-4.6"]) {
      const input: Record<string, unknown> = { agent: "scout", prompt: "x", model };
      assert.equal(
        await run(rules(stateOf({ sessionEgress: "internal" })), eventOf("subagent", input)),
        undefined,
        model,
      );
      assert.equal(input.model, model, model);
    }
  });

  it("still allows a per-call id that moves the child to a STRICTER class", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "internal" })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "databricks/databricks-claude-sonnet-4-5");
  });

  /**
   * Rewritten 2026-08-13. The limit is real and stays, but its *trigger* changed: `big` used to be
   * `restricted` because an internal session could not reach github-copilot. Nothing is restricted
   * by class now, so the trigger is the surviving one — an agent whose model is not being served.
   */
  it("DOCUMENTED LIMIT: a per-call model does not resurrect an agent the ceiling already excluded", async () => {
    // `offline` is `model: local`, and ALL_MODELS omits the local lane, so it is `restricted` at
    // load time and absent from the capability ceiling's allowedAgents. A per-call model that WOULD
    // work cannot lift that: the ceiling is registered once per session and cannot be widened per
    // call, so letting this through would only move the same refusal into `pi-subagents`' preflight,
    // minutes later and with a worse message.
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "offline", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" }),
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

describe("DSP-SCHEMA", () => {
  /**
   * The failure: a model-authored `outputSchema` closed with `additionalProperties: false` discards
   * a finished run the moment the child answers with more keys than it was asked for, and
   * `pi-subagents` cannot recover from it even when the child retries correctly. The unit-level
   * cover is in `output-schema.test.ts`; this asserts the rule is wired and never blocks.
   */
  it("REGRESSION: opens a closed outputSchema on the way through, without blocking", async () => {
    const input: Record<string, unknown> = {
      agent: "scout",
      prompt: "x",
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.deepEqual(input.outputSchema, {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    });
  });

  it("leaves a non-dispatch tool's outputSchema alone", async () => {
    const input: Record<string, unknown> = {
      command: "ls",
      outputSchema: { type: "object", additionalProperties: false },
    };
    assert.equal(await run(rules(stateOf()), eventOf("bash", input)), undefined);
    assert.deepEqual(input.outputSchema, { type: "object", additionalProperties: false });
  });
});

describe("DSP-AGENT", () => {
  it("ACCEPTANCE: a typo'd agent file is refused by name at dispatch, not at minute 40", async () => {
    const blocked = await run(rules(stateOf()), eventOf("subagent", { agent: "typo", prompt: "x" }));
    assert.equal(blocked?.ruleId, "DSP-AGENT");
    assert.match(blocked?.reason ?? "", /unknown tier "nope"/);
    assert.match(blocked?.reason ?? "", /Fix .*typo\.md, or dispatch a different agent/);
  });

  /**
   * Rewritten 2026-08-13. This used to dispatch `big` from an `internal` session and expect a
   * refusal reading "Dispatch an agent whose own model stays within this internal session". Both
   * halves changed: `big` now dispatches, and the "other advice" branch belongs to the one
   * surviving `restricted` cause.
   */
  it("does NOT refuse an agent whose provider is classed looser than the session", async () => {
    const input: Record<string, unknown> = { agent: "big", prompt: "x" };
    assert.equal(await run(rules(stateOf({ sessionEgress: "internal" })), eventOf("subagent", input)), undefined);
    // 2026-08-13: `strong` declares thinkingLevel: "high", which now rides along on resolution.
    // Used to assert the bare id.
    assert.equal(input.model, "github-copilot/claude-opus-5:high");
  });

  it("refuses an agent whose model is not being served, with the other advice", async () => {
    const blocked = await run(rules(stateOf()), eventOf("subagent", { agent: "offline", prompt: "x" }));
    assert.equal(blocked?.ruleId, "DSP-AGENT");
    assert.match(blocked?.reason ?? "", /Start the backend that serves its model/);
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
    // 2026-08-13: `cheap` declares thinkingLevel: "low", which now rides along on resolution.
    // Used to assert the bare id.
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low");
  });

  it("still resolves a call-time model when the registry could not be built at all", async () => {
    // This rule used to bail whenever the registry was missing, which left a session whose agent
    // files failed to load dispatching with NO model resolution: an unresolvable tier word went
    // out unchecked and was substring-matched downstream. Only `routing` is load-bearing here.
    const input: Record<string, unknown> = { model: "tier:strong", prompt: "x" };
    assert.equal(await run(rules(stateOf({ withRegistry: false })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/claude-opus-5:high");
  });

  it("names the dispatch target in a routing refusal, not just the value that failed", async () => {
    // A fan-out produces one of these per child. "unknown_model: github-copilot/gpt-5.1" without a
    // subagent name does not say which delegation died.
    const state = stateOf();
    state.settings = {
      ...state.settings,
      routing: { ...ROUTING, tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.1" } } },
    };
    const blocked = await run(rules(state), eventOf("subagent", { agent: "scout", prompt: "x" }));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /dispatch target: agent "scout"/);
    assert.match(blocked?.reason ?? "", /Nothing was substituted/);
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
    // 2026-08-13: `local` declares thinkingLevel: "medium", appended after the id's own slash.
    // Used to assert the bare id.
    assert.equal(
      input.model,
      "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF:medium",
      "provider is the FIRST segment; the id keeps its own slash",
    );
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
    // 2026-08-13: `cheap` declares thinkingLevel: "low", which now rides along on resolution.
    // Used to assert the bare id.
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low");
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
    state.registry = loadAgentRegistry({ dirs: [dir], routing: ROUTING, config: CONFIG });
    const blocked = await run(rules(state), eventOf("subagent", { agent: "ghost", prompt: "x" }));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /came from the `model:` frontmatter of agent "ghost"/);
    assert.match(blocked?.reason ?? "", /ghost\.md/);
  });

  /**
   * WITHDRAWN 2026-08-13. This asserted that a provider `routing.json` does not classify was refused
   * outright ("no defensible answer to may this session's data go there"). That is egress
   * containment in another costume: an unclassed provider is now unlabelled, not forbidden.
   */
  it("dispatches onto a provider the routing map does not classify, leaving it unlabelled", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "deepseek/deepseek-v4-flash" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "deepseek/deepseek-v4-flash");
  });

  it("still refuses an UNKNOWN model on an unclassed provider — existence is the surviving gate", async () => {
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "deepseek/deepseek-v9-imaginary" }),
    );
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /unknown_model/);
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
      // 2026-08-13: `cheap` declares thinkingLevel: "low", which now rides along on resolution.
      // Used to assert the bare id.
      assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low", tool);
    }
  });
});

/**
 * The workflow floor.
 *
 * A `workflowScript` launches children the rule set never sees: they are built inside the package,
 * past the tool-call boundary where a tier word is resolved to a `provider/model`. A child that
 * names no model therefore falls back to its agent file's `model:` frontmatter — a tier word only
 * this repository understands — and `pi-subagents` hands an unmatched string on unchanged for PI to
 * substring-match. That is the door onto a provider `config/models.json` never declared, and it
 * opens as a credentials error rather than as the silent provider substitution it actually is.
 *
 * Pinning our own resolved default tier at the workflow level closes it for the children that name
 * nothing, and leaves the ones that name something alone.
 *
 * THIS BLOCK DEPENDS ON A PACKAGE INTERNAL — `pi-subagents` 0.41.0,
 * `src/runs/foreground/subagent-executor.ts`:
 *
 *   :4106  the async branch destructures the workflow request into `workflowChildDefaults`,
 *          omitting `action, agent, task, tasks, chain, concurrency, foregroundOnly, clarify,
 *          timeoutMs, maxRuntimeMs, usageBudget`. `model` is NOT omitted, so it survives into the
 *          defaults. `:4178` is the foreground twin and also keeps it.
 *   :4142  each child is built as `prepareWorkflowChildParams({ ...workflowChildDefaults,
 *          ...childParams, … })` — defaults first, child second, so the child wins. `:4202` is the
 *          foreground twin.
 *
 * RE-CHECK BOTH WHEN `pi-subagents` IS UPGRADED. If `model` joins the omit list at :4106 the floor
 * silently stops reaching the children and pinning it becomes a claim the package no longer
 * honours; if the spread order at :4142 flips, the floor starts overriding children that chose
 * their own model. `guards the pi-subagents internals this floor rests on` below fails on either.
 */
describe("DSP-RESOLVE: a workflowScript with no model", () => {
  const WORKFLOW = "await runs.all([{key: 'a', agent: 'scout', task: 'x'}])";
  /** `CONFIG.defaultTier` is `fast`, and `fast` declares `thinkingLevel: "medium"`. */
  const DEFAULT_TIER_MODEL = "github-copilot/claude-sonnet-5:medium";

  it("pins the default tier as the fan-out's floor", async () => {
    const input: Record<string, unknown> = { workflowScript: WORKFLOW };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, DEFAULT_TIER_MODEL, "children that name no model inherit our catalogue");
  });

  it("announces the pin as a floor, and says what still overrides it", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    const input: Record<string, unknown> = { workflowScript: WORKFLOW };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input), ctx), undefined);
    const line = notices.find((n) => n.includes("defaultTier")) ?? "";
    assert.match(line, /workflowScript/, "which shape was pinned");
    assert.match(line, /FLOOR for its children/, "that it is a floor, not a decision");
    assert.match(line, /a child that names one still wins/, "that it is overridable per child");
    assert.match(line, /subagent-executor\.ts:4106 and :4142/, "where the behaviour is anchored");
  });

  it("records the pin on the rewrite bookkeeping", async () => {
    resetSurfaced();
    // `applied` is internal to DSP-RESOLVE; its one externally visible effect is that a rewritten
    // call opens the resolved provider's lane (index.ts, `state.semaphores.for(...)`). No lane
    // means nothing was recorded as applied.
    const state = stateOf();
    const input: Record<string, unknown> = { workflowScript: WORKFLOW };
    assert.equal(await run(rules(state), eventOf("subagent", input)), undefined);
    assert.deepEqual(
      state.semaphores.snapshot().map((lane) => lane.provider),
      ["github-copilot"],
      "the model rewrite was recorded against the provider it resolved to",
    );
  });

  it("leaves a workflowScript that names its own model, and does not announce a floor", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    const input: Record<string, unknown> = { workflowScript: WORKFLOW, model: "tier:strong" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input), ctx), undefined);
    assert.equal(input.model, "github-copilot/claude-opus-5:high", "an explicit workflow model is the floor");
    assert.deepEqual(notices, [], "nothing was defaulted, so there is nothing to announce");
  });

  it("leaves a management action alone — it launches no child for a model to reach", async () => {
    const input: Record<string, unknown> = { action: "status", id: "abc123" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, undefined);
  });

  it("names the workflow floor as the origin when the default tier does not resolve", async () => {
    const state = stateOf();
    state.settings = {
      ...state.settings,
      routing: { ...ROUTING, tiers: { ...ROUTING.tiers, fast: { model: "github-copilot/gpt-5.1", thinkingLevel: "medium" } } },
    };
    const input: Record<string, unknown> = { workflowScript: WORKFLOW };
    const blocked = await run(rules(state), eventOf("subagent", input));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /floor for this workflowScript's children/);
    assert.equal(input.model, undefined, "a refused call is never rewritten");
  });

  it("guards the pi-subagents internals this floor rests on", () => {
    const source = readFileSync(
      join(REPO_ROOT, "node_modules", "pi-subagents", "src", "runs", "foreground", "subagent-executor.ts"),
      "utf8",
    );
    const lines = source.split("\n");

    const destructures = lines.filter((line) => line.includes("...workflowChildDefaults } ="));
    assert.equal(destructures.length, 2, "the async and foreground branches, :4106 and :4178");
    for (const line of destructures) {
      const omitted = line.slice(0, line.indexOf("...workflowChildDefaults"));
      assert.doesNotMatch(
        omitted,
        /\bmodel\s*:/,
        "pi-subagents began stripping `model` from workflowChildDefaults — the floor no longer " +
          "reaches the children; re-read subagent-executor.ts:4106 before trusting DSP-RESOLVE",
      );
    }

    const builds = lines.filter((line) => line.includes("prepareWorkflowChildParams({ ...workflowChildDefaults"));
    assert.equal(builds.length, 2, "the async and foreground child builds, :4142 and :4202");
    for (const line of builds) {
      assert.ok(
        line.indexOf("...workflowChildDefaults") < line.indexOf("...childParams"),
        "the spread order flipped: the workflow default would now OVERRIDE a child's own model",
      );
    }
  });
});

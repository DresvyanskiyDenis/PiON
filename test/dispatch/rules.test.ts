import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_KEYS, clampedTiers, rules, type State } from "../../extensions/dispatch/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { ProviderSemaphoreSet } from "../../extensions/dispatch/semaphore.ts";
import { loadAgentRegistry, type AgentRegistry } from "../../extensions/dispatch/registry.ts";
import { resetWorktreeProvider } from "../../extensions/dispatch/isolation.ts";
import type { EgressClass } from "../../extensions/lib/dispatch-veto.ts";
import type { GuardRule } from "../../extensions/lib/guarded-handler.ts";
import { resetIndexDbCache } from "../../extensions/session-index/db.ts";
import { admissibleProviders, makeCatalogue, restrictCatalogue } from "../../extensions/dispatch/catalogue.ts";
import {
  ALL_MODELS,
  CATALOGUE,
  CONFIG,
  CONFIGURED_PROVIDERS,
  GOOD_SCOUT,
  ROUTING,
  THINKING_CAPS,
  scratch,
  writeAgents,
  type AgentFile,
} from "./helpers.ts";

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
  /** `null` models an unreadable `config/models.json`: the "is it configured" filter half is off. */
  readonly configuredProviders?: null;
}

function stateOf(opts: StateOpts = {}): State {
  const sessionEgress = opts.sessionEgress ?? "public";
  const configuredProviders = opts.configuredProviders === null ? undefined : CONFIGURED_PROVIDERS;
  // Mirrors `register()`: the admission set is built from config, and the catalogue is restricted
  // through it ONCE. Building `State` by hand without this was a false green — the gate would never
  // fire here while firing in production, which is the wrong direction for a test to be wrong in.
  const admission = opts.withRouting === false ? undefined : admissibleProviders(ROUTING, configuredProviders);
  const catalogue = admission === undefined ? CATALOGUE : restrictCatalogue(CATALOGUE, admission).catalogue;
  return {
    ...(opts.withCatalogue === false ? {} : { catalogue }),
    ...(admission !== undefined ? { admission } : {}),
    settings: {
      dispatch: CONFIG,
      routing: opts.withRouting === false ? undefined : ROUTING,
      configuredProviders,
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

  it("REGRESSION: one session dispatches onto all its classes in turn", async () => {
    // The owner's actual complaint, as one test: a session classed `internal` fans out to a public
    // provider, its own and the confidential one without a single refusal — every egress class in
    // `ROUTING.egress`, from one session.
    //
    // 2026-08-13: the first two rows go through a TIER lookup, so `strong`'s and `cheap`'s declared
    // thinkingLevel now rides along; the last row is a literal provider/id override, which never
    // carries a tier's thinkingLevel (see `applyTierThinkingLevel` in `tiers.ts`), so it still
    // resolves to itself unchanged. Used to assert the bare id on the first two rows.
    //
    // 2026-08-14: a row for `deepseek/deepseek-v4-flash` was dropped. It stood for "an unclassed
    // provider", and under the admission rule there is no such dispatchable state — a provider
    // absent from `config/models.json` and from `egress` is refused before its class is ever
    // consulted. What THIS test pins, that the session's own class never refuses, is unchanged; the
    // refusal that replaced the row is pinned in the admission describe below.
    const state = stateOf({ sessionEgress: "internal" });
    for (const [model, resolved] of [
      ["strong", "github-copilot/claude-opus-5:high"],
      ["cheap", "databricks/databricks-claude-haiku-4-5:low"],
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

/**
 * `/agents` answers the question after the fact — "am I really getting the effort routing.json
 * promises?" — which is the one an operator asks once an afternoon of runs has already gone by. It
 * reads the same disclosure the dispatch path does, so the two cannot disagree.
 */
describe("clampedTiers (the /agents line)", () => {
  it("is empty when every tier asks for something its model serves", () => {
    assert.deepEqual(clampedTiers(stateOf()), []);
  });

  it("names the tier, both levels and the real vocabulary", () => {
    const state = stateOf();
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4", thinkingLevel: "max" } },
    };
    assert.deepEqual(clampedTiers({ ...state, settings: { ...state.settings, routing } }), [
      "cheap asks max, runs high (serves low|medium|high)",
    ]);
  });

  /** "We cannot see the vocabulary" must not render as "nothing is clamped". */
  it("reports nothing at all when the registry is unavailable", () => {
    const state = stateOf({ withCatalogue: false });
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4", thinkingLevel: "max" } },
    };
    assert.deepEqual(clampedTiers({ ...state, settings: { ...state.settings, routing } }), []);
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

  /**
   * The disclosure defect, end to end. `_meta.json` records the launch string verbatim
   * (`model: target.model`, pi-subagents/src/runs/foreground/execution.ts:137), so a call that left
   * `:max` on the string put `"max"` in the run metadata for a run that shipped `high`. The suffix
   * is now rewritten to the level that will actually reach the provider.
   */
  it("rewrites an unsupported reasoning level to the one that will actually ship", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/gpt-5.4:high", "this model serves low|medium|high; max 400s");
  });

  it("says so out loud, naming BOTH levels and what the model does serve", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    await run(rules(stateOf()), eventOf("subagent", input), ctx);
    const line = notices.find((n) => n.includes("reasoning effort"));
    assert.ok(line, `expected a clamp notice, got: ${JSON.stringify(notices)}`);
    assert.match(line, /asked for reasoning effort `max`/);
    assert.match(line, /will run at `high`/);
    assert.match(line, /low, medium, high/, "the real vocabulary, so a retry has somewhere to go");
    assert.match(line, /Nothing was rerouted/, "disclosure is not failover");
  });

  it("leaves a supported level alone and says nothing about it", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:medium" };
    await run(rules(stateOf()), eventOf("subagent", input), ctx);
    assert.equal(input.model, "github-copilot/gpt-5.4:medium");
    assert.equal(notices.find((n) => n.includes("reasoning effort")), undefined);
  });

  /**
   * `github-copilot/claude-opus-5` is in the catalogue's id set but carries no thinking capability,
   * modelling a registry that does not describe the model. An unknown vocabulary must leave the
   * string exactly as written — inventing a clamp would be the silent substitution this repo bans,
   * pointed the other way.
   */
  it("does not touch a level it cannot check", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/claude-opus-5:max" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/claude-opus-5:max");
  });

  it("does not touch a level when the whole registry is unavailable", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    assert.equal(await run(rules(stateOf({ withCatalogue: false })), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "github-copilot/gpt-5.4:max");
  });

  it("clamps a level a TIER declared, not only one the call named", async () => {
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4", thinkingLevel: "max" } },
    };
    const state = stateOf();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(
      await run(rules({ ...state, settings: { ...state.settings, routing } }), eventOf("subagent", input)),
      undefined,
    );
    assert.equal(input.model, "github-copilot/gpt-5.4:high");
  });

  /**
   * The routing HINT. "max is not available here" invites the next question immediately, and the
   * registry can answer it — `databricks/databricks-claude-sonnet-4-5` takes a token budget and so
   * declares the full ladder. It is named, with its egress class, and nothing moves.
   */
  it("names which configured models DO serve the level, with their egress class", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    await run(rules(stateOf()), eventOf("subagent", input), ctx);
    const line = notices.find((n) => n.includes("reasoning effort")) ?? "";
    assert.match(line, /Models that DO serve `max`/);
    assert.match(line, /databricks \(egress confidential\): databricks\/databricks-claude-sonnet-4-5/);
    assert.match(line, /hint, not a reroute/, "naming an alternative must not read as failover");
    assert.equal(input.model, "github-copilot/gpt-5.4:high", "the hint changes nothing about where this runs");
  });

  it("says so plainly when NOTHING configured serves the level", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    // A registry holding only the clamping model — the shape a session has when no configured
    // provider can serve the asked level. The hint must then say "this is the ceiling", not go
    // quiet: an empty list is a finding, and the reader needs to know it was looked for.
    const state = stateOf();
    const catalogue = makeCatalogue(
      ["github-copilot/gpt-5.4"],
      THINKING_CAPS.filter(([id]) => id === "github-copilot/gpt-5.4"),
    );
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    await run(rules({ ...state, catalogue }), eventOf("subagent", input), ctx);
    const line = notices.find((n) => n.includes("reasoning effort")) ?? "";
    assert.match(line, /No configured model serves `max` at all/);
    assert.match(line, /ceiling rather than a routing choice/);
  });

  /**
   * The hint may only name endpoints this install actually has. `ctx.modelRegistry.getAvailable()`
   * also carries providers PI knows natively — `deepseek` is in no `config/models.json` block and
   * in no `routing.json` egress entry, so it can be assigned no class, and offering it as a place to
   * run `max` inverts the hint's whole purpose. See `providersServing`.
   */
  it("never offers a provider that is in the registry but in no config", async () => {
    resetSurfaced();
    const { ctx, notices } = capturingCtx();
    // A registry shaped like the real machine's: the clamping model, plus a native-catalogue
    // provider that serves the asked level and that nothing here configures.
    const catalogue = makeCatalogue(
      ["github-copilot/gpt-5.4", "deepseek/deepseek-v4-flash"],
      [
        ...THINKING_CAPS.filter(([id]) => id === "github-copilot/gpt-5.4"),
        [
          "deepseek/deepseek-v4-flash",
          { reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" } },
        ] as const,
      ],
    );
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    await run(rules({ ...stateOf(), catalogue }), eventOf("subagent", input), ctx);
    const line = notices.find((n) => n.includes("reasoning effort")) ?? "";
    assert.ok(!line.includes("deepseek"), "an unconfigured endpoint is not a routing candidate");
    assert.ok(!line.includes("unlabelled"), "`unlabelled` is a filter now, never a rendered class");
    assert.match(line, /No configured model serves `max` at all/, "and the ceiling wording covers the empty case");
  });

  /**
   * `onThinkingClamp: "abort"` is for the run where a quietly downgraded effort is worse than no
   * run. It refuses by name and still hints; it never picks another provider.
   */
  it("refuses the dispatch instead when config/dispatch.json says abort", async () => {
    const state = stateOf();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:max" };
    const blocked = await run(
      rules({ ...state, settings: { ...state.settings, dispatch: { ...CONFIG, onThinkingClamp: "abort" } } }),
      eventOf("subagent", input),
    );
    assert.match(blocked?.reason ?? "", /refusing this dispatch/);
    assert.match(blocked?.reason ?? "", /asked for reasoning effort `max`/);
    assert.match(blocked?.reason ?? "", /silently downgraded to `high`/);
    assert.match(blocked?.reason ?? "", /Models that DO serve `max`/);
  });

  it("abort does not fire for a level the model serves", async () => {
    const state = stateOf();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "github-copilot/gpt-5.4:high" };
    assert.equal(
      await run(
        rules({ ...state, settings: { ...state.settings, dispatch: { ...CONFIG, onThinkingClamp: "abort" } } }),
        eventOf("subagent", input),
      ),
      undefined,
    );
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
   * The history of this one test is the history of the rule.
   *
   * Originally it asserted that a provider `routing.json` does not classify was refused outright
   * ("no defensible answer to may this session's data go there"). WITHDRAWN 2026-08-13 as egress
   * containment in another costume, and replaced by "dispatches onto it, leaving it unlabelled".
   *
   * REINSTATED on a different footing 2026-08-14, from the owner directly: *a provider that is not
   * configured does not exist*. This is NOT the containment rule coming back — it does not ask
   * whether this session's data may go there, and it is the same answer for every session class. It
   * asks whether this install has the provider at all, and `deepseek` is in PI's built-in registry,
   * in no `config/models.json` block and in no `routing.json` egress entry, with no key on the
   * machine. The old behaviour admitted it here and let it die in a child process on a missing
   * credential, minutes later, attributed to the wrong thing.
   */
  it("refuses a provider this install has not configured, naming the model, the provider and why", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "deepseek/deepseek-v4-flash" };
    const blocked = await run(rules(stateOf()), eventOf("subagent", input));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    const reason = blocked?.reason ?? "";
    assert.match(reason, /unconfigured_provider/, "its own error kind, not `unknown_model`");
    assert.match(reason, /deepseek\/deepseek-v4-flash/, "names the model");
    assert.match(reason, /"deepseek" is not configured for dispatch/, "names the provider");
    assert.match(reason, /it is not configured in config\/models\.json/, "names the first missing config");
    assert.match(reason, /it has no egress class in config\/routing\.json/, "and the second");
    assert.match(reason, /Dispatchable providers are: databricks, github-copilot, local, openai/);
    assert.match(reason, /Nothing is substituted/, "a refusal, never a fallback");
    assert.equal(input.model, "deepseek/deepseek-v4-flash", "refused, not rewritten");
  });

  it("refuses on the provider BEFORE the model, so the reason points at the config and not at a typo", async () => {
    // `deepseek/deepseek-v9-imaginary` is absent from the registry too. Reporting `unknown_model`
    // would send the reader hunting for a spelling mistake; the model id is not the problem.
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "deepseek/deepseek-v9-imaginary" }),
    );
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /unconfigured_provider/);
    assert.doesNotMatch(blocked?.reason ?? "", /unknown_model/);
  });

  it("refuses an unconfigured provider even when the model registry could not be read", async () => {
    // The two configs are readable whatever the registry did, so this gate does not depend on it.
    // Without that, an unreadable registry would silently re-open the door.
    const blocked = await run(
      rules(stateOf({ withCatalogue: false })),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "deepseek/deepseek-v4-flash" }),
    );
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /unconfigured_provider/);
  });

  it("keeps admitting a configured, classified provider — the rule is structural, not a deny-list", async () => {
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-sonnet-4-5" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input)), undefined);
    assert.equal(input.model, "databricks/databricks-claude-sonnet-4-5");
  });

  it("still refuses an unknown model on a CONFIGURED provider — existence is the second gate", async () => {
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "databricks/gpt-9-imaginary" }),
    );
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /unknown_model/);
  });

  it("does not name an unconfigured provider in a typo suggestion", async () => {
    // `suggestModels` reads `state.catalogue`, which is restricted at session_start, so a correction
    // cannot resolve to somewhere the gate would then refuse. Menu, suggestions and gate agree.
    const blocked = await run(
      rules(stateOf()),
      eventOf("subagent", { agent: "scout", prompt: "x", model: "github-copilot/deepseek-v4-flash" }),
    );
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.doesNotMatch(blocked?.reason ?? "", /deepseek\/deepseek-v4-flash/);
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
  /** `CONFIG.defaultTier` is `strong`, and `strong` declares `thinkingLevel: "high"`. */
  const DEFAULT_TIER_MODEL = "github-copilot/claude-opus-5:high";

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
      // The tier broken here has to be `CONFIG.defaultTier` — breaking any other one leaves the
      // floor resolving happily and the test asserts nothing.
      routing: {
        ...ROUTING,
        tiers: { ...ROUTING.tiers, [CONFIG.defaultTier]: { model: "github-copilot/gpt-5.1", thinkingLevel: "medium" } },
      },
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
    assert.equal(destructures.length, 2, "the async and foreground branches, :4723 and :4998");
    for (const line of destructures) {
      const omitted = line.slice(0, line.indexOf("...workflowChildDefaults"));
      assert.doesNotMatch(
        omitted,
        /\bmodel\s*:/,
        "pi-subagents began stripping `model` from workflowChildDefaults — the floor no longer " +
          "reaches the children; re-read subagent-executor.ts:4723 before trusting DSP-RESOLVE",
      );
    }

    // Both branches hand those defaults to prepareWorkflowChildLaunchParams (:4851 and :5056),
    // which forwards them to prepareWorkflowLaunchParams — since 0.57.0 the merge that decides
    // whether a child may keep its own model lives there, in one place, not at the call sites.
    const mergeStart = lines.findIndex((line) => line.startsWith("export function prepareWorkflowLaunchParams("));
    assert.ok(mergeStart >= 0, "prepareWorkflowLaunchParams is gone — the child merge moved somewhere new");
    const mergeEnd = lines.findIndex((line, i) => i > mergeStart && line === "}");
    const body = lines.slice(mergeStart, mergeEnd).join("\n");
    const defaultsAt = body.indexOf("...workflowDefaults,");
    const childAt = body.indexOf("...childParams,");
    assert.ok(defaultsAt >= 0 && childAt >= 0, "the workflow-default/child merge is no longer two object spreads");
    assert.ok(
      defaultsAt < childAt,
      "the spread order flipped: the workflow default would now OVERRIDE a child's own model",
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { rules, type State } from "../../extensions/dispatch/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { ProviderSemaphoreSet } from "../../extensions/dispatch/semaphore.ts";
import { loadAgentRegistry } from "../../extensions/dispatch/registry.ts";
import { admissibleProviders, makeCatalogue, restrictCatalogue } from "../../extensions/dispatch/catalogue.ts";
import { forceLaneModel, laneMenu, laneModel, laneNotice } from "../../extensions/dispatch/local-lane.ts";
import { ALL_MODELS, CONFIG, CONFIGURED_PROVIDERS, GOOD_SCOUT, ROUTING, THINKING_CAPS, scratch, writeAgents } from "./helpers.ts";

const LOCAL_ID = "example-org/local-model-GGUF";
const LOCAL = `local/${LOCAL_ID}`;

const ALL_NULL = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
const CATALOGUE = makeCatalogue(new Set([...ALL_MODELS, LOCAL]), [
  ...THINKING_CAPS,
  [LOCAL, { reasoning: true, thinkingLevelMap: ALL_NULL }],
]);

function stateOf(): State {
  const admission = admissibleProviders(ROUTING, CONFIGURED_PROVIDERS);
  const dir = writeAgents(join(scratch(), "agents"), [
    GOOD_SCOUT,
    // An explicit provider/id pin in the agent file: the lane must override this too.
    { name: "pinned", frontmatter: "name: pinned\ndescription: Pinned to a cloud model by id.\nmodel: databricks/databricks-claude-haiku-4-5" },
  ]);
  return {
    catalogue: restrictCatalogue(CATALOGUE, admission).catalogue,
    admission,
    settings: {
      dispatch: CONFIG,
      routing: ROUTING,
      configuredProviders: CONFIGURED_PROVIDERS,
      problems: [],
      sources: { dispatch: "<test>/dispatch.json", routing: "<test>/routing.json" },
    },
    registry: loadAgentRegistry({ dirs: [dir], routing: ROUTING, config: CONFIG, availableModels: ALL_MODELS }),
    sessionEgress: "local",
    egressSource: "test",
    depth: 0,
    semaphores: new ProviderSemaphoreSet(ROUTING.concurrency, CONFIG.concurrencyDefault),
    ceilingNotes: [],
    vetoIds: [],
    problems: [],
  };
}

function ctxOn(provider: string, id: string): { ctx: ExtensionContext; notices: string[] } {
  const notices: string[] = [];
  const ctx = {
    cwd: scratch(),
    hasUI: true,
    ui: { notify: (m: string) => notices.push(m) },
    model: { provider, id },
  } as unknown as ExtensionContext;
  return { ctx, notices };
}

const onLane = () => ctxOn("local", LOCAL_ID);
const offLane = () => ctxOn("github-copilot", "claude-opus-5");

function eventOf(input: Record<string, unknown>): ToolCallEvent {
  return { toolName: "subagent", toolCallId: "call-1", input } as unknown as ToolCallEvent;
}

async function run(input: Record<string, unknown>, ctx: ExtensionContext) {
  for (const rule of rules(stateOf())) {
    const verdict = await rule.evaluate(eventOf(input), ctx);
    if (verdict?.block) return { ruleId: rule.id, reason: verdict.reason };
  }
  return undefined;
}

describe("local lane detection", () => {
  it("is the session's active provider being classed `local`, read live", () => {
    assert.deepEqual(laneModel(ROUTING, { provider: "local", id: LOCAL_ID }), { provider: "local", id: LOCAL_ID });
    assert.equal(laneModel(ROUTING, { provider: "databricks", id: "databricks-claude-haiku-4-5" }), undefined);
    assert.equal(laneModel(ROUTING, undefined), undefined);
    assert.equal(laneModel(undefined, { provider: "local", id: LOCAL_ID }), undefined);
  });
});

describe("local lane forcing (DSP-RESOLVE)", () => {
  it("forces a tier name to the session's local model", async () => {
    const { ctx } = onLane();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: "tier:strong" };
    assert.equal(await run(input, ctx), undefined);
    assert.equal(input.model, LOCAL);
  });

  it("forces the agent file's own tier when the call names no model", async () => {
    const { ctx } = onLane();
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(await run(input, ctx), undefined);
    assert.equal(input.model, LOCAL, "scout's frontmatter says `cheap`, a databricks model");
  });

  it("forces an explicit provider/id pin, on the call and in the agent file", async () => {
    const { ctx } = onLane();
    const onCall: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-haiku-4-5" };
    assert.equal(await run(onCall, ctx), undefined);
    assert.equal(onCall.model, LOCAL);
    const inFile: Record<string, unknown> = { agent: "pinned", prompt: "x" };
    assert.equal(await run(inFile, ctx), undefined);
    assert.equal(inFile.model, LOCAL);
  });

  it("forces every child of a fanout, including a nested chain step", async () => {
    const { ctx } = onLane();
    const input: Record<string, unknown> = {
      tasks: [
        { agent: "scout", task: "a", model: "github-copilot/claude-opus-5" },
        { agent: "scout", task: "b" },
      ],
      chain: [{ agent: "scout", task: "c", model: "tier:strong" }, { parallel: [{ agent: "scout", task: "d", model: "databricks/databricks-claude-sonnet-4-5" }] }],
    };
    assert.equal(await run(input, ctx), undefined);
    const tasks = input.tasks as Record<string, unknown>[];
    const chain = input.chain as Record<string, unknown>[];
    assert.deepEqual(
      [input.model, tasks[0]?.model, tasks[1]?.model, chain[0]?.model, (chain[1]?.parallel as Record<string, unknown>[])[0]?.model],
      [LOCAL, LOCAL, LOCAL, LOCAL, LOCAL],
    );
  });

  it("rewrites literal models in an inline workflowScript and refuses a computed one", async () => {
    const { ctx } = onLane();
    const ok: Record<string, unknown> = {
      workflowScript: 'await runs.run("a", { agent: "scout", model: "databricks/databricks-claude-sonnet-4-5", task: "x" });',
    };
    assert.equal(await run(ok, ctx), undefined);
    assert.match(String(ok.workflowScript), new RegExp(`model: "${LOCAL.replace(/[/.]/g, "\\$&")}"`));
    assert.doesNotMatch(String(ok.workflowScript), /gpt-5\.5/);

    const computed: Record<string, unknown> = {
      workflowScript: 'await runs.run("a", { agent: "scout", model: pick(), task: "x" });',
    };
    const blocked = await run(computed, ctx);
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.match(blocked?.reason ?? "", /local lane/);
    assert.match(blocked?.reason ?? "", /nothing was sent to another provider/i);
  });

  it("refuses a workflowScriptPath whose file sets a model, and accepts one that does not", async () => {
    const { ctx } = onLane();
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pinned.js"), 'await runs.run("a", { agent: "scout", model: "databricks/databricks-claude-sonnet-4-5" });');
    writeFileSync(join(dir, "plain.js"), 'await runs.run("a", { agent: "scout", task: "x" });');
    const blocked = await run({ workflowScriptPath: join(dir, "pinned.js") }, ctx);
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");
    assert.equal(await run({ workflowScriptPath: join(dir, "plain.js") }, ctx), undefined);
    assert.equal(await run({ workflowScriptPath: join(dir, "missing.js") }, ctx).then((b) => b?.ruleId), "DSP-RESOLVE");
  });

  it("announces the forcing instead of doing it silently", async () => {
    resetSurfaced();
    const { ctx, notices } = onLane();
    await run({ agent: "scout", prompt: "x", model: "databricks/databricks-claude-haiku-4-5" }, ctx);
    const line = notices.find((n) => n.includes("local lane"));
    assert.ok(line, JSON.stringify(notices));
    assert.match(line, /databricks\/databricks-claude-haiku-4-5/);
    assert.match(line, new RegExp(`forced to ${LOCAL.replace(/[/.]/g, "\\$&")}`));
  });

  it("leaves a management action (nothing launched) alone", async () => {
    const { ctx } = onLane();
    const input: Record<string, unknown> = { action: "status" };
    assert.equal(await run(input, ctx), undefined);
    assert.equal(input.model, undefined);
  });
});

describe("off the lane, dispatch is unchanged", () => {
  it("resolves tiers and keeps explicit pins exactly as before", async () => {
    const { ctx, notices } = offLane();
    const tier: Record<string, unknown> = { agent: "scout", prompt: "x", model: "strong" };
    assert.equal(await run(tier, ctx), undefined);
    assert.equal(tier.model, "github-copilot/claude-opus-5:high");
    const pin: Record<string, unknown> = { agent: "scout", prompt: "x", model: "databricks/databricks-claude-haiku-4-5" };
    assert.equal(await run(pin, ctx), undefined);
    assert.equal(pin.model, "databricks/databricks-claude-haiku-4-5");
    const fromFile: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(await run(fromFile, ctx), undefined);
    assert.equal(fromFile.model, "databricks/databricks-claude-haiku-4-5:low");
    assert.equal(notices.find((n) => n.includes("local lane")), undefined);
  });

  it("a session with no model at all is off the lane", async () => {
    const ctx = { cwd: scratch() } as unknown as ExtensionContext;
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(await run(input, ctx), undefined);
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low");
  });
});

describe("the lane's prompt text", () => {
  it("says, in one line, that every dispatch runs on local/<id>", () => {
    const model = { provider: "local", id: LOCAL_ID };
    assert.match(laneNotice(model), new RegExp(`^local lane: all sub-agents run on ${LOCAL.replace(/[/.]/g, "\\$&")}`));
    const menu = laneMenu(model);
    assert.ok(menu.startsWith("## Sub-agent model selection\n"));
    assert.equal(menu.split("\n").length, 2, "the header and the one line, nothing to choose from");
  });
});

describe("forceLaneModel", () => {
  it("is idempotent and reports what it replaced", () => {
    const input: Record<string, unknown> = { model: "tier:strong", tasks: [{ agent: "a", model: "x/y" }] };
    const first = forceLaneModel(input, LOCAL, "/repo");
    assert.deepEqual(first.replaced, ["tier:strong", "x/y"]);
    const second = forceLaneModel(input, LOCAL, "/repo");
    assert.deepEqual(second.replaced, []);
  });
});

/**
 * The three properties a pinned lead model has to have, asserted directly:
 *
 *   1. a pin is respected — a pinned project starts on the pinned tier's model;
 *   2. an unacknowledged change is undone — any selection away from the pin snaps back, loudly;
 *   3. an acknowledged change is recorded — `/lead-model <tier> <why>` rewrites the pin file *and*
 *      writes a fact carrying the reason, which is the half that survives a compaction.
 *
 * The harness is `test/path-defaults/index.test.ts`'s, extended with the two members this module
 * needs and that one does not: a `sessionManager`, so the fact lands in a temp file rather than a
 * real session's, and a way to fire `model_select`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { MIN_REASON_LENGTH } from "../../extensions/lead-model/config.ts";
import { id, register as leadModel, resolveLeadModel } from "../../extensions/lead-model/index.ts";

const ROUTING = {
  tiers: {
    strong: { model: "github-copilot/claude-opus-5", thinkingLevel: "high" },
    light: { model: "github-copilot/claude-sonnet-5" },
    confidential: { model: "databricks/databricks-claude-sonnet-4-5", thinkingLevel: "high" },
  },
  egress: { "github-copilot": "public", databricks: "confidential" },
};

const OPUS = "github-copilot/claude-opus-5";
const SONNET = "github-copilot/claude-sonnet-5";
const KNOWN = new Set([OPUS, SONNET, "databricks/databricks-claude-sonnet-4-5"]);
const REASON = "one lead for the whole investigation, so the results stay comparable";

let sandbox: string;
let routingFile: string;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-lead-model-"));
  routingFile = join(sandbox, "routing.json");
  await writeFile(routingFile, JSON.stringify(ROUTING));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

let savedRouting: string | undefined;
let savedOverride: string | undefined;
beforeEach(() => {
  savedRouting = process.env.PI_ROUTING_JSON;
  savedOverride = process.env.PI_LEAD_MODEL_JSON;
  process.env.PI_ROUTING_JSON = routingFile;
  delete process.env.PI_LEAD_MODEL_JSON;
});
afterEach(() => {
  if (savedRouting === undefined) delete process.env.PI_ROUTING_JSON;
  else process.env.PI_ROUTING_JSON = savedRouting;
  if (savedOverride === undefined) delete process.env.PI_LEAD_MODEL_JSON;
  else process.env.PI_LEAD_MODEL_JSON = savedOverride;
});

/** A fresh project directory, optionally carrying a pin file. */
let projects = 0;
async function project(pin?: Record<string, unknown> | string): Promise<string> {
  const cwd = join(sandbox, `project-${++projects}`);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  if (pin !== undefined) {
    await writeFile(join(cwd, ".pi", "lead-model.json"), typeof pin === "string" ? pin : JSON.stringify(pin));
  }
  return cwd;
}

const PINNED_STRONG = { version: 1, tier: "strong", since: "2026-08-31", reason: REASON };

describe("id", () => {
  it("is stable", () => {
    assert.equal(id, "lead-model");
  });
});

describe("resolveLeadModel", () => {
  it('is "unpinned" when the project has no .pi/lead-model.json', async () => {
    assert.equal(resolveLeadModel(await project()).kind, "unpinned");
  });

  it("resolves the pinned tier through the routing table", async () => {
    const res = resolveLeadModel(await project(PINNED_STRONG));
    assert.equal(res.kind, "pinned");
    if (res.kind === "pinned") {
      assert.equal(res.target.model, OPUS);
      assert.equal(res.target.provider, "github-copilot");
      assert.equal(res.target.thinkingLevel, "high");
      assert.equal(res.pin.reason, REASON);
    }
  });

  it('is "config-error" on malformed JSON, and never throws', async () => {
    const cwd = await project("{ not json");
    assert.doesNotThrow(() => resolveLeadModel(cwd));
    const res = resolveLeadModel(cwd);
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /not valid JSON/);
  });

  it('is "config-error" when the pin names a tier the routing table does not define', async () => {
    const res = resolveLeadModel(await project({ ...PINNED_STRONG, tier: "nope" }));
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /nope/);
  });

  it('is "config-error" when the pin carries no real reason', async () => {
    const res = resolveLeadModel(await project({ ...PINNED_STRONG, reason: "x" }));
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /reason/);
  });
});

/* --- harness --------------------------------------------------------------------------------- */

type Level = "info" | "warning" | "error";
interface Notice {
  message: string;
  level: Level;
}

function makeHarness(opts: {
  cwd: string;
  transcript: string;
  knownModels?: Set<string>;
  setModelResult?: boolean;
  currentModel?: { provider: string; id: string };
}) {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => unknown }> = {};
  const setModelCalls: { provider: string; id: string }[] = [];
  const thinkingCalls: unknown[] = [];
  const notices: Notice[] = [];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands[name] = def;
    },
    setModel: async (model: { provider: string; id: string }) => {
      setModelCalls.push(model);
      return opts.setModelResult ?? true;
    },
    setThinkingLevel: (level: unknown) => thinkingCalls.push(level),
  } as unknown as Parameters<typeof leadModel>[0];

  const ctx = {
    hasUI: true,
    cwd: opts.cwd,
    model: opts.currentModel,
    sessionManager: {
      getSessionFile: () => opts.transcript,
      getSessionId: () => "test-session",
    },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        (opts.knownModels ?? KNOWN).has(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined,
    },
    ui: {
      notify: (message: string, level: Level = "info") => notices.push({ message, level }),
      setStatus: () => undefined,
    },
  };

  leadModel(pi);

  return {
    notices,
    setModelCalls,
    thinkingCalls,
    fireSessionStart: async () => {
      for (const h of handlers["session_start"] ?? []) await h({}, ctx);
    },
    fireModelSelect: async (model: { provider: string; id: string }) => {
      for (const h of handlers["model_select"] ?? []) {
        await h({ type: "model_select", model, previousModel: undefined, source: "set" }, ctx);
      }
    },
    run: async (args = "") => commands["lead-model"]?.handler(args, ctx),
  };
}

/** A transcript path under the sandbox. `factsPathFor` derives the sibling `.facts.md` from it. */
let transcripts = 0;
function transcript(): { path: string; facts: string } {
  const path = join(sandbox, `s-${++transcripts}.jsonl`);
  return { path, facts: `${path.replace(/\.jsonl$/, "")}.facts.md` };
}

/* --- the three properties -------------------------------------------------------------------- */

describe("a pin is respected", () => {
  it("selects the pinned tier's model at session_start, with its thinking level", async () => {
    const h = makeHarness({ cwd: await project(PINNED_STRONG), transcript: transcript().path });
    await h.fireSessionStart();
    assert.deepEqual(h.setModelCalls, [{ provider: "github-copilot", id: "claude-opus-5" }]);
    assert.deepEqual(h.thinkingCalls, ["high"]);
    assert.ok(h.notices.some((n) => n.level === "info" && n.message.includes('pinned to tier "strong"')));
  });

  it("does nothing at all for an unpinned project", async () => {
    const h = makeHarness({ cwd: await project(), transcript: transcript().path });
    await h.fireSessionStart();
    assert.deepEqual(h.setModelCalls, []);
    assert.deepEqual(h.notices, []);
  });

  it("announces a broken pin file at error level, and enforces nothing", async () => {
    const h = makeHarness({ cwd: await project("{ not json"), transcript: transcript().path });
    await h.fireSessionStart();
    assert.deepEqual(h.setModelCalls, []);
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("no lead model is pinned")));
  });
});

describe("an unacknowledged change is undone", () => {
  it("reverts a switch away from the pin, and says what it undid", async () => {
    const h = makeHarness({ cwd: await project(PINNED_STRONG), transcript: transcript().path });
    await h.fireSessionStart();
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-sonnet-5" });

    assert.equal(h.setModelCalls.length, 2, "the pin was put back");
    assert.deepEqual(h.setModelCalls[1], { provider: "github-copilot", id: "claude-opus-5" });
    const revert = h.notices.at(-1);
    assert.equal(revert?.level, "error");
    assert.ok(revert?.message.includes(`reverted the switch to ${SONNET}`));
    assert.ok(revert?.message.includes("/lead-model"), "the sanctioned path is named");
  });

  it("does not fight a selection that IS the pin", async () => {
    const h = makeHarness({ cwd: await project(PINNED_STRONG), transcript: transcript().path });
    await h.fireSessionStart();
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-opus-5" });
    assert.equal(h.setModelCalls.length, 1);
  });

  it("does not recurse: the revert's own model_select is not reverted again", async () => {
    const h = makeHarness({ cwd: await project(PINNED_STRONG), transcript: transcript().path });
    await h.fireSessionStart();
    // Feed the module its own effect: a revert emits a model_select for the pinned model.
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-sonnet-5" });
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-opus-5" });
    assert.equal(h.setModelCalls.length, 2);
  });

  it("leaves an unpinned project's model changes alone", async () => {
    const h = makeHarness({ cwd: await project(), transcript: transcript().path });
    await h.fireSessionStart();
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-sonnet-5" });
    assert.deepEqual(h.setModelCalls, []);
  });

  it("stands down, loudly, when the pinned model cannot be selected at all", async () => {
    const h = makeHarness({
      cwd: await project(PINNED_STRONG),
      transcript: transcript().path,
      knownModels: new Set([SONNET]),
    });
    await h.fireSessionStart();
    assert.deepEqual(h.setModelCalls, []);
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("NOT enforced")));
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-sonnet-5" });
    assert.deepEqual(h.setModelCalls, [], "an unenforceable pin does not trap the session");
  });
});

describe("an acknowledged change is recorded", () => {
  it("rewrites the pin file, switches the session, and writes a fact carrying the reason", async () => {
    const cwd = await project(PINNED_STRONG);
    const t = transcript();
    const h = makeHarness({ cwd, transcript: t.path });
    await h.fireSessionStart();

    await h.run("light this stream is mechanical edits and does not need the strong lead");

    const written = JSON.parse(await readFile(join(cwd, ".pi", "lead-model.json"), "utf8"));
    assert.equal(written.tier, "light");
    assert.match(written.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(written.reason, "this stream is mechanical edits and does not need the strong lead");

    assert.deepEqual(h.setModelCalls.at(-1), { provider: "github-copilot", id: "claude-sonnet-5" });

    const recorded = await readFile(t.facts, "utf8");
    assert.match(recorded, /moved from tier "strong"/);
    assert.match(recorded, /to tier "light"/);
    assert.match(recorded, /mechanical edits/);
  });

  it("enforces the new pin immediately: the old model is now the drift", async () => {
    const cwd = await project(PINNED_STRONG);
    const h = makeHarness({ cwd, transcript: transcript().path });
    await h.fireSessionStart();
    await h.run("light this stream is mechanical edits and does not need the strong lead");
    const before = h.setModelCalls.length;
    await h.fireModelSelect({ provider: "github-copilot", id: "claude-opus-5" });
    assert.deepEqual(h.setModelCalls.at(-1), { provider: "github-copilot", id: "claude-sonnet-5" });
    assert.equal(h.setModelCalls.length, before + 1);
  });

  it("refuses a change with no reason, writes nothing and switches nothing", async () => {
    const cwd = await project(PINNED_STRONG);
    const h = makeHarness({ cwd, transcript: transcript().path });
    await h.fireSessionStart();
    const before = h.setModelCalls.length;

    await h.run("light");
    await h.run("light too short");

    assert.equal(h.setModelCalls.length, before);
    const pin = JSON.parse(await readFile(join(cwd, ".pi", "lead-model.json"), "utf8"));
    assert.equal(pin.tier, "strong", "the pin file is untouched");
    const refusals = h.notices.filter((n) => n.level === "error" && n.message.includes("refused"));
    assert.equal(refusals.length, 2);
    assert.ok(refusals[0]?.message.includes(String(MIN_REASON_LENGTH)));
  });

  it("refuses an unknown tier, and writes nothing", async () => {
    const cwd = await project();
    const h = makeHarness({ cwd, transcript: transcript().path });
    await h.fireSessionStart();
    await h.run("nonexistent this tier does not exist anywhere");
    assert.equal(existsSync(join(cwd, ".pi", "lead-model.json")), false);
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("refused")));
  });

  it("pins a previously unpinned project, and records it as coming from no pin", async () => {
    const cwd = await project();
    const t = transcript();
    const h = makeHarness({ cwd, transcript: t.path });
    await h.fireSessionStart();
    await h.run("strong hold one lead for the whole investigation");

    const written = JSON.parse(await readFile(join(cwd, ".pi", "lead-model.json"), "utf8"));
    assert.equal(written.tier, "strong");
    assert.match(await readFile(t.facts, "utf8"), /moved from no pin to tier "strong"/);
  });

  it("with no arguments, reports the pin instead of changing anything", async () => {
    const cwd = await project(PINNED_STRONG);
    const h = makeHarness({ cwd, transcript: transcript().path });
    await h.fireSessionStart();
    const before = h.setModelCalls.length;
    await h.run("   ");
    assert.equal(h.setModelCalls.length, before);
    const status = h.notices.at(-1);
    assert.equal(status?.level, "info");
    assert.ok(status?.message.includes('pinned to tier "strong"'));
    assert.ok(status?.message.includes("Enforced this session: yes"));
  });
});

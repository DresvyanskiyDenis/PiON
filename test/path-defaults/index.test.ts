import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { register as pathDefaults, declareSessionEgress, id, resolvePathDefaults, type Resolution } from "../../extensions/path-defaults/index.ts";

let sandbox: string;
let routingFile: string;
let pathDefaultsFile: string;

const ROUTING = {
  tiers: {
    strong: { model: "github-copilot/claude-opus-5" },
    fast: { model: "github-copilot/gpt-5.1" },
    confidential: { model: "databricks/databricks-claude-sonnet-4-5" },
    reasoning: { model: "databricks/databricks-claude-sonnet-4-5", thinkingLevel: "high" },
    suffixed: { model: "github-copilot/claude-opus-5:max" },
    "suffix-wins": { model: "github-copilot/claude-opus-5:low", thinkingLevel: "high" },
    "bogus-suffix": { model: "github-copilot/claude-opus-5:extreme" },
  },
  egress: {
    "github-copilot": "public",
    databricks: "confidential",
  },
};

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-path-defaults-index-"));
  routingFile = join(sandbox, "routing.json");
  pathDefaultsFile = join(sandbox, "path-defaults.json");
  await writeFile(routingFile, JSON.stringify(ROUTING));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

let savedRoutingEnv: string | undefined;
let savedEgressEnv: string | undefined;
beforeEach(() => {
  savedRoutingEnv = process.env.PI_ROUTING_JSON;
  savedEgressEnv = process.env.PI_ROUTING_EGRESS;
  process.env.PI_ROUTING_JSON = routingFile;
  delete process.env.PI_ROUTING_EGRESS;
});
afterEach(() => {
  if (savedRoutingEnv === undefined) delete process.env.PI_ROUTING_JSON;
  else process.env.PI_ROUTING_JSON = savedRoutingEnv;
  if (savedEgressEnv === undefined) delete process.env.PI_ROUTING_EGRESS;
  else process.env.PI_ROUTING_EGRESS = savedEgressEnv;
});

describe("id", () => {
  it("is stable", () => {
    assert.equal(id, "path-defaults");
  });
});

describe("resolvePathDefaults", () => {
  it("is \"disabled\" when config/path-defaults.json does not exist", () => {
    const res = resolvePathDefaults(join(sandbox, "does-not-exist.json"));
    assert.equal(res.kind, "disabled");
  });

  it("is \"config-error\" on malformed JSON, never throws", async () => {
    await writeFile(pathDefaultsFile, "{ not json");
    const res = resolvePathDefaults(pathDefaultsFile);
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /not valid JSON/);
  });

  it("is \"configured\" and resolves the tier through routing.json", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({ version: 1, tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } }),
    );
    const res = resolvePathDefaults(pathDefaultsFile);
    assert.equal(res.kind, "configured");
    if (res.kind === "configured") {
      assert.equal(res.file.tier, "confidential");
      assert.equal(res.target.provider, "databricks");
      assert.equal(res.target.egress, "confidential");
    }
  });

  it("is \"config-error\" when the file names a tier routing.json does not define", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({ version: 1, tier: "nonexistent-tier", egress: { web: "allow", mcp: "allow", publicModels: "allow" } }),
    );
    const res = resolvePathDefaults(pathDefaultsFile);
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /nonexistent-tier/);
  });

  it("never throws even for a totally garbage path-defaults value", async () => {
    await writeFile(pathDefaultsFile, JSON.stringify({ version: 1, tier: 5 }));
    assert.doesNotThrow(() => resolvePathDefaults(pathDefaultsFile));
    const res = resolvePathDefaults(pathDefaultsFile);
    assert.equal(res.kind, "config-error");
  });
});

describe("declareSessionEgress", () => {
  it("sets PI_ROUTING_EGRESS from a configured resolution", () => {
    const res: Resolution = {
      kind: "configured",
      file: { version: 1, tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } },
      target: { tier: "confidential", model: "databricks/databricks-claude-sonnet-4-5", provider: "databricks", modelId: "databricks-claude-sonnet-4-5", egress: "confidential" },
    };
    declareSessionEgress(res);
    assert.equal(process.env.PI_ROUTING_EGRESS, "confidential");
  });

  it("never clobbers an existing declaration", () => {
    process.env.PI_ROUTING_EGRESS = "public";
    const res: Resolution = {
      kind: "configured",
      file: { version: 1, tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } },
      target: { tier: "confidential", model: "databricks/databricks-claude-sonnet-4-5", provider: "databricks", modelId: "databricks-claude-sonnet-4-5", egress: "confidential" },
    };
    declareSessionEgress(res);
    assert.equal(process.env.PI_ROUTING_EGRESS, "public");
  });

  it("is a no-op for disabled/config-error resolutions", () => {
    for (const res of [{ kind: "disabled" }, { kind: "config-error", message: "x" }] as Resolution[]) {
      delete process.env.PI_ROUTING_EGRESS;
      declareSessionEgress(res);
      assert.equal(process.env.PI_ROUTING_EGRESS, undefined);
    }
  });
});

// --- Behavioural tests against a fake ExtensionAPI/ExtensionContext (auto-title's harness shape) ---

type Level = "info" | "warning" | "error";
interface Notice {
  message: string;
  level: Level;
}

function makeHarness(opts: {
  scopedModels?: unknown[];
  currentModel?: { provider: string; id: string };
  knownModels?: Set<string>; // "provider/id" strings the fake registry can `find`
  setModelResult?: boolean;
}) {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => unknown }> = {};
  const setModelCalls: unknown[] = [];
  const setThinkingLevelCalls: unknown[] = [];
  const statusCalls: { key: string; text: string | undefined }[] = [];
  const notices: Notice[] = [];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown }) => {
      commands[name] = def;
    },
    setModel: async (model: unknown) => {
      setModelCalls.push(model);
      return opts.setModelResult ?? true;
    },
    setThinkingLevel: (level: unknown) => {
      setThinkingLevelCalls.push(level);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const ctx = {
    // A real session_start context always has a UI (TUI or RPC) here — the
    // `-p`/`--mode json` no-UI case is exercised separately by `path-defaults`'s own module tests
    // via `resolvePathDefaults`, not through this harness. `lib/announce.ts` routes on
    // `ctx.hasUI`, so this fake must declare it or every `ui.notify` assertion below silently sees
    // the stderr fallback instead.
    hasUI: true,
    cwd: process.cwd(),
    scopedModels: opts.scopedModels ?? [],
    model: opts.currentModel,
    modelRegistry: {
      find: (provider: string, modelId: string) => {
        const key = `${provider}/${modelId}`;
        if ((opts.knownModels ?? new Set()).has(key)) return { provider, id: modelId } as unknown;
        return undefined;
      },
    },
    ui: {
      notify: (message: string, level: Level = "info") => notices.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  pathDefaults(pi);

  return {
    fireSessionStart: async () => {
      for (const h of handlers["session_start"] ?? []) await h({}, ctx);
    },
    runCommand: async (name: string, args = "") => commands[name]?.handler(args, ctx),
    setModelCalls,
    setThinkingLevelCalls,
    statusCalls,
    notices,
  };
}

/** A `path-defaults.json` naming `tier`, so a test can aim at any tier without restating the
 *  whole file. */
async function writeConfiguredTier(tier: string): Promise<void> {
  await writeFile(
    pathDefaultsFile,
    JSON.stringify({ version: 1, tier, egress: { web: "allow", mcp: "allow", publicModels: "allow" } }),
  );
}

describe("default export — session_start behaviour", () => {
  let savedArgv: string[];
  beforeEach(async () => {
    savedArgv = process.argv;
    await writeConfiguredTier("confidential");
    process.env.PI_PATH_DEFAULTS_JSON = pathDefaultsFile;
  });
  afterEach(() => {
    process.argv = savedArgv;
    delete process.env.PI_PATH_DEFAULTS_JSON;
  });

  it("calls setModel with the resolved model and flags the status bar", async () => {
    const h = makeHarness({ knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]) });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 1);
    assert.deepEqual(h.setModelCalls[0], { provider: "databricks", id: "databricks-claude-sonnet-4-5" });
    assert.deepEqual(h.statusCalls.at(-1), { key: "scope", text: "⚑ confidential" });
  });

  it("does not call setModel when scopedModels is already populated", async () => {
    const h = makeHarness({
      scopedModels: [{ provider: "databricks", id: "databricks-claude-sonnet-4-5" }],
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.message.includes("explicit model")));
  });

  it("does not call setModel when --model was passed on argv", async () => {
    process.argv = ["node", "pi", "--model", "databricks/databricks-claude-sonnet-4-5"];
    const h = makeHarness({ knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]) });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
  });

  it("announces an error and does not call setModel when the target model is not configured", async () => {
    const h = makeHarness({ knownModels: new Set() });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("no such model is")));
  });

  it("announces an error naming the missing credential when setModel returns false, and does not silently stay switched", async () => {
    const h = makeHarness({
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
      currentModel: { provider: "github-copilot", id: "claude-opus-5" },
      setModelResult: false,
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 1, "setModel is still called — that IS the credential probe");
    const err = h.notices.find((n) => n.level === "error");
    assert.ok(err);
    assert.match(err!.message, /no credential is available/);
    assert.match(err!.message, /staying on github-copilot\/claude-opus-5/);
  });

  it("applies the tier's declared thinkingLevel through setThinkingLevel once setModel succeeded", async () => {
    await writeConfiguredTier("reasoning");
    const h = makeHarness({ knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]) });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 1);
    assert.deepEqual(h.setThinkingLevelCalls, ["high"]);
  });

  it("resolves a tier whose model carries a thinking suffix, and applies that suffix's level", async () => {
    await writeConfiguredTier("suffixed");
    const h = makeHarness({ knownModels: new Set(["github-copilot/claude-opus-5"]) });
    await h.fireSessionStart();
    assert.deepEqual(h.setModelCalls[0], { provider: "github-copilot", id: "claude-opus-5" });
    assert.deepEqual(h.setThinkingLevelCalls, ["max"]);
  });

  it("lets the model string's suffix outrank the tier's declared thinkingLevel", async () => {
    await writeConfiguredTier("suffix-wins");
    const h = makeHarness({ knownModels: new Set(["github-copilot/claude-opus-5"]) });
    await h.fireSessionStart();
    assert.deepEqual(h.setThinkingLevelCalls, ["low"]);
  });

  it("refuses a bogus thinking suffix rather than reading it as a level", async () => {
    await writeConfiguredTier("bogus-suffix");
    const h = makeHarness({ knownModels: new Set(["github-copilot/claude-opus-5"]) });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.setThinkingLevelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("no such model is")));
  });

  it("does not call setThinkingLevel when the tier declares no level and the model carries none", async () => {
    const h = makeHarness({ knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]) });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 1);
    assert.equal(h.setThinkingLevelCalls.length, 0);
  });

  it("does not call setThinkingLevel when an explicit model selection is already in effect", async () => {
    await writeConfiguredTier("reasoning");
    const h = makeHarness({
      scopedModels: [{ provider: "databricks", id: "databricks-claude-sonnet-4-5" }],
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.setThinkingLevelCalls.length, 0);
  });

  it("does not call setThinkingLevel when the target model is not in the registry", async () => {
    await writeConfiguredTier("reasoning");
    const h = makeHarness({ knownModels: new Set() });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.setThinkingLevelCalls.length, 0);
  });

  it("does not call setThinkingLevel when setModel fails for want of a credential", async () => {
    await writeConfiguredTier("reasoning");
    const h = makeHarness({
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
      currentModel: { provider: "github-copilot", id: "claude-opus-5" },
      setModelResult: false,
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 1);
    assert.equal(h.setThinkingLevelCalls.length, 0);
  });

  it("clears the status flag for a public tier", async () => {
    await writeConfiguredTier("strong");
    const h = makeHarness({ knownModels: new Set(["github-copilot/claude-opus-5"]) });
    await h.fireSessionStart();
    assert.deepEqual(h.statusCalls.at(-1), { key: "scope", text: undefined });
  });

  it("does nothing when path-defaults.json does not exist", async () => {
    await rm(pathDefaultsFile, { force: true });
    const h = makeHarness({ knownModels: new Set() });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.statusCalls.length, 0);
  });

  it("does not throw and announces the failure when config/path-defaults.json is malformed", async () => {
    await writeFile(pathDefaultsFile, "{ not json");
    const h = makeHarness({ knownModels: new Set() });
    await assert.doesNotReject(h.fireSessionStart());
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("not applied")));
  });
});

describe("registerCommand(\"path-defaults-status\")", () => {
  let savedArgv: string[];
  beforeEach(async () => {
    savedArgv = process.argv;
    await writeConfiguredTier("confidential");
    process.env.PI_PATH_DEFAULTS_JSON = pathDefaultsFile;
  });
  afterEach(() => {
    process.argv = savedArgv;
    delete process.env.PI_PATH_DEFAULTS_JSON;
  });

  it("reports the configured resolution without mutating the model", async () => {
    const h = makeHarness({ knownModels: new Set() });
    await h.runCommand("path-defaults-status");
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.message.includes("configured default tier")));
  });
});

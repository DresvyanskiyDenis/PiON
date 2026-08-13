import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { register as pathDefaults, declareSessionEgress, egressClassFor, id, resolveForCwd, type Resolution } from "../../extensions/path-defaults/index.ts";

let sandbox: string;
let routingFile: string;
let pathDefaultsFile: string;

const ROUTING = {
  tiers: {
    strong: { model: "github-copilot/claude-opus-5" },
    fast: { model: "github-copilot/gpt-5.1" },
    confidential: { model: "databricks/databricks-claude-sonnet-4-5" },
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

describe("resolveForCwd", () => {
  it("is \"disabled\" when config/path-defaults.json does not exist", () => {
    const res = resolveForCwd("/home/user/anywhere", join(sandbox, "does-not-exist.json"));
    assert.equal(res.kind, "disabled");
  });

  it("is \"config-error\" on malformed JSON, never throws", async () => {
    await writeFile(pathDefaultsFile, "{ not json");
    const res = resolveForCwd("/home/user/anywhere", pathDefaultsFile);
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /not valid JSON/);
  });

  it("is \"unmatched\" when no root (and no wildcard) covers cwd", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [{ path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } }],
      }),
    );
    const res = resolveForCwd("/home/user/Downloads", pathDefaultsFile);
    assert.equal(res.kind, "unmatched");
  });

  it("is \"matched\" and resolves the root's tier through routing.json", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [
          { path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" }, reason: "confidential source" },
          { path: "*", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        ],
      }),
    );
    const res = resolveForCwd("/home/user/work/acme/some-repo", pathDefaultsFile);
    assert.equal(res.kind, "matched");
    if (res.kind === "matched") {
      assert.equal(res.root.tier, "confidential");
      assert.equal(res.target.provider, "databricks");
      assert.equal(res.target.egress, "confidential");
    }
  });

  it("is \"config-error\" when a root names a tier routing.json does not define", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [{ path: "*", tier: "nonexistent-tier", egress: { web: "allow", mcp: "allow", publicModels: "allow" } }],
      }),
    );
    const res = resolveForCwd("/home/user/anywhere", pathDefaultsFile);
    assert.equal(res.kind, "config-error");
    if (res.kind === "config-error") assert.match(res.message, /nonexistent-tier/);
  });

  it("never throws even for a totally garbage path-defaults value", async () => {
    await writeFile(pathDefaultsFile, JSON.stringify({ version: 1, roots: "nope" }));
    assert.doesNotThrow(() => resolveForCwd("/home/user/anywhere", pathDefaultsFile));
    const res = resolveForCwd("/home/user/anywhere", pathDefaultsFile);
    assert.equal(res.kind, "config-error");
  });
});

describe("egressClassFor", () => {
  it("returns the matched root's declarative policy", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [
          { path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } },
          { path: "*", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        ],
      }),
    );
    const policy = egressClassFor("/home/user/work/acme/repo", pathDefaultsFile);
    assert.deepEqual(policy, { sessionEgress: "confidential", web: "deny", mcp: "allow", publicModels: "deny" });
  });

  it("fails open (fully allowed, public) when the file is missing — never a surprise lockout", () => {
    const policy = egressClassFor("/home/user/anywhere", join(sandbox, "does-not-exist.json"));
    assert.deepEqual(policy, { sessionEgress: "public", web: "allow", mcp: "allow", publicModels: "allow" });
  });

  it("fails open when the cwd is unmatched", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [{ path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } }],
      }),
    );
    const policy = egressClassFor("/home/user/Downloads", pathDefaultsFile);
    assert.deepEqual(policy, { sessionEgress: "public", web: "allow", mcp: "allow", publicModels: "allow" });
  });

  it("fails open, never throws, on malformed config", async () => {
    await writeFile(pathDefaultsFile, "{ not json");
    assert.doesNotThrow(() => egressClassFor("/home/user/anywhere", pathDefaultsFile));
    assert.deepEqual(egressClassFor("/home/user/anywhere", pathDefaultsFile), {
      sessionEgress: "public",
      web: "allow",
      mcp: "allow",
      publicModels: "allow",
    });
  });
});

describe("declareSessionEgress", () => {
  it("sets PI_ROUTING_EGRESS from a matched resolution", () => {
    const res: Resolution = {
      kind: "matched",
      root: { path: "*", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } },
      target: { tier: "confidential", model: "databricks/databricks-claude-sonnet-4-5", provider: "databricks", modelId: "databricks-claude-sonnet-4-5", egress: "confidential" },
    };
    declareSessionEgress(res);
    assert.equal(process.env.PI_ROUTING_EGRESS, "confidential");
  });

  it("never clobbers an existing declaration", () => {
    process.env.PI_ROUTING_EGRESS = "public";
    const res: Resolution = {
      kind: "matched",
      root: { path: "*", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } },
      target: { tier: "confidential", model: "databricks/databricks-claude-sonnet-4-5", provider: "databricks", modelId: "databricks-claude-sonnet-4-5", egress: "confidential" },
    };
    declareSessionEgress(res);
    assert.equal(process.env.PI_ROUTING_EGRESS, "public");
  });

  it("is a no-op for disabled/unmatched/config-error resolutions", () => {
    for (const res of [{ kind: "disabled" }, { kind: "unmatched" }, { kind: "config-error", message: "x" }] as Resolution[]) {
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
  cwd: string;
  scopedModels?: unknown[];
  currentModel?: { provider: string; id: string };
  knownModels?: Set<string>; // "provider/id" strings the fake registry can `find`
  setModelResult?: boolean;
}) {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => unknown }> = {};
  const setModelCalls: unknown[] = [];
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const ctx = {
    // A real session_start context always has a UI (TUI or RPC) here — the
    // `-p`/`--mode json` no-UI case is exercised separately by `path-defaults`'s own module tests
    // via `resolveForCwd`/`egressClassFor`, not through this harness. `lib/announce.ts` routes on
    // `ctx.hasUI`, so this fake must declare it or every `ui.notify` assertion below silently sees
    // the stderr fallback instead.
    hasUI: true,
    cwd: opts.cwd,
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
    statusCalls,
    notices,
  };
}

describe("default export — session_start behaviour", () => {
  let savedArgv: string[];
  beforeEach(async () => {
    savedArgv = process.argv;
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [
          { path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" }, reason: "confidential source" },
          { path: "*", tier: "strong", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        ],
      }),
    );
    process.env.PI_PATH_DEFAULTS_JSON = pathDefaultsFile;
  });
  afterEach(() => {
    process.argv = savedArgv;
    delete process.env.PI_PATH_DEFAULTS_JSON;
  });

  it("calls setModel with the resolved model and flags the status bar for a matched enterprise root", async () => {
    const h = makeHarness({
      cwd: "/home/user/work/acme/some-repo",
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 1);
    assert.deepEqual(h.setModelCalls[0], { provider: "databricks", id: "databricks-claude-sonnet-4-5" });
    assert.deepEqual(h.statusCalls.at(-1), { key: "scope", text: "⚑ confidential" });
    assert.ok(h.notices.some((n) => n.level === "info" && n.message.includes("confidential source")));
  });

  it("does not call setModel when scopedModels is already populated", async () => {
    const h = makeHarness({
      cwd: "/home/user/work/acme/some-repo",
      scopedModels: [{ provider: "databricks", id: "databricks-claude-sonnet-4-5" }],
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.message.includes("explicit model")));
  });

  it("does not call setModel when --model was passed on argv", async () => {
    process.argv = ["node", "pi", "--model", "databricks/databricks-claude-sonnet-4-5"];
    const h = makeHarness({
      cwd: "/home/user/work/acme/some-repo",
      knownModels: new Set(["databricks/databricks-claude-sonnet-4-5"]),
    });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
  });

  it("announces an error and does not call setModel when the target model is not configured", async () => {
    const h = makeHarness({ cwd: "/home/user/work/acme/some-repo", knownModels: new Set() });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("no such model is")));
  });

  it("announces an error naming the missing credential when setModel returns false, and does not silently stay switched", async () => {
    const h = makeHarness({
      cwd: "/home/user/work/acme/some-repo",
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

  it("clears the status flag for a public (wildcard) root", async () => {
    const h = makeHarness({
      cwd: "/home/user/Downloads",
      knownModels: new Set(["github-copilot/claude-opus-5"]),
    });
    await h.fireSessionStart();
    assert.deepEqual(h.statusCalls.at(-1), { key: "scope", text: undefined });
  });

  it("does nothing when the root is unmatched and there is no wildcard", async () => {
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [{ path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } }],
      }),
    );
    const h = makeHarness({ cwd: "/home/user/Downloads", knownModels: new Set() });
    await h.fireSessionStart();
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.statusCalls.length, 0);
  });

  it("does not throw and announces the failure when config/path-defaults.json is malformed", async () => {
    await writeFile(pathDefaultsFile, "{ not json");
    const h = makeHarness({ cwd: "/home/user/anywhere", knownModels: new Set() });
    await assert.doesNotReject(h.fireSessionStart());
    assert.ok(h.notices.some((n) => n.level === "error" && n.message.includes("not applied")));
  });
});

describe("registerCommand(\"path-defaults-status\")", () => {
  let savedArgv: string[];
  beforeEach(async () => {
    savedArgv = process.argv;
    await writeFile(
      pathDefaultsFile,
      JSON.stringify({
        version: 1,
        roots: [{ path: "/home/user/work/acme", tier: "confidential", egress: { web: "deny", mcp: "allow", publicModels: "deny" } }],
      }),
    );
    process.env.PI_PATH_DEFAULTS_JSON = pathDefaultsFile;
  });
  afterEach(() => {
    process.argv = savedArgv;
    delete process.env.PI_PATH_DEFAULTS_JSON;
  });

  it("reports the resolution for the current directory without mutating the model", async () => {
    const h = makeHarness({ cwd: "/home/user/work/acme/repo", knownModels: new Set() });
    await h.runCommand("path-defaults-status");
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.notices.some((n) => n.message.includes("matches root")));
  });
});

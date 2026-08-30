/**
 * `DSP-RESOLVE`'s model-resolution record, persisted to `index.db` through `session-index`'s
 * `logEvent` — see the "REQ-CTX-22 / `/index`" comment in `extensions/dispatch/index.ts`.
 *
 * The assertions go through a real database and a real `SELECT` rather than a stubbed logger: the
 * claim being tested is "a later reader of `/index` can answer what this delegation ran on", and a
 * mocked writer cannot show that the row is actually readable back.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { rules, type State } from "../../extensions/dispatch/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { ProviderSemaphoreSet } from "../../extensions/dispatch/semaphore.ts";
import { loadAgentRegistry, type AgentRegistry } from "../../extensions/dispatch/registry.ts";
import {
  resetWorktreePreflight,
  resetWorktreeProvider,
  setWorktreePreflight,
} from "../../extensions/dispatch/isolation.ts";

// These fixtures dispatch from a cwd that is not a repository, so the worktree preflight has to
// be told what it would have found. It is exercised for real in `test/dispatch/isolation.test.ts`.
const FEASIBLE_WORKTREE = () =>
  ({ ok: true, repoRoot: "/repo", commonDir: "/repo/.git", baseCommit: "0".repeat(40) }) as const;
import type { GuardRule } from "../../extensions/lib/guarded-handler.ts";
import { openIndexDb, resetIndexDbCache } from "../../extensions/session-index/db.ts";
import {
  ALL_MODELS,
  CATALOGUE,
  CONFIG,
  CONFIGURED_PROVIDERS,
  GOOD_SCOUT,
  ROUTING,
  scratch,
  writeAgents,
  type AgentFile,
} from "./helpers.ts";

const SURGEON: AgentFile = {
  name: "surgeon",
  frontmatter: "name: surgeon\ndescription: Edits code and therefore needs its own worktree.\nmodel: cheap\nisolation: worktree",
};

function registryOf(): AgentRegistry {
  const dir = writeAgents(join(scratch(), "agents"), [GOOD_SCOUT, SURGEON]);
  return loadAgentRegistry({ dirs: [dir], routing: ROUTING, config: CONFIG, availableModels: ALL_MODELS });
}

function stateOf(): State {
  return {
    catalogue: CATALOGUE,
    settings: {
      dispatch: CONFIG,
      routing: ROUTING,
      configuredProviders: CONFIGURED_PROVIDERS,
      problems: [],
      sources: { dispatch: "<test>/dispatch.json", routing: "<test>/routing.json" },
    },
    registry: registryOf(),
    sessionEgress: "public",
    egressSource: "test",
    depth: 0,
    semaphores: new ProviderSemaphoreSet(ROUTING.concurrency, CONFIG.concurrencyDefault),
    ceilingNotes: [],
    vetoIds: [],
    problems: [],
  };
}

function eventOf(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { toolName, toolCallId: "call-1", input } as unknown as ToolCallEvent;
}

/** Unlike `rules.test.ts`'s `CTX`, this one carries a session id — the event log is keyed on it. */
function ctxWithSession(sessionId: string): ExtensionContext {
  return {
    cwd: "/repo",
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

/** Same short-circuit contract as `guardedHandler`: the first blocking rule wins. */
async function run(
  set: readonly GuardRule[],
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ ruleId: string; reason: string } | undefined> {
  for (const rule of set) {
    const verdict = await rule.evaluate(event, ctx);
    if (verdict?.block) return { ruleId: rule.id, reason: verdict.reason };
  }
  return undefined;
}

interface LoggedEvent {
  readonly kind: string;
  readonly name: string;
  readonly ok: number;
  readonly payload: string | null;
}

let sandbox: string;
let prevIndexDb: string | undefined;

/** Points `logEvent` at a database of this test's own, and returns its path for the read back. */
async function useOwnIndexDb(prefix: string): Promise<string> {
  const dbPath = join(await mkdtemp(join(sandbox, prefix)), "index.db");
  process.env.PI_INDEX_DB = dbPath;
  resetIndexDbCache();
  return dbPath;
}

function dispatchEventsFor(dbPath: string, sessionId: string): LoggedEvent[] {
  const db = openIndexDb(dbPath);
  return db
    .prepare("SELECT kind, name, ok, payload FROM events WHERE session_id = ? AND kind = 'dispatch' ORDER BY id")
    .all(sessionId) as unknown as LoggedEvent[];
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "dispatch-logging-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  prevIndexDb = process.env.PI_INDEX_DB;
  resetSurfaced();
  resetWorktreeProvider();
});
afterEach(() => {
  if (prevIndexDb === undefined) delete process.env.PI_INDEX_DB;
  else process.env.PI_INDEX_DB = prevIndexDb;
  resetIndexDbCache();
});

describe("DSP-RESOLVE: persisting the model-resolution record", () => {
  it("records the model a rewritten call resolved to, and the tier it came from", async () => {
    const dbPath = await useOwnIndexDb("agent-");

    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input), ctxWithSession("s-agent")), undefined);
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low", "the call was rewritten");

    const rows = dispatchEventsFor(dbPath, "s-agent");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[0].name, "dispatch.resolve:scout", "the <domain>.<action>:<subject> shape teammates uses");
    const payload = JSON.parse(rows[0].payload!);
    assert.equal(payload.tool, "subagent");
    assert.equal(payload.agent, "scout");
    assert.equal(payload.provider, "databricks");
    assert.equal(payload.model.from, "cheap", "the agent file's own frontmatter spec");
    assert.equal(payload.model.to, "databricks/databricks-claude-haiku-4-5:low");
    assert.equal(payload.model.tier, "cheap");
    assert.equal(payload.model.defaultedScope, undefined, "nothing was defaulted here");
  });

  it("records a resolution even when the caller already named the model, so nothing was rewritten", async () => {
    const dbPath = await useOwnIndexDb("call-");

    // Exactly what the `cheap` tier resolves to, suffix included: the rule finds `input.model`
    // already equal to the target and writes nothing onto the call. The resolution still happened.
    const named = "databricks/databricks-claude-haiku-4-5:low";
    const input: Record<string, unknown> = { agent: "scout", prompt: "x", model: named };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input), ctxWithSession("s-call")), undefined);
    assert.equal(input.model, named, "no rewrite — keying the row off a rewrite would lose this dispatch");

    const rows = dispatchEventsFor(dbPath, "s-call");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "dispatch.resolve:scout");
    const payload = JSON.parse(rows[0].payload!);
    assert.equal(payload.model.from, named, "the `model` argument of this call");
    assert.equal(payload.model.to, named);
    assert.equal(payload.model.tier, undefined, "a provider-qualified id belongs to no tier");
    assert.equal(payload.provider, "databricks", "the provider is still the first segment of the id");
  });

  it("carries the concurrency and the isolation it applied, when it applied any", async () => {
    const dbPath = await useOwnIndexDb("applied-");

    setWorktreePreflight(FEASIBLE_WORKTREE);
    const input: Record<string, unknown> = { agent: "surgeon", prompt: "x", tasks: [1, 2, 3, 4, 5, 6, 7], concurrency: 7 };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input), ctxWithSession("s-applied")), undefined);
    resetWorktreePreflight();
    assert.equal(input.concurrency, 4, "databricks is capped at 4 in the routing fixture");
    assert.equal(input.worktree, true);

    const rows = dispatchEventsFor(dbPath, "s-applied");
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0].payload!);
    assert.equal(payload.concurrency.changed, true);
    assert.equal(payload.concurrency.requested, 7);
    assert.equal(payload.concurrency.applied, 4);
    assert.equal(payload.isolation.kind, "package");
  });

  it("writes no row for a call an earlier rule refused", async () => {
    const dbPath = await useOwnIndexDb("refused-");

    const input: Record<string, unknown> = { prompt: "x", model: "tier:galaxy" };
    const blocked = await run(rules(stateOf()), eventOf("subagent", input), ctxWithSession("s-refused"));
    assert.equal(blocked?.ruleId, "DSP-RESOLVE");

    // Deliberate: the refusal is already in the guarded handler's audit entry, and a `dispatch`
    // that never resolved a model has nothing to report about what it ran on.
    assert.deepEqual(dispatchEventsFor(dbPath, "s-refused"), []);
  });

  it("leaves the verdict and the model untouched when the event log cannot be written", async () => {
    // An unwritable path: `openIndexDb()` fails at `mkdirSync`, and `logEvent` swallows it.
    process.env.PI_INDEX_DB = join("/", "definitely", "not", "a", "writable", "path", "index.db");
    resetIndexDbCache();

    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    const verdict = await run(rules(stateOf()), eventOf("subagent", input), ctxWithSession("s-broken-log"));
    assert.equal(verdict, undefined, "a broken event log does not block the dispatch");
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low", "the resolution itself is unaffected");
  });

  it("survives a context that cannot produce a session id at all", async () => {
    const dbPath = await useOwnIndexDb("no-session-");

    // `rules.test.ts`'s plain `{ cwd }` context: reading `sessionManager` throws, and the row is
    // written under the empty session id rather than the dispatch failing.
    const ctx = { cwd: "/repo" } as unknown as ExtensionContext;
    const input: Record<string, unknown> = { agent: "scout", prompt: "x" };
    assert.equal(await run(rules(stateOf()), eventOf("subagent", input), ctx), undefined);
    assert.equal(input.model, "databricks/databricks-claude-haiku-4-5:low");

    const rows = dispatchEventsFor(dbPath, "");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "dispatch.resolve:scout");
  });
});

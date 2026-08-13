// EXT-09 — extensions/quota/index.ts's wiring: session_start/turn_end refresh, the input
// pre-flight, the /quota command, and the guarded-vs-fail-loud split between lifecycle hooks and
// the user-initiated command.
//
// No PI runtime is loaded (no test may hit ~/.pi/agent). `register(pi)` is
// exercised against a minimal fake ExtensionAPI/ExtensionContext that records what was called,
// and the real HTTP endpoint is replaced by PI_QUOTA_USAGE_URL pointing at a local node:http
// server — the only injection point index.ts exposes for it (see its own comment on that line).
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { register } from "../../extensions/quota/index.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();
  return {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { description?: string; handler: CommandHandler }) {
      commands.set(name, options);
    },
    handlers,
    commands,
  } as const;
}

function fakeCtx(provider?: string) {
  const statuses = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    model: provider ? { provider } : undefined,
    statuses,
    notifications,
  };
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function jsonServer(status: number, body: unknown, hits?: { count: number }): Promise<string> {
  const server = createServer((_req, res) => {
    if (hits) hits.count += 1;
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/copilot_internal/user`;
}

let sandboxCounter = 0;
async function sandbox(): Promise<string> {
  sandboxCounter += 1;
  const dir = await mkdtemp(join(tmpdir(), `pi-quota-index-${sandboxCounter}-`));
  return dir;
}

/** Runs `fn` with the given env vars set, restoring the previous values afterwards — same
 *  save/restore pattern as test/ext-13-local-catalogue.test.ts's PI_LOCAL_BASE_URL tests. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeQuotaConfig(dir: string, tokenFile: string, extra: Record<string, unknown> = {}): Promise<string> {
  const path = join(dir, "quota.json");
  await writeFile(
    path,
    JSON.stringify({ quota: { enabled: true, ttlMs: 60000, timeoutMs: 2000, tokenFile, preflight: { enabled: true, thresholdPct: 15 }, ...extra } }),
  );
  return path;
}

async function writeToken(dir: string, body: unknown, mode = 0o600): Promise<string> {
  const path = join(dir, "copilot-quota-token.json");
  await writeFile(path, JSON.stringify(body));
  await chmod(path, mode);
  return path;
}

describe("EXT-09 register() wiring", () => {
  it("session_start refreshes the footer to a metered percentage", async () => {
    resetSurfaced();
    const dir = await sandbox();
    const tokenPath = await writeToken(dir, { token: "ghp_x" });
    const cfgPath = await writeQuotaConfig(dir, tokenPath);
    const url = await jsonServer(200, {
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 84 } },
    });

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: url }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx();
      await pi.handlers.get("session_start")?.({ type: "session_start" }, ctx);
      assert.equal(ctx.statuses.get("quota"), "quota 84%");
    });
  });

  it("the input pre-flight warns when the remaining percentage is at or below the threshold", async () => {
    resetSurfaced();
    const dir = await sandbox();
    const tokenPath = await writeToken(dir, { token: "ghp_x" });
    const cfgPath = await writeQuotaConfig(dir, tokenPath);
    const url = await jsonServer(200, {
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 8 } },
    });

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: url }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx("github-copilot");
      const result = await pi.handlers.get("input")?.({ type: "input", text: "hi", source: "interactive" }, ctx);
      assert.deepEqual(result, { action: "continue" });
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0]?.type, "warning");
      assert.match(ctx.notifications[0]?.message ?? "", /8% remaining/);
    });
  });

  it("the input pre-flight never fires for a provider other than github-copilot, and never fetches", async () => {
    resetSurfaced();
    const dir = await sandbox();
    const tokenPath = await writeToken(dir, { token: "ghp_x" });
    const cfgPath = await writeQuotaConfig(dir, tokenPath);
    const hits = { count: 0 };
    const url = await jsonServer(200, { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 8 } } }, hits);

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: url }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx("anthropic");
      await pi.handlers.get("input")?.({ type: "input", text: "hi", source: "interactive" }, ctx);
      assert.equal(ctx.notifications.length, 0);
      assert.equal(hits.count, 0);
    });
  });

  it("an unlimited snapshot never triggers the pre-flight warning — nothing to threshold against", async () => {
    resetSurfaced();
    const dir = await sandbox();
    const tokenPath = await writeToken(dir, { token: "ghp_x" });
    const cfgPath = await writeQuotaConfig(dir, tokenPath);
    const url = await jsonServer(200, { quota_snapshots: { premium_interactions: { unlimited: true, token_based_billing: true } } });

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: url }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx("github-copilot");
      await pi.handlers.get("input")?.({ type: "input", text: "hi", source: "interactive" }, ctx);
      assert.equal(ctx.notifications.length, 0);
    });
  });

  it("/quota with no token file configured", async () => {
    const dir = await sandbox();
    const cfgPath = await writeQuotaConfig(dir, join(dir, "does-not-exist.json"));

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: undefined }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx();
      await pi.commands.get("quota")?.handler("", ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0]?.message ?? "", /no quota token configured/);
    });
  });

  it("/quota with an insecure token file reports why, not a generic message", async () => {
    resetSurfaced();
    const dir = await sandbox();
    const tokenPath = await writeToken(dir, { token: "ghp_x" }, 0o644);
    const cfgPath = await writeQuotaConfig(dir, tokenPath);

    await withEnv({ PI_QUOTA_CONFIG: cfgPath }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx();
      await pi.commands.get("quota")?.handler("", ctx);
      const messages = ctx.notifications.map((n) => n.message);
      assert.ok(messages.some((m) => /quota unavailable — token unusable/.test(m)));
    });
  });

  it("/quota on the recorded unlimited tenant shape names the regime honestly", async () => {
    resetSurfaced();
    const dir = await sandbox();
    const tokenPath = await writeToken(dir, { token: "ghp_x" });
    const cfgPath = await writeQuotaConfig(dir, tokenPath);
    const url = await jsonServer(200, {
      copilot_plan: "business",
      quota_snapshots: { premium_interactions: { unlimited: true, token_based_billing: true } },
    });

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: url }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx();
      await pi.commands.get("quota")?.handler("", ctx);
      const message = ctx.notifications[0]?.message ?? "";
      assert.match(message, /ai_credits/);
      assert.match(message, /unlimited, token-based billing/);
      assert.doesNotMatch(message, /0%|100%/);
    });
  });

  it("a malformed config/quota.json is guarded on session_start and the input pre-flight, but fails loud on /quota", async () => {
    const dir = await sandbox();
    const cfgPath = join(dir, "quota.json");
    await writeFile(cfgPath, "{not json");

    await withEnv({ PI_QUOTA_CONFIG: cfgPath, PI_QUOTA_USAGE_URL: undefined }, async () => {
      const pi = fakePi();
      register(pi as never);
      const ctx = fakeCtx("github-copilot");

      // Guarded: neither of these rejects, even though the config load throws internally.
      await assert.doesNotReject(pi.handlers.get("session_start")?.({ type: "session_start" }, ctx) as Promise<void>);
      const inputResult = await pi.handlers.get("input")?.({ type: "input", text: "hi", source: "interactive" }, ctx);
      assert.deepEqual(inputResult, { action: "continue" });

      // Fail loud: the explicit user command is not guarded and must surface the real error.
      await assert.rejects(pi.commands.get("quota")?.handler("", ctx) as Promise<void>);
    });
  });
});

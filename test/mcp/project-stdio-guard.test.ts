// F1 layer 2 — `guardProjectStdioSpawn` in the vendored `pi-packages/pi-mcp-adapter/server-manager.ts`.
//
// Layer 1 (the approval ledger) decides whether a project's MCP config is read at all. Layer 2
// assumes layer 1 said yes and still refuses to hand a repo-authored child process the parent
// environment: `resolveEnv` copies the whole of `process.env`, and a configured harness resolves
// provider tokens into it. `config/bin/mcp-stdio-guard` (`env -i` + an explicit allowlist) already
// existed and was reviewed; what changed is that a PROJECT-sourced stdio server can no longer
// decline it.
//
// The global config the project half is contrasted against is SYNTHETIC (test/mcp/sandbox.ts) —
// this repository ships no MCP servers, and "global servers keep their environment" needs a global
// server to be a statement about anything.
//
// Read-only outside the scratch dirs it creates and removes.
import { useSandboxHome, SYNTHETIC_MCP_CONFIG } from "./sandbox.ts";

useSandboxHome();

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { accessSync, constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER_CONFIG = join(REPO_ROOT, "pi-packages", "pi-mcp-adapter", "config.ts");
const ADAPTER_STDIO_GUARD = join(REPO_ROOT, "pi-packages", "pi-mcp-adapter", "stdio-guard.ts");
const REAL_GUARD = join(REPO_ROOT, "config", "bin", "mcp-stdio-guard");

type StdioGuardModule = typeof import("../../pi-packages/pi-mcp-adapter/stdio-guard.ts");
type ConfigModule = typeof import("../../pi-packages/pi-mcp-adapter/config.ts");
let guardProjectStdioSpawn: StdioGuardModule["guardProjectStdioSpawn"];
let setProjectConfigTrustGate: ConfigModule["setProjectConfigTrustGate"];

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalGuard = process.env.PI_MCP_STDIO_GUARD;

const PROJECT_SERVER = "project-stdio";
const GLOBAL_SERVER = "browser-stdio";

describe("F1 layer 2 — project-sourced stdio servers are wrapped unconditionally", () => {
  let agentDir = "";
  let projectDir = "";

  before(async () => {
    ({ guardProjectStdioSpawn } = await import(ADAPTER_STDIO_GUARD));
    ({ setProjectConfigTrustGate } = await import(ADAPTER_CONFIG));
  });

  after(() => {
    setProjectConfigTrustGate(undefined);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalGuard === undefined) delete process.env.PI_MCP_STDIO_GUARD;
    else process.env.PI_MCP_STDIO_GUARD = originalGuard;
  });

  afterEach(async () => {
    setProjectConfigTrustGate(undefined);
    if (originalGuard === undefined) delete process.env.PI_MCP_STDIO_GUARD;
    else process.env.PI_MCP_STDIO_GUARD = originalGuard;
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    agentDir = "";
    projectDir = "";
  });

  /**
   * An APPROVED project (layer 1 said yes) that defines a stdio server, plus a synthetic global
   * config so the global/project distinction is a real one and not an empty set.
   */
  async function seedApprovedProject(): Promise<void> {
    agentDir = await mkdtemp(join(tmpdir(), "pi-layer2-agent-"));
    projectDir = await mkdtemp(join(tmpdir(), "pi-layer2-proj-"));
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify(SYNTHETIC_MCP_CONFIG, null, 2), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(projectDir, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { [PROJECT_SERVER]: { command: "npx", args: ["-y", "evil"] } } }),
      "utf8",
    );
    setProjectConfigTrustGate(() => true);
  }

  it("wraps a project-sourced server that never asked to be wrapped", async () => {
    await seedApprovedProject();
    const spawn = guardProjectStdioSpawn(PROJECT_SERVER, "npx", ["-y", "evil"], { A: "1" }, projectDir);
    assert.equal(spawn.wrapped, true);
    assert.equal(spawn.command, REAL_GUARD, "the derived wrapper path must be the repo's own");
    assert.deepEqual([...spawn.args], ["npx", "-y", "evil"], "the real command becomes argv[1]");
    assert.deepEqual(spawn.env, { A: "1" });
  });

  it("leaves a global/user-level server exactly as configured", async () => {
    // The operator's own servers legitimately need inherited environment; the global mcp.json opts
    // the ones that do not into the wrapper explicitly. Forcing it here would break them silently.
    await seedApprovedProject();
    const spawn = guardProjectStdioSpawn(GLOBAL_SERVER, "npx", ["-y", "some-server"], { A: "1" }, projectDir);
    assert.equal(spawn.wrapped, false);
    assert.equal(spawn.command, "npx");
    assert.deepEqual([...spawn.args], ["-y", "some-server"]);
  });

  it("leaves a server nobody defined alone — no config, no wrapping, no throw", async () => {
    await seedApprovedProject();
    assert.equal(guardProjectStdioSpawn("not-in-any-config", "npx", [], {}, projectDir).wrapped, false);
  });

  it("THROWS when the wrapper is missing — an unwrapped spawn is never the fallback", async () => {
    await seedApprovedProject();
    process.env.PI_MCP_STDIO_GUARD = join(tmpdir(), "pi-layer2-no-such-guard");
    assert.throws(
      () => guardProjectStdioSpawn(PROJECT_SERVER, "npx", [], {}, projectDir),
      /must be spawned through the env-minimising wrapper/,
    );
    // ...and the same missing wrapper must not take out the operator's own servers.
    assert.equal(guardProjectStdioSpawn(GLOBAL_SERVER, "npx", [], {}, projectDir).wrapped, false);
  });

  it("strips MCP_STDIO_EXTRA_ENV: a project may not widen the wrapper's allowlist", async () => {
    // Without this, `"env": {"MCP_STDIO_EXTRA_ENV": "PROVIDER_API_TOKEN GITHUB_TOKEN"}` walks the
    // credentials straight back through the wrapper that exists to strip them.
    await seedApprovedProject();
    const spawn = guardProjectStdioSpawn(
      PROJECT_SERVER,
      "npx",
      [],
      { MCP_STDIO_EXTRA_ENV: "PROVIDER_API_TOKEN GITHUB_TOKEN", KEEP: "yes" },
      projectDir,
    );
    assert.deepEqual(spawn.env, { KEEP: "yes" });
  });

  it("keeps MCP_STDIO_EXTRA_ENV for a global server — the operator owns that allowlist", async () => {
    await seedApprovedProject();
    const spawn = guardProjectStdioSpawn(
      GLOBAL_SERVER,
      REAL_GUARD,
      ["npx"],
      { MCP_STDIO_EXTRA_ENV: "EXAMPLE_BROWSERS_PATH" },
      projectDir,
    );
    assert.deepEqual(spawn.env, { MCP_STDIO_EXTRA_ENV: "EXAMPLE_BROWSERS_PATH" });
  });

  it("does not double-wrap a project server that already points at the guard", async () => {
    // Two hops would work but would eat MCP_STDIO_EXTRA_ENV between them, which reads as a broken
    // server rather than as a denial.
    await seedApprovedProject();
    const spawn = guardProjectStdioSpawn(PROJECT_SERVER, REAL_GUARD, ["npx"], {}, projectDir);
    assert.equal(spawn.wrapped, true);
    assert.equal(spawn.command, REAL_GUARD);
    assert.deepEqual([...spawn.args], ["npx"], "argv must not gain a second wrapper");
  });

  it("a project whose config layer 1 refused defines no project-scoped names at all", async () => {
    // Belt and braces: with the gate closed the server never reaches the manager, so there is
    // nothing to wrap. The two layers are independent, and this pins that they compose.
    await seedApprovedProject();
    setProjectConfigTrustGate(() => false);
    assert.equal(guardProjectStdioSpawn(PROJECT_SERVER, "npx", [], {}, projectDir).wrapped, false);
  });
});

describe("F1 layer 2 — the wrapper it depends on", () => {
  it("exists at the path derived from the vendored module and is executable", () => {
    assert.ok(existsSync(REAL_GUARD), `${REAL_GUARD} must exist`);
    accessSync(REAL_GUARD, constants.X_OK);
  });

  it("still uses env -i plus an explicit allowlist — the property the patch relies on", async () => {
    const body = await readFile(REAL_GUARD, "utf8");
    assert.match(body, /env -i/, "the wrapper must start the child from an EMPTY environment");
    assert.match(body, /BASELINE_VARS/);
    assert.match(body, /\bexec\b/, "exec keeps the PID so the SDK's SIGTERM escalation still works");
  });
});

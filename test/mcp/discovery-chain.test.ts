// EXT-14a: proves the claim behind the pi-mcp-adapter review — "the ordinary discovery chain
// (project .mcp.json and ~/.config/mcp/mcp.json) is the surface
// our default-deny posture must own" — against the REAL adapter's own source enumeration
// (pi-packages/pi-mcp-adapter/config.ts's getMcpDiscoverySummary), not an assumption.
//
// The pi-global file under test is SYNTHETIC (test/mcp/sandbox.ts). This repository ships
// `config/mcp.default.json` = `{"mcpServers": {}}`, which cannot demonstrate that a pi-owned source is
// enumerated with a server count at all; the mechanism is what EXT-14a claims, so the mechanism is what
// is fed. `$HOME` is a temp directory too, so `shared-global` is a path inside the sandbox and this file
// no longer reads whatever MCP clients happen to be installed on the machine running the suite.
//
// Nothing is written outside the scratch dirs this test creates and removes itself.
import { useSandboxHome, SYNTHETIC_MCP_CONFIG, SYNTHETIC_SERVERS } from "./sandbox.ts";

const SANDBOX_HOME = useSandboxHome();

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER_CONFIG = join(REPO_ROOT, "pi-packages", "pi-mcp-adapter", "config.ts");

type ConfigModule = typeof import("../../pi-packages/pi-mcp-adapter/config.ts");
let getMcpDiscoverySummary: ConfigModule["getMcpDiscoverySummary"];
let setProjectConfigTrustGate: ConfigModule["setProjectConfigTrustGate"];

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

describe("EXT-14a discovery chain: hostConfigDiscovery does not gate shared-global/shared-project", () => {
  before(async () => {
    ({ getMcpDiscoverySummary, setProjectConfigTrustGate } = await import(ADAPTER_CONFIG));
    // EXT-30 hand-off T4 made the PROJECT half of the chain trust-gated (default-deny). The claim
    // under test here is about `hostConfigDiscovery`, which is a different mechanism, so trust is
    // pinned open and the gate itself is proven in test/mcp/project-trust-gate.test.ts.
    setProjectConfigTrustGate(() => true);
  });

  after(() => {
    setProjectConfigTrustGate(undefined);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  let agentDir = "";
  let projectDir = "";

  afterEach(async () => {
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    agentDir = "";
    projectDir = "";
  });

  async function seed(): Promise<void> {
    agentDir = await mkdtemp(join(tmpdir(), "pi-ext14a-disc-agent-"));
    projectDir = await mkdtemp(join(tmpdir(), "pi-ext14a-disc-proj-"));
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify(SYNTHETIC_MCP_CONFIG, null, 2), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }

  it("the sandbox really is the home directory the adapter enumerates against", () => {
    // Guards the guard: `useSandboxHome()` has to run before the adapter is imported, and if that
    // ordering ever breaks, every assertion below would quietly go back to reading the developer's
    // real ~/.config/mcp/mcp.json and passing for the wrong reason.
    assert.equal(homedir(), SANDBOX_HOME);
  });

  it("enumerates shared-global (~/.config/mcp/mcp.json) as kind=shared, scope=global", async () => {
    await seed();
    const summary = getMcpDiscoverySummary(undefined, projectDir);
    const sharedGlobal = summary.sources.find((s) => s.id === "shared-global");
    assert.ok(sharedGlobal, "expected a shared-global source in the discovery chain");
    assert.equal(sharedGlobal!.path, join(SANDBOX_HOME, ".config", "mcp", "mcp.json"));
    assert.equal(sharedGlobal!.kind, "shared");
    assert.equal(sharedGlobal!.scope, "global");
  });

  it("enumerates shared-project (.mcp.json) as kind=shared, scope=project, at the project cwd", async () => {
    await seed();
    const summary = getMcpDiscoverySummary(undefined, projectDir);
    const sharedProject = summary.sources.find((s) => s.id === "shared-project");
    assert.ok(sharedProject, "expected a shared-project source in the discovery chain");
    assert.equal(sharedProject!.path, join(projectDir, ".mcp.json"));
    assert.equal(sharedProject!.kind, "shared");
    assert.equal(sharedProject!.scope, "project");
  });

  it("a seeded pi-global source reports kind=pi and counts every server it defines", async () => {
    await seed();
    const summary = getMcpDiscoverySummary(undefined, projectDir);
    const piGlobal = summary.sources.find((s) => s.id === "pi-global");
    assert.ok(piGlobal, "expected the pi-global source");
    assert.equal(piGlobal!.kind, "pi");
    assert.equal(
      piGlobal!.serverCount,
      SYNTHETIC_SERVERS.length,
      "the pi-owned source must count the servers its file defines, remote and stdio alike",
    );
    assert.equal(summary.hasPiOwnedServers, true);
  });

  it("hostConfigDiscovery:'off' gates IMPORT_PATHS host configs ONLY — shared-global/shared-project stay in the discovery chain regardless (trust permitting)", async () => {
    await seed();
    const summary = getMcpDiscoverySummary(undefined, projectDir);

    assert.equal(summary.hostConfigDiscovery, "off", "the pi-global file's settings.hostConfigDiscovery must be honoured");
    // Every foreign-host import candidate (Cursor, Claude Code, Claude Desktop, ...) that IS discovered on
    // this machine must be reported inactive — that is what "off" governs.
    for (const hostConfig of summary.hostConfigs) {
      assert.equal(hostConfig.active, false, `${hostConfig.kind} host config must be inactive under hostConfigDiscovery:'off'`);
    }
    // But the ordinary shared-config sources are unaffected by hostConfigDiscovery — they are a different
    // mechanism (getConfigSources()) from IMPORT_PATHS (gated by hostConfigDiscovery). Since the EXT-30
    // hand-off the project half is additionally gated on trust, which is why `before` pins it open.
    // This is the fact that makes "own the ordinary discovery chain" a real, separate obligation from
    // "foreign-host import defaults to off" (already covered by test/mcp/default-deny.test.ts's A2).
    const sourceIds = summary.sources.map((s) => s.id);
    assert.ok(sourceIds.includes("shared-global"), "shared-global must still be enumerated with hostConfigDiscovery off");
    assert.ok(sourceIds.includes("shared-project"), "shared-project must still be enumerated with hostConfigDiscovery off");
  });

  it("(documented residual gap, same class as default-deny A4) a shared-global file is read and merged for any server name the pi-owned file does not define", async () => {
    await seed();
    // Written into the sandbox home, not the real one. The point is that a pi-global file cannot
    // pre-empt a server name it has never heard of — exactly as A4 documents for a project .mcp.json.
    // Previously this was observational ("if this machine happens to have one"), which asserted nothing
    // on a clean machine; with a sandbox home the gap can simply be demonstrated.
    const sharedDir = join(SANDBOX_HOME, ".config", "mcp");
    await mkdir(sharedDir, { recursive: true });
    await writeFile(
      join(sharedDir, "mcp.json"),
      JSON.stringify({ mcpServers: { "foreign-remote": { url: "https://foreign.example.invalid/mcp" } } }, null, 2),
      "utf8",
    );

    const summary = getMcpDiscoverySummary(undefined, projectDir);
    const sharedGlobal = summary.sources.find((s) => s.id === "shared-global")!;
    assert.equal(sharedGlobal.serverCount, 1, "the shared-global file is read, and its server counts");
    await rm(join(sharedDir, "mcp.json"), { force: true });
  });
});

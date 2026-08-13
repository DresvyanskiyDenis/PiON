// EXT-14a: proves "${VAR} expansion, per-server env and NODE_EXTRA_CA_CERTS all need to work" against
// the REAL vendored pi-mcp-adapter code and against the tracked config/mcp.example.json — no mocking.
//
// Two sub-suites:
//  1. "${VAR} expansion" drives pi-packages/pi-mcp-adapter/utils.ts directly. It also documents a genuine
//     finding: URL interpolation (resolveServerUrl) fails loud on a missing var; header/env interpolation
//     (interpolateEnvRecord) does not — a missing var silently becomes "". A residual gap: patching
//     vendored, security-reviewed source is out of scope here.
//  2. "NODE_EXTRA_CA_CERTS" proves the mechanism our remote/HTTP transport depends on: for a server
//     connected in-process (no spawn, unlike EXT-14b's stdio servers), Node's TLS stack reads
//     NODE_EXTRA_CA_CERTS once at process start. Proven with a local self-signed HTTPS server and two
//     fresh child `node` processes (with/without the var) — never touches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER_UTILS = join(REPO_ROOT, "pi-packages", "pi-mcp-adapter", "utils.ts");
// The tracked template. `config/mcp.json` is installer-generated and git-ignored, and
// `config/mcp.default.json` defines no servers at all, so the example is the only shipped file that
// carries a `${VAR}` header to round-trip.
const MCP_EXAMPLE = join(REPO_ROOT, "config", "mcp.example.json");

type UtilsModule = typeof import("../../pi-packages/pi-mcp-adapter/utils.ts");
let resolveServerUrl: UtilsModule["resolveServerUrl"];
let interpolateEnvRecord: UtilsModule["interpolateEnvRecord"];

describe("EXT-14a ${VAR} expansion (real pi-mcp-adapter/utils.ts)", () => {
  before(async () => {
    ({ resolveServerUrl, interpolateEnvRecord } = await import(ADAPTER_UTILS));
  });

  const ORIGINAL = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL)) delete process.env[key];
    for (const [key, value] of Object.entries(ORIGINAL)) process.env[key] = value;
  });

  it("resolveServerUrl expands a set ${VAR}", () => {
    process.env.PI_EXT14A_TEST_HOST = "mcp.example.internal";
    const resolved = resolveServerUrl({ url: "https://${PI_EXT14A_TEST_HOST}/mcp" });
    assert.equal(resolved, "https://mcp.example.internal/mcp");
  });

  it("resolveServerUrl fails loud (throws, names the var) when a URL-embedded var is unset — REQ-PRV-32", () => {
    delete process.env.PI_EXT14A_MISSING_VAR;
    assert.throws(
      () => resolveServerUrl({ url: "https://${PI_EXT14A_MISSING_VAR}/mcp" }),
      /Missing environment variable.*PI_EXT14A_MISSING_VAR/,
    );
  });

  it("interpolateEnvRecord expands a set ${VAR} in a header value", () => {
    process.env.PI_EXT14A_TEST_KEY = "secret-value-123";
    const headers = interpolateEnvRecord({ CONTEXT7_API_KEY: "${PI_EXT14A_TEST_KEY}" });
    assert.equal(headers?.CONTEXT7_API_KEY, "secret-value-123");
  });

  it("(documented residual gap) interpolateEnvRecord does NOT fail loud on a missing header var — it silently becomes an empty string", () => {
    delete process.env.PI_EXT14A_MISSING_HEADER_VAR;
    const headers = interpolateEnvRecord({ "X-Test": "${PI_EXT14A_MISSING_HEADER_VAR}" });
    // This is the vendored adapter's real, current behaviour (utils.ts interpolateEnvVars: `?? ""`), unlike
    // resolveServerUrl's explicit getMissingEnvVars() guard. It is weaker than REQ-PRV-32's fail-loud bar,
    // but out of scope to patch here (vendored + security-reviewed at an exact sha256). Asserted here
    // so a future adapter bump that changes this behaviour is caught, not assumed.
    assert.equal(headers?.["X-Test"], "");
  });

  it("every ${VAR} header in the shipped config/mcp.example.json round-trips through the real interpolator", async () => {
    // Used to pin one shipped server by name. This repository ships no MCP servers any more, so the
    // subject is the template a user copies from: whatever header placeholders it offers must be
    // spelled the way the interpolator actually reads them, or the copied entry sends an empty
    // credential and the server answers 401 with nothing to go on.
    const example = JSON.parse(await readFile(MCP_EXAMPLE, "utf8"));
    const templates = Object.entries(example.mcpServers as Record<string, { headers?: Record<string, string> }>)
      .filter(([, server]) => server.headers)
      .map(([name, server]) => [name, server.headers!] as const);
    assert.ok(templates.length > 0, "config/mcp.example.json must keep an example that sets a header");

    for (const [name, headers] of templates) {
      for (const [header, value] of Object.entries(headers)) {
        const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
        assert.ok(match, `${name}.headers.${header} = ${JSON.stringify(value)} is not a \${VAR} placeholder`);
        process.env[match![1]] = `test-value-for-${match![1]}`;
        const resolved = interpolateEnvRecord(headers);
        assert.equal(resolved?.[header], `test-value-for-${match![1]}`);
      }
    }
  });
});

describe("EXT-14a NODE_EXTRA_CA_CERTS reaches an in-process (remote/HTTP) TLS connection", () => {
  let scratchDir: string;
  let certPath: string;
  let keyPath: string;

  before(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "pi-ext14a-ca-"));
    certPath = join(scratchDir, "cert.pem");
    keyPath = join(scratchDir, "key.pem");
    // Self-signed cert, generated locally — no network. -addext SAN so Node's fetch (which checks SAN, not
    // just CN) accepts it once the CA is trusted.
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "pipe" });
  });

  after(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  // The server AND the fetch both run inside ONE spawned child process (self-connect over loopback), rather
  // than a server in this test process with a separate child fetching it. This sandbox's process isolation
  // blocks a grandchild's outbound loopback connection back to an ancestor's listening socket even when the
  // TLS trust is otherwise correct (verified empirically while writing this test) — a property of the test
  // *environment*, not of Node, the adapter, or NODE_EXTRA_CA_CERTS. A single self-contained child is exactly
  // what happens in production too: `pi` is one process that both reads NODE_EXTRA_CA_CERTS at start and
  // makes the outbound MCP connection itself for the remote/HTTP transport (no spawn on that path at all).
  function runSelfConnectChild(nodeExtraCaCerts: string | undefined): { code: number; stdout: string; stderr: string } {
    const script = `
      const https = require("node:https");
      const fs = require("node:fs");
      const server = https.createServer(
        { key: fs.readFileSync(${JSON.stringify(keyPath)}), cert: fs.readFileSync(${JSON.stringify(certPath)}) },
        (_req, res) => res.end("ok"),
      );
      server.listen(0, "127.0.0.1", async () => {
        const port = server.address().port;
        try {
          const r = await fetch("https://127.0.0.1:" + port + "/");
          process.stdout.write(await r.text());
          server.close(() => process.exit(0));
        } catch (err) {
          process.stderr.write(String(err && err.cause ? err.cause : err));
          server.close(() => process.exit(1));
        }
      });
    `;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (nodeExtraCaCerts === undefined) delete env.NODE_EXTRA_CA_CERTS;
    else env.NODE_EXTRA_CA_CERTS = nodeExtraCaCerts;
    try {
      const stdout = execFileSync(process.execPath, ["-e", script], { stdio: "pipe", env });
      return { code: 0, stdout: stdout.toString(), stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
  }

  it("REJECTS the self-signed cert when NODE_EXTRA_CA_CERTS is unset (sanity: our cert is genuinely untrusted by default)", () => {
    const result = runSelfConnectChild(undefined);
    assert.notEqual(result.code, 0, `expected failure; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /self.signed certificate/i);
  });

  it("SUCCEEDS once NODE_EXTRA_CA_CERTS points at our CA — proving the mechanism our remote/HTTP transport relies on: set once on the process before it starts, no per-request or per-server wiring needed", () => {
    const result = runSelfConnectChild(certPath);
    assert.equal(result.code, 0, `expected success; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stdout, "ok");
  });
});

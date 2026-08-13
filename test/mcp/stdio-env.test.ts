// EXT-14b: MCP — stdio child servers.
//
// pi-mcp-adapter's resolveEnv() (pi-packages/pi-mcp-adapter/server-manager.ts:1065-1075) always
// inherits the FULL parent process environment for every stdio server, then layers the server's
// own `env` block on top — and that fully-populated object defeats @modelcontextprotocol/client's
// own safe-default env (stdio.mjs's getDefaultEnvironment(): HOME/LOGNAME/PATH/SHELL/TERM/USER
// only), because the adapter's object is spread AFTER it and wins. Neither file is ours to patch
// (vendored + sha256-pinned adapter; an installed SDK dependency of it).
//
// config/bin/mcp-stdio-guard is the config-side lever instead. These tests exercise the REAL
// script (no mocking) exactly the way the real adapter invokes a stdio command: spawn(command,
// args, { env, stdio, shell: false }) — see server-manager.ts:366-372 and
// @modelcontextprotocol/client/dist/stdio.mjs's start(). No network, no npx, no real
// server process — a tiny fixture script stands in for "the real command" and reports what it can
// see.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WRAPPER = join(REPO_ROOT, "config", "bin", "mcp-stdio-guard");
const FIXTURE = join(REPO_ROOT, "test", "mcp", "fixtures", "stdio-echo-server.mjs");
// The tracked example template. `config/mcp.json` is installer-generated, git-ignored and ships with
// no servers at all, so the example is the only place in this repository where a stdio server entry
// exists to be checked against the rules the wrapper above enforces.
const MCP_EXAMPLE = join(REPO_ROOT, "config", "mcp.example.json");

/**
 * Runs the wrapper against the fixture with a given extra env, mirroring exactly what
 * server-manager.ts's resolveEnv() hands to StdioClientTransport: the wrapper's OWN process env is
 * the full simulated "parent" (Object.assign onto a copy of process.env), never a partial one —
 * resolveEnv() never produces a partial env, so a test that only set three vars would not be
 * representative of what actually reaches the wrapper in production.
 */
function runFixtureThroughWrapper(
  extraEnv: Record<string, string>,
): Promise<{ lines: string[]; child: ReturnType<typeof spawn> }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const child = spawn(WRAPPER, [process.execPath, FIXTURE], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("fixture never reached READY within 5s"));
      }
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      // The fixture never exits on its own (it stays alive until signalled) — resolve as soon as
      // it has reported everything it is going to report, rather than waiting for a "close" event
      // that would never come.
      if (!settled && out.includes("READY\n")) {
        settled = true;
        clearTimeout(timer);
        resolve({ lines: out.split("\n").filter(Boolean), child });
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

describe("mcp-stdio-guard — env minimisation (EXT-14b)", () => {
  it("passes the baseline vars through (HOME/PATH/SHELL/TERM/USER/LOGNAME — the SDK's own safe-default list)", async () => {
    const { lines, child } = await runFixtureThroughWrapper({});
    child.kill("SIGKILL");
    const env = Object.fromEntries(
      lines.filter((l) => l.startsWith("ENV:")).map((l) => l.slice(4).split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    for (const name of ["HOME", "PATH", "SHELL", "TERM", "USER", "LOGNAME"]) {
      assert.ok(name in env, `expected ${name} to reach the real process`);
    }
  });

  it("carries NODE_EXTRA_CA_CERTS and the proxy variables into the spawned child (REQ-EXT-36)", async () => {
    const { lines, child } = await runFixtureThroughWrapper({
      NODE_EXTRA_CA_CERTS: "/fake/corp-ca-bundle",
      HTTPS_PROXY: "http://proxy.internal:8080",
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "127.0.0.1,localhost,.local",
    });
    child.kill("SIGKILL");
    const raw = lines.filter((l) => l.startsWith("ENV:")).join("\n");
    assert.match(raw, /ENV:NODE_EXTRA_CA_CERTS=\/fake\/corp-ca-bundle/);
    assert.match(raw, /ENV:HTTPS_PROXY=http:\/\/proxy\.internal:8080/);
    assert.match(raw, /ENV:HTTP_PROXY=http:\/\/proxy\.internal:8080/);
    assert.match(raw, /ENV:NO_PROXY=127\.0\.0\.1,localhost,\.local/);
  });

  it("does NOT forward credentials the parent process holds that the child never asked for", async () => {
    const { lines, child } = await runFixtureThroughWrapper({
      TRACKER_PERSONAL_TOKEN: "tracker-secret-should-not-leak",
      COPILOT_GITHUB_TOKEN: "gho_should_not_leak",
      PROVIDER_API_TOKEN: "provider_should_not_leak",
      CONTEXT7_API_KEY: "ctx7-should-not-leak",
      PI_COPILOT_QUOTA_TOKEN: "ghp_should_not_leak",
    });
    child.kill("SIGKILL");
    const raw = lines.filter((l) => l.startsWith("ENV:")).join("\n");
    for (const name of [
      "TRACKER_PERSONAL_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "PROVIDER_API_TOKEN",
      "CONTEXT7_API_KEY",
      "PI_COPILOT_QUOTA_TOKEN",
    ]) {
      assert.doesNotMatch(raw, new RegExp(`ENV:${name}=`), `${name} must not reach a stdio MCP child`);
    }
  });

  it("MCP_STDIO_EXTRA_ENV names exactly which extra vars a specific server may keep — an unnamed var still does not leak", async () => {
    const { lines, child } = await runFixtureThroughWrapper({
      MCP_STDIO_EXTRA_ENV: "EXAMPLE_BROWSERS_PATH",
      EXAMPLE_BROWSERS_PATH: "/fake/home/.cache/example-browsers",
      // Present in the simulated parent, same shape as the leaked-credential case above, but NOT
      // named in MCP_STDIO_EXTRA_ENV — must still be dropped even though it "looks" like config.
      SOME_OTHER_APP_SETTING: "should-not-leak-either",
    });
    child.kill("SIGKILL");
    const raw = lines.filter((l) => l.startsWith("ENV:")).join("\n");
    assert.match(raw, /ENV:EXAMPLE_BROWSERS_PATH=\/fake\/home\/\.cache\/example-browsers/);
    assert.doesNotMatch(raw, /ENV:SOME_OTHER_APP_SETTING=/);
    // MCP_STDIO_EXTRA_ENV itself is machinery for the wrapper, not a secret, but confirm it does not
    // also leak into the child's own env (it has no reason to be there).
    assert.doesNotMatch(raw, /ENV:MCP_STDIO_EXTRA_ENV=/);
  });

  it("refuses with a named, non-zero exit when spawned with no command at all", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(WRAPPER, [], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 64);
    assert.match(result.stderr, /no command given/);
  });
});

describe("mcp-stdio-guard — exec preserves pid, so the SDK's SIGTERM/SIGKILL escalation still reaches the real process", () => {
  it("the real server process (fixture) runs at the SAME pid Node reports for the spawned wrapper", async () => {
    const env = { ...process.env };
    const child = spawn(WRAPPER, [process.execPath, FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
    const wrapperPid = child.pid;
    assert.ok(wrapperPid, "spawn must report a pid");

    const fixturePid = await new Promise<number>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("fixture did not report PID within 5s")), 5000);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const m = out.match(/PID:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("error", reject);
    });

    assert.equal(fixturePid, wrapperPid, "exec must replace the wrapper's process image in place, not fork a child");
    child.kill("SIGKILL");
  });

  it("a SIGTERM sent to the spawned pid reaches and terminates the real process underneath", async () => {
    const env = { ...process.env };
    const child = spawn(WRAPPER, [process.execPath, FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture never reached READY")), 5000);
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", reject);
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGTERM");
    const { code, signal } = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SIGTERM did not terminate the process within 5s — exec may not have replaced the pid")), 5000)),
    ]);
    // Node's default SIGTERM disposition terminates the process; on POSIX platforms `signal` is
    // "SIGTERM" (code null). On Windows, `child_process.kill` maps to TerminateProcess, so allow a
    // clean-exit fallback there instead of asserting a signal that platform cannot report.
    if (platform() === "win32") {
      assert.ok(code !== null || signal !== null);
    } else {
      assert.equal(signal, "SIGTERM");
    }
  });
});

// The three assertions below used to name the two stdio servers this repository shipped. It ships
// none any more — `config/mcp.default.json` is `{"mcpServers": {}}` (pinned by
// test/mcp/default-deny.test.ts A0) — so naming a server here would assert on one person's install.
// What survives, and is what actually mattered, is the RULE every stdio entry has to satisfy, held
// against the tracked example template: whatever a user copies out of it is already correct.
describe("config/mcp.example.json — every stdio entry a user might copy obeys the wrapper's contract", () => {
  async function example(): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
    return JSON.parse(await readFile(MCP_EXAMPLE, "utf8"));
  }

  /** The entries that spawn a child process — the only ones the wrapper has anything to say about. */
  async function stdioEntries(): Promise<Array<[string, Record<string, unknown>]>> {
    const cfg = await example();
    return Object.entries(cfg.mcpServers).filter(([, server]) => "command" in server);
  }

  it("the template offers at least one stdio server, so this contract is tested against something", async () => {
    assert.ok((await stdioEntries()).length > 0, "config/mcp.example.json must keep a stdio example");
  });

  it("every stdio entry points its command at the real, executable mcp-stdio-guard file, and stays lazy", async () => {
    for (const [name, server] of await stdioEntries()) {
      assert.equal(server.command, "mcp-stdio-guard", `"${name}" must be spawned through the wrapper`);
      assert.ok(
        Array.isArray(server.args) && (server.args as unknown[]).length > 0,
        `"${name}" must carry the real command in args`,
      );
      // A lazy lifecycle is what keeps an `npx`-fetched server cheap: the spawn is deferred to first
      // use instead of running at every session start.
      assert.equal(server.lifecycle, "lazy", `"${name}" must stay lazy`);
    }
  });

  it("every extra env var an stdio entry sets is named in its own MCP_STDIO_EXTRA_ENV — otherwise the wrapper drops it and the server breaks in a way nobody can debug", async () => {
    for (const [name, server] of await stdioEntries()) {
      const env = (server.env ?? {}) as Record<string, string>;
      const declared = new Set((env.MCP_STDIO_EXTRA_ENV ?? "").split(/\s+/).filter(Boolean));
      for (const key of Object.keys(env)) {
        if (key === "MCP_STDIO_EXTRA_ENV") continue;
        assert.ok(declared.has(key), `"${name}" sets ${key} but does not name it in MCP_STDIO_EXTRA_ENV`);
      }
      for (const key of declared) {
        assert.ok(key in env, `"${name}" allowlists ${key} but never sets it`);
      }
    }
  });

  it("mcp-stdio-guard is present, executable, and lives where a bare command name resolves it via PATH (config/bin/ -> ~/bin/<name>, created by scripts/install.sh)", async () => {
    const { statSync } = await import("node:fs");
    const stat = statSync(WRAPPER);
    assert.ok(stat.isFile());
    // eslint-disable-next-line no-bitwise
    assert.ok((stat.mode & 0o111) !== 0, "mcp-stdio-guard must be executable");
    assert.equal(dirname(WRAPPER), join(REPO_ROOT, "config", "bin"));
  });
});

/**
 * A throwaway `$HOME` for the MCP suites, plus the synthetic server set they assert against.
 *
 * **Why a fake `$HOME`.** `pi-packages/pi-mcp-adapter/config.ts` computes `IMPORT_PATHS`,
 * `GENERIC_GLOBAL_CONFIG_PATH` and `AGENTS_GLOBAL_CONFIG_PATHS` at module scope from `os.homedir()`.
 * Those suites used to run against the developer's real home directory — reading `~/.claude.json`,
 * `~/.config/mcp/mcp.json` and `~/.agents/mcp.json` — which made the results depend on which other
 * agents happened to be installed on the machine, and made one assertion ("a foreign host config
 * defining our server names is never merged") *require* a personal file to be meaningful. Calling
 * `useSandboxHome()` before the first `import()` of the adapter pins all of that inside a temp tree.
 * `node --test` gives each file its own process, so the module-scope capture happens once, here.
 *
 * **Why synthetic servers.** This repository ships **zero** MCP servers: `config/mcp.default.json`
 * is `{"mcpServers": {}}`. The precedence, merge and trust-gate mechanisms still have to be covered,
 * so the suites define their own server set below — three shapes that exercise every branch the real
 * ones used to: a remote HTTP server, a stdio server behind the spawn guard, and one that ships
 * opted-out. Names are deliberately generic; none of them resolves to a real service.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points `$HOME` at a fresh empty directory and returns it. Call this at module scope, *before* any
 * `import()` of the adapter, or the module-scope path constants will already have been captured.
 */
export function useSandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
  process.env.HOME = home;
  // macOS-only, and only consulted by a handful of libraries, but leaving the real one behind is the
  // same class of leak as leaving $HOME behind.
  delete process.env.USERPROFILE;
  return home;
}

/** A remote HTTP server that ships enabled. Stands in for any read-only documentation service. */
export const REMOTE_ENABLED = {
  url: "https://mcp.example.invalid/docs",
  headers: { EXAMPLE_DOCS_API_KEY: "${EXAMPLE_DOCS_API_KEY}" },
  lifecycle: "lazy",
  directTools: true,
} as const;

/** A stdio server that ships enabled, spawned through the wrapper rather than directly. */
export const STDIO_ENABLED = {
  command: "mcp-stdio-guard",
  args: ["npx", "-y", "@example/browser-mcp", "--headless"],
  env: {
    MCP_STDIO_EXTRA_ENV: "EXAMPLE_BROWSERS_PATH",
    EXAMPLE_BROWSERS_PATH: "${HOME}/.cache/example-browsers",
  },
  lifecycle: "lazy",
} as const;

/** A second stdio server with no extra env at all — the wrapper's universal baseline is enough. */
export const STDIO_MINIMAL = {
  command: "mcp-stdio-guard",
  args: ["npx", "-y", "@example/diagram-mcp"],
  lifecycle: "lazy",
} as const;

/**
 * A server that ships OFF. The asymmetry matters to several assertions: an entry that widens the
 * *data* a session can reach is opted into per project, where one that only widens the *tool* surface
 * is not, and a merge must never silently flip this one on.
 */
export const REMOTE_OPT_IN = {
  url: "http://127.0.0.1:9999/mcp",
  lifecycle: "lazy",
  disabled: true,
} as const;

/** The pi-global `mcp.json` these suites seed into a scratch agent dir. */
export const SYNTHETIC_MCP_CONFIG = {
  mcpServers: {
    "docs-remote": REMOTE_ENABLED,
    "browser-stdio": STDIO_ENABLED,
    "diagram-stdio": STDIO_MINIMAL,
    "vault-remote": REMOTE_OPT_IN,
  },
  settings: { hostConfigDiscovery: "off", directTools: false },
} as const;

export const SYNTHETIC_SERVERS = ["docs-remote", "browser-stdio", "diagram-stdio", "vault-remote"] as const;
export const SYNTHETIC_ENABLED_SERVERS = ["docs-remote", "browser-stdio", "diagram-stdio"] as const;
export const SYNTHETIC_OPT_IN_SERVERS = ["vault-remote"] as const;

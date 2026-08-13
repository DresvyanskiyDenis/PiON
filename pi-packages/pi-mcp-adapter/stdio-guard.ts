/**
 * LOCAL PATCH — pi-config. NOT upstream. A new file, so an upstream upgrade cannot conflict with it;
 * `server-manager.ts` gains one import line and three lines inside `createConnection`.
 *
 * Layer 2 of the project-MCP-config fix. Layer 1 is the approval-record trust gate
 * (`config.ts` + `extensions/lib/mcp-approvals.ts`) and decides whether a project's `.mcp.json` /
 * `.pi/mcp.json` is read at all. This layer assumes layer 1 said yes and still refuses to hand the
 * resulting child process the parent environment.
 *
 * `resolveEnv` in `server-manager.ts` copies the WHOLE of `process.env` into every stdio child and
 * then layers the server's own `env` on top. That is every provider key, every service token and
 * every other secret `config/shell/pi-env.sh` loads — the exact set depends on which providers you
 * configured, which is the point: the child receives all of them, whatever they are, and a stdio
 * server is an arbitrary program. `config/bin/mcp-stdio-guard` (`env -i` plus an
 * explicit allowlist) is the repo's answer and was reviewed and found correct — but it was OPT-IN:
 * a server entry had to point its own `command` at the wrapper, and a hostile `.pi/mcp.json`
 * simply does not opt in.
 *
 * So the opt-in is removed for anything a PROJECT names. Global/user-level servers are untouched:
 * they are the operator's own config, `config/mcp.json` already routes the ones that need it
 * through the wrapper explicitly, and forcing it on servers that legitimately need inherited
 * environment would break them silently — the opposite of what this patch is for.
 *
 * This lives in its own module rather than at the foot of `server-manager.ts` because that file
 * uses TypeScript constructor parameter properties, which Node's strip-only loader rejects
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — it cannot be imported from a test, and an untested
 * security control is not a security control. `test/mcp/project-stdio-guard.test.ts` imports this.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { projectScopedServerNames } from "./config.ts";

export type StdioGuardLogSink = (level: "warn" | "debug", message: string) => void;

/**
 * Defaults to stderr and is redirected to the adapter's `logger` by `server-manager.ts`.
 *
 * `./logger.ts` is NOT imported here: it uses TypeScript constructor parameter properties, which
 * Node's strip-only loader rejects, and importing it would make this module untestable — the same
 * reason this module is not part of `server-manager.ts`. A default that writes to stderr also means
 * the warning below survives even if the sink is never installed.
 */
let logSink: StdioGuardLogSink = (level, message) => {
  if (level === "warn") process.stderr.write(`[pi-config] mcp: ${message}\n`);
};

export function setStdioGuardLogSink(sink: StdioGuardLogSink): void {
  logSink = sink;
}

/** Escape hatch for tests and for a relocated checkout. Must point at an existing file. */
const MCP_STDIO_GUARD_ENV = "PI_MCP_STDIO_GUARD";

/** Names the wrapper reads out of its own environment; never honoured for a project-sourced server. */
const MCP_STDIO_EXTRA_ENV = "MCP_STDIO_EXTRA_ENV";

/**
 * `pi-packages/pi-mcp-adapter/server-manager.ts` -> `<repo>/config/bin/mcp-stdio-guard`.
 * `realpath` first: `pi-packages/` is symlinked into the agent dir on this machine, and a path
 * resolved through the symlink would climb out of the wrong tree.
 */
function mcpStdioGuardPath(): string {
  const override = process.env[MCP_STDIO_GUARD_ENV];
  if (override !== undefined && override !== "") return resolvePath(override);
  const url = fileURLToPath(import.meta.url);
  let here: string;
  try {
    here = realpathSync(url);
  } catch {
    here = url;
  }
  return resolvePath(dirname(here), "..", "..", "config", "bin", "mcp-stdio-guard");
}

export interface GuardedStdioSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  /** True when the wrapper was inserted. Exported shape so tests can assert on it. */
  readonly wrapped: boolean;
}

/**
 * Wraps a project-sourced stdio spawn in `config/bin/mcp-stdio-guard`.
 *
 * Fails LOUD, never silently: if the server is project-sourced and the wrapper is missing or not
 * executable, this throws and the server does not start. Spawning it unwrapped would hand a
 * repo-controlled process every credential in the environment, which is the exact outcome the
 * whole patch exists to prevent — "the wrapper was missing" is not a reason to do it anyway.
 *
 * `MCP_STDIO_EXTRA_ENV` is stripped for project-sourced servers. The wrapper reads that variable
 * from its own environment to widen its allowlist by name, so leaving it under the project's
 * control would let `"env": {"MCP_STDIO_EXTRA_ENV": "OPENAI_API_KEY GITHUB_TOKEN"}` walk the
 * credentials straight back through the wrapper. Operator-owned global servers keep the mechanism.
 */
export function guardProjectStdioSpawn(
  serverName: string,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  configCwd?: string,
): GuardedStdioSpawn {
  const cwd = configCwd ?? process.cwd();
  if (!projectScopedServerNames(cwd).has(serverName)) {
    return { command, args, env, wrapped: false };
  }

  const guard = mcpStdioGuardPath();
  if (!existsSync(guard)) {
    throw new Error(
      `MCP server "${serverName}" is defined by project config under ${cwd} and must be spawned ` +
        `through the env-minimising wrapper, but ${guard} does not exist. Refusing to start it ` +
        `with the full parent environment. Restore config/bin/mcp-stdio-guard or set ` +
        `${MCP_STDIO_GUARD_ENV} to its location.`,
    );
  }
  if (resolvePath(command) === guard) {
    // Already pointed at the wrapper by its own entry. Wrapping twice would work but would drop
    // MCP_STDIO_EXTRA_ENV between the two hops, which looks like a broken server, not a denial.
    return { command, args, env, wrapped: true };
  }

  const { [MCP_STDIO_EXTRA_ENV]: dropped, ...rest } = env;
  if (dropped !== undefined) {
    logSink(
      "warn",
      `${serverName}: ignoring ${MCP_STDIO_EXTRA_ENV} from project MCP config — a project may not widen the stdio env allowlist`,
    );
  }
  logSink("debug", `${serverName}: project-sourced stdio server routed through ${guard}`);
  return { command: guard, args: [command, ...args], env: rest, wrapped: true };
}

/**
 * Where the repository under test is, and how to reach a config file the installer generates.
 *
 * **Two problems this solves, both of which made tests lie.**
 *
 * 1. `extensions/lib/paths.ts`'s `repoRoot()` is `process.env.PI_CONFIG_REPO ?? ~/pi-config`. On the
 *    machine of anyone who has actually installed this harness, that fallback points at their *live
 *    install* — so a test that reads "the repo's own `config/…`" silently read someone else's
 *    configuration and passed for the wrong reason. Importing this module pins `PI_CONFIG_REPO` at
 *    the checkout the test file lives in, before any extension module can call `repoRoot()`. Put the
 *    import **first** in the file: ES modules evaluate dependencies in import order, and that
 *    ordering is what makes the assignment win.
 *
 * 2. Ten config files are **generated** by `scripts/install.sh` from tracked `*.default.json`
 *    templates (`GENERATED_CONFIGS` in that script, plus `models`, `routing` and `mcp`) and are
 *    git-ignored. On a clean checkout they are simply absent. A test that hardcodes
 *    `config/<name>.json` therefore passes on a developer's machine and fails in CI — or, worse,
 *    asserts against values the operator typed at an install prompt rather than against anything
 *    this repository ships. `configFile()` prefers the generated file when one exists (so the suite
 *    still describes a real install) and falls back to the tracked template (so a clean checkout is
 *    the same test).
 *
 * Not exported as a fixture builder: a test that needs a config file it can *write* should still
 * make its own temp directory. This is only for the read-only "what does this repository ship"
 * assertions.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this test file belongs to — never `~/pi-config`. */
export const REPO = fileURLToPath(new URL("../..", import.meta.url));

// Deliberately unconditional. An inherited PI_CONFIG_REPO pointing somewhere else is exactly the
// accident this module exists to stop; a test that wants a different root sets it per-case.
process.env.PI_CONFIG_REPO = REPO;

export const CONFIG_DIR = join(REPO, "config");

/**
 * The path to the config file **this repository ships** under `config/<name>`: the tracked
 * `<name>.default.json` template when there is one, otherwise the tracked `<name>.json` for the
 * files that have no template (`dispatch.json`, `tasks.json`, …). `name` is given without an
 * extension.
 *
 * Deliberately prefers the template over the generated file even when both exist. Running the
 * installer on the machine that runs the suite is normal, and after it does, `config/<name>.json`
 * holds the operator's answers — endpoints, a selected provider, an MCP server list. A test that
 * read that file would assert against one person's install and pass or fail for reasons that have
 * nothing to do with the tree under review. Everything here asks "what does this repository ship",
 * and the answer to that is always the tracked file.
 */
export function shippedConfig(name: string): string {
  const template = join(CONFIG_DIR, `${name}.default.json`);
  if (existsSync(template)) return template;
  const tracked = join(CONFIG_DIR, `${name}.json`);
  if (existsSync(tracked)) return tracked;
  throw new Error(`neither config/${name}.default.json nor config/${name}.json exists in ${CONFIG_DIR}`);
}

/**
 * The generated `config/<name>.json` when `scripts/install.sh` has produced one on this machine,
 * otherwise `undefined`. Only for the handful of assertions that are genuinely about the live
 * install rather than about the shipped tree.
 */
export function generatedConfig(name: string): string | undefined {
  const generated = join(CONFIG_DIR, `${name}.json`);
  return existsSync(generated) ? generated : undefined;
}

/** `shippedConfig()` parsed as JSON. */
export function readShippedConfig<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(shippedConfig(name), "utf8")) as T;
}

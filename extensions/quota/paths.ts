/**
 * Every path `EXT-09` touches, in one place — mirrors the layering convention already
 * established by `extensions/lib/paths.ts` (`configDir()`, `stateRoot()`) and
 * `extensions/digest/paths.ts` (`digestConfigPath()`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../lib/paths.ts";

/**
 * `config/quota.json`, installed by symlink to `~/.pi/agent/quota.json` (`config/README.md`'s
 * pattern for every file under `config/`). `PI_QUOTA_CONFIG` overrides for tests.
 */
export function quotaConfigPath(): string {
  return process.env.PI_QUOTA_CONFIG ?? join(configDir(), "quota.json");
}

/**
 * `REQ-PRV-27`'s classic PAT file — deliberately **outside** `configDir()` (`~/.pi/agent`), on
 * `$XDG_CONFIG_HOME/pi` (or `~/.config/pi`), so PI's `/login` rewrite of `auth.json` and any
 * `~/.pi/agent` reset never touch it. The filename is load-bearing, not cosmetic:
 * `extensions/guard/gates/secret-paths.ts`'s `SEC-QUOTA-TOKEN` rule denies the agent read access
 * to any path ending `quota-token.json`; `copilot-quota-token.json` matches it.
 *
 * Read per call, never hoisted — same reasoning as `extensions/lib/local-catalogue.ts`'s
 * `localBaseUrl()`: the env var must not be frozen at import time for tests to override it.
 */
export function defaultTokenFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "pi", "copilot-quota-token.json");
}

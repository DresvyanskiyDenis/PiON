/**
 * `EXT-27` — file locations, mirroring the layering convention `extensions/digest/paths.ts`
 * already established (`configDir()` + an env override for tests).
 *
 * `config/path-defaults.json` ships in the repo and is installed by symlink to
 * `~/.pi/agent/path-defaults.json` (`config/README.md`'s pattern for every file under
 * `config/` — a row for this file is one of this item's `openQuestions`, since `config/README.md`
 * is a shared file this item may not edit).
 */
import { join } from "node:path";
import { configDir } from "../lib/paths.ts";

/** `PI_PATH_DEFAULTS_JSON` overrides for tests and for anyone running against a non-default tree. */
export function pathDefaultsConfigPath(): string {
  return process.env.PI_PATH_DEFAULTS_JSON ?? join(configDir(), "path-defaults.json");
}

/**
 * `config/routing.json`, read-only from here. Matches the exact override name
 * `extensions/digest/paths.ts` and `config/bin/pi-tier` already use, so one env var controls
 * every reader of this file.
 */
export function routingConfigPath(): string {
  return process.env.PI_ROUTING_JSON ?? join(configDir(), "routing.json");
}

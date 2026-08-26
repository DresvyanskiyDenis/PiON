/**
 * File location, mirroring `extensions/path-defaults/paths.ts`'s `configDir()` + env-override
 * convention.
 *
 * Deliberately `<configDir>/rules`, not a new top-level directory in this repo: the whole point of
 * this format (see `config.ts`'s header) is that the SAME `rules/` directory can be symlinked into
 * another harness. Living inside `configDir()` (PI's own live `~/.pi/agent`) means adding this
 * feature adds nothing to `.gitignore` and nothing to `config/settings.json` — an operator who
 * wants their rules tracked symlinks their own directory in, exactly as they already do for the
 * rules directory of whatever other harness they run.
 */
import { join } from "node:path";
import { configDir } from "../lib/paths.ts";

/** `PI_CONFIG_RULES_DIR` overrides for tests and for anyone running against a non-default tree. */
export function rulesDir(): string {
  return process.env.PI_CONFIG_RULES_DIR ?? join(configDir(), "rules");
}

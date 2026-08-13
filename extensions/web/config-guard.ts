/**
 * `EXT-07` — "pin exactly one search backend, in config, with a declared loud failure".
 *
 * `pi-web-access` supports 19 search providers and an `"auto"`/`"all"`/array selection that probes
 * or fan-outs across whichever of them have credentials present. Left unpinned, that is "a set of
 * credentials and egress paths nobody decided on" (the same document). This module makes the pin
 * an enforced invariant, checked at every `session_start`, rather than a fact that is merely true
 * today because nobody has added a second provider's API key yet.
 *
 * Two files are involved and this module cross-checks them:
 *   - `config/web-search.json` → installed as `~/.pi/agent/web-search.json` — the file
 *     `pi-web-access` actually reads (see `getWebSearchConfigPath()` in its `utils.ts`:
 *     `join(getWebSearchConfigDir(), "web-search.json")`, where `getWebSearchConfigDir()` returns
 *     `process.env.PI_CODING_AGENT_DIR` verbatim when set, else `$XDG_CONFIG_HOME/pi`, else
 *     `~/.pi`).
 *   - `config/web.json` → installed as `~/.pi/agent/web.json` — EXT-07's own declaration of intent
 *     for humans and `jq`-based tooling (an acceptance test reads
 *     `.search.backend` from exactly this file).
 * A mismatch between the two — someone edits one and not the other — is exactly the kind of drift
 * REQ-PRV-32 ("fail loud, never silent") exists to catch.
 *
 * The path above is computed locally (`webSearchConfigPath()`) rather than imported from
 * `pi-web-access/utils.ts` directly. `pi-web-access` ships only `*.ts` source, no compiled `dist`,
 * and Node's built-in TypeScript loader refuses to strip types for *any* `.ts` file that resolves
 * under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — reproduced empirically
 * under `node --test`, 2026-08-07; `tsc` alone does not catch this because it has no opinion on
 * Node's runtime module-resolution restrictions). This deployment always exports
 * `PI_CODING_AGENT_DIR` (`config/shell/pi-env.sh`), and in that state PI's own `getAgentDir()`
 * (`configDir()` below, tilde-expanded) and `pi-web-access`'s `getWebSearchConfigDir()`
 * (unexpanded) both return that same env var verbatim — so `configDir()` and
 * `getWebSearchConfigPath()` agree exactly whenever the deployment precondition holds. The two
 * functions' *unset* fallbacks differ (`~/.pi/agent` vs `~/.pi`/`$XDG_CONFIG_HOME/pi`); that
 * divergence only matters if `PI_CODING_AGENT_DIR` is ever unset, which is out of this module's
 * control.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../lib/paths.ts";

/** See the module docstring: re-derives pi-web-access's own getWebSearchConfigPath() locally. */
function webSearchConfigPath(): string {
  return join(configDir(), "web-search.json");
}

const MULTI_PROVIDER_VALUES = new Set(["auto", "all"]);

export interface PinnedBackendCheck {
  readonly declaredPath: string;
  readonly liveConfigPath: string;
  readonly backend: string;
}

function readJsonFile(path: string, humanLabel: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `web: ${humanLabel} not found at ${path}. EXT-07 requires it to be installed there ` +
        "(see config/README.md) — refusing to start with pi-web-access's default " +
        `multi-provider auto-detection. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`web: ${humanLabel} at ${path} is not valid JSON: ${cause}`);
  }
}

/** Our own declared-intent file: `config/web.json` → `~/.pi/agent/web.json`. */
function readDeclaredBackend(): { path: string; backend: string } {
  const path = join(configDir(), "web.json");
  const doc = readJsonFile(path, "EXT-07's declared-backend file (config/web.json)");
  const search = doc.search;
  const backend =
    search && typeof search === "object" && !Array.isArray(search)
      ? (search as Record<string, unknown>).backend
      : undefined;
  if (typeof backend !== "string" || backend.length === 0) {
    throw new Error(`web: ${path} has no non-empty "search.backend" string set — pin exactly one backend.`);
  }
  return { path, backend };
}

/** The file `pi-web-access` itself reads. */
function readLiveProvider(): { path: string; provider: string } {
  const path = webSearchConfigPath();
  const doc = readJsonFile(path, "pi-web-access's own config (config/web-search.json)");
  const provider = doc.provider ?? doc.searchProvider;
  if (provider === undefined) {
    throw new Error(`web: ${path} has no "provider" set — pin exactly one search backend.`);
  }
  if (Array.isArray(provider)) {
    throw new Error(
      `web: ${path} "provider" is an array (${JSON.stringify(provider)}) — EXT-07 requires exactly ` +
        "one backend, not concurrent multi-provider fan-out.",
    );
  }
  if (typeof provider !== "string" || MULTI_PROVIDER_VALUES.has(provider)) {
    throw new Error(
      `web: ${path} "provider" is ${JSON.stringify(provider)} — EXT-07 requires one named backend ` +
        '(e.g. "searxng"), not "auto"/"all".',
    );
  }
  return { path, provider };
}

/**
 * Throws unless exactly one search backend is pinned and both config files agree on which one.
 * Called from `web.ts`'s `session_start` handler — I/O belongs there, not in `register()`.
 */
export function assertPinnedSearchBackend(): PinnedBackendCheck {
  const declared = readDeclaredBackend();
  const live = readLiveProvider();
  if (declared.backend !== live.provider) {
    throw new Error(
      `web: pinned-backend mismatch — ${declared.path} says "search.backend": ` +
        `${JSON.stringify(declared.backend)} but ${live.path} says "provider": ` +
        `${JSON.stringify(live.provider)}. Fix whichever one drifted.`,
    );
  }
  return { declaredPath: declared.path, liveConfigPath: live.path, backend: declared.backend };
}

/**
 * `pi-web-access`'s fetch tool is named `fetch_content` by default (`resolveToolNames()` in its
 * `index.ts`). The ported `AGENTS.md`'s six TRIGGER blocks — written against the pre-adoption
 * custom-build spec — call it `web_fetch` throughout (`## Web access`,
 * `TRIGGER: current docs before code touching a library`). Rather than requiring an edit to
 * `AGENTS.md` (a shared file this item may not touch), `config/
 * web-search.json` renames the tool at the source via `pi-web-access`'s own `toolNames.fetchContent`
 * override, which `resolveToolNames()` accepts as a plain string rename with no other code change.
 * This function makes that rename an enforced invariant, the same way `assertPinnedSearchBackend`
 * enforces the backend pin: a config edit that silently drops the override would make three of the
 * six TRIGGER blocks and the `sofa` skill call a tool that no longer exists, and do so silently.
 */
export function assertFetchToolAliasedToWebFetch(): { readonly path: string; readonly name: string } {
  const path = webSearchConfigPath();
  const doc = readJsonFile(path, "pi-web-access's own config (config/web-search.json)");
  const toolNames = doc.toolNames;
  const fetchContentName =
    toolNames && typeof toolNames === "object" && !Array.isArray(toolNames)
      ? (toolNames as Record<string, unknown>).fetchContent
      : undefined;
  if (fetchContentName !== "web_fetch") {
    throw new Error(
      `web: ${path} must set "toolNames": { "fetchContent": "web_fetch" } — the ported AGENTS.md's ` +
        `TRIGGER blocks and the sofa skill call web_fetch by name, and pi-web-access's default tool ` +
        `name is fetch_content. Currently: ${JSON.stringify(fetchContentName)}.`,
    );
  }
  return { path, name: fetchContentName };
}

/**
 * `config/path-defaults.json` — shape, parsing and structural validation.
 *
 * Was a `roots` array, longest-prefix matched against `cwd`, so a session's tier and egress
 * posture depended on which directory it started in. That per-directory split is gone: there is
 * now exactly one configured tier and one egress policy for every session, regardless of `cwd`.
 * `path` (per-root), `reason` (per-root), the wildcard-last rule, and duplicate-path detection are
 * all deleted along with `roots` — none of them mean anything once there is nothing left to match
 * against.
 *
 * What survives from the roots-based design, unchanged:
 *
 *  1. The single `tier` field names a `config/routing.json` tier (`strong`/`light`/
 *     `confidential` — the 2026-08-15 owner decision deleted `fast` and `local` and renamed
 *     `cheap` to `light`), not a literal `provider`+`model` pair. `config/README.md` rule 3:
 *     "no bare model id outside `routing.json` and `models.json` — agents, skills and scripts
 *     reference a tier." The provider/model/session-egress-class all come from `./routing.ts`
 *     resolving that tier, so `config/routing.json` stays the single source of truth for what a
 *     tier means — the same reason `EXT-05`'s `dispatch/tiers.ts` refuses to let a fanout target
 *     embed a raw model.
 *  2. The `egress` object (`web`/`mcp`/`publicModels`, each `"allow"`/`"deny"`) is kept exactly as
 *     specced — it is a DIFFERENT axis from the tier's session-egress class (which is
 *     public/internal/confidential, `EXT-05`'s vocabulary, used for sub-agent dispatch
 *     containment). It is now a single, whole-install, per-channel policy rather than a per-root
 *     one, but the shape and the DECLARATIVE-ONLY caveat are unchanged — this module does not
 *     intercept a web call or an MCP call itself, and does not claim to; see `index.ts`'s header
 *     comment.
 */
import { readFileSync } from "node:fs";
import { pathDefaultsConfigPath } from "./paths.ts";

export type Channel = "allow" | "deny";

export interface EgressChannels {
  readonly web: Channel;
  readonly mcp: Channel;
  readonly publicModels: Channel;
}

export interface PathDefaultsFile {
  readonly version: 1;
  /** A `config/routing.json` tier name. Resolved lazily by `./routing.ts`, not validated here. */
  readonly tier: string;
  readonly egress: EgressChannels;
}

/** No TypeScript parameter properties on purpose — `extensions/hooks/schema.ts`'s own note:
 *  Node's `--test` runs `.ts` through type-stripping only, and `constructor(readonly x: T)` is a
 *  real syntax transform, not an erasure; it throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at run
 *  time on Node 22.22.3. `tsc --noEmit` alone does not catch this. */
export class PathDefaultsShapeError extends Error {
  readonly source: string;

  constructor(message: string, source: string) {
    super(`${source}: ${message}`);
    this.name = "PathDefaultsShapeError";
    this.source = source;
  }
}

const CHANNEL_KEYS = ["web", "mcp", "publicModels"] as const;

function isChannel(v: unknown): v is Channel {
  return v === "allow" || v === "deny";
}

/**
 * Structural validation only — never touches disk, never resolves a tier. Pure so it is
 * unit-testable and so `bin/rules/pc-20-path-defaults-shape.mjs` can restate the same rules
 * offline against the committed file (that script cannot import `.ts`, so it duplicates the
 * checks in plain JS; this is the version the running extension actually enforces).
 *
 * Throws `PathDefaultsShapeError` on the first problem found, naming `source` (a path, or
 * `"<inline>"` for tests) so an error message is always locatable.
 */
export function validatePathDefaults(value: unknown, source: string): PathDefaultsFile {
  const fail = (message: string): never => {
    throw new PathDefaultsShapeError(message, source);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return fail(`"version" must be 1, got ${JSON.stringify(obj.version)}`);

  if (typeof obj.tier !== "string" || obj.tier.length === 0) {
    return fail('"tier" must be a non-empty string naming a config/routing.json tier');
  }

  if (obj.egress === null || typeof obj.egress !== "object" || Array.isArray(obj.egress)) {
    return fail('"egress" must be an object with web/mcp/publicModels keys');
  }
  const egressObj = obj.egress as Record<string, unknown>;
  for (const key of CHANNEL_KEYS) {
    if (!isChannel(egressObj[key])) {
      return fail(`egress.${key} must be "allow" or "deny", got ${JSON.stringify(egressObj[key])}`);
    }
  }
  const egress: EgressChannels = {
    web: egressObj.web as Channel,
    mcp: egressObj.mcp as Channel,
    publicModels: egressObj.publicModels as Channel,
  };

  return { version: 1, tier: obj.tier, egress };
}

/** @throws PathDefaultsShapeError on malformed shape, or a plain Error on a missing/unreadable file. */
export function loadPathDefaults(path: string = pathDefaultsConfigPath()): PathDefaultsFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  return validatePathDefaults(parsed, path);
}

/**
 * `config/path-defaults.json` — shape, parsing and structural validation.
 *
 * Departures from an earlier draft's JSON example, both deliberate:
 *
 *  1. Each root names a `tier` (`config/routing.json`'s `strong`/`fast`/`cheap`/`confidential`/
 *     `local`), not a literal `provider`+`model` pair. `config/README.md` rule 3: "no bare model
 *     id outside `routing.json` and `models.json` — agents, skills and scripts reference a tier."
 *     A root's `provider`/`model`/session-egress-class all now come from `./routing.ts` resolving
 *     that tier, so `config/routing.json` stays the single source of truth for what a tier means —
 *     the same reason `EXT-05`'s `dispatch/tiers.ts` refuses to let a fanout target embed a raw
 *     model. This also removes the need to hand-maintain a `class: "enterprise"|"personal"` field:
 *     the session-egress class comes from the tier's provider instead (see `index.ts`).
 *  2. The `egress` object (`web`/`mcp`/`publicModels`, each `"allow"`/`"deny"`) is kept exactly as
 *     specced — it is a DIFFERENT axis from the tier's session-egress class (which is
 *     public/internal/confidential, `EXT-05`'s vocabulary, used for sub-agent dispatch
 *     containment). This root-level object is a per-channel, per-directory policy consumed by
 *     `EXT-07` (web tools) and `EXT-14` (MCP adapter) through `egressClassFor()`. It is
 *     DECLARATIVE ONLY — this module does not intercept a web call or an MCP call itself, and
 *     does not claim to; see `index.ts`'s header comment.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathDefaultsConfigPath } from "./paths.ts";

export type Channel = "allow" | "deny";

export interface RootEgress {
  readonly web: Channel;
  readonly mcp: Channel;
  readonly publicModels: Channel;
}

export interface RootDef {
  /** `~`-prefixed, absolute, or the literal wildcard `"*"`. */
  readonly path: string;
  /** A `config/routing.json` tier name. Resolved lazily by `./routing.ts`, not validated here. */
  readonly tier: string;
  readonly egress: RootEgress;
  /** Shown in the session-start notice for an enterprise-ish root. Optional, human-facing only. */
  readonly reason?: string;
}

export interface PathDefaultsFile {
  readonly version: 1;
  readonly roots: readonly RootDef[];
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
  if (!Array.isArray(obj.roots)) return fail('"roots" must be an array');
  // Narrowing a property access (`obj.roots is unknown[]`) does not survive into the nested
  // `.map()` closure below — TS re-widens `obj.roots` to `unknown` inside it. Capturing the
  // already-narrowed value into a local binding fixes the type once, at the point it was proven.
  const rawRoots: unknown[] = obj.roots;

  let sawWildcard = false;
  const seenPaths = new Set<string>();
  const roots: RootDef[] = rawRoots.map((raw, i) => {
    const where = `roots[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`${where} must be an object`);
    }
    const r = raw as Record<string, unknown>;

    if (typeof r.path !== "string" || r.path.length === 0) {
      return fail(`${where}.path must be a non-empty string`);
    }
    if (r.path !== "*" && !r.path.startsWith("~") && !r.path.startsWith("/")) {
      return fail(`${where}.path "${r.path}" is neither "*" nor an absolute-able path (must start with "~" or "/")`);
    }
    if (seenPaths.has(r.path)) return fail(`${where}.path "${r.path}" is a duplicate of an earlier root`);
    seenPaths.add(r.path);

    if (r.path === "*") {
      if (sawWildcard) return fail(`more than one wildcard ("*") root`);
      sawWildcard = true;
      if (i !== rawRoots.length - 1) {
        return fail(`the wildcard ("*") root must be last (longest-prefix matching depends on it) — found at index ${i} of ${rawRoots.length}`);
      }
    } else if (sawWildcard) {
      // Unreachable given the check above (wildcard must be last), kept as a second, independent
      // guard so a future refactor of the last-index check cannot silently reopen this hole.
      return fail(`${where} follows the wildcard ("*") root and can never be reached`);
    }

    if (typeof r.tier !== "string" || r.tier.length === 0) {
      return fail(`${where}.tier must be a non-empty string naming a config/routing.json tier`);
    }

    if (r.egress === null || typeof r.egress !== "object" || Array.isArray(r.egress)) {
      return fail(`${where}.egress must be an object with web/mcp/publicModels keys`);
    }
    const egressObj = r.egress as Record<string, unknown>;
    for (const key of CHANNEL_KEYS) {
      if (!isChannel(egressObj[key])) {
        return fail(`${where}.egress.${key} must be "allow" or "deny", got ${JSON.stringify(egressObj[key])}`);
      }
    }
    const egress: RootEgress = { web: egressObj.web as Channel, mcp: egressObj.mcp as Channel, publicModels: egressObj.publicModels as Channel };

    if (r.reason !== undefined && typeof r.reason !== "string") {
      return fail(`${where}.reason must be a string when present`);
    }

    return {
      path: r.path,
      tier: r.tier,
      egress,
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    };
  });

  return { version: 1, roots };
}

/** `~` and `~/…` are expanded against `HOME`; every other path (including `"*"`) passes through. */
export function expandHome(p: string, home: string = process.env.HOME ?? homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
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

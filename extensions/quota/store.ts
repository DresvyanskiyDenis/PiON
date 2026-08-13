/**
 * `REQ-PRV-27` — the classic `ghp_` PAT, stored **outside** `auth.json`, `0600`, with a `tier`.
 *
 * The failure this module exists to prevent was observed, not imagined: an existing quota file
 * carried an invalid `tier` value that nothing ever surfaced, so the meter was quietly dead. A
 * present-but-broken token file must be loud, not silent.
 *
 * `bin/pi-check` (`EXT-04`, not this item) enforces the same rules at build/CI time by statting
 * the file and reading its JSON without ever using the secret. This module enforces them again at
 * the one place the token value actually gets used, so a file that passes CI and is later
 * re-permissioned (or hand-edited) by something outside this repo's control is still caught.
 */
import { readFile, stat } from "node:fs/promises";
import { describeError } from "../lib/once.ts";

/** `03` §8.5's exact enum — `pi-check` validates the same set. */
export const TOKEN_TIERS = ["free", "pro", "pro+", "business", "enterprise"] as const;
export type QuotaTokenTier = (typeof TOKEN_TIERS)[number];

export interface QuotaToken {
  readonly token: string;
  readonly tier?: QuotaTokenTier;
  /** Informational only (`REQ-PRV-28`'s dated record). The extension no longer branches on this
   *  field — `copilot.ts`'s parser reads the actual response shape instead, see its file header. */
  readonly regime?: string;
  readonly createdAt?: string;
}

export class QuotaTokenError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "QuotaTokenError";
  }
}

/**
 * Reads and validates the token file at `path`.
 *
 * Returns `undefined` when the file does not exist — "no quota token configured yet" is the
 * expected state for anyone who has not run the one-time setup in `docs/extensions/quota.md`,
 * not an error.
 *
 * Throws `QuotaTokenError` (fail loud, `REQ-PRV-32`) when the file exists but is unusable: wrong
 * permissions, invalid JSON, an empty/missing token, an unsupported `tier`, or a fine-grained
 * `github_pat_…` token — GitHub's enterprise premium-usage endpoint does not accept those,
 * so accepting one here would just move today's silent failure one level down.
 */
export async function readToken(path: string): Promise<QuotaToken | undefined> {
  let mode: number;
  try {
    const st = await stat(path);
    mode = st.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new QuotaTokenError(`could not stat ${path}: ${describeError(err)}`, err);
  }

  // Reject anything readable/writable by group or other. Exact 0600 is the documented target;
  // a stricter mode (e.g. 0400) is also fine and is not rejected — only excess exposure is.
  if ((mode & 0o077) !== 0) {
    throw new QuotaTokenError(
      `${path} must not be readable or writable by group/other (found mode ${mode.toString(8).padStart(3, "0")}, REQ-PRV-27 requires 0600)`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new QuotaTokenError(`could not read ${path}: ${describeError(err)}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QuotaTokenError(`${path} is not valid JSON: ${describeError(err)}`, err);
  }

  return validateToken(parsed, path);
}

/** Exported so tests can exercise validation without touching the filesystem. */
export function validateToken(parsed: unknown, path = "<in-memory>"): QuotaToken {
  const fail = (msg: string): never => {
    throw new QuotaTokenError(`${path}: ${msg}`);
  };
  if (typeof parsed !== "object" || parsed === null) fail("root must be a JSON object");
  const root = parsed as Record<string, unknown>;

  // `fail`'s `never` return type does not narrow `token` for TS's control-flow analysis here
  // (same limitation `config.ts`'s `validateQuotaConfig` sidesteps with explicit `as` casts after
  // each guard) — cast once, right after the guard, rather than relying on narrowing.
  const rawToken = root.token;
  if (typeof rawToken !== "string" || rawToken.length === 0) fail('"token" must be a non-empty string');
  const token = rawToken as string;
  if (token.startsWith("github_pat_")) {
    fail(
      '"token" is a fine-grained PAT (github_pat_…) — the enterprise premium usage endpoint requires ' +
        "a classic ghp_ token (REQ-PRV-27)",
    );
  }

  let tier: QuotaTokenTier | undefined;
  if (root.tier !== undefined) {
    if (typeof root.tier !== "string" || !(TOKEN_TIERS as readonly string[]).includes(root.tier)) {
      fail(`"tier" must be one of: ${TOKEN_TIERS.join(", ")}`);
    }
    tier = root.tier as QuotaTokenTier;
  }

  const regime = typeof root.regime === "string" ? root.regime : undefined;
  const createdAt = typeof root.createdAt === "string" ? root.createdAt : undefined;

  return { token, tier, regime, createdAt };
}

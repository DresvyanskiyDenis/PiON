/**
 * `config/quota.json` — owned by `EXT-09`, loaded by `extensions/quota/index.ts`.
 *
 * Follows `extensions/digest/config.ts`'s exact shape: a typed config, a `DEFAULT_*` constant, a
 * `load*Config()` that treats a missing file as "not configured yet" (fine, use defaults) and a
 * present-but-malformed file as a fail-loud error (`REQ-PRV-32`) — a typo here must never
 * silently turn into "the quota segment stopped updating" with no trace.
 */
import { readFile } from "node:fs/promises";
import { defaultTokenFilePath, quotaConfigPath } from "./paths.ts";

export interface PreflightConfig {
  /** `REQ-EXT-45`'s visibility half: warn before the turn's first provider request. */
  readonly enabled: boolean;
  /** Warn at or below this remaining percentage. Independent of `render()`'s own ≤10% icon. */
  readonly thresholdPct: number;
}

export interface QuotaConfig {
  readonly enabled: boolean;
  /** How long a fetched snapshot is trusted before the next non-forced refresh re-fetches it. */
  readonly ttlMs: number;
  /** Per-request budget for the `copilot_internal/user` call. */
  readonly timeoutMs: number;
  /** Expanded (`~`/`$HOME` resolved) absolute path to the classic PAT file. */
  readonly tokenFile: string;
  readonly preflight: PreflightConfig;
}

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  enabled: true,
  // Same cache lifetime `@narumitw/pi-usage`'s own `CACHE_TTL_MS` uses (src/usage.ts) — there is
  // no reason to poll GitHub's account endpoint more often than that package's own reviewed
  // default, and matching it means one fewer number to justify independently.
  ttlMs: 300_000,
  timeoutMs: 10_000,
  tokenFile: defaultTokenFilePath(),
  preflight: { enabled: true, thresholdPct: 15 },
};

export class QuotaConfigError extends Error {
  readonly path: string;
  constructor(message: string, path: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "QuotaConfigError";
    this.path = path;
  }
}

export async function loadQuotaConfig(path: string = quotaConfigPath()): Promise<QuotaConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_QUOTA_CONFIG;
    throw new QuotaConfigError(`could not read ${path}: ${(err as Error).message}`, path, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QuotaConfigError(`${path} is not valid JSON: ${(err as Error).message}`, path, err);
  }

  return validateQuotaConfig(parsed, path);
}

/** Exported so tests can exercise validation without touching the filesystem. */
export function validateQuotaConfig(parsed: unknown, path = "<in-memory>"): QuotaConfig {
  const fail = (msg: string): never => {
    throw new QuotaConfigError(`${path}: ${msg}`, path);
  };
  if (typeof parsed !== "object" || parsed === null) fail("root must be a JSON object");
  const root = parsed as Record<string, unknown>;
  const q = root.quota;
  if (typeof q !== "object" || q === null) fail('missing "quota" object');
  const d = q as Record<string, unknown>;

  const enabled = d.enabled ?? DEFAULT_QUOTA_CONFIG.enabled;
  if (typeof enabled !== "boolean") fail('"quota.enabled" must be a boolean');

  const ttlMs = d.ttlMs ?? DEFAULT_QUOTA_CONFIG.ttlMs;
  if (!isPositiveInt(ttlMs)) fail('"quota.ttlMs" must be a positive integer');

  const timeoutMs = d.timeoutMs ?? DEFAULT_QUOTA_CONFIG.timeoutMs;
  if (!isPositiveInt(timeoutMs)) fail('"quota.timeoutMs" must be a positive integer');

  const tokenFileRaw = d.tokenFile ?? DEFAULT_QUOTA_CONFIG.tokenFile;
  if (typeof tokenFileRaw !== "string" || tokenFileRaw.length === 0) {
    fail('"quota.tokenFile" must be a non-empty string');
  }

  const preflight = validatePreflight(d.preflight, fail);

  return {
    enabled: enabled as boolean,
    ttlMs: ttlMs as number,
    timeoutMs: timeoutMs as number,
    tokenFile: expandHome(tokenFileRaw as string),
    preflight,
  };
}

function validatePreflight(raw: unknown, fail: (msg: string) => never): PreflightConfig {
  if (raw === undefined) return DEFAULT_QUOTA_CONFIG.preflight;
  if (typeof raw !== "object" || raw === null) fail('"quota.preflight" must be an object');
  const p = raw as Record<string, unknown>;

  const enabled = p.enabled ?? DEFAULT_QUOTA_CONFIG.preflight.enabled;
  if (typeof enabled !== "boolean") fail('"quota.preflight.enabled" must be a boolean');

  const thresholdPct = p.thresholdPct ?? DEFAULT_QUOTA_CONFIG.preflight.thresholdPct;
  if (!isPercent(thresholdPct)) fail('"quota.preflight.thresholdPct" must be a number between 0 and 100');

  return { enabled: enabled as boolean, thresholdPct: thresholdPct as number };
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isPercent(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

/**
 * `~` and `$HOME`/`${HOME}` expansion — identical behaviour to `extensions/digest/config.ts`'s
 * `expandHome`, duplicated here rather than lifted into `extensions/lib/`: it is five lines, and
 * adding a new shared-lib export is not this item's file to make.
 */
export function expandHome(path: string): string {
  const home = process.env.HOME ?? "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path.replace(/\$\{HOME\}|\$HOME/g, home);
}

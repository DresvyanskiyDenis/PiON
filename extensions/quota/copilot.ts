/**
 * The Copilot quota read path — `GET https://api.github.com/copilot_internal/user` (the *public*
 * github.com account-info endpoint; distinct from the chat endpoint `models.json` points at, which
 * on an enterprise data-residency seat is a `copilot-api.<tenant>.ghe.com` host) plus the
 * field-shape parser.
 *
 * ## Why this is a port, not an import, of `@narumitw/pi-usage`
 *
 * `docs/PACKAGES.md`'s own `@narumitw/pi-usage` entry says it plainly: *"the real fallback is
 * copying the endpoint knowledge into `EXT-09`"*. Two independent, verified reasons this item
 * takes that fallback rather than importing the package:
 *
 * 1. **Auth is incompatible.** `src/query.ts`'s `resolveGitHubCopilotUsageAuth` requires a PI
 *    `/login`-issued OAuth credential (`credential.type === "oauth"`) and explicitly throws on a
 *    non-public GitHub domain ("does not yet support GitHub Enterprise accounts"). This repo's
 *    Copilot config never runs `/login github-copilot` (binding fact: its OAuth resolver clobbers
 *    the `baseUrl` override) and authenticates with an apiKey instead — so the package's own
 *    query path cannot be used for our provider's *chat* credential at all. `EXT-09`'s meter uses
 *    a wholly separate classic PAT (`REQ-PRV-27`), so this only matters as a reason not to import
 *    `query.ts`; it does not block reusing the pure `normalizeGitHubCopilotUsagePayload` function.
 * 2. **The pure function cannot be imported either, for a tooling reason, not a design one.**
 *    The package ships TypeScript source with no `main`/`exports` field (`pi.extensions` is its
 *    only entry point, meant for PI's own jiti loader as a *standalone* discovered extension, not
 *    as an importable library). Confirmed live in this environment:
 *    `node --test` refuses to import any `.ts` file under `node_modules` —
 *    `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: Stripping types is currently unsupported for
 *    files under node_modules` — so any module that imported it would make every test that
 *    transitively touches this file un-runnable under `node --test` (this repo's own testing
 *    convention, `EXT-04a` precedent). `EXT-12a` hit the identical error
 *    against a sibling `@narumitw/*` package and made the same call.
 *
 * The functions below are a source-cited reimplementation of
 * `@narumitw/pi-usage@0.49.3` `src/providers/github-copilot.ts` (reviewed and pinned in
 * `docs/PACKAGES.md`, sha256 `4720586…e9adef6`), narrowed to the one bucket `REQ-PRV-26/-28`
 * actually meters (`premium_interactions`) plus the free-tier fallback it also parses. Re-diff
 * against that file on any `@narumitw/pi-usage` version bump.
 *
 * ## One real tenant shape, measured
 *
 * A Copilot Business seat on a GitHub Enterprise Cloud data-residency tenant reported
 * `quota_snapshots.premium_interactions = { unlimited: true, token_based_billing: true }` — a
 * syntactically valid, fully-parseable response that legitimately carries **no number to render**.
 * That is `unlimited`, below, and it is a different case from `QuotaUnavailable` (the endpoint
 * genuinely not answering, or answering with a shape this parser does not recognise at all).
 * Both cases render the same honest `"quota —"` (`REQ-PRV-23`: never a fabricated `0%`), but only
 * `QuotaUnavailable` is a *failure* — `unlimited` is the correct, understood answer.
 */
import { describeError } from "../lib/once.ts";

const DEFAULT_USAGE_URL = "https://api.github.com/copilot_internal/user";
/** Matches the classic-PAT header shape used throughout the V-13 verification procedure and
 *  `@narumitw/pi-usage`'s own request (`query.ts`'s `fetchProviderJson`). */
const USER_AGENT = "GitHubCopilotChat/0.26.7";
const EDITOR_VERSION = "vscode/1.99.0";

export type QuotaKind = "metered" | "unlimited";

export interface QuotaSnapshot {
  readonly kind: QuotaKind;
  /** `"premium_requests" | "ai_credits" | "chat_requests"` — underscored, matching the field
   *  names `/quota`'s output leads with. */
  readonly id: string;
  readonly label: string;
  readonly used?: number;
  readonly limit?: number;
  /** Present only when `kind === "metered"`. Never fabricated for `"unlimited"`. */
  readonly remainingPct?: number;
  readonly resetsAt?: string;
  readonly plan?: string;
  readonly fetchedAt: number;
}

/** The endpoint did not answer usefully: non-2xx, a network/timeout failure, invalid JSON, or a
 *  response shape this parser does not recognise at all. Always degrades; never crashes a
 *  session — see `index.ts`'s `refresh()`. */
export class QuotaUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "QuotaUnavailable";
  }
}

/**
 * Fetches and parses the quota snapshot. `url` is a parameter (default the real endpoint), not a
 * hardcoded call site, so tests can point it at a local `node:http` server — the same technique
 * `extensions/lib/local-catalogue.ts`'s `fetchLiveModelIds` tests use.
 */
export async function fetchQuota(
  token: string,
  signal: AbortSignal,
  url: string = DEFAULT_USAGE_URL,
): Promise<QuotaSnapshot> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": USER_AGENT,
        "Editor-Version": EDITOR_VERSION,
      },
      signal,
    });
  } catch (err) {
    throw new QuotaUnavailable(`${url} request failed: ${describeError(err)}`, err);
  }

  if (!res.ok) {
    throw new QuotaUnavailable(`${url} -> HTTP ${res.status} ${res.statusText}`.trim());
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new QuotaUnavailable(`${url} returned invalid JSON: ${describeError(err)}`, err);
  }

  return normalizeCopilotQuota(payload, Date.now());
}

/**
 * The ported parser. Mirrors `@narumitw/pi-usage`'s branch order exactly: `premium_interactions`
 * first (billing-regime-tagged via `token_based_billing`, "unlimited" short-circuits before any
 * numeric field is read), then the free-tier `limited_user_quotas`/`monthly_quotas.chat` fallback,
 * then `QuotaUnavailable` — there is no third, silent "assume zero" branch.
 */
export function normalizeCopilotQuota(payload: unknown, fetchedAt: number): QuotaSnapshot {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new QuotaUnavailable("copilot_internal/user response was not a JSON object");
  }
  const root = payload as Record<string, unknown>;
  const plan = asString(root.copilot_plan) ?? asString(root.access_type_sku);
  const snapshots = asObject(root.quota_snapshots);
  const premium = asObject(snapshots?.premium_interactions);

  if (premium) {
    const tokenBasedBilling = premium.token_based_billing === true;
    const id = tokenBasedBilling ? "ai_credits" : "premium_requests";
    const label = tokenBasedBilling ? "AI credits" : "Premium requests";

    if (premium.unlimited === true) {
      return { kind: "unlimited", id, label, plan, fetchedAt };
    }

    const entitlement = asNonnegativeNumber(premium.entitlement);
    const rawRemaining = asFiniteNumber(premium.remaining) ?? asFiniteNumber(premium.quota_remaining);
    if (entitlement === undefined || rawRemaining === undefined) {
      throw new QuotaUnavailable(`${label} quota response was incomplete (missing entitlement/remaining)`);
    }
    const remaining = Math.max(0, rawRemaining);
    const used = asNonnegativeNumber(premium.credits_used) ?? Math.max(0, entitlement - remaining);
    return {
      kind: "metered",
      id,
      label,
      used,
      limit: entitlement,
      remainingPct: pct(remaining, entitlement),
      resetsAt: resetTimestamp(root),
      plan,
      fetchedAt,
    };
  }

  const limited = asObject(root.limited_user_quotas);
  const monthly = asObject(root.monthly_quotas);
  const remaining = asNonnegativeNumber(limited?.chat);
  const entitlement = asNonnegativeNumber(monthly?.chat);
  if (remaining === undefined || entitlement === undefined) {
    throw new QuotaUnavailable(
      "copilot_internal/user response contained no supported quota shape " +
        "(neither quota_snapshots.premium_interactions nor limited_user_quotas.chat)",
    );
  }
  return {
    kind: "metered",
    id: "chat_requests",
    label: "Chat requests",
    used: Math.max(0, entitlement - remaining),
    limit: entitlement,
    remainingPct: pct(remaining, entitlement),
    resetsAt: resetTimestamp(root),
    plan,
    fetchedAt,
  };
}

/** The footer segment. `REQ-PRV-23`: an unmeterable state renders an honest `"—"`, never a
 *  fabricated `0%` (or a fabricated `100%` for `"unlimited"`, which would be just as dishonest). */
export function render(snapshot: QuotaSnapshot): string {
  if (snapshot.kind !== "metered" || snapshot.remainingPct === undefined) return "quota —";
  return `${snapshot.remainingPct <= 10 ? "⚠ " : ""}quota ${snapshot.remainingPct}%`;
}

/** The `/quota` command's text. Leads with the underscored `id` deliberately — it is the one
 *  stable, greppable token in the output regardless of which regime a tenant is on. */
export function describeSnapshot(snapshot: QuotaSnapshot): string {
  const planSuffix = snapshot.plan ? `, plan ${snapshot.plan}` : "";
  if (snapshot.kind === "unlimited") {
    return `${snapshot.id} (${snapshot.label}): unlimited, token-based billing${planSuffix}`;
  }
  const resetSuffix = snapshot.resetsAt ? `, resets ${snapshot.resetsAt}` : "";
  return `${snapshot.id} (${snapshot.label}): ${snapshot.used}/${snapshot.limit} used, ${snapshot.remainingPct}% left${resetSuffix}${planSuffix}`;
}

function pct(remaining: number, limit: number): number {
  return limit > 0 ? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))) : 100;
}

function resetTimestamp(root: Record<string, unknown>): string | undefined {
  const raw =
    asString(root.quota_reset_date_utc) ?? asString(root.quota_reset_date) ?? asString(root.limited_user_reset_date);
  if (!raw) return undefined;
  return Number.isNaN(Date.parse(raw)) ? undefined : raw;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n === undefined || n < 0 ? undefined : n;
}

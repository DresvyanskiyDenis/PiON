/**
 * The `local` lane: an OpenAI-compatible model server on `127.0.0.1:8888` (`EXT-13`, `REQ-PRV-22`).
 *
 * Everything here is pure or takes its I/O target as an argument, so the whole lane is testable
 * without loading PI. `extensions/credentials.ts` is the thin wiring on top.
 *
 * ## The two budgets
 * Model discovery gets **3 s, hard** because it runs on the startup path — a dead local server must
 * cost 3 s, not 120 s, and must never be fatal. First-token-of-a-cold-model gets **300 s**, set
 * transport-wide by `settings.json` `httpIdleTimeoutMs`, not here. Without the split, one
 * unreachable local server makes `pi --list-models` (and therefore `verify.sh` and every cron
 * recipe) hang for the full stream timeout.
 *
 * ## Why the whole lane is non-fatal
 * `routing.json` marks the `local` tier `"optional": true`. Anyone without a local server must
 * still be able to start the agent, so an unreachable server is a one-line warning and every
 * other provider is unaffected. This is the one place in the tree where "fail loud" means "say
 * it once and carry on" rather than "abort" — because the failure is *environmental*, not a
 * provider call the user asked for. The moment the user actually selects a `local/…` model, the
 * failure goes through `provider-error.ts` and aborts like every other provider.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { describeError } from "./once.ts";

export const DISCOVERY_TIMEOUT_MS = 3_000;

/** Default local-server listener. Read per call, never hoisted — tests and `pi-env.sh` both set it. */
export function localBaseUrl(): string {
  return process.env.PI_LOCAL_BASE_URL ?? "http://127.0.0.1:8888/v1";
}

interface OpenAIModelList {
  data?: Array<{ id?: unknown }>;
}

/**
 * `GET {baseUrl}/models` inside a hard 3 s budget.
 *
 * Returns `undefined` — never throws, never returns `[]` — when the server is unreachable, slow,
 * or answers with anything that is not a usable model list. `undefined` means "no opinion", and
 * every caller treats it as "leave the configured catalogue exactly as it is". Returning `[]`
 * here would be a factual claim that the local server serves zero models, and `mergeLocalCatalogue`
 * would act on it by deleting the curated entries.
 *
 * NOTE (ported from `searxng.ts`): a fired `AbortSignal.timeout` stays aborted forever, so the
 * timeout signal is constructed per call and never hoisted to module scope.
 */
export async function fetchLiveModelIds(
  baseUrl: string,
  outerSignal?: AbortSignal,
): Promise<string[] | undefined> {
  const budget = outerSignal
    ? AbortSignal.any([outerSignal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)])
    : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: budget });
    if (!res.ok) return undefined;
    const body = (await res.json()) as OpenAIModelList;
    if (!Array.isArray(body?.data)) return undefined;
    const ids = body.data
      .map((entry) => entry?.id)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

export type PingResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** The `session_start` warm-up ping. Same 3 s budget, same never-throws contract. */
export async function pingLocal(baseUrl: string): Promise<PingResult> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}`.trim() };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: describeError(err) };
  }
}

/* ------------------------------------------------------------------------------------------- *
 * models.json — read, never written
 * ------------------------------------------------------------------------------------------- */

/** Only the fields this module needs. `models.json` carries more and it is passed through. */
export interface ConfiguredModelEntry {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  input?: unknown;
  cost?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConfiguredLocalProvider {
  api?: unknown;
  baseUrl?: unknown;
  compat?: Record<string, unknown>;
  models: ConfiguredModelEntry[];
}

/**
 * Read `providers.local` out of a `models.json`.
 *
 * Returns `undefined` for "I could not read it" — file missing, unreadable, invalid JSON, or no
 * `local` provider. That is not an error: a colleague may not have a `local` block at all.
 */
export async function readConfiguredLocalProvider(
  modelsJsonPath: string,
): Promise<ConfiguredLocalProvider | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(modelsJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  const providers = (parsed as { providers?: Record<string, unknown> } | null)?.providers;
  const local = providers?.["local"] as ConfiguredLocalProvider | undefined;
  if (!local || typeof local !== "object") return undefined;
  const models = Array.isArray(local.models) ? local.models : [];
  return { api: local.api, baseUrl: local.baseUrl, compat: local.compat, models };
}

/* ------------------------------------------------------------------------------------------- *
 * The merge
 * ------------------------------------------------------------------------------------------- */

export interface MergeResult {
  readonly models: ProviderModelConfig[];
  /** Live ids with no `models.json` entry — synthesised with conservative defaults. */
  readonly synthesised: string[];
  /** `models.json` ids the local server is not currently serving — dropped, and said out loud. */
  readonly dropped: string[];
}

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Compose the list `refreshModels` publishes: the local server's live ids, carrying `models.json`'s
 * tuning wherever the two overlap.
 *
 * **This is a deliberate deviation from an earlier draft, and it is not cosmetic.** That draft's
 * `refreshModels` returns a freshly synthesised entry per live id. PI's composer
 * (`dist/core/provider-composer.js`, `applyExtension`) *replaces* the provider's model list with
 * whatever an extension returns and uses the `models.json` entry only as a source of `api` and
 * `baseUrl` defaults — every other field is taken from the returned definition verbatim. Shipping
 * the spec's version therefore silently discards, for all four local models:
 *   - `samplingParams` (Qwen3.6 needs `temperature 0.6 / top_p 0.95 / top_k 20`; Gemma-4 needs
 *     `temperature 1.0 / top_k 64` — wrong sampling is a quality regression nobody would trace
 *     back to a model-catalogue refresh),
 *   - model-level `compat.thinkingFormat` and `chatTemplateKwargs`,
 *   - the provider-level `compat` block, whose `supportsDeveloperRole: false` is what stops PI
 *     sending a `developer` role that llama.cpp does not accept,
 *   - the tuned `contextWindow` (80 000 / 60 000, not the generic 128 000) and display names.
 *
 * So the merge replicates PI's own `modelFromJson` defaulting and `mergeCompat` layering
 * (provider compat first, model compat over it) and hands back complete definitions.
 */
export function mergeLocalCatalogue(
  configured: ConfiguredLocalProvider,
  liveIds: readonly string[],
): MergeResult {
  const byId = new Map<string, ConfiguredModelEntry>();
  for (const entry of configured.models) {
    if (typeof entry?.id === "string") byId.set(entry.id, entry);
  }

  const models: ProviderModelConfig[] = [];
  const synthesised: string[] = [];
  const seen = new Set<string>();

  for (const id of liveIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id);
    if (entry) {
      models.push(fromConfigured(id, entry, configured));
    } else {
      synthesised.push(id);
      models.push(synthesise(id, configured));
    }
  }

  const dropped = [...byId.keys()].filter((id) => !seen.has(id));
  return { models, synthesised, dropped };
}

function fromConfigured(
  id: string,
  entry: ConfiguredModelEntry,
  provider: ConfiguredLocalProvider,
): ProviderModelConfig {
  const compat = mergeCompat(provider.compat, entry.compat);
  const model: Record<string, unknown> = {
    ...entry,
    id,
    name: typeof entry.name === "string" ? entry.name : id,
    reasoning: entry.reasoning === true,
    input: isStringArray(entry.input) ? entry.input : ["text"],
    cost: isObject(entry.cost) ? entry.cost : { ...DEFAULT_COST },
    contextWindow: isPositiveNumber(entry.contextWindow)
      ? entry.contextWindow
      : DEFAULT_CONTEXT_WINDOW,
    maxTokens: isPositiveNumber(entry.maxTokens) ? entry.maxTokens : DEFAULT_MAX_TOKENS,
  };
  if (compat) model["compat"] = compat;
  else delete model["compat"];
  return model as unknown as ProviderModelConfig;
}

/**
 * A live id with no `models.json` entry. Conservative on purpose: `reasoning: false` and text-only,
 * because claiming a capability the local server may not have is the kind of silent wrongness this
 * project forbids. The provider-level `compat` block still applies — it describes the *server*,
 * not the model.
 */
function synthesise(id: string, provider: ConfiguredLocalProvider): ProviderModelConfig {
  const model: Record<string, unknown> = {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { ...DEFAULT_COST },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  const compat = mergeCompat(provider.compat, undefined);
  if (compat) model["compat"] = compat;
  return model as unknown as ProviderModelConfig;
}

/**
 * Replica of PI's `mergeCompat` (`dist/core/provider-composer.js`): a shallow merge with the four
 * known nested objects merged one level deeper. Kept in step with that function by
 * `test/ext-13-local-catalogue.test.ts`; re-check it on a PI bump.
 */
const NESTED_COMPAT_KEYS = [
  "openRouterRouting",
  "vercelGatewayRouting",
  "chatTemplateKwargs",
  "chatTemplateArgs",
] as const;

export function mergeCompat(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!override) return base;
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of NESTED_COMPAT_KEYS) {
    const baseValue = base?.[key];
    const overrideValue = override[key];
    if (isObject(baseValue) || isObject(overrideValue)) {
      merged[key] = { ...(isObject(baseValue) ? baseValue : {}), ...(isObject(overrideValue) ? overrideValue : {}) };
    }
  }
  return merged;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Publishing the cross-session job store to `pi-subagents`' two well-known registries.
 *
 * - **background-work** (`Symbol.for("pi-subagents.background-work.v1")`) — a provider whose
 *   `listActiveWork()` keeps `subagent_wait` / auto-drain awake while our detached jobs are
 *   still running, so "wait for background work" means *all* background work, not only the
 *   package's own async runs.
 * - **external-runs** (`Symbol.for("pi-subagents.external-runs.v2")`) — display-only records of
 *   "work owned by another runtime", which is exactly what a process that outlives its `pi`
 *   session is. This is what puts our jobs on the fleet panel below the editor, next to the
 *   package's own children (`pi-subagents/src/tui/fleet-status.ts:432`, rendered as
 *   `external · <label>`).
 *
 * **The two registries are not the same shape, and that is the whole point of this file.**
 * background-work is a *pull* registry: we hand it a provider and it calls `listActiveWork()`
 * whenever it wants to know. external-runs used to be one too — `v1`, `{version, providers}` —
 * and this module registered a provider into it. `pi-subagents` 0.57.0 replaced that with `v2`,
 * a *push* registry of records: `{version, runs: Map<`${sessionId}\0${id}`, ExternalRun>}`, whose
 * producers call `registerExternalRun` / `updateExternalRun` / `unregisterExternalRun`
 * (`src/api/external-runs.ts`). Nothing reads `v1` any more. A provider registered there is
 * registered into a global object that this process creates, nobody consumes, and no error is
 * raised about — which is precisely how our jobs went missing from the panel without a symptom
 * other than their absence. `publishExternalRuns` below is the push side of that protocol.
 *
 * The **version assertion cannot catch this class of break**, and it is worth being explicit
 * about why rather than trusting it again: the version lives *inside* the registry, but the
 * registry is addressed by a *versioned symbol*. A bump moves the whole registry to a new key,
 * so the old key is simply unoccupied and we happily create it ourselves. The assertion protects
 * against a same-key shape change and nothing else. What catches a key bump is a test that
 * asserts the key string we publish to against the one the installed package reads — see
 * `test/jobs/registry.test.ts`.
 *
 * **Why the protocol is re-implemented instead of imported.** `pi-subagents` exports these
 * from `pi-subagents/background-work` and `pi-subagents/external-runs`, but both are `.ts`
 * source files inside `node_modules`, and Node refuses type-stripping there
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — the same wall `EXT-22` and `EXT-12a` hit.
 * Importing them would make `node --test` unable to load this module at all.
 *
 * The registries are process-local (`globalThis`), so this creates no cross-process coupling
 * and works whether or not `pi-subagents` is loaded in this session.
 */
import { describeError } from "../lib/once.ts";
import type { JobState } from "./store.ts";

export const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
export const BACKGROUND_WORK_PROTOCOL_VERSION = 1;
export const EXTERNAL_RUN_REGISTRY_KEY = "pi-subagents.external-runs.v2";
export const EXTERNAL_RUN_REGISTRY_VERSION = 2;

/** Our provider name in the background-work registry, and our `source` on every run record. */
export const PROVIDER_NAME = "pi-config-jobs";

/** Both registries reject an id or session id longer than this. */
const MAX_ID_LENGTH = 256;
/** `external-runs` bounds an id harder than background-work does (`maxIdentityLength`). */
const MAX_RUN_ID_LENGTH = 160;
/**
 * A pi-subagents session id is the session *file path*, so it gets its own budget
 * (`EXTERNAL_RUN_LIMITS.maxSessionIdLength`).
 */
const MAX_SESSION_ID_LENGTH = 4_096;
/** `external-runs` rejects free text longer than this (`maxTextLength`). */
const MAX_TEXT_LENGTH = 160;
/**
 * How many of our runs may sit in the shared cache at once.
 *
 * The registry's own ceiling is 100 records across *all* producers and a snapshot is cut to 20
 * (`EXTERNAL_RUN_LIMITS.maxCachedRuns` / `maxSnapshotRuns`). We write into the map directly —
 * `registerExternalRun`, the function that would enforce the 100, is unimportable here — so the
 * self-limit has to be ours. 20 is the snapshot width: publishing a 21st running job could not
 * show it anyway, and spending the shared budget on a record nobody can see would starve the
 * package's own children out of their panel.
 */
const MAX_PUBLISHED_RUNS = 20;

interface ProviderRegistry<P> {
  version: number;
  providers: Map<string, P>;
}

interface BackgroundWorkItem {
  id: string;
  sessionId: string;
}

interface BackgroundWorkProvider {
  name: string;
  listActiveWork(): readonly BackgroundWorkItem[];
}

/** `queued` and `pending` exist in the protocol; a detached job is never either. */
export type ExternalRunState = "running" | "completed" | "failed" | "stopped";

/**
 * Exactly the fields we set, and no others: `validateRun` rejects a record carrying a key it does
 * not know (`inputObject`, `external-runs.ts:83-88`), so the `cwd`, `exitCode` and
 * `completionReason` this module used to publish under `v1` would now delete the record on read
 * rather than decorate it.
 */
export interface ExternalRunRecord {
  id: string;
  sessionId: string;
  source: string;
  label: string;
  state: ExternalRunState;
  startedAt: number;
}

interface ExternalRunRegistry {
  version: number;
  runs: Map<string, ExternalRunRecord>;
}

/**
 * The shared guard for both registries: one key discipline, one version discipline, one message.
 *
 * `collection` is the field each protocol keeps its members in — `providers` for background-work,
 * `runs` for external-runs. It is checked because a slot whose shape disagrees with the version it
 * claims is not one this build can safely write into, and because the two protocols diverging on
 * exactly that field is what this file exists to keep straight.
 */
function registrySlot<T extends object>(key: string, version: number, collection: string, create: () => T): T {
  const symbol = Symbol.for(key);
  const target = globalThis as Record<PropertyKey, unknown>;
  const existing = target[symbol];
  if (existing === undefined) {
    const created = create();
    target[symbol] = created;
    return created;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`malformed registry at Symbol.for("${key}")`);
  }
  const candidate = existing as Record<string, unknown>;
  if (candidate.version !== version || !(candidate[collection] instanceof Map)) {
    throw new Error(
      `registry at Symbol.for("${key}") is version ${String(candidate.version)}, ` +
        `this build speaks version ${version} — refusing to register rather than corrupt it`,
    );
  }
  return existing as T;
}

function registryFor<P>(key: string, version: number): ProviderRegistry<P> {
  return registrySlot<ProviderRegistry<P>>(key, version, "providers", () => ({ version, providers: new Map() }));
}

function runRegistry(): ExternalRunRegistry {
  return registrySlot<ExternalRunRegistry>(
    EXTERNAL_RUN_REGISTRY_KEY,
    EXTERNAL_RUN_REGISTRY_VERSION,
    "runs",
    () => ({ version: EXTERNAL_RUN_REGISTRY_VERSION, runs: new Map() }),
  );
}

/** The key `external-runs` files a record under. */
export function externalRunKey(sessionId: string, id: string): string {
  return `${sessionId}\0${id}`;
}

/** Both protocols reject empty, untrimmed, over-long or NUL-bearing strings. */
function usableId(value: unknown, maxLength: number = MAX_ID_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= maxLength &&
    !value.includes("\0")
  );
}

/**
 * Whether `sanitizeDisplayText` would return this string unchanged.
 *
 * `external-runs` runs ids and session ids through `identity()`, which demands
 * `sanitizeDisplayText(value) === value` and **throws** otherwise — and a throw on *read* deletes
 * the record (`snapshotExternalRuns` with `ignoreMalformed`). So a record that fails this test
 * would not merely render oddly, it would vanish, which is the bug this file is fixing.
 *
 * The sanitiser strips ANSI introducers and collapses every run of whitespace-or-control to a
 * single space (`pi-subagents/src/shared/display-text.ts`). A string survives it untouched iff it
 * carries no control characters, no whitespace other than `U+0020`, and no doubled space —
 * leading and trailing spaces are already excluded by the trim check above. Checked rather than
 * repaired: a job id or a session path is an identifier, and quietly rewriting one would file the
 * record under a key nothing else can find.
 */
function displayStable(value: string): boolean {
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return false;
  if (/\s/u.test(value.replace(/ /g, ""))) return false;
  return !value.includes("  ");
}

function usableText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\0/g, "").trim().slice(0, MAX_TEXT_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toExternalRunState(status: JobState["status"]): ExternalRunState {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
  }
}

export function toBackgroundWorkItems(jobs: readonly JobState[]): BackgroundWorkItem[] {
  const items: BackgroundWorkItem[] = [];
  for (const job of jobs) {
    if (job.status !== "running") continue;
    if (!usableId(job.id) || !usableId(job.parentSession)) continue;
    items.push({ id: job.id, sessionId: job.parentSession });
  }
  return items;
}

/**
 * A `JobState` as an `external-runs` record, or `undefined` when it cannot be represented.
 *
 * `sessionId` is passed in rather than read off the job, and the two are different identifiers
 * for the same session on purpose. `job.parentSession` is `sessionManager.getSessionId()`, which
 * is what this extension scopes its own announcements by. `pi-subagents` scopes the panel by
 * `resolveCurrentSessionId`, which prefers `getSessionFile()` — the session file *path* — and
 * only falls back to the id (`src/shared/session-identity.ts:6-10`). Filing our records under the
 * id would put them in the registry under a key the panel never queries.
 */
export function toExternalRun(job: JobState, sessionId: string): ExternalRunRecord | undefined {
  if (!usableId(job.id, MAX_RUN_ID_LENGTH) || !displayStable(job.id)) return undefined;
  if (!usableId(sessionId, MAX_SESSION_ID_LENGTH) || !displayStable(sessionId)) return undefined;
  const label = usableText(job.label ?? job.cmd);
  if (label === undefined) return undefined;
  if (!Number.isSafeInteger(job.startedAt) || job.startedAt < 0) return undefined;
  return {
    id: job.id,
    sessionId,
    source: PROVIDER_NAME,
    label,
    state: toExternalRunState(job.status),
    startedAt: job.startedAt,
  };
}

/**
 * The records this session should be advertising: its own running jobs, oldest first, bounded.
 *
 * Only *running* jobs, because the panel shows only active states
 * (`isActiveState`, `fleet-status.ts:96-98`) — a finished record would be invisible and would
 * still spend the shared cache budget. Only *this session's*, because `snapshotExternalRuns`
 * filters by session id, so a sibling session's job could not be rendered here either. Both
 * facts are the reason the store itself stays cross-session while this projection of it does not.
 */
export function toExternalRuns(jobs: readonly JobState[], sessionId: string): ExternalRunRecord[] {
  const runs: ExternalRunRecord[] = [];
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const run = toExternalRun(job, sessionId);
    if (run) runs.push(run);
  }
  runs.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  return runs.slice(0, MAX_PUBLISHED_RUNS);
}

/**
 * Makes the registry agree with `jobs` — the push half of `external-runs` v2.
 *
 * Idempotent and self-cleaning: it writes a record for every running job of this session and
 * removes every record it previously wrote that is no longer one, so calling it after a start,
 * on every sweep, and at session start is enough to keep the panel honest without any per-event
 * bookkeeping. Only records carrying our own `source` are ever removed; another producer's rows
 * are not this function's to touch.
 *
 * Returns the records now published, which is what the tests assert on.
 */
export function publishExternalRuns(sessionId: string, jobs: readonly JobState[]): ExternalRunRecord[] {
  const runs = toExternalRuns(jobs, sessionId);
  const current = runRegistry();
  const wanted = new Set(runs.map((run) => externalRunKey(run.sessionId, run.id)));
  for (const [key, value] of current.runs) {
    if (value?.source === PROVIDER_NAME && !wanted.has(key)) current.runs.delete(key);
  }
  for (const run of runs) current.runs.set(externalRunKey(run.sessionId, run.id), run);
  return runs;
}

/** Withdraws every record this producer published. The jobs themselves keep running. */
export function unpublishExternalRuns(): void {
  const current = runRegistry();
  for (const [key, value] of current.runs) {
    if (value?.source === PROVIDER_NAME) current.runs.delete(key);
  }
}

export interface RegisterProvidersOptions {
  /** Synchronous snapshot of the store. The protocol calls its list method synchronously. */
  readonly snapshot: () => readonly JobState[];
  /** Where a scan failure is reported. Never swallowed. */
  readonly onError: (line: string) => void;
}

/**
 * Registers the background-work provider and returns a disposer that removes exactly it.
 *
 * A failing snapshot is reported through `onError` and answered with an empty list rather
 * than a throw. That is deliberate and narrow: `snapshotBackgroundWork()` wraps a throwing
 * provider and rethrows, which would take down the caller's wait loop — the same
 * "one bug must not brick the agent" rule as `EXT-01`'s guarded-handler contract. The error
 * is surfaced, so this is not a swallow.
 *
 * The external-run half is *not* here any more: v2 is a push protocol, so it is
 * `publishExternalRuns`, called wherever the store is already being read.
 */
export function registerJobProviders(options: RegisterProvidersOptions): () => void {
  const safeSnapshot = (): readonly JobState[] => {
    try {
      return options.snapshot();
    } catch (err) {
      options.onError(`[pi-config] jobs: background-work snapshot failed: ${describeError(err)}`);
      return [];
    }
  };

  const backgroundWork: BackgroundWorkProvider = {
    name: PROVIDER_NAME,
    listActiveWork: () => toBackgroundWorkItems(safeSnapshot()),
  };
  const bgRegistry = registryFor<BackgroundWorkProvider>(
    BACKGROUND_WORK_REGISTRY_KEY,
    BACKGROUND_WORK_PROTOCOL_VERSION,
  );
  bgRegistry.providers.set(PROVIDER_NAME, backgroundWork);

  return () => {
    if (bgRegistry.providers.get(PROVIDER_NAME) === backgroundWork) {
      bgRegistry.providers.delete(PROVIDER_NAME);
    }
  };
}

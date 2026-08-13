/**
 * Publishing the cross-session job store to `pi-subagents`' two well-known registries.
 *
 * - **background-work** (`Symbol.for("pi-subagents.background-work.v1")`) — a provider whose
 *   `listActiveWork()` keeps `subagent_wait` / auto-drain awake while our detached jobs are
 *   still running, so "wait for background work" means *all* background work, not only the
 *   package's own async runs.
 * - **external-runs** (`Symbol.for("pi-subagents.external-runs.v1")`) — observational records
 *   of "work owned by another runtime", which is exactly what a process that outlives its
 *   `pi` session is. This is what makes our jobs visible in the package's inspectors.
 *
 * **Why the protocol is re-implemented instead of imported.** `pi-subagents` exports these
 * from `pi-subagents/background-work` and `pi-subagents/external-runs`, but both are `.ts`
 * source files inside `node_modules`, and Node refuses type-stripping there
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — the same wall `EXT-22` and `EXT-12a` hit.
 * Importing them would make `node --test` unable to load this module at all. The protocols are
 * a version tag plus a `Map`, they are versioned, and the version is asserted here: a bump on
 * their side surfaces as a loud error instead of a silent mis-registration.
 *
 * The registries are process-local (`globalThis`), so this creates no cross-process coupling
 * and works whether or not `pi-subagents` is loaded in this session.
 */
import { describeError } from "../lib/once.ts";
import type { JobState } from "./store.ts";

export const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
export const BACKGROUND_WORK_PROTOCOL_VERSION = 1;
export const EXTERNAL_RUN_REGISTRY_KEY = "pi-subagents.external-runs.v1";
export const EXTERNAL_RUN_REGISTRY_VERSION = 1;

/** Our provider name in both registries. */
export const PROVIDER_NAME = "pi-config-jobs";

/** Both registries reject an id or session id longer than this. */
const MAX_ID_LENGTH = 256;
/** `external-runs` rejects free text longer than this. */
const MAX_TEXT_LENGTH = 4_096;

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

type ExternalRunState = "running" | "completed" | "failed" | "stopped";
type ExternalRunCompletionReason = "exit" | "timeout" | "user-kill" | "auto-close-quiet" | "crash" | "unknown";

interface ExternalRun {
  id: string;
  sessionId: string;
  source: string;
  state: ExternalRunState;
  command?: string;
  cwd?: string;
  completionReason?: ExternalRunCompletionReason;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number | null;
}

interface ExternalRunProvider {
  name: string;
  listExternalRuns(): readonly ExternalRun[];
}

function registryFor<P>(key: string, version: number): ProviderRegistry<P> {
  const symbol = Symbol.for(key);
  const target = globalThis as Record<PropertyKey, unknown>;
  const existing = target[symbol];
  if (existing === undefined) {
    const created: ProviderRegistry<P> = { version, providers: new Map() };
    target[symbol] = created;
    return created;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`malformed registry at Symbol.for("${key}")`);
  }
  const candidate = existing as Partial<ProviderRegistry<P>>;
  if (candidate.version !== version || !(candidate.providers instanceof Map)) {
    throw new Error(
      `registry at Symbol.for("${key}") is version ${String(candidate.version)}, ` +
        `this build speaks version ${version} — refusing to register rather than corrupt it`,
    );
  }
  return candidate as ProviderRegistry<P>;
}

/** Both protocols reject empty, untrimmed, over-long or NUL-bearing strings. */
function usableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= MAX_ID_LENGTH &&
    !value.includes("\0")
  );
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

export function toCompletionReason(job: JobState): ExternalRunCompletionReason | undefined {
  if (job.status === "running") return undefined;
  if (job.status === "killed") return "user-kill";
  if (job.exitCode === -1) return "crash";
  return "exit";
}

/** A `JobState` as an `external-runs` record, or `undefined` when it cannot be represented. */
export function toExternalRun(job: JobState): ExternalRun | undefined {
  if (!usableId(job.id) || !usableId(job.parentSession)) return undefined;
  const command = usableText(job.label ?? job.cmd);
  const cwd = usableText(job.cwd);
  const reason = toCompletionReason(job);
  return {
    id: job.id,
    sessionId: job.parentSession,
    source: PROVIDER_NAME,
    state: toExternalRunState(job.status),
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(reason !== undefined ? { completionReason: reason } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { completedAt: job.finishedAt } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
  };
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

export function toExternalRuns(jobs: readonly JobState[]): ExternalRun[] {
  const runs: ExternalRun[] = [];
  for (const job of jobs) {
    const run = toExternalRun(job);
    if (run) runs.push(run);
  }
  return runs;
}

export interface RegisterProvidersOptions {
  /** Synchronous snapshot of the store. Both protocols call their list methods synchronously. */
  readonly snapshot: () => readonly JobState[];
  /** Where a scan failure is reported. Never swallowed. */
  readonly onError: (line: string) => void;
}

/**
 * Registers both providers and returns a disposer that removes exactly these registrations.
 *
 * A failing snapshot is reported through `onError` and answered with an empty list rather
 * than a throw. That is deliberate and narrow: `snapshotBackgroundWork()` wraps a throwing
 * provider and rethrows, which would take down the caller's wait loop — the same
 * "one bug must not brick the agent" rule as `EXT-01`'s guarded-handler contract. The error
 * is surfaced, so this is not a swallow.
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

  const disposers: Array<() => void> = [];

  const backgroundWork: BackgroundWorkProvider = {
    name: PROVIDER_NAME,
    listActiveWork: () => toBackgroundWorkItems(safeSnapshot()),
  };
  const bgRegistry = registryFor<BackgroundWorkProvider>(
    BACKGROUND_WORK_REGISTRY_KEY,
    BACKGROUND_WORK_PROTOCOL_VERSION,
  );
  bgRegistry.providers.set(PROVIDER_NAME, backgroundWork);
  disposers.push(() => {
    if (bgRegistry.providers.get(PROVIDER_NAME) === backgroundWork) {
      bgRegistry.providers.delete(PROVIDER_NAME);
    }
  });

  const externalRuns: ExternalRunProvider = {
    name: PROVIDER_NAME,
    listExternalRuns: () => toExternalRuns(safeSnapshot()),
  };
  const runRegistry = registryFor<ExternalRunProvider>(
    EXTERNAL_RUN_REGISTRY_KEY,
    EXTERNAL_RUN_REGISTRY_VERSION,
  );
  runRegistry.providers.set(PROVIDER_NAME, externalRuns);
  disposers.push(() => {
    if (runRegistry.providers.get(PROVIDER_NAME) === externalRuns) {
      runRegistry.providers.delete(PROVIDER_NAME);
    }
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}

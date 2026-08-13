/**
 * The module load registry: one mechanism, three consumers.
 *
 * PI does not expose `LoadExtensionsResult` to extensions — `ExtensionAPI` has `getAllTools`,
 * `getCommands` and `events`, and nothing that enumerates loaded or failed extensions (V-31).
 * So the reporting is ours, and because it is ours it is per *module* rather than per extension
 * file, which is strictly more granular than the platform's own.
 *
 * Consumers (built once, here, not three times):
 *   - `EXT-10` `/doctor`  — the expected-but-absent report (`report()`, `absentModules()`)
 *   - `EXT-30` deadman     — did a module that loaded ever reach `session_start`?
 *                            (`recordHeartbeat`, `silentModules()`)
 *   - `EXT-31` drift probe — the event/API inventory to diff an upstream release against
 *                            (`declareModule`, `eventInventory()`, `apiInventory()`)
 *
 * Three states have to stay distinguishable, because their fixes differ:
 *   loaded  — `register()` returned
 *   failed  — `register()` threw; the error text is kept
 *   absent  — declared in `DECLARED_MODULES` and never seen at all (the file did not even
 *             get as far as being called, e.g. the whole `index.ts` import graph broke)
 *
 * Module-level state, so the caveat from `once.ts` applies: this is a single registry only
 * because this tree mandates a single PI extension file.
 */

/**
 * The full module set, in the order `extensions/index.ts` composes them. Editing this list is
 * how a new module becomes *expected*; a module that registers without being listed is reported
 * as undeclared rather than ignored.
 *
 * `trust` (`EXT-30`) is built and composed as of the EXT-30 wave, so this list and
 * `index.ts`'s `ORDER` are now the same set — `test/integration/composition.test.ts` asserts it.
 * `trust`'s own `session_start` deadman reads `absentModules()`/`failedModules()` from here, so a
 * module removed from `ORDER` without being removed from this list is both reported by `/doctor`
 * and, if it is a guardrail, blocked on by the deadman. That is the intended failure mode; do not
 * "fix" it by deleting entries.
 */
export const DECLARED_MODULES = [
  // safety and identity — first, always
  "guard",
  "trust",
  "session-context",
  "credentials",
  // capability configuration that later modules read
  "path-defaults",
  "skills-env",
  "skill-mask",
  // tool providers and input mutators — after the guard, never before it
  "web",
  "bash",
  "hooks",
  "input-transform",
  "big-results",
  // orchestration
  "dispatch",
  "teammates",
  "worktree",
  "jobs",
  "tasks",
  // observability and lifecycle
  "quota",
  "digest",
  "compaction",
  "context-report",
  "context-imports",
  "session-index",
  "auto-title",
  "skills-lint",
  // diagnostics last, so it observes everything above
  "doctor",
] as const;

export type ModuleId = (typeof DECLARED_MODULES)[number];

export type ModuleLoadState = "loaded" | "failed" | "absent";

/** What a module says about itself at `session_start`. */
export interface ModuleDeclaration {
  readonly id: string;
  readonly version: string;
  /** PI event names bound, e.g. ["tool_call", "session_start"]. */
  readonly events: readonly string[];
  /** `pi.*` members used, e.g. ["registerTool", "appendEntry", "exec"]. */
  readonly apis: readonly string[];
}

export interface ModuleStatus {
  readonly id: string;
  readonly state: ModuleLoadState;
  /** Present in `DECLARED_MODULES`. */
  readonly declared: boolean;
  /** Reached `session_start` and called `recordHeartbeat`. */
  readonly heartbeat: boolean;
  readonly error?: string;
  readonly version?: string;
  readonly events: readonly string[];
  readonly apis: readonly string[];
}

export interface ManifestReport {
  readonly declared: readonly string[];
  readonly loaded: readonly string[];
  readonly failed: ReadonlyArray<readonly [string, string]>;
  /** Declared, but `register()` was never even attempted. */
  readonly absent: readonly string[];
  /** Registered without being declared — drift in the other direction. */
  readonly undeclared: readonly string[];
  /** Loaded, but never reached `session_start`. This is what the deadman watches. */
  readonly silent: readonly string[];
  readonly modules: readonly ModuleStatus[];
}

const loaded = new Set<string>();
const failed = new Map<string, string>();
const heartbeats = new Set<string>();
const declarations = new Map<string, ModuleDeclaration>();

export function recordLoad(id: string): void {
  loaded.add(id);
  failed.delete(id);
}

export function recordLoadFailure(id: string, err: unknown): void {
  loaded.delete(id);
  failed.set(id, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

/** Called from each module's `session_start` handler. The deadman's liveness signal. */
export function recordHeartbeat(id: string): void {
  heartbeats.add(id);
}

/** Called from each module's `session_start` handler. Implies a heartbeat. */
export function declareModule(decl: ModuleDeclaration): void {
  declarations.set(decl.id, decl);
  heartbeats.add(decl.id);
}

/** Declared modules whose `register()` returned. */
export function loadedModules(): ModuleId[] {
  return DECLARED_MODULES.filter((id) => loaded.has(id));
}

/** Declared modules whose `register()` threw, with the error text. */
export function failedModules(): Array<[ModuleId, string]> {
  return DECLARED_MODULES.filter((id) => failed.has(id)).map(
    (id) => [id, failed.get(id)!] as [ModuleId, string],
  );
}

/** The expected-but-absent report: declared, but never loaded and never reported as failed. */
export function absentModules(): ModuleId[] {
  return DECLARED_MODULES.filter((id) => !loaded.has(id) && !failed.has(id));
}

/** Registered under an id nobody declared. */
export function undeclaredModules(): string[] {
  const known = new Set<string>(DECLARED_MODULES);
  return [...new Set([...loaded, ...failed.keys(), ...heartbeats])].filter((id) => !known.has(id));
}

/** Loaded but never seen at `session_start` — a module that registered and then went quiet. */
export function silentModules(): string[] {
  return [...loaded].filter((id) => !heartbeats.has(id));
}

export function moduleStatus(id: string): ModuleStatus {
  const decl = declarations.get(id);
  const state: ModuleLoadState = failed.has(id) ? "failed" : loaded.has(id) ? "loaded" : "absent";
  const status: ModuleStatus = {
    id,
    state,
    declared: (DECLARED_MODULES as readonly string[]).includes(id),
    heartbeat: heartbeats.has(id),
    events: decl?.events ?? [],
    apis: decl?.apis ?? [],
  };
  const error = failed.get(id);
  return {
    ...status,
    ...(error === undefined ? {} : { error }),
    ...(decl === undefined ? {} : { version: decl.version }),
  };
}

export function manifestReport(): ManifestReport {
  const ids = [...new Set<string>([...DECLARED_MODULES, ...loaded, ...failed.keys(), ...heartbeats])];
  return {
    declared: [...DECLARED_MODULES],
    loaded: loadedModules(),
    failed: failedModules(),
    absent: absentModules(),
    undeclared: undeclaredModules(),
    silent: silentModules(),
    modules: ids.map(moduleStatus),
  };
}

/** `EXT-31`: every PI event this harness binds, deduped and sorted. */
export function eventInventory(): string[] {
  return dedupeSorted([...declarations.values()].flatMap((d) => d.events));
}

/** `EXT-31`: every `pi.*` member this harness calls, deduped and sorted. */
export function apiInventory(): string[] {
  return dedupeSorted([...declarations.values()].flatMap((d) => d.apis));
}

/** Test-only. */
export function resetManifest(): void {
  loaded.clear();
  failed.clear();
  heartbeats.clear();
  declarations.clear();
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

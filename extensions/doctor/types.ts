/**
 * `EXT-10` shared types. Kept in their own file because `checks.ts`, `render.ts` and the unit
 * tests all need them without pulling in `extensions/doctor.ts`'s `register()` (which imports a
 * live `ExtensionAPI` type only available inside a real PI process).
 *
 * The check-id union is a superset of an earlier draft's six ids. Two are added because
 * this item's own task text — not just the older per-item spec — requires them:
 *   - `D-07` every MCP **server** named in the instruction text resolves against
 *     `config/mcp.json`'s declared servers (the spec's summary line says "skill, agent, tool
 *     **and server**"; the six-row table underneath it never actually defines a server check).
 *   - `D-08` the adopted-package report (R-13).
 *   - `D-09` the hook layer is carrying rules. Added 2026-08-11 with the `hooks.yaml` polarity
 *     reversal (`docs/DENYLIST.md` §4a finding #5): a broken hooks file now degrades `EXT-15` to
 *     zero rules instead of containing the session, and a degraded hook layer is invisible from
 *     the outside — every tool call simply proceeds. Without this check the only signal is one
 *     `error` announcement at session start, which scrolls away.
 */

export type Severity = "ok" | "warn" | "error";

export type CheckId = "D-01" | "D-02" | "D-03" | "D-04" | "D-05" | "D-06" | "D-07" | "D-08" | "D-09";

export interface Finding {
  readonly check: CheckId;
  readonly severity: Severity;
  /** The offending name, path or module id. */
  readonly subject: string;
  readonly message: string;
  /** What the human does about it — never empty. */
  readonly action: string;
}

export interface DoctorReport {
  readonly findings: readonly Finding[];
  readonly modules: { readonly declared: number; readonly loaded: number; readonly failed: readonly string[] };
  readonly skills: { readonly count: number };
  readonly agents: { readonly count: number };
  readonly tools: { readonly count: number; readonly names: readonly string[] };
  /** `D-07`. Declared MCP servers, regardless of `disabled`. */
  readonly servers: { readonly count: number; readonly names: readonly string[] };
  /** `D-06`. `guard:ready` observation is best-effort (see `doctor.ts` module docstring for why);
   *  `moduleLoaded` — sourced from `manifest.ts`, not the event — is what D-06 actually gates on. */
  readonly guard: {
    readonly moduleLoaded: boolean;
    readonly handshakeObserved: boolean;
    readonly version?: string;
    readonly gateCount?: number;
    readonly selfTestPatternId: string | null;
    readonly selfTestOk: boolean;
  };
  /**
   * The model summary line, renamed field by field on 2026-08-15 because the old shape encouraged
   * exactly one wrong reading. It used to be `{ available, uncredentialed }`, and `uncredentialed`
   * held every entry in the model registry without a credential — which `render.ts` then printed as
   * "declared-but-uncredentialed". Neither half was true: those entries are the registry PI ships,
   * nothing in this configuration declares them, nothing is missing because of them, and the list is
   * as long as the registry's uncredentialed tail. `/doctor` output can land in the model's context,
   * so enumerating it cost tokens to say nothing.
   *
   * The names below are chosen so the mistake cannot be repeated by reading the field name alone.
   */
  readonly models: {
    /** Every entry the model registry returns — the registry's size, not a claim about config. */
    readonly inRegistry: number;
    /** Of those, the ones that carry a credential here: the models that can actually answer. */
    readonly usableHere: number;
    /**
     * The only genuinely interesting list: `provider/id` for models **this configuration
     * references** — `routing.json` tier `model` and `fallback` refs, thinking suffix stripped —
     * that resolve in the registry but have no credential. A mere registry entry never appears
     * here. `D-04` carries the per-tier diagnosis; this is the count's subject line.
     */
    readonly referencedWithoutCredential: readonly string[];
  };
  /** `D-08`. `config/packages.lock.json` cross-referenced against `node_modules/`. */
  readonly packages: {
    readonly declared: number;
    readonly resolved: number;
    readonly absent: readonly string[];
    readonly versionMismatch: readonly string[];
  };
  /** `D-09`. `undefined` reason = the hook layer loaded its rules normally. */
  readonly hooks: { readonly degradedReason?: string };
  /** `false` when any finding has severity `"error"`. */
  readonly ok: boolean;
}

export function reportIsOk(findings: readonly Finding[]): boolean {
  return !findings.some((f) => f.severity === "error");
}

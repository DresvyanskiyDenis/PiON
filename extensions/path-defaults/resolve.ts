/**
 * Pure resolution logic — no PI import, no I/O, no clock — so the whole rule set is
 * unit-testable, the same split `extensions/compaction/loop-guard.ts` uses.
 *
 * `rootFor` (longest-prefix `cwd` matching) and `config.ts`'s `expandHome` are both gone: there is
 * no longer a per-directory root to match against `cwd`, so a `cwd`-shaped matcher has nothing
 * left to compute. `explicitModelRequested` and `statusFlag` below are untouched — neither one was
 * ever about *which* directory gets a default, only about whether this session already has an
 * explicit model choice, and how to render whatever egress class the (now single) configured tier
 * resolves to.
 */
import type { SessionEgressClass } from "./routing.ts";

/**
 * True when this invocation's `argv` names an explicit model choice — `--model`, `--models`, or
 * `--provider`. PI's extension API exposes no parsed CLI args (`ExtensionContext`/
 * `SessionStartEvent` carry neither), so this is a deliberate, documented `process.argv` scan
 * rather than a typed accessor. `ctx.scopedModels.length > 0` (checked by the caller) already
 * covers `--models`/`enabledModels` scoping; this covers the single-shot `--model`/`--provider`
 * flags that do NOT populate `scopedModels` (an earlier draft checked only
 * `scopedModels`, which would have made acceptance test J4 fail for a bare `--model` override).
 */
export function explicitModelRequested(argv: readonly string[] = process.argv): boolean {
  return argv.some((a) => a === "--model" || a === "--models" || a === "--provider");
}

/** Footer/status-bar flag (`ctx.ui.setStatus`). `undefined` clears the status for a public session. */
export function statusFlag(egress: SessionEgressClass): string | undefined {
  return egress === "public" ? undefined : `⚑ ${egress}`;
}

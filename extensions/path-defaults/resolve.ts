/**
 * Pure resolution logic — no PI import, no I/O, no clock — so the whole rule set is
 * unit-testable, the same split `extensions/compaction/loop-guard.ts` uses.
 */
import { sep } from "node:path";
import { expandHome, type RootDef } from "./config.ts";
import type { SessionEgressClass } from "./routing.ts";

/**
 * Longest-prefix match against `cwd`. `"*"` (validated to be last, if present) is the fallback.
 * Boundary-safe: `~/work/client-other` never matches a `~/work/client` root, because both the
 * candidate root and `cwd` are compared with a trailing separator appended.
 *
 * Returns `undefined` when nothing matches — an unclassified directory with no wildcard root is a
 * normal, valid outcome (`index.ts` treats it as "do nothing", not as a misconfiguration).
 */
export function rootFor(cwd: string, roots: readonly RootDef[], home?: string): RootDef | undefined {
  const cwdWithSep = withTrailingSep(cwd);
  let best: RootDef | undefined;
  let bestLen = -1;
  for (const root of roots) {
    if (root.path === "*") {
      if (best === undefined) best = root; // lowest priority; anything longer already won
      continue;
    }
    const expanded = withTrailingSep(expandHome(root.path, home));
    if (cwdWithSep.startsWith(expanded) && expanded.length > bestLen) {
      best = root;
      bestLen = expanded.length;
    }
  }
  return best;
}

function withTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

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

/** Footer/status-bar flag (`ctx.ui.setStatus`). `undefined` clears the status for a public root. */
export function statusFlag(egress: SessionEgressClass): string | undefined {
  return egress === "public" ? undefined : `⚑ ${egress}`;
}

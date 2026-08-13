/**
 * The sub-agent dispatch veto — interface only (review defect 22).
 *
 * `EXT-03` was specified to contain a routing veto for a runtime that does not exist until W2.
 * The predicate type therefore lives here, `EXT-03` ships the call site, and `EXT-05` fills the
 * implementation by wiring it into `pi-subagents`' `registerSubagentCapabilityCeiling()` rather
 * than forking a dispatcher.
 *
 * Two rules will be built on this and both are acceptance criteria, not descriptions:
 *   - REQ-CTX-47: veto a generic agent when a domain specialist matches, with REQ-CTX-06's
 *     written-justification hatch.
 *   - Egress containment: a session classed `confidential` cannot dispatch a child onto a
 *     `public` provider. `egressAllows()` is that rule and nothing else uses it yet.
 *
 * No implementation ships here on purpose. What ships is the shape the two call sites must
 * agree on, so that W2 does not get to re-invent it.
 */
import type { EscapeHatchDenial } from "./escape-hatch.ts";
import { describeError, surfaceOnce } from "./once.ts";

/** The classes in `config/routing.json`'s `egress` map. */
export type EgressClass = "public" | "internal" | "confidential";

/** Lower is more restricted. A child may never be less restricted than its parent. */
export const EGRESS_RANK: Readonly<Record<EgressClass, number>> = {
  confidential: 0,
  internal: 1,
  public: 2,
};

/** True when a parent classed `parent` may dispatch a child onto a provider classed `child`. */
export function egressAllows(parent: EgressClass, child: EgressClass): boolean {
  return EGRESS_RANK[child] <= EGRESS_RANK[parent];
}

export interface DispatchRequest {
  /** Agent definition name, e.g. "general-purpose" or "researcher". */
  readonly agentType: string;
  /** The prompt the child would receive. The specialist match is made against this. */
  readonly prompt: string;
  /** Semantic tier of the dispatching session, per `config/routing.json`. */
  readonly parentTier?: string;
  readonly parentEgress?: EgressClass;
  /** Semantic tier the child would run on. */
  readonly childTier?: string;
  /** Provider key the child would resolve to, e.g. "github-copilot". */
  readonly childProvider?: string;
  readonly childEgress?: EgressClass;
  /** Present when the veto is evaluated from a `tool_call` handler. */
  readonly toolCallId?: string;
}

/**
 * A veto reuses `EscapeHatchDenial` verbatim so the call site can hand it straight to
 * `denyWithEscapeHatch()` — one gate vocabulary, not two.
 */
export type DispatchVerdict =
  | { readonly veto: false }
  | { readonly veto: true; readonly denial: EscapeHatchDenial };

export type DispatchVeto = (
  req: DispatchRequest,
) => DispatchVerdict | Promise<DispatchVerdict>;

export interface DispatchVetoRegistration {
  /** Stable id, e.g. "DV-SPECIALIST" or "DV-EGRESS". Named in surfaced errors. */
  readonly id: string;
  readonly evaluate: DispatchVeto;
}

const registry: DispatchVetoRegistration[] = [];

/** `EXT-05` calls this at `session_start`; order of registration is order of evaluation. */
export function registerDispatchVeto(registration: DispatchVetoRegistration): void {
  registry.push(registration);
}

export function dispatchVetoes(): readonly DispatchVetoRegistration[] {
  return [...registry];
}

/**
 * The call site `EXT-03` ships. Same contract as `guardedHandler`: the first veto wins and
 * short-circuits (fail closed on a match); a veto that throws is surfaced exactly once and
 * skipped (fail open on our bug).
 */
export async function evaluateDispatch(
  req: DispatchRequest,
  log?: (line: string) => void,
): Promise<DispatchVerdict> {
  for (const registration of registry) {
    try {
      const verdict = await registration.evaluate(req);
      if (verdict.veto) return verdict;
    } catch (err) {
      surfaceOnce(undefined, `dispatch-veto:${registration.id}:${String(err).slice(0, 120)}`, () =>
        (log ?? defaultLog)(
          `[pi-config] dispatch veto ${registration.id} failed internally and was skipped: ` +
            describeError(err),
        ),
      );
    }
  }
  return { veto: false };
}

/** Test-only. */
export function resetDispatchVetoes(): void {
  registry.length = 0;
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

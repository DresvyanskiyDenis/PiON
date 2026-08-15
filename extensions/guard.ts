/**
 * `EXT-03` — the permission layer PI does not have.
 *
 * PI's core is read/bash/edit/write and a single `tool_call` block primitive. `pi-sandbox` 0.6.2
 * is adopted for OS-level containment, but it is not this: its `denyRead` is explicitly not a
 * hard block and its network filter is a local MITM TLS proxy with a generated CA whose
 * interaction with corporate TLS inspection is unresolved. **This gate sits above the sandbox and
 * never delegates to it.**
 *
 * ## 2026-08-14 — allow-list out, deny-list in
 *
 * This used to be seven gates ending in a program allow-list that refused anything not on it, and
 * refused it *outright* in a headless run because there was no one to ask. Measured on one live
 * project, 24 of 33 sub-agent runs were blocked rather than failed. Removed outright by owner
 * decision, 2026-08-14: only catastrophic commands are blocked now.
 *
 * ## 2026-08-15 — `SEC` stops blocking too
 *
 * `SEC` was the one gate kept on the blocking side for a reason other than destruction. Owner
 * decision, 2026-08-15: it becomes audit-only as well, on the same rule — only catastrophic
 * commands block, and reading a file is not catastrophic.
 *
 * So: **six gates, two of which block and four of which only observe.**
 *
 *   - `DB` — the eight catastrophic shapes. Blocks. Mostly no override.
 *   - `GIT` — history destruction only: `filter-repo`/`filter-branch`, and a force-push onto a
 *     protected branch. Blocks, overridable with a written justification. Ordinary git is not
 *     gated.
 *   - `SEC`, `PRV`, `FS`, `RTE` — **audit only**. They evaluate, write one `guard.observed` entry
 *     when they match, and permit the call. Nothing here prompts: fewer approvals is the point, and
 *     a gate that asks instead of blocking has not been relaxed.
 *
 * `SEC`'s demotion costs more than the other three and is written down rather than absorbed: a
 * tool call may now read a credential file into the model's context, which sends it to whichever
 * provider serves the next turn, and **no runtime control in this repo prevents that** — not a
 * weakened one, none. `bin/rules/pc-06-no-committed-secrets.mjs` is push-time and protects the
 * repository rather than the context; `pi-sandbox` 0.6.2 is declared in `config/packages.lock.json`
 * but imported by nothing, and its `denyRead` is documented as not a hard block even once wired.
 * See `guard/gates/secret-paths.ts` for the full statement and for the one-line path back.
 *
 * Order still matters, for the two that block: cheapest and most absolute first, so a
 * catastrophic shape is reported as what it is rather than as whatever a later gate noticed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardedHandler, type GuardRule } from "./lib/guarded-handler.ts";
import { loadPolicy, type Policy } from "./guard/policy.ts";
import { defaultServices, type GuardServices } from "./guard/services.ts";
import { secretPathsGate } from "./guard/gates/secret-paths.ts";
import { dangerousBashGate } from "./guard/gates/dangerous-bash.ts";
import { destructiveGitGate } from "./guard/gates/destructive-git.ts";
import { privilegedCommandsGate } from "./guard/gates/privileged-commands.ts";
import { writeSurfaceGate } from "./guard/gates/write-surface.ts";
import { agentRoutingGate } from "./guard/gates/agent-routing.ts";

export const id = "guard";
export const GUARD_VERSION = "2.1.0";

/** Exported so `test/` and `/doctor` can build the same rule set without a live `pi`. */
export function buildRules(policy: Policy, services: GuardServices): GuardRule[] {
  const rules: GuardRule[] = [
    secretPathsGate(policy, services), // SEC-*  — credential paths, AUDIT ONLY
    dangerousBashGate(policy, services), // DB-*   — catastrophic shapes, mostly no override
    destructiveGitGate(policy, services), // GIT-*  — history destruction, written justification
    privilegedCommandsGate(policy, services), // PRV-*  — AUDIT ONLY
    writeSurfaceGate(policy, services), // FS-*   — AUDIT ONLY
    agentRoutingGate(policy, services), // RTE-*  — AUDIT ONLY
  ];
  if (process.env.PI_GUARD_TEST_THROW === "1") {
    // The one thing people skip and then regret:
    // without it, the first internal exception in a gate silently converts the agent into a
    // machine that refuses every tool call.
    rules.unshift({
      id: "TEST-THROW",
      evaluate() {
        throw new Error("PI_GUARD_TEST_THROW=1: deliberate internal failure (REQ-EXT-16 probe)");
      },
    });
  }
  return rules;
}

export function register(pi: ExtensionAPI): void {
  const policy = loadPolicy();
  const services = defaultServices({ audit: (type, data) => pi.appendEntry(type, data) });

  if (policy.problem !== undefined) {
    // Fail loud. A guard running on defaults it did not choose is a fact the operator has to see.
    services.log(`[pi-config] guard: ${policy.problem}`);
  }

  const rules = buildRules(policy, services);

  pi.on(
    "tool_call",
    guardedHandler({
      owner: id,
      rules,
      onInternalError: "open", // REQ-EXT-16: our bug must not block every tool
      // F2: a rule that keeps throwing the same error must keep reporting it, not go silent
      // after the first `surfaceOnce` dedup — see `guarded-handler.ts`.
      alwaysSurfaceInternalErrors: true,
      audit: (type, data) => pi.appendEntry(type, data),
      log: services.log,
    }),
  );

  // Handshake consumed by trust.ts's deadman and by doctor.ts's D-06 — enrichment for both, never
  // their pass/fail signal (that is `lib/manifest.ts`'s load record). `pi.events` is a bare
  // EventBus with no replay buffer and `guard` registers FIRST, so the one-shot emit below is
  // missed by every subscriber that attaches later — which is all of them. Answering `guard:whois`
  // is what makes the round trip work: a subscriber attaches its `guard:ready`
  // listener, then asks, and gets the same payload back synchronously.
  const handshake = {
    version: GUARD_VERSION,
    gates: rules.map((r) => r.id),
    policySource: policy.source,
    degraded: policy.degraded,
  };
  pi.events.on("guard:whois", () => pi.events.emit("guard:ready", handshake));
  pi.events.emit("guard:ready", handshake);
}

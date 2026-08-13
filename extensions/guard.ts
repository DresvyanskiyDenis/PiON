/**
 * `EXT-03` — the permission layer PI does not have.
 *
 * PI's core is read/bash/edit/write and a single `tool_call` block primitive. `pi-sandbox` 0.6.2
 * is adopted for OS-level containment, but it is not this: its `denyRead` is explicitly not a
 * hard block and its network filter is a local MITM TLS proxy with a generated CA whose
 * interaction with corporate TLS inspection is unresolved. **This gate sits above the sandbox and
 * never delegates to it.**
 *
 * Six gates, in the order that is itself the policy: cheap and absolute first, the one that can
 * block on a human last.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardedHandler, type GuardRule } from "./lib/guarded-handler.ts";
import { loadPolicy, type Policy } from "./guard/policy.ts";
import { defaultServices, type GuardServices } from "./guard/services.ts";
import { secretPathsGate } from "./guard/gates/secret-paths.ts";
import { dangerousBashGate } from "./guard/gates/dangerous-bash.ts";
import { destructiveGitGate } from "./guard/gates/destructive-git.ts";
import { privilegedCommandsGate } from "./guard/gates/privileged-commands.ts";
import { agentRoutingGate } from "./guard/gates/agent-routing.ts";
import { bashAllowlistGate } from "./guard/gates/bash-allowlist.ts";

export const id = "guard";
export const GUARD_VERSION = "1.0.0";

/** Exported so `test/` and `/doctor` can build the same rule set without a live `pi`. */
export function buildRules(policy: Policy, services: GuardServices): GuardRule[] {
  const rules: GuardRule[] = [
    secretPathsGate(policy), // SEC-*  — no override, ever
    dangerousBashGate(policy, services), // DB-*   — catastrophic patterns, mostly no override
    destructiveGitGate(policy, services), // GIT-*  — overridable with a written justification
    privilegedCommandsGate(policy, services), // PRV-*  — sudo / chmod 777 / pkill -9 / killall
    agentRoutingGate(policy, services), // RTE-*  — SHOULD-level veto, overridable
    bashAllowlistGate(policy, services), // ALW-*  — confirm in TUI, fail closed headless
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
    // Fail loud. A guard running on defaults it did not choose is a fact the operator has to
    // see; `bash-allowlist.ts` reads `policy.degraded` and gets stricter, never looser.
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

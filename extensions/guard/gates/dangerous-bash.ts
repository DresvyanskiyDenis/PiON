/**
 * `REQ-PRV-36`, `REQ-EXT-14`, `REQ-EXT-15` — the eight catastrophic-bash patterns.
 *
 * The gate is not filtered by tool name for the same reason `secret-paths.ts` is not: the ported
 * script had to work under harnesses that spell the bash tool differently, so anything carrying a
 * `command` / `cmd` / `script` string is checked.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../../lib/escape-hatch.ts";
import { matchCommand } from "../patterns.ts";
import { commandStrings } from "../targets.ts";
import { tryOverride } from "../override.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

export function dangerousBashGate(_policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "DB",
    // F2: catastrophic-pattern coverage that silently disappears on our own bug is exactly the
    // unsafe direction. `guarded-handler.ts`'s shared default is "open".
    onInternalError: "closed",
    evaluate(event) {
      for (const command of commandStrings(event)) {
        const hit = matchCommand(command);
        if (!hit) continue;

        if (
          hit.overridable &&
          tryOverride({
            event,
            gateId: hit.id,
            keys: ["command", "cmd", "script"],
            services,
            detail: { pattern: hit.what },
          })
        ) {
          continue;
        }

        return denyWithEscapeHatch({
          gateId: hit.id,
          what: hit.what,
          overridable: hit.overridable,
          legitimateUse: hit.overridable
            ? "There are legitimate uses of this, but they are rare and specific."
            : undefined,
        });
      }
      return { block: false };
    },
  };
}

/**
 * The non-git half of `REQ-PRV-42`: "plus `sudo *`, `chmod 777 *`, `pkill -9 *`, `killall *`".
 *
 * ADDED GATE — not in an earlier draft, which assigns those four to `destructive-git.ts` by
 * omission and then describes that file as git-only. They are a MUST with their own acceptance
 * criterion ("each listed command is refused with a reason naming the rule"), so they get the one
 * file `REQ-CTX-05` asks for rather than being smuggled into a gate named after something else.
 *
 * All four are overridable. They are policy, not catastrophe: `sudo` is denied because two prior
 * harnesses denied it, and the whole point of `REQ-CTX-06` is that a stated reason gets through.
 * The genuinely catastrophic forms (`sudo rm -rf /`, `chmod -R 777 /`) are matched earlier by
 * `dangerous-bash.ts`, which has no override, and gate order is what guarantees that.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../../lib/escape-hatch.ts";
import { program, tokenize, type Segment } from "../shell.ts";
import { commandStrings } from "../targets.ts";
import { tryOverride } from "../override.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

interface PrivHit {
  readonly id: string;
  readonly what: string;
  readonly legitimateUse: string;
}

export function privilegedCommandsGate(_policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "PRV",
    evaluate(event) {
      for (const command of commandStrings(event)) {
        for (const segment of tokenize(command)) {
          const hit = inspect(segment);
          if (!hit) continue;

          if (
            tryOverride({
              event,
              gateId: hit.id,
              keys: ["command", "cmd", "script"],
              services,
              detail: { what: hit.what },
            })
          ) {
            return { block: false };
          }
          return denyWithEscapeHatch({
            gateId: hit.id,
            what: hit.what,
            legitimateUse: hit.legitimateUse,
            overridable: true,
          });
        }
      }
      return { block: false };
    },
  };
}

function inspect(segment: Segment): PrivHit | null {
  // `sudo` is a peeled wrapper, so it is read off `wrappers`, not off argv[0]. That is exactly
  // the tokeniser's value: `env X=1 sudo foo` is the same rule as `sudo foo` (REQ-PRV-39).
  if (segment.wrappers.includes("sudo") || segment.wrappers.includes("doas")) {
    return {
      id: "PRV-SUDO",
      what: "running a command as root",
      legitimateUse: "Almost nothing in this harness needs root.",
    };
  }

  const name = program(segment);
  if (name === undefined) return null;
  const args = segment.argv.slice(1);

  if (name === "chmod" && args.some((a) => /^[0-7]*777$/.test(a))) {
    return {
      id: "PRV-CHMOD-777",
      what: "chmod 777 (world-writable, and it is almost never what was meant)",
      legitimateUse: "755 for directories and executables, 644 for files.",
    };
  }

  if (name === "pkill" && args.some((a) => a === "-9" || a === "-KILL" || a === "-SIGKILL")) {
    return {
      id: "PRV-PKILL-9",
      what: "pkill -9 (SIGKILL by pattern — no cleanup, and the pattern can over-match)",
      legitimateUse: "Send the default TERM first, and name the pid when one is known.",
    };
  }

  if (name === "killall") {
    return {
      id: "PRV-KILLALL",
      what: "killall (kills every process with that name, including ones you did not start)",
      legitimateUse: "kill <pid> targets exactly one process.",
    };
  }

  return null;
}

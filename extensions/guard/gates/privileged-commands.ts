/**
 * `PRV-*` — **audit only since 2026-08-14.** It observes; it never blocks and never prompts.
 *
 * This gate carried the non-git half of the privileged-command list: `sudo *`, `chmod 777 *`,
 * `pkill -9 *`, `killall *`. Removed outright by owner decision, 2026-08-14: only catastrophic
 * commands are blocked now, and none of these four is catastrophic on its own — `sudo` on this
 * machine prompts for a password the agent does not have, `chmod 777` is a permissions mistake and
 * not a data loss, `pkill -9`/`killall` cost at worst an unsaved editor buffer. The shapes that ARE
 * catastrophic keep their own walls one gate earlier: `sudo rm -rf /` is `DB-RM-ROOT` and
 * `chmod -R 777 /` is `DB-CHMOD-777`, neither overridable, and gate order is what guarantees they
 * are reached first.
 *
 * Kept as an audit record rather than deleted, because the four detectors answer a question
 * nothing else in the tree can after the fact: *did this session run something as root, or kill
 * processes it did not start?* That is worth a line in the transcript even when it is allowed —
 * and it costs one regex pass on a command already tokenised for `DB`.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { program, tokenize, type Segment } from "../shell.ts";
import { commandStrings } from "../targets.ts";
import { observe } from "../observe.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

interface PrivHit {
  readonly id: string;
  readonly what: string;
}

export function privilegedCommandsGate(_policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "PRV",
    evaluate(event) {
      for (const command of commandStrings(event)) {
        for (const segment of tokenize(command)) {
          const hit = inspect(segment);
          if (!hit) continue;
          return observe({ event, gateId: hit.id, what: hit.what, services });
        }
      }
      return { block: false };
    },
  };
}

function inspect(segment: Segment): PrivHit | null {
  // `sudo` is a peeled wrapper, so it is read off `wrappers`, not off argv[0]. That is exactly
  // the tokeniser's value: `env X=1 sudo foo` is the same rule as `sudo foo`.
  if (segment.wrappers.includes("sudo") || segment.wrappers.includes("doas")) {
    return { id: "PRV-SUDO", what: "running a command as root" };
  }

  const name = program(segment);
  if (name === undefined) return null;
  const args = segment.argv.slice(1);

  if (name === "chmod" && args.some((a) => /^[0-7]*777$/.test(a))) {
    return { id: "PRV-CHMOD-777", what: "chmod 777 (world-writable)" };
  }

  if (name === "pkill" && args.some((a) => a === "-9" || a === "-KILL" || a === "-SIGKILL")) {
    return { id: "PRV-PKILL-9", what: "pkill -9 (SIGKILL by pattern — the pattern can over-match)" };
  }

  if (name === "killall") {
    return { id: "PRV-KILLALL", what: "killall (every process with that name, not only ours)" };
  }

  return null;
}

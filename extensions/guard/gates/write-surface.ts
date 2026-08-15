/**
 * `FS-*` — the sandbox write boundary. **Audit only since 2026-08-14.**
 *
 * ## What changed and why
 *
 * This gate used to refuse a bash command whose write targets resolved outside cwd, `$TMPDIR` and
 * the state root. It was the thing that made widening the program allowlist defensible; the
 * allow-list model it was defending was then removed outright by owner decision, 2026-08-14, and
 * only catastrophic commands were left to be blocked, taking the enforcement here down with it.
 * Writing outside the project is not catastrophic — it is how a `~/.config` edit, a
 * `/usr/local/bin` install and a `brew`-managed file all get written. The genuinely unrecoverable
 * write shapes are matched one gate earlier and still refuse with no override: `DB-RM-ROOT`,
 * `DB-DD-DISK`, `DB-REDIR-DISK`, `DB-MKFS`. `SEC-*` used to refuse every credential path ahead of
 * both; since 2026-08-15 it only records them, so a write into a credential path is now observed
 * twice and refused by neither.
 *
 * ## Why it is kept as an observer rather than deleted
 *
 * `write-surface.ts` is the only thing in the tree that resolves *which path a command line
 * mutates*, across redirection, in-place flags, `find` actions, archive destinations, `curl -o`,
 * `tee` and the mutating coreutils — regardless of which program expressed it. That answer is the
 * highest-value line in a post-mortem ("what did this run write, and where?"), and it costs one
 * pass over an already-tokenised command. So it keeps computing it and writes one `guard.observed`
 * entry per out-of-sandbox write. It does not block, it does not prompt, and it does not tell the
 * model anything — the record is for whoever reads the transcript afterwards.
 *
 * Its blind spot is unchanged and still worth stating: it cannot see inside an interpreter —
 * `python3 -c`, `node -e`, `awk '{print > "/etc/x"}'`, a `make` target. The answer to that was
 * always OS-level containment, never a regex, and `pi-sandbox` is still not wired for it.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { tokenize } from "../shell.ts";
import { commandStrings } from "../targets.ts";
import { locateWrites, type LocatedWrite } from "../write-surface.ts";
import { observe } from "../observe.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

export function writeSurfaceGate(_policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "FS",
    evaluate(event, ctx) {
      for (const command of commandStrings(event)) {
        for (const segment of tokenize(command)) {
          for (const write of locateWrites(segment, ctx.cwd)) {
            if (write.location === "inside") continue;
            return observe({
              event,
              gateId: write.location === "outside" ? "FS-OUTSIDE" : "FS-UNRESOLVED",
              what: describe(write),
              services,
              detail: { form: write.form, target: write.word, resolved: write.resolved },
            });
          }
        }
      }
      return { block: false };
    },
  };
}

function describe(write: LocatedWrite): string {
  if (write.location === "unknown") {
    return (
      `${write.form} writing to "${write.word}", whose location cannot be determined ` +
      `(it starts with a variable this process cannot resolve)`
    );
  }
  return `${write.form} writing to "${write.word}" (${write.resolved}), outside the project`;
}

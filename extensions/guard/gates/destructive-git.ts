/**
 * `REQ-PRV-42` — destructive git stays on the denylist.
 *
 * Every rule here is *overridable with a written justification*. The requirements draw the
 * line: safety gates against accidents (`rm -rf /`) are walls, workflow gates are hatches, and a
 * force-push is a decision, not an accident. Two independent harnesses already carry this list;
 * a third omission would be a regression.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../../lib/escape-hatch.ts";
import { program, tokenize, type Segment } from "../shell.ts";
import { commandStrings } from "../targets.ts";
import { tryOverride } from "../override.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

interface GitHit {
  readonly id: string;
  readonly what: string;
  readonly legitimateUse: string;
}

/** git's own global options that consume the next word, so the subcommand is found correctly. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

export function destructiveGitGate(policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "GIT",
    evaluate(event) {
      for (const command of commandStrings(event)) {
        for (const segment of tokenize(command)) {
          if (program(segment) !== "git") continue;
          const hit = inspect(segment, policy);
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

function inspect(segment: Segment, policy: Policy): GitHit | null {
  const args = segment.argv.slice(1);
  const subIdx = subcommandIndex(args);
  if (subIdx === -1) return null;
  const sub = args[subIdx]!;
  const rest = args.slice(subIdx + 1);
  const short = shortFlags(rest);
  const long = longFlags(rest);
  const operands = rest.filter((a) => !a.startsWith("-"));

  if (sub === "push") {
    if (long.has("force") || short.has("f")) {
      return {
        id: "GIT-FORCE",
        what: "git push --force (overwrites history on the remote)",
        legitimateUse: "--force-with-lease on a non-protected branch is allowed without a hatch.",
      };
    }
    if (long.has("force-with-lease") || long.has("force-if-includes")) {
      const branch = pushTargets(operands).find((b) => policy.protectedBranches.includes(b));
      if (branch !== undefined) {
        return {
          id: "GIT-FORCE-PROTECTED",
          what: `git push --force-with-lease onto the protected branch "${branch}"`,
          legitimateUse: "Force-pushing a protected branch needs a stated reason.",
        };
      }
    }
    const remote = operands[0];
    if (
      policy.remoteAllowlist.length > 0 &&
      remote !== undefined &&
      !remote.startsWith("-") &&
      !policy.remoteAllowlist.includes(remote)
    ) {
      return {
        id: "GIT-REMOTE",
        what: `git push to "${remote}", which is not in the configured remote allowlist`,
        legitimateUse: `Allowed remotes: ${policy.remoteAllowlist.join(", ")}.`,
      };
    }
    return null;
  }

  if (sub === "reset" && long.has("hard")) {
    return {
      id: "GIT-RESET",
      what: "git reset --hard (discards every uncommitted change)",
      legitimateUse: "git stash keeps the work; --hard does not.",
    };
  }

  if (sub === "branch" && (short.has("D") || (long.has("delete") && long.has("force")))) {
    return {
      id: "GIT-BRANCH-D",
      what: "git branch -D (force-deletes a branch that may not be merged)",
      legitimateUse: "git branch -d refuses only when the branch is unmerged, which is the point.",
    };
  }

  if (sub === "clean" && (short.has("f") || long.has("force"))) {
    return {
      id: "GIT-CLEAN",
      what: "git clean -f (deletes untracked files irrecoverably)",
      legitimateUse: "git clean -n lists what would go without deleting anything.",
    };
  }

  if (sub === "checkout" && rest.includes("--") && operands.includes(".")) {
    return {
      id: "GIT-CHECKOUT-DOT",
      what: "git checkout -- . (discards every unstaged change in the tree)",
      legitimateUse: "Naming the individual files makes the blast radius visible.",
    };
  }

  return null;
}

function subcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (GLOBAL_OPTS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** `-fd` contributes both `f` and `d`. Long flags are excluded. */
function shortFlags(args: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    for (const ch of arg.slice(1)) out.add(ch);
  }
  return out;
}

function longFlags(args: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--") || arg === "--") continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    out.add(eq === -1 ? body : body.slice(0, eq));
  }
  return out;
}

/** `origin main`, `origin HEAD:main`, `origin +main` → the destination branch names. */
function pushTargets(operands: readonly string[]): string[] {
  return operands.slice(1).map((refspec) => {
    const withoutLead = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    const colon = withoutLead.lastIndexOf(":");
    const dest = colon === -1 ? withoutLead : withoutLead.slice(colon + 1);
    return dest.replace(/^refs\/heads\//, "");
  });
}

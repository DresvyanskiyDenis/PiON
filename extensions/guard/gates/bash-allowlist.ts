/**
 * `REQ-PRV-38` — the only interactive gate, and the only one that can block on a human.
 *
 * PI has no approval prompt of its own: "NO prompts — only the
 * `beforeToolCall` block primitive". This is that prompt.
 *
 * Headless behaviour is the whole difficulty. `ctx.hasUI` is `false` under `-p` and
 * `--mode json` and `ctx.ui.*` are no-ops there, so approval is *impossible*, and
 * `REQ-PRV-38` is a MUST. The only safe answer is to fail CLOSED with a named reason.
 * This item ships the escape from that as data, not as a code path:
 * `nonInteractive: "allowlist-only"` runs the allowlist and blocks the miss, and the
 * `PI_GUARD_APPROVE=1` escalation is opt-in per invocation and never a default.
 *
 * This is the only gate that honours that escalation, and it does not decide so itself: the
 * mechanism, the per-gate stance table and the announcement all live in `../escalation.ts`.
 * Both refusal paths below — the `deny-all` refusal and the allowlist miss — read the same
 * `headlessRelaxation()`, which is the asymmetry this file used to carry.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { type Segment, program, tokenize } from "../shell.ts";
import {
  announceRelaxation,
  escalationRelaxes,
  NEVER_RELAXED_PROGRAMS,
  type RelaxationReason,
} from "../escalation.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

/**
 * Session-scoped "allow this exact command again" memory (`REQ-PRV-38`).
 * Module-level, which is process-lifetime: this tree guarantees exactly one
 * discovered extension file, so there is exactly one copy of this Set. It does NOT survive
 * `/reload`, and that is the conservative direction.
 */
const sessionApproved = new Set<string>();

const EMPTY_ALLOWLIST: ReadonlySet<string> = new Set<string>();

export function bashAllowlistGate(policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "ALW",
    async evaluate(event, ctx) {
      if (event.toolName !== "bash") return { block: false };
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (command.trim().length === 0) return { block: false };

      // A policy we could not read is a policy we do not have. Nothing is allowlisted, and the
      // loud message about it was already printed by `guard.ts` at registration time.
      const allowlist = policy.degraded ? EMPTY_ALLOWLIST : policy.allowlist;

      // Computed before any early return, so the announcement fires on the first bash call of a
      // relaxed session even when that first call happens to be allowlisted. A relaxation nobody
      // was told about is the failure mode this whole notice exists for.
      const relaxation = headlessRelaxation(policy);
      if (relaxation !== null) announceRelaxation(ctx, policy, relaxation, services.log);

      if (!ctx.hasUI && policy.nonInteractive === "deny-all" && relaxation === null) {
        return {
          block: true,
          reason:
            `Guard policy nonInteractive="deny-all": bash is refused in this session ` +
            `(mode=${ctx.mode}) because approval cannot be requested. ` +
            `Run interactively, or set ${policy.escalationEnv}=${policy.escalationValue}.`,
        };
      }

      const segments = tokenize(command);
      const unknown = segments.filter((s) => {
        const p = program(s);
        return s.opaque || !p || !allowlist.has(p);
      });
      if (unknown.length === 0) return { block: false };

      const names = unknown.map((s) => (s.opaque ? "<opaque>" : (program(s) ?? "<empty>"))).join(", ");
      const key = normalize(command);
      if (sessionApproved.has(key)) return { block: false };

      if (!ctx.hasUI) {
        if (relaxation !== null) {
          // Escalation pre-grants the approval prompt. It does NOT pre-grant a directory change:
          // `secret-paths.ts` resolves relative arguments against `ctx.cwd`, so a `cd` inside the
          // same command would put a credential store one allowlisted `cat` away from the model.
          const held = unknown.filter((s) => NEVER_RELAXED_PROGRAMS.has(program(s) ?? ""));
          if (held.length === 0) {
            services.audit("guard.approval", {
              scope: relaxation,
              toolCallId: event.toolCallId,
              programs: names,
              at: Date.now(),
            });
            return { block: false };
          }
          return { block: true, reason: heldRefusal(held, String(ctx.mode)) };
        }
        return {
          block: true,
          reason: headlessRefusal(policy, allowlist, unknown, names, String(ctx.mode)),
        };
      }

      const decision = await ask(ctx, policy, command, names);
      if (decision === "session") {
        sessionApproved.add(key);
        services.audit("guard.approval", {
          scope: "session",
          toolCallId: event.toolCallId,
          programs: names,
          at: Date.now(),
        });
        return { block: false };
      }
      if (decision === "once") {
        services.audit("guard.approval", {
          scope: "once",
          toolCallId: event.toolCallId,
          programs: names,
          at: Date.now(),
        });
        return { block: false };
      }
      return { block: true, reason: `Denied by operator: ${names}` };
    },
  };
}

/**
 * `cd` is the blocked program that has no allowlistable substitute, and it is the one a headless
 * child reaches for most. Every subagent runs with `hasUI: false` (`mode=json`), PI's bash tool
 * takes only `{ command, timeout }` — there is no per-call `cwd` parameter, and the tool's own
 * description promises "the current working directory" — so a child told to build a subproject
 * writes `cd sub && npm run build`. The tokeniser splits that correctly and clears `npm`; only the
 * `cd` segment misses. Wording that said "use an allowlisted equivalent" without naming a single
 * allowlisted program is advice the model cannot act on, so it rewords and retries the same shape
 * until its budget runs out.
 *
 * Allowlisting `cd` is NOT the fix, because it would weaken `secret-paths.ts`. That gate resolves
 * relative arguments against `ctx.cwd`, never against a directory an earlier segment of the same
 * command already moved to, so in `cd ~/.aws && cat credentials` the bare `credentials` resolves
 * to `<cwd>/credentials` and matches no DENY pattern. `cat` is allowlisted, so the only two things
 * standing between that line and the file are `cd` being non-allowlisted and `SEC-AWS` matching
 * the `~/.aws` argument itself — which it does only since that rule was anchored `(\/|$)` rather
 * than `\/` (see `secret-paths.ts`). Two independent stops, deliberately: `cd` stays off the
 * allowlist and stays in `NEVER_RELAXED_PROGRAMS`, so neither an allowlist edit nor an escalation
 * can remove both at once.
 */
const CD_REMEDY =
  "'cd' cannot be allowlisted, and it is not needed: the bash tool has no cwd parameter and " +
  "always runs in the session working directory. Pass the directory to the program instead — " +
  "'npm --prefix DIR run …', 'git -C DIR …', 'make -C DIR …', 'pytest DIR', 'uv --project DIR …' " +
  "— or give absolute paths.";

/**
 * The headless refusal text. It names the allowlist verbatim because "use an allowlisted
 * equivalent" is unactionable to a model that cannot see the list and has no UI to go and read it;
 * naming the programs is what turns this from a dead end into a redirect.
 */
function headlessRefusal(
  policy: Policy,
  allowlist: ReadonlySet<string>,
  unknown: readonly Segment[],
  names: string,
  mode: string,
): string {
  const blocked = new Set(
    unknown.map((segment) => program(segment)).filter((name): name is string => !!name),
  );
  const allowed = [...allowlist].sort().join(", ");
  return (
    `Command uses non-allowlisted program(s): ${names}. This session has no UI ` +
    `(mode=${mode}), so approval cannot be requested and the call is refused. ` +
    (blocked.has("cd") ? `${CD_REMEDY} ` : "") +
    `Allowlisted programs: ${allowed || "(none)"}. ` +
    `Rewrite the command using those, or run this task interactively, or re-run with ` +
    `${policy.escalationEnv}=${policy.escalationValue}.`
  );
}

type Decision = "once" | "session" | "deny";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

async function ask(
  ctx: ExtensionContext,
  policy: Policy,
  command: string,
  names: string,
): Promise<Decision> {
  const message = `${command}\n\nNot on the allowlist: ${names}`;
  const opts = { timeout: policy.confirmTimeoutMs };

  if (policy.approvalUi === "confirm") {
    // A timed-out or dismissed dialog returns false, which is a DENY. That is the only
    // direction a missing answer may resolve in.
    const ok = await ctx.ui.confirm("Approve command?", message, opts);
    return ok ? "session" : "deny";
  }

  const choice = await ctx.ui.select(
    `Approve command? (${names})`,
    [ALLOW_ONCE, ALLOW_SESSION, DENY],
    opts,
  );
  if (choice === ALLOW_ONCE) return "once";
  if (choice === ALLOW_SESSION) return "session";
  return "deny";
}

/**
 * Why the headless allowlist is not being enforced, or `null` when it is.
 *
 * Two sources, and they are not the same thing: the per-invocation environment escalation, and a
 * `config/guard.json` that ships `nonInteractive: "allow-all"`. The second is a switch that stays
 * switched on across restarts, so it is NOT the escalation mechanism and must never be mistaken
 * for it — but it produces the identical relaxation, so it gets the identical announcement.
 * Reporting only the env var would leave the more persistent of the two silent.
 */
function headlessRelaxation(policy: Policy): RelaxationReason | null {
  if (escalationRelaxes(policy, "ALW")) return "escalation";
  if (policy.nonInteractive === "allow-all") return "policy";
  return null;
}

/** The refusal for a program escalation is not allowed to un-refuse. */
function heldRefusal(held: readonly Segment[], mode: string): string {
  const names = held.map((segment) => program(segment) ?? "<empty>").join(", ");
  return (
    `Command uses ${names}, which stays refused (mode=${mode}) even with headless approval ` +
    `pre-granted: a directory change would defeat credential-path checking, which resolves ` +
    `relative paths against the session working directory. ${CD_REMEDY}`
  );
}

function normalize(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** Test-only. */
export function resetSessionApprovals(): void {
  sessionApproved.clear();
}

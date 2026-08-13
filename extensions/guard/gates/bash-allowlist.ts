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
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { program, tokenize } from "../shell.ts";
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

      if (!ctx.hasUI && policy.nonInteractive === "deny-all" && !escalated(policy)) {
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
        if (policy.nonInteractive === "allow-all" || escalated(policy)) return { block: false };
        return {
          block: true,
          reason:
            `Command uses non-allowlisted program(s): ${names}. This session has no UI ` +
            `(mode=${ctx.mode}), so approval cannot be requested and the call is refused. ` +
            `Use an allowlisted equivalent, or run this task interactively, or re-run with ` +
            `${policy.escalationEnv}=${policy.escalationValue}.`,
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
 * F9: both the env var name and the accepted value must come from `policy` — a literal second
 * spelling here would let anything that controls the `pi` process environment (a hook, a
 * launcher, an MCP server's `env` block) escalate headless `allowlist-only` to allow, regardless
 * of what `config/guard.json` names as the escalation. There is exactly one escalation now.
 */
function escalated(policy: Policy): boolean {
  return process.env[policy.escalationEnv] === policy.escalationValue;
}

function normalize(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** Test-only. */
export function resetSessionApprovals(): void {
  sessionApproved.clear();
}

/**
 * The ONE escalation mechanism, and the declared stance of every gate towards it.
 *
 * ## What escalation means
 *
 * The harness ships one escape from headless refusal: an environment variable, named by
 * `config/guard.json`'s `escalation` field (`PI_GUARD_APPROVE=1` as shipped), set **per
 * invocation**. Its meaning is deliberately narrow and is stated here once so no gate has to
 * guess: *the operator has pre-granted the approval they would have given at the interactive
 * prompt*. Nothing more. It is not "disable the guard", and it is not a trust level.
 *
 * That definition is what decides which gates may honour it. `bash-allowlist.ts` (`ALW`) is the
 * only gate that asks a human anything — every other gate either refuses outright (`SEC`, the
 * non-overridable half of `DB`) or already carries a headless-usable escape hatch that works
 * without a UI (`REQ-CTX-06`'s written justification: `GIT`, `PRV`, `RTE`, the overridable half of
 * `DB`). A gate with an escape hatch does not need this one, and giving it one would let a
 * headless child force-push `main` with nothing written down.
 *
 * ## Why a table instead of a per-gate `if`
 *
 * The bug this file exists to close: `escalated()` used to live inside `bash-allowlist.ts`, so
 * whether a gate honoured escalation was invisible unless you read that gate's source. A gate
 * could ignore the mechanism silently, and one branch of `ALW` itself nearly did. Every gate id
 * now declares a stance in `GATE_ESCALATION`, `guard.ts` refuses to stay quiet about a gate that
 * declares none, and `test/guard/escalation.test.ts` fails if a registered gate is missing from
 * the table. "Honoured identically by every gate" is enforced, not asserted in prose.
 *
 * ## Off by default, per invocation
 *
 * The only input is `process.env`. There is deliberately no `config/*.json` boolean that turns
 * escalation on and stays on: `config/guard.json` may *name* the variable and its expected value,
 * never pre-set it. An environment variable dies with the shell that exported it; a JSON `true`
 * does not, and a machine running relaxed for three weeks because of a commit nobody re-read is
 * the failure this shape prevents.
 */
import { emitNotice, type LogSink, type NoticeTarget } from "../lib/announce.ts";
import { surfaceOnce } from "../lib/once.ts";
import type { Policy } from "./policy.ts";

/** `approval` — this gate's refusal is a stand-in for an approval prompt. `never` — it is a wall. */
export type EscalationStance = "approval" | "never";

/**
 * Every gate id built by `guard.ts#buildRules`, with what escalation does to it.
 *
 * `SEC` is `never` and is not up for discussion (`REQ-PRV-15`, `REQ-PRV-37`): relaxing the bash
 * allowlist must never relax access to a credential store. The others are `never` because they
 * already accept a written justification, which a headless child can supply.
 */
export const GATE_ESCALATION: Readonly<Record<string, EscalationStance>> = {
  SEC: "never",
  DB: "never",
  GIT: "never",
  PRV: "never",
  RTE: "never",
  ALW: "approval",
  // `guard.ts` prepends this one under `PI_GUARD_TEST_THROW=1`. It is listed so the invariant
  // stays absolute — every id `buildRules` can produce declares a stance — rather than becoming
  // "every id except the ones we remember to exclude".
  "TEST-THROW": "never",
};

/**
 * Programs that stay refused headless even while escalation is active.
 *
 * `cd` is here because `secret-paths.ts` resolves every relative path argument against `ctx.cwd`
 * and never against a directory an earlier segment of the same command already moved to. So
 * `cd ~/.aws && cat credentials` presents `SEC` with `~/.aws` and a bare `credentials`, and `cat`
 * is allowlisted — the `ALW` gate refusing `cd` is what stops that line today, which is exactly
 * why `cd` is absent from the shipped allowlist. If escalation could un-refuse `cd`, escalation
 * would relax the credential rules by the back door, and the "SEC is never escalatable" rule in
 * the table above would be false in practice while looking true.
 */
export const NEVER_RELAXED_PROGRAMS: ReadonlySet<string> = new Set(["cd", "pushd", "chdir"]);

/**
 * True when this invocation carries the escalation. The ONLY reader of the escalation env var in
 * the tree — the name and the accepted value both come from `policy`, never from a literal, so a
 * policy that renames or disables the escalation actually renames or disables it.
 *
 * An empty name or an empty expected value is treated as "no escalation configured" rather than
 * as "matches an unset variable": `process.env[""]` is `undefined`, and an escalation that fires
 * on absence would be on by default, which is the one thing it must never be.
 */
export function escalationActive(policy: Policy): boolean {
  if (policy.escalationEnv.length === 0 || policy.escalationValue.length === 0) return false;
  return process.env[policy.escalationEnv] === policy.escalationValue;
}

/**
 * Whether escalation relaxes `gateId` right now. Every gate that can refuse calls this and
 * nothing else; no gate reads the environment itself.
 *
 * A gate id absent from `GATE_ESCALATION` is treated as NON-escalatable — the safe direction —
 * and says so on the log. Throwing instead would be worse than useless here: `guardedHandler`
 * fails open on a rule that throws, so a gate asking an honest question would be skipped
 * entirely.
 */
export function escalationRelaxes(policy: Policy, gateId: string): boolean {
  const stance = stanceOf(gateId);
  if (stance === undefined) {
    surfaceOnce(undefined, `guard:escalation:undeclared:${gateId}`, () =>
      emitNotice(undefined, undeclaredLine(gateId), "error"),
    );
    return false;
  }
  if (stance === "never") return false;
  return escalationActive(policy);
}

/** Gate ids that declare no stance. `guard.ts` reports these at registration. */
export function undeclaredGates(gateIds: readonly string[]): string[] {
  return gateIds.filter((id) => stanceOf(id) === undefined);
}

export function undeclaredLine(gateId: string): string {
  return (
    `[pi-config] guard: gate "${gateId}" declares no escalation stance in GATE_ESCALATION ` +
    `(extensions/guard/escalation.ts). Treating it as NON-escalatable. Add it to the table.`
  );
}

/** Why the headless allowlist is not being enforced. Two sources, one notice. */
export type RelaxationReason = "escalation" | "policy";

/**
 * The notice text. It names what is relaxed AND what is still enforced, because a relaxation
 * announced as "guard relaxed" tells the operator nothing they can act on, and a relaxation not
 * announced at all is how a machine gets an incident.
 *
 * The "and in every subagent it spawns" clause is verified, not assumed: `pi-subagents` spawns
 * each child as a real process with `env: { ...process.env, ... }`, so the escalation is
 * inherited by every descendant of the invocation that set it. That is the intended behaviour —
 * a hatch that stopped at the first child would be useless for delegated work — but it is also
 * why the notice says it out loud rather than leaving the operator to find out.
 */
export function relaxationNotice(policy: Policy, reason: RelaxationReason): string {
  const cause =
    reason === "escalation"
      ? `${policy.escalationEnv}=${policy.escalationValue} is set for this invocation`
      : `config/guard.json sets nonInteractive="allow-all"`;
  const undo =
    reason === "escalation"
      ? `Unset ${policy.escalationEnv} to restore approval-gated behaviour.`
      : `Set nonInteractive back to "allowlist-only" to restore it.`;
  return (
    `[pi-config] guard: headless bash approval is PRE-GRANTED — ${cause}. ` +
    `RELAXED: the bash allowlist; non-allowlisted programs now run without approval in this ` +
    `session and in every subagent it spawns. ` +
    `STILL ENFORCED: SEC-* credential paths (no override, ever), DB-* catastrophic patterns, ` +
    `and GIT-*/PRV-*/RTE-*, which still require a written justification. ` +
    `${[...NEVER_RELAXED_PROGRAMS].join("/")} stay refused, because secret-path checking ` +
    `resolves relative paths against the session cwd and a directory change would defeat it. ` +
    `${undo}`
  );
}

/** Emits `relaxationNotice` once per session, on whichever channel this run mode has. */
export function announceRelaxation(
  ctx: NoticeTarget | undefined,
  policy: Policy,
  reason: RelaxationReason,
  log?: LogSink,
): void {
  surfaceOnce(undefined, `guard:allowlist-relaxed:${reason}`, () => {
    if (log) emitNotice(ctx, relaxationNotice(policy, reason), "warning", log);
    else emitNotice(ctx, relaxationNotice(policy, reason), "warning");
  });
}

function stanceOf(gateId: string): EscalationStance | undefined {
  return Object.hasOwn(GATE_ESCALATION, gateId) ? GATE_ESCALATION[gateId] : undefined;
}

/**
 * `SEC-*` — credential-path detection. **Audit only since 2026-08-15.**
 *
 * ## What changed and why
 *
 * This gate refused any tool call whose arguments named a credential path, on read and on write,
 * with no override of any kind. When the guard was inverted from an allow-list to a deny-list on
 * 2026-08-14 it was the one gate kept on the blocking side for a reason other than destruction.
 * Owner decision, 2026-08-15: `SEC` stops blocking too. Only catastrophic commands block, and
 * reading a file is not catastrophic. `DB-*` and the two history-destroying `GIT-*` rules are now
 * the entire blocking set; `SEC` joins `PRV`, `FS` and `RTE` as an observer — it evaluates, writes
 * one `guard.observed` entry per match, and permits the call.
 *
 * The detection is the part worth keeping and it is untouched: the `DENY`/`ALLOW` tables, the
 * `SEC-PI-STATE` anchoring and every comment explaining them below are exactly what they were.
 * Only the verdict changed. Re-enforcing is a one-line change back to `denyWithEscapeHatch` in
 * `evaluate` — the table it would enforce is still here, still tested, still correct.
 *
 * ## The consequence, stated plainly because it is not small
 *
 * A tool call may now read a credential file, and its contents land in the model's context and are
 * therefore sent to whichever provider serves the next turn. **There is no runtime control left
 * that prevents this.** Not a weakened one — none. Specifically:
 *
 *   - `bin/rules/pc-06-no-committed-secrets.mjs` (`PC-06`, run by `pi-check --all`) scans what git
 *     tracks for secret-shaped literals. It is a **push-time** gate and it protects the
 *     **repository**, not the model's context. It cannot see a value that was read into a turn and
 *     never written to a tracked file, and it is not a substitute for this gate.
 *   - `pi-sandbox` 0.6.2 is declared in `config/packages.lock.json` and installed, but **nothing
 *     imports it** — it is on no runtime path in this repo. When it is wired, its `denyRead` is
 *     documented as explicitly not a hard block, so it would not close this either.
 *
 * What is left is the `guard.observed` record in the transcript and the operator reading it.
 *
 * ## Detection coverage, unchanged (`REQ-PRV-37` -> `REQ-PRV-39`)
 *
 * This gate reads the *arguments* of a tool call. A bash command can still reach a secret through a
 * construct the tokeniser cannot see through — `eval "$(printf ...)"`, a variable holding the path,
 * a script file that opens it, a `find -exec`. Segments containing those constructs are marked
 * `opaque` by the tokeniser and their words are still harvested, but nothing here can follow a value
 * that only exists at runtime. The honest statement of coverage is: direct paths in tool arguments
 * are seen and recorded, runtime-computed paths are not seen at all.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { collectTargets } from "../targets.ts";
import { observe } from "../observe.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

/** Allowlist wins first — these are templates, committed on purpose. */
const ALLOW = [/\.env\.(example|template|sample)$/, /\.env\.local\.example$/];

/**
 * Denylist, in the order it is evaluated. Specific FILE patterns precede the DIRECTORY patterns
 * that would also match them, so the reported id is the informative one: `cat ~/.ssh/id_ed25519`
 * must report `SEC-KEY`, which an ordering with `SEC-SSH` first could never produce.
 */
const DENY: ReadonlyArray<[string, RegExp]> = [
  ["SEC-ENV", /(^|\/)\.env(\.[^/]+)?$/],
  // F3: `~/.pi/secrets.env` does not start with `.env`, so `SEC-ENV` above never matched it.
  ["SEC-PI-SECRETS", /(^|\/)secrets\.env$/],
  ["SEC-PI-SECRETS", /(^|\/)\.pi\/secrets/],
  ["SEC-KEY", /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/],
  ["SEC-PEM", /\.(pem|p12|pfx|key)$/],
  ["SEC-AWS-CRED", /(^|\/)\.aws\/credentials$/],
  ["SEC-CREDJSON", /(^|\/)credentials\.json$/],
  // The agent's own credential stores — REQ-PRV-15. These are the ones PI itself writes.
  ["SEC-PI-AUTH", /(^|\/)\.pi\/agent\/(auth|trust)\.json$/],
  ["SEC-TOKENCACHE", /(^|\/)\.cache\/pi\/dbx-token-[^/]*$/],
  ["SEC-QUOTA-PAT", /(^|\/)\.config\/pi-config\/copilot-pat$/],
  // REQ-PRV-37 names these two; the requirement is the MUST.
  ["SEC-QUOTA-TOKEN", /quota-token\.json$/],
  ["SEC-SESSION", /\.session$/],
  // Directory-scoped, evaluated last so a more precise id above always wins.
  //
  // `(\/|$)` and not `\/`: the directory itself is a target, not only the paths under it. A bare
  // `~/.aws` reaches this table whenever it is an argument — `cd ~/.aws`, `ls ~/.ssh`,
  // `tar -cf x ~/.aws` — and with a trailing-slash-only anchor none of those matched. That was
  // survivable while the bash allowlist refused every unknown program headless; it stopped being
  // survivable the moment a headless run could be escalated past that gate. Since the 2026-08-15
  // demotion this anchoring no longer refuses anything, but it is still the only reason
  // `cd ~/.aws && cat credentials` is *recorded* at all (the second segment's bare `credentials`
  // resolves against the session cwd, which is not `~/.aws`, so the directory match in the first
  // segment is the whole detection). Do not loosen it back.
  // Deliberately NOT applied to `SEC-SECRETSDIR` below: `secrets?` is an ordinary English word
  // and `(\/|$)` there would deny every command whose last argument happens to be `secret`.
  ["SEC-SSH", /(^|\/)\.ssh(\/|$)/],
  ["SEC-AWS", /(^|\/)\.aws(\/|$)/],
  ["SEC-SECRETSDIR", /(^|\/)secrets?\//],
  ["SEC-PI-STATE", /(^|\/)\.pi\/agent\//],
];

export function secretPathsGate(_policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "SEC",
    // No `onInternalError` override — this gate now sits on `guarded-handler.ts`'s shared default,
    // "open". It used to carry `"closed"` (F2), on the reasoning that this rule's absence IS the
    // unsafe state: if a bug skipped it a credential read would go through unrefused, so refusing
    // the call was the safer failure. That reasoning inverted with the 2026-08-15 demotion. The rule
    // no longer refuses anything, so its absence now costs exactly one missing audit line — while
    // failing closed would mean a bug in an audit-only gate turns the agent into a machine that
    // refuses every tool call. That is the precise failure `REQ-EXT-16` exists to prevent, and there
    // is no longer anything on the other side of the trade.
    evaluate(event, ctx) {
      // Deliberately NOT filtered by tool name: the ported hook's own header explains why —
      // the same script must work under harnesses that use different tool names.
      for (const target of collectTargets(event, ctx.cwd)) {
        if (ALLOW.some((re) => re.test(target))) continue;
        const hit = DENY.find(([, re]) => re.test(target));
        if (hit) {
          return observe({
            event,
            gateId: hit[0],
            what: `${event.toolName} touching a credential path (${target})`,
            services,
            detail: { target },
          });
        }
      }
      return { block: false };
    },
  };
}

/** Exported for the table test, which asserts the id a given path produces. */
export const SECRET_DENY_RULES: ReadonlyArray<[string, RegExp]> = DENY;
export const SECRET_ALLOW_RULES: readonly RegExp[] = ALLOW;

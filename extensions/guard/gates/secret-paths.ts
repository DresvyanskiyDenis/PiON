/**
 * `REQ-PRV-15`, `REQ-PRV-37`. No override exists.
 *
 * RESIDUAL RISK, stated rather than papered over (`REQ-PRV-37` -> `REQ-PRV-39`): this gate reads
 * the *arguments* of a tool call. A bash command can still reach a secret through a construct the
 * tokeniser cannot see through — `eval "$(printf ...)"`, a variable holding the path, a script
 * file that opens it, a `find -exec`. Segments containing those constructs are marked `opaque` by
 * the tokeniser and their words are still harvested, but nothing here can follow a value that
 * only exists at runtime. `pi-sandbox` is NOT the answer: its `denyRead` is explicitly not a hard
 * block, which is why this gate sits ABOVE the sandbox and never delegates to it. The honest
 * statement of coverage is: direct paths in tool arguments, yes; runtime-computed paths, no.
 */
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../../lib/escape-hatch.ts";
import { collectTargets } from "../targets.ts";
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
  // survivable the moment a headless run could be escalated past that gate. As of the 2026-08-14
  // deny-list inversion there is no other gate left to rest on at all — the allowlist, the
  // escalation and the FS boundary are gone or advisory — so this anchoring is now the *only*
  // thing that refuses `cd ~/.aws && cat credentials`, and it has no override. Do not loosen it
  // back.
  // Deliberately NOT applied to `SEC-SECRETSDIR` below: `secrets?` is an ordinary English word
  // and `(\/|$)` there would deny every command whose last argument happens to be `secret`.
  ["SEC-SSH", /(^|\/)\.ssh(\/|$)/],
  ["SEC-AWS", /(^|\/)\.aws(\/|$)/],
  ["SEC-SECRETSDIR", /(^|\/)secrets?\//],
  ["SEC-PI-STATE", /(^|\/)\.pi\/agent\//],
];

export function secretPathsGate(_policy: Policy): GuardRule {
  return {
    id: "SEC",
    // F2: this rule's absence IS the unsafe state — a bug that skips it must refuse the tool
    // call, not quietly let it through. `guarded-handler.ts`'s shared default is "open".
    onInternalError: "closed",
    evaluate(event, ctx) {
      // Deliberately NOT filtered by tool name: the ported hook's own header explains why —
      // the same script must work under harnesses that use different tool names.
      for (const target of collectTargets(event, ctx.cwd)) {
        if (ALLOW.some((re) => re.test(target))) continue;
        const hit = DENY.find(([, re]) => re.test(target));
        if (hit) {
          return denyWithEscapeHatch({
            gateId: hit[0],
            what: `${event.toolName} touching a credential path (${target})`,
            overridable: false,
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

/**
 * The call site for `REQ-CTX-06`'s written-justification hatch.
 *
 * `lib/escape-hatch.ts` owns the protocol (the token, the minimum length, the "did you just
 * restate the command" check). This owns the *tool_call* half: which argument the justification
 * may appear in, removing it in place so the executed command is unchanged, and emitting the
 * single `guard.override` audit entry this module emits.
 *
 * Mutating `event.input` in place is the documented way to patch arguments ("input mutation is
 * in-place and is not re-validated"). All that is removed is a `#`
 * comment line, so the command's behaviour cannot change.
 */
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { extractJustification, stripJustification } from "../lib/escape-hatch.ts";
import type { GuardServices } from "./services.ts";

export interface OverrideAttempt {
  readonly event: ToolCallEvent;
  readonly gateId: string;
  /** Input keys that may carry the justification, in priority order. */
  readonly keys: readonly string[];
  readonly services: GuardServices;
  /** Extra fields for the audit entry, e.g. the matched pattern. */
  readonly detail?: Record<string, unknown>;
}

/**
 * @returns true when a valid justification was found. The justification comment has then been
 * stripped from `event.input` and one `guard.override` entry has been written.
 */
export function tryOverride(attempt: OverrideAttempt): boolean {
  const input = attempt.event.input as Record<string, unknown>;
  for (const key of attempt.keys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const justification = extractJustification(value, attempt.gateId);
    if (!justification) continue;

    input[key] = stripJustification(value, attempt.gateId);
    attempt.services.audit("guard.override", {
      gateId: attempt.gateId,
      toolName: attempt.event.toolName,
      toolCallId: attempt.event.toolCallId,
      argument: key,
      justification: justification.text,
      at: Date.now(),
      ...attempt.detail,
    });
    return true;
  }
  return false;
}

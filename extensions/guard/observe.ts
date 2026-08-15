/**
 * The audit-only verdict — what a gate does now that it no longer blocks.
 *
 * ## Why this exists
 *
 * The 2026-08-14 inversion turned the guard from an allow-list into a deny-list, and the 2026-08-15
 * follow-up took `SEC` off the blocking side as well: only `DB-*` and the two history-destroying
 * `GIT-*` rules refuse anything now. `SEC` (credential paths), `PRV` (sudo / chmod 777 / pkill -9 /
 * killall), `FS` (the sandbox write boundary) and `RTE` (the dispatch routing veto) all stopped
 * refusing — but their *detectors* were the only thing in the tree that could tell an operator,
 * after the fact, that a command read a credential file, ran as root, wrote outside the project, or
 * dispatched a generic agent past a matching specialist.
 *
 * Removing enforcement is the instruction. Removing observability is not: "fail loud is
 * unchanged". So those four gates keep evaluating and write one `guard.observed` entry per match,
 * then return `{ block: false }`. The entry is deliberately shaped like `guard.block`'s
 * (`lib/guarded-handler.ts#writeAudit`) so a reader can join the two streams: same `gateId`,
 * `toolName`, `toolCallId` and `at`, with `what` carrying the human-readable finding.
 *
 * What this is NOT: a prompt, a warning banner or a rate limit. It never reaches the model and
 * never reaches the operator mid-run — a gate that asks instead of blocking has not been relaxed.
 * It lands in the session transcript, which is where an audit belongs.
 */
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GuardVerdict } from "../lib/guarded-handler.ts";
import type { GuardServices } from "./services.ts";

export interface Observation {
  readonly event: ToolCallEvent;
  /** The specific finding id, e.g. `FS-OUTSIDE` or `PRV-SUDO`. */
  readonly gateId: string;
  /** One human-readable sentence: what was seen, not what to do about it. */
  readonly what: string;
  readonly services: GuardServices;
  /** Extra structured fields, e.g. the resolved write target. */
  readonly detail?: Record<string, unknown>;
}

/** Records the observation and permits the call. The return value is always `{ block: false }`. */
export function observe(observation: Observation): GuardVerdict {
  observation.services.audit("guard.observed", {
    gateId: observation.gateId,
    toolName: observation.event.toolName,
    toolCallId: observation.event.toolCallId,
    what: observation.what,
    at: Date.now(),
    ...observation.detail,
  });
  return { block: false };
}

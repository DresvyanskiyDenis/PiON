/**
 * The named, session-scoped registry — the fourth thing no
 * package supplies: *"a named, session-scoped registry so a teammate is addressable by name across
 * turns."*
 *
 * `pi-subagents` gives every child an opaque run id and a one-shot lifecycle. What is missing is a
 * handle the model can hold in its head — `reviewer`, `researcher` — that still resolves to the same
 * live session three turns later. That is this file.
 *
 * "Session-scoped" is literal and load-bearing:
 *   - the map is owned by one registration of the extension and cleared at `session_shutdown`;
 *   - it is stamped with the owning session id, so a report can never attribute a teammate to the
 *     wrong lead;
 *   - nothing is persisted. A teammate is a live in-process session, and a handle that outlived the
 *     process would resolve to a session that no longer exists — a worse failure than not finding it.
 *
 * It also owns the delivery bookkeeping, because "who delivered and who did not" is a property of
 * the team, not of any one message: {@link TeamRegistry.stranded} is what `turn_end` and
 * `session_shutdown` report on, and it is the direct answer to the 22 empty notifications.
 */
import { MAX_REMINDERS, MAX_TEAMMATES } from "./contract.ts";
import {
  DeliveryObligation,
  describeOutcome,
  type DeliveryStatus,
  type ObligationOutcome,
} from "./obligation.ts";
import type { DeliverySink, TeammateSession } from "./runtime.ts";

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type TeammateStatus = "idle" | "working" | "abandoned" | "closed";

export interface TranscriptLine {
  readonly at: number;
  readonly from: "lead" | "teammate";
  readonly text: string;
}

export interface TeammateRecord {
  readonly name: string;
  readonly agent: string;
  readonly session: TeammateSession;
  readonly spawnedAt: number;
  status: TeammateStatus;
  /** The obligation opened by the most recent `send`, if any. */
  obligation?: DeliveryObligation;
  readonly history: ObligationOutcome[];
  readonly transcript: TranscriptLine[];
}

export class TeammateError extends Error {
  readonly teammate: string | undefined;
  constructor(message: string, teammate?: string) {
    super(message);
    this.name = "TeammateError";
    this.teammate = teammate;
  }
}

export interface TeamRegistryOptions {
  readonly ownerSessionId: string;
  readonly maxTeammates?: number;
  readonly maxReminders?: number;
}

export class TeamRegistry implements DeliverySink {
  readonly ownerSessionId: string;
  readonly maxTeammates: number;
  readonly maxReminders: number;

  readonly #team = new Map<string, TeammateRecord>();

  constructor(options: TeamRegistryOptions) {
    this.ownerSessionId = options.ownerSessionId;
    this.maxTeammates = options.maxTeammates ?? MAX_TEAMMATES;
    this.maxReminders = options.maxReminders ?? MAX_REMINDERS;
  }

  get size(): number {
    return this.#team.size;
  }

  names(): string[] {
    return [...this.#team.keys()];
  }

  values(): TeammateRecord[] {
    return [...this.#team.values()];
  }

  get(name: string): TeammateRecord | undefined {
    return this.#team.get(name);
  }

  /** Resolution failures are thrown, not returned: a lead talking to a teammate that is not there
   *  must not read like a teammate that answered nothing. */
  require(name: string): TeammateRecord {
    const found = this.#team.get(name);
    if (found === undefined) {
      const live = this.names();
      throw new TeammateError(
        `no teammate "${name}". ` +
          (live.length > 0 ? `Live teammates: ${live.join(", ")}.` : `No teammates are live.`) +
          ` Spawn one with teammate(action="spawn", name=…, agent=…).`,
        name,
      );
    }
    return found;
  }

  /** Every reason a spawn can be refused, checked before anything expensive happens. */
  assertCanSpawn(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new TeammateError(
        `teammate name "${name}" is invalid: use lower-case letters, digits and hyphens, ` +
          `starting with a letter, at most 32 characters.`,
        name,
      );
    }
    if (this.#team.has(name)) {
      throw new TeammateError(`teammate "${name}" already exists; send to it or close it first.`, name);
    }
    if (this.#team.size >= this.maxTeammates) {
      throw new TeammateError(
        `teammate: refused — ${this.maxTeammates} already live (${this.names().join(", ")}). ` +
          `Each teammate is a full extra session; close one before spawning another.`,
        name,
      );
    }
  }

  add(record: Omit<TeammateRecord, "history" | "transcript" | "status">): TeammateRecord {
    this.assertCanSpawn(record.name);
    const full: TeammateRecord = { ...record, status: "idle", history: [], transcript: [] };
    this.#team.set(record.name, full);
    return full;
  }

  /** Opens the obligation for one lead -> teammate message. Nothing else may create one. */
  open(name: string, now: number = Date.now()): DeliveryObligation {
    const t = this.require(name);
    const obligation = new DeliveryObligation(name, this.maxReminders, now);
    t.obligation = obligation;
    t.status = "working";
    return obligation;
  }

  /** Records the outcome of a finished obligation and moves the teammate back to a resting state. */
  close(name: string, now: number = Date.now()): ObligationOutcome | undefined {
    const t = this.get(name);
    const obligation = t?.obligation;
    if (t === undefined || obligation === undefined) return undefined;
    obligation.settle(now);
    const outcome = obligation.outcome(now);
    t.history.push(outcome);
    if (outcome.delivery !== undefined) {
      t.transcript.push({ at: outcome.closedAt, from: "teammate", text: outcome.delivery.report });
    }
    t.status = obligation.phase === "abandoned" ? "abandoned" : "idle";
    t.obligation = undefined;
    return outcome;
  }

  /** {@link DeliverySink}. The single write path from a child back into the lead's bookkeeping. */
  deliver(
    teammate: string,
    report: string,
    status: DeliveryStatus,
  ): { readonly accepted: boolean; readonly note: string } {
    const t = this.#team.get(teammate);
    if (t === undefined) {
      return {
        accepted: false,
        note:
          `not delivered: teammate "${teammate}" is no longer registered with the lead. ` +
          `Your report was not received.`,
      };
    }
    const obligation = t.obligation;
    if (obligation === undefined) {
      return {
        accepted: false,
        note:
          `not delivered: the lead is not waiting on you right now, so there is nothing to deliver ` +
          `into. Wait for the next message before reporting.`,
      };
    }
    obligation.record(report, status);
    if (obligation.terminal) {
      return {
        accepted: false,
        note:
          `received late: the lead already released you after ${obligation.reminders} reminder(s), ` +
          `so this report was recorded but not returned to it. Deliver before going idle next time.`,
      };
    }
    return { accepted: true, note: status === "blocked" ? "blocked report delivered" : "delivered" };
  }

  async remove(name: string): Promise<void> {
    const t = this.#team.get(name);
    if (t === undefined) return;
    this.#team.delete(name);
    t.status = "closed";
    await disposeQuietly(t);
  }

  /**
   * Teammates whose most recent work never reached the lead: released undelivered, or still
   * mid-obligation at the moment we are asked. This list is the whole point of the module — on the
   * old harness it was empty-by-construction because nobody was keeping it.
   */
  stranded(): Array<{ readonly record: TeammateRecord; readonly why: string }> {
    const out: Array<{ record: TeammateRecord; why: string }> = [];
    for (const t of this.#team.values()) {
      if (t.obligation !== undefined && !t.obligation.terminal && t.obligation.delivery === undefined) {
        out.push({ record: t, why: `still working; nothing delivered yet` });
        continue;
      }
      const last = t.history[t.history.length - 1];
      if (last !== undefined && (last.phase === "abandoned" || last.phase === "aborted")) {
        out.push({ record: t, why: describeOutcome(last) });
      }
    }
    return out;
  }

  /** `/teammates`. One block per teammate, wide enough to act on and no wider. */
  render(): string {
    if (this.#team.size === 0) {
      return `no teammates in session ${this.ownerSessionId} (max ${this.maxTeammates}).`;
    }
    const rows = this.values().map((t) => {
      const last = t.history[t.history.length - 1];
      const delivered = t.history.filter((h) => h.phase === "delivered" || h.phase === "blocked").length;
      const undelivered = t.history.filter((h) => h.phase === "abandoned" || h.phase === "aborted").length;
      const where = t.session.sessionFile ?? `(unsaved session ${t.session.sessionId})`;
      return [
        `  ${t.name.padEnd(16)} ${t.agent.padEnd(22)} ${t.status}`,
        `      exchanges: ${t.history.length} (${delivered} delivered, ${undelivered} undelivered)`,
        last !== undefined ? `      last: ${describeOutcome(last)}` : `      last: (never messaged)`,
        `      transcript: ${where}`,
      ].join("\n");
    });
    return `teammates in session ${this.ownerSessionId} (${this.#team.size}/${this.maxTeammates}):\n${rows.join("\n")}`;
  }

  /** `session_shutdown`. Disposes everything and clears; the caller reports what was stranded. */
  async clear(): Promise<void> {
    const all = this.values();
    this.#team.clear();
    await Promise.all(all.map((t) => disposeQuietly(t)));
  }
}

async function disposeQuietly(t: TeammateRecord): Promise<void> {
  try {
    t.session.dispose();
  } catch (err) {
    // Teardown of one child must not strand the others; the failure is surfaced by the caller's
    // shutdown report, which already names every session file.
    process.stderr.write(
      `[pi-config] teammates: disposing "${t.name}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

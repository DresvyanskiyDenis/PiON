/**
 * The delivery-obligation state machine, as code.
 *
 * One obligation is opened per lead -> teammate message and is the *only* thing that can end a
 * `teammate(action:"send")` call. There are exactly four terminal states and every one of them
 * produces text for the lead:
 *
 *   delivered  — the teammate called the reply tool with a report.
 *   blocked    — the teammate called the reply tool and said it could not finish. Still a delivery.
 *   abandoned  — it went idle {@link MAX_REMINDERS} times without calling it. Released, recorded,
 *                and reported as an error, because this is the exact failure of session 488f77ad.
 *   aborted    — the lead's own turn was aborted. Not the teammate's fault, still not a delivery.
 *
 * There is no fifth state in which the call simply returns nothing, which is the whole point: on the
 * old harness "idle with no delivery" was invisible, so it happened five times out of five without
 * anyone noticing until the reports were looked for and were not there.
 *
 * The machine is pure — no sessions, no I/O, no timers — so the bound on reminders is testable
 * without spending a token.
 */
import { MAX_REMINDERS } from "./contract.ts";

export type DeliveryStatus = "complete" | "blocked";

export type ObligationPhase =
  | "awaiting"
  | "reminding"
  | "delivered"
  | "blocked"
  | "abandoned"
  | "aborted";

export interface Delivery {
  readonly report: string;
  readonly status: DeliveryStatus;
  readonly at: number;
}

export type IdleStep =
  | { readonly action: "done"; readonly delivery: Delivery }
  | { readonly action: "remind"; readonly attempt: number; readonly max: number }
  | { readonly action: "release"; readonly reason: string };

export interface ObligationOutcome {
  readonly teammate: string;
  readonly phase: ObligationPhase;
  readonly reminders: number;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly delivery?: Delivery;
  /** A reply that arrived after the obligation was already released. Recoverable, but not returned. */
  readonly lateDelivery?: Delivery;
  /** Why the exchange was aborted. Set only for `phase: "aborted"`. */
  readonly reason?: string;
}

export class DeliveryObligation {
  readonly teammate: string;
  readonly maxReminders: number;
  readonly openedAt: number;

  #phase: ObligationPhase = "awaiting";
  #reminders = 0;
  #delivery: Delivery | undefined;
  #lateDelivery: Delivery | undefined;
  #deliveries = 0;
  #closedAt = 0;
  #reason: string | undefined;

  constructor(teammate: string, maxReminders: number = MAX_REMINDERS, now: number = Date.now()) {
    if (!Number.isInteger(maxReminders) || maxReminders < 0) {
      throw new RangeError(
        `teammates: maxReminders must be a non-negative integer, got ${String(maxReminders)}`,
      );
    }
    this.teammate = teammate;
    this.maxReminders = maxReminders;
    this.openedAt = now;
  }

  get phase(): ObligationPhase {
    return this.#phase;
  }

  get reminders(): number {
    return this.#reminders;
  }

  /** How many times the reply tool fired. >1 means the teammate revised; the last one wins. */
  get deliveryCount(): number {
    return this.#deliveries;
  }

  get delivery(): Delivery | undefined {
    return this.#delivery;
  }

  get lateDelivery(): Delivery | undefined {
    return this.#lateDelivery;
  }

  /** True once the call may return: nothing is pending and nothing more will be attempted. */
  get terminal(): boolean {
    return (
      this.#phase === "delivered" ||
      this.#phase === "blocked" ||
      this.#phase === "abandoned" ||
      this.#phase === "aborted"
    );
  }

  /** True when the teammate met the obligation — including by declaring itself blocked. */
  get discharged(): boolean {
    return this.#phase === "delivered" || this.#phase === "blocked";
  }

  /**
   * Called by the reply tool the runtime injects into the child. This is the single write path;
   * nothing else can discharge an obligation.
   */
  record(report: string, status: DeliveryStatus = "complete", now: number = Date.now()): void {
    const delivery: Delivery = { report, status, at: now };
    this.#deliveries += 1;
    if (this.terminal) {
      // A reply that arrives after release cannot be returned to a tool call that already
      // finished. It is kept so `/teammates` and the shutdown report can point at real work
      // instead of pretending it does not exist.
      this.#lateDelivery = delivery;
      return;
    }
    this.#delivery = delivery;
  }

  /**
   * Called every time the child session goes idle. Idempotent once terminal, and bounded by
   * construction: at most `maxReminders` `remind` steps are ever returned, after which every call
   * returns `release`. That bound is what stops this from becoming the stop-hook loop the old
   * harness's `TeammateIdle` hook had to be capped to avoid.
   */
  onIdle(now: number = Date.now()): IdleStep {
    this.settle(now);
    if (this.#phase === "delivered" || this.#phase === "blocked") {
      return { action: "done", delivery: this.#delivery as Delivery };
    }
    if (this.terminal) {
      return { action: "release", reason: this.#releaseReason() };
    }
    if (this.#reminders < this.maxReminders) {
      this.#reminders += 1;
      this.#phase = "reminding";
      return { action: "remind", attempt: this.#reminders, max: this.maxReminders };
    }
    this.#phase = "abandoned";
    this.#closedAt = now;
    return { action: "release", reason: this.#releaseReason() };
  }

  /**
   * Promotes a recorded delivery to its terminal phase. Never reminds, never abandons.
   *
   * Split out of {@link onIdle} because a delivery must be recognised on *every* path that ends an
   * exchange, not only on the one that polls for idleness. A recorded report sitting behind an
   * `awaiting` phase is undelivered work that the bookkeeping cannot see — the module's whole
   * failure mode, one level down.
   */
  settle(now: number = Date.now()): void {
    if (this.terminal || this.#delivery === undefined) return;
    this.#phase = this.#delivery.status === "blocked" ? "blocked" : "delivered";
    this.#closedAt = now;
  }

  /**
   * The exchange ended without the teammate getting the chance to answer — the lead's turn was
   * aborted, or the child session itself threw. Terminal, and explicitly not a delivery: an
   * exchange that ends this way must never be reported as one.
   */
  abort(reason: string, now: number = Date.now()): void {
    if (this.terminal) return;
    this.#phase = "aborted";
    this.#reason = reason;
    this.#closedAt = now;
  }

  outcome(now: number = Date.now()): ObligationOutcome {
    return {
      teammate: this.teammate,
      phase: this.#phase,
      reminders: this.#reminders,
      openedAt: this.openedAt,
      closedAt: this.#closedAt || now,
      ...(this.#delivery !== undefined ? { delivery: this.#delivery } : {}),
      ...(this.#lateDelivery !== undefined ? { lateDelivery: this.#lateDelivery } : {}),
      ...(this.#reason !== undefined ? { reason: this.#reason } : {}),
    };
  }

  #releaseReason(): string {
    if (this.#phase === "aborted") {
      return (
        `the exchange with "${this.teammate}" ended before it delivered ` +
        `(${this.#reason ?? "reason not recorded"}); nothing was delivered`
      );
    }
    return (
      `teammate "${this.teammate}" went idle ${this.maxReminders + 1} times without delivering ` +
      `(after ${this.#reminders} reminder${this.#reminders === 1 ? "" : "s"}) and was released`
    );
  }
}

/** One line per finished obligation, for `/teammates` and the shutdown report. */
export function describeOutcome(o: ObligationOutcome): string {
  const age = Math.max(0, Math.round((o.closedAt - o.openedAt) / 1000));
  switch (o.phase) {
    case "delivered":
      return `${o.teammate}: delivered (${o.delivery?.report.length ?? 0} chars, ${age}s, ${o.reminders} reminder(s))`;
    case "blocked":
      return `${o.teammate}: reported BLOCKED (${age}s, ${o.reminders} reminder(s))`;
    case "abandoned":
      return (
        `${o.teammate}: UNDELIVERED after ${o.reminders} reminder(s), ${age}s` +
        (o.lateDelivery ? " — a late reply arrived after release and was kept" : "")
      );
    case "aborted":
      return `${o.teammate}: exchange ended after ${age}s without delivery (${o.reason ?? "reason not recorded"})`;
    default:
      return `${o.teammate}: still ${o.phase} after ${age}s`;
  }
}

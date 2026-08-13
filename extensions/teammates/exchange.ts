/**
 * One lead -> teammate exchange, from message to outcome.
 *
 * This is the control-flow half of the delivery obligation, and it is the reason the obligation is
 * structural rather than advisory. `teammate(action:"send")` does not return when the child stops
 * talking; it returns when the obligation reaches a terminal state. "The child went idle and said
 * nothing" is therefore not a return path — it is an event that either produces a reminder or an
 * `abandoned` outcome that the lead is told about, loudly.
 *
 * The loop is bounded by {@link DeliveryObligation}, which hands out at most `maxReminders`
 * `remind` steps and then `release` forever. There is no condition under which this iterates
 * indefinitely, which is the corrected version of the old harness's `TeammateIdle` hook — that one
 * had to be capped at two reminders after the fact to avoid a stop-hook loop.
 */
import { reminderText, withObligation } from "./contract.ts";
import type { ObligationOutcome } from "./obligation.ts";
import { TeammateError, type TeamRegistry } from "./team.ts";

export interface ExchangeDeps {
  readonly registry: TeamRegistry;
  readonly name: string;
  readonly message: string;
  readonly signal?: AbortSignal | undefined;
  readonly onUpdate?: ((line: string) => void) | undefined;
  readonly now?: () => number;
}

export interface ExchangeResult {
  readonly outcome: ObligationOutcome;
  /** The child's last assistant text, captured only when nothing was delivered. Salvage, not result. */
  readonly salvage?: string;
  readonly sessionFile?: string;
}

export async function runExchange(deps: ExchangeDeps): Promise<ExchangeResult> {
  const now = deps.now ?? Date.now;
  const t = deps.registry.require(deps.name);
  const obligation = deps.registry.open(deps.name, now());
  t.transcript.push({ at: now(), from: "lead", text: deps.message });

  try {
    await t.session.prompt(withObligation(deps.message), { signal: deps.signal });

    for (;;) {
      if (deps.signal?.aborted) {
        obligation.abort("the lead's turn was aborted", now());
        break;
      }
      const step = obligation.onIdle(now());
      if (step.action !== "remind") break;
      deps.onUpdate?.(
        `${deps.name} went idle without delivering — reminding (${step.attempt}/${step.max})`,
      );
      await t.session.prompt(reminderText(step.attempt, step.max), { signal: deps.signal });
    }
  } catch (err) {
    // Fail loud, with the cause chain intact (REQ-PRV-32). The obligation is closed first so the
    // registry never keeps a teammate stuck in `working` because of an error path.
    obligation.abort(`the child session threw: ${err instanceof Error ? err.message : String(err)}`, now());
    const outcome = deps.registry.close(deps.name, now());
    throw new TeammateError(
      `teammate "${deps.name}" (agent ${t.agent}) failed mid-exchange after ` +
        `${outcome?.reminders ?? 0} reminder(s): ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}. ` +
        `Its transcript is at ${t.session.sessionFile ?? `(unsaved session ${t.session.sessionId})`}.`,
      deps.name,
    );
  }

  const outcome = deps.registry.close(deps.name, now());
  if (outcome === undefined) {
    throw new TeammateError(
      `teammate "${deps.name}": the exchange finished but no outcome was recorded. This is a bug in ` +
        `the teammates module, not in the teammate; its transcript is at ` +
        `${t.session.sessionFile ?? `(unsaved session ${t.session.sessionId})`}.`,
      deps.name,
    );
  }

  const salvage = outcome.delivery === undefined ? safeLastText(t.session) : undefined;
  return {
    outcome,
    ...(salvage !== undefined && salvage !== "" ? { salvage } : {}),
    ...(t.session.sessionFile !== undefined ? { sessionFile: t.session.sessionFile } : {}),
  };
}

/**
 * The child's last assistant message, for an undelivered exchange only.
 *
 * This exists because of the specific shape of the 488f77ad failure: the reports were *written*,
 * they just never moved. Pointing at a transcript file is the correct fix; also handing the lead the
 * last thing the teammate said turns a dead end into something actionable. It is labelled at every
 * call site as not-a-delivery, because a salvaged tail read as a report is how a half-finished
 * answer gets treated as a finished one.
 */
function safeLastText(session: { lastAssistantText(): string | undefined }): string | undefined {
  try {
    return session.lastAssistantText();
  } catch {
    // Salvage is a best-effort courtesy on an error path; failing to get it must not replace the
    // abandonment error the lead actually needs to see.
    return undefined;
  }
}

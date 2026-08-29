/**
 * The written-justification protocol (REQ-CTX-06).
 *
 * `tool_call` can return only `{ block, reason }`, so the `reason` string is the ONLY channel
 * back to the model. The protocol therefore has to be expressible in prose and re-detectable
 * in the arguments of the next call.
 */

export interface EscapeHatchDenial {
  readonly gateId: string;
  /** What was matched, in the model's own terms. */
  readonly what: string;
  /** What a legitimate use would look like, if any. Omit when nothing legitimises it. */
  readonly legitimateUse?: string;
  /** false => hard gate: no justification is accepted (e.g. `rm -rf /`). */
  readonly overridable: boolean;
}

/** The literal token a re-issued call must carry. Exported so gates can spell it in help text. */
export const JUSTIFY_TOKEN = "PI-JUSTIFY";

/** A justification shorter than this is not an explanation. */
export const MIN_JUSTIFICATION_CHARS = 20;

/** Builds the reason string. This text is the entire user interface of a gate. */
export function denyWithEscapeHatch(d: EscapeHatchDenial): { block: true; reason: string } {
  const head = `Blocked by gate ${d.gateId}: ${d.what}.`;
  if (!d.overridable) {
    return {
      block: true,
      reason: `${head} This gate has no override. Do not retry; change the approach.`,
    };
  }
  const how =
    `If this is genuinely required, re-issue the SAME call with a leading comment line ` +
    `"# ${JUSTIFY_TOKEN}(${d.gateId}): <one sentence saying why, naming the concrete target>". ` +
    `A justification that restates the command instead of explaining it will be rejected.`;
  return {
    block: true,
    reason: d.legitimateUse ? `${head} ${d.legitimateUse} ${how}` : `${head} ${how}`,
  };
}

/**
 * The inverse of `denyWithEscapeHatch`: reads a denial's `gateId`, `what` and `overridable`
 * back out of the reason string that carries them.
 *
 * `tool_call` returns nothing but `{ block, reason }`, and `guardedHandler`'s `guard.block`
 * audit entry (`lib/guarded-handler.ts`) stores exactly that reason, not the `EscapeHatchDenial`
 * it was built from. `guard/denial-card.ts` renders that audit entry for a person, and a person
 * reading a denial needs the three fields separately, not run together in one paragraph. Rather
 * than widen the audit entry, and with it `guardedHandler`'s call site — the one path in this
 * tree required to stay boring — the parser is kept beside the builder, so a wording change in
 * either one breaks this file's tests first.
 *
 * Returns `null` for a reason this function did not build: a rule that constructs its own denial
 * text outside `denyWithEscapeHatch`, or a wording this parser predates. That is the honest
 * answer for the card to act on, and it does: it falls back to the raw reason rather than
 * inventing a gate id or an override that is not really there.
 */
export function parseEscapeHatchDenial(reason: string): EscapeHatchDenial | null {
  const m = /^Blocked by gate ([^:]+): (.*?)\.(?:\s|$)/s.exec(reason);
  if (!m) return null;
  return {
    gateId: m[1]!,
    what: m[2]!,
    overridable: !reason.includes("This gate has no override."),
  };
}

/**
 * The exact re-issue line `denyWithEscapeHatch` embeds in its `how` paragraph, pre-filled with
 * `gateId` and ready to paste above the retried call. Kept as its own export, separate from the
 * prose `denyWithEscapeHatch` builds for the model, because `guard/denial-card.ts` needs the
 * template on its own line rather than folded into a sentence — the gate id is the one part of
 * an override that is silently ignored when mistyped, so a card that shows it has to show it
 * spelled exactly right.
 */
export function justificationTemplate(gateId: string): string {
  return `# ${JUSTIFY_TOKEN}(${gateId}): <one sentence saying why, naming the concrete target>`;
}

export interface Justification {
  readonly gateId: string;
  readonly text: string;
}

/** Extracts a justification from a bash command string (or any free-text tool argument). */
export function extractJustification(raw: string, gateId: string): Justification | null {
  const m = justifyRe(gateId).exec(raw);
  if (!m) return null;
  const text = m[1]!.trim();
  if (text.length < MIN_JUSTIFICATION_CHARS) return null;
  if (restatesTheCommand(raw, gateId, text)) return null;
  return { gateId, text };
}

/** Strips the justification comment so the executed command is unchanged. */
export function stripJustification(raw: string, gateId: string): string {
  return raw.replace(stripRe(gateId), "");
}

/**
 * Rejects the degenerate case: a "justification" that is the command echoed back.
 *
 * The comparison is made against the command with the justification line removed. Comparing
 * against `raw` — which still contains the justification — makes the containment test
 * trivially true and rejects every justification, including valid ones.
 */
function restatesTheCommand(raw: string, gateId: string, text: string): boolean {
  const rest = normalize(stripJustification(raw, gateId));
  if (rest.length === 0) return false;
  const claim = normalize(text);
  return claim.includes(rest) || rest.includes(claim);
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function justifyRe(gateId: string): RegExp {
  return new RegExp(`^[ \\t]*#[ \\t]*${JUSTIFY_TOKEN}\\(${escapeRe(gateId)}\\)[ \\t]*:[ \\t]*(.+)$`, "mi");
}

function stripRe(gateId: string): RegExp {
  return new RegExp(`^[ \\t]*#[ \\t]*${JUSTIFY_TOKEN}\\(${escapeRe(gateId)}\\)[ \\t]*:.*$\\n?`, "mi");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

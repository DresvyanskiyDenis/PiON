/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */

export const id = "PC-15";
export const title = "No extension source references the X-Initiator header";
export const closes = ["REQ-PRV-29"];

// Deliberately broad rather than trying to distinguish "reads" from "mutates" with a regex:
// a real AST check belongs to the W3c doctor, once there is a TS parser in the dependency
// tree; a static checker with no dependencies cannot safely tell "reads and forwards
// unchanged" from "reads then reassigns", so any reference at all is a finding here. Legit
// code has no reason to name this header — the runtime sets it once, upstream of every
// extension's `before_provider_headers` hook.
const X_INITIATOR = /X-Initiator/i;

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const files = ctx.listFiles({ dir: "extensions", exts: [".ts"] });
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    for (const { line, text } of ctx.lines(file)) {
      if (X_INITIATOR.test(text)) {
        findings.push({ rule: id, file, line, message: '"X-Initiator" referenced in extension code — REQ-PRV-29 forbids any extension from touching this header' });
      }
    }
  }
  return findings;
}

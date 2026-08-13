/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { REPLACE_AFTER } from "../lib/patterns.mjs";

export const id = "PC-11";
export const title = "No unreplaced REPLACE_AFTER_* token anywhere under config/ (review defect 1)";
export const closes = ["REQ-PRV-12a"];

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const files = ctx.listFiles({ dir: "config" });
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    for (const { line, text } of ctx.lines(file)) {
      REPLACE_AFTER.lastIndex = 0;
      for (const m of text.matchAll(REPLACE_AFTER)) {
        findings.push({ rule: id, file, line, message: `unreplaced release-blocker token "${m[0]}" — see docs/getting-started/install.md` });
      }
    }
  }
  return findings;
}

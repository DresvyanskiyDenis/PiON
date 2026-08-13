/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { PLACEHOLDER } from "../lib/patterns.mjs";

export const id = "PC-10";
export const title = "No unreplaced <PLACEHOLDER> token anywhere under config/";
export const closes = ["REQ-PRV-12a"];

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const files = ctx.listFiles({ dir: "config" });
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    // The existing carve-out ("pi-env.sh documents the placeholder table in comments") was keyed
    // on the .sh extension, so it missed config/bin/* — shell scripts with a shebang and no
    // extension, whose ENV: comment blocks document the same table. Key on the file actually
    // being a shell script instead.
    const text = ctx.readText(file);
    if (text === null) continue;
    const isShell = file.endsWith(".sh") || text.startsWith("#!");
    for (const { line, text: lineText } of ctx.lines(file)) {
      if (isShell && /^\s*#/.test(lineText)) continue;
      PLACEHOLDER.lastIndex = 0;
      for (const m of lineText.matchAll(PLACEHOLDER)) {
        // `<PLACEHOLDER>` is the NAME of the convention, not a substitution target — config/README.md
        // states the rule and would otherwise report itself. Every real token is a specific
        // identifier (<GHE_TENANT_HOST>, <CORP_CA_PEM>, ...).
        if (m[0] === "<PLACEHOLDER>") continue;
        findings.push({ rule: id, file, line, message: `unreplaced placeholder "${m[0]}"` });
      }
    }
  }
  return findings;
}

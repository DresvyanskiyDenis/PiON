/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { BARE_ANTHROPIC } from "../lib/patterns.mjs";

export const id = "PC-08";
export const title = "No bare Anthropic model id in routing.json, agents/*.md, or extensions/**/*.ts";
export const closes = ["REQ-CTX-81"];

/** @param {RuleContext} ctx @returns {string[]} */
function scanTargets(ctx) {
  const targets = [];
  if (ctx.exists("config/routing.json")) targets.push("config/routing.json");
  else if (ctx.exists("config/routing.default.json")) targets.push("config/routing.default.json");
  targets.push(...ctx.listFiles({ dir: "agents", exts: [".md"] }));
  targets.push(...ctx.listFiles({ dir: "extensions", exts: [".ts"] }));
  return targets;
}

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of scanTargets(ctx)) {
    for (const { line, text } of ctx.lines(file)) {
      BARE_ANTHROPIC.lastIndex = 0;
      for (const m of text.matchAll(BARE_ANTHROPIC)) {
        if (ctx.isProviderQualified(text, m.index)) continue; // "github-copilot/claude-opus-5" is fine
        findings.push({
          rule: id,
          file,
          line,
          message: `bare model id "${m[1]}" — write "<provider>/${m[1]}"`,
        });
      }
    }
  }
  return findings;
}

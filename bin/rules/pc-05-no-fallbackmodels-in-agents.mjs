/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { parseFrontmatter } from "../lib/frontmatter.mjs";

export const id = "PC-05";
export const title = 'No "fallbackModels" key in any tracked agents/*.md frontmatter';
export const closes = ["REQ-EXT-08-cancelled"];

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const files = ctx.listFiles({ dir: "agents", exts: [".md"] });
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    const text = ctx.readText(file);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    if (!fm.ok) continue;
    const entry = fm.entries.get("fallbackModels");
    if (!entry) continue;
    findings.push({
      rule: id,
      file,
      line: entry.line,
      message: '"fallbackModels" found — a child that quietly answers from a weaker model is the same silent-degradation behaviour EXT-08 was cancelled for',
    });
  }
  return findings;
}

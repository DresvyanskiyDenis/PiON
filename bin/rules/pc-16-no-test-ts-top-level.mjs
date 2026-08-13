/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const id = "PC-16";
export const title = "No *.test.ts file sits at the top level of extensions/ (review defect 12)";
export const closes = ["REQ-EXT-16"];

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const dir = join(ctx.repoRoot, "extensions");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  /** @type {Finding[]} */
  const findings = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      findings.push({
        rule: id,
        file: `extensions/${entry.name}`,
        message: "unit test at the top level of extensions/ would be auto-loaded as an extension by PI's discovery — move it under test/unit/",
      });
    }
  }
  return findings;
}

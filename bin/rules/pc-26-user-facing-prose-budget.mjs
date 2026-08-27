/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanStrings, isUserFacing } from "../lib/user-strings.mjs";

// PC-26 — the prose ratchet.
//
// WHAT IT CHECKS
//
// Every string this repo hands to a person — an argument to `ui.notify`, `ui.setStatus`, a
// widget, or an `Error` constructor, and every `message`/`description`/`title`-shaped object
// property — is counted for one mark of house style: the em dash. The count must equal the
// number recorded in `config/slop-lint.json`. Above it, the gate fails and names the sites;
// below it, the gate also fails and says to lower the budget.
//
// WHY IT FAILS IN BOTH DIRECTIONS
//
// A budget that only fires upward is not a ratchet, it is a number that drifts. Somebody
// cleans three call sites, nobody edits the config, and those three slots are quietly
// available to the next change. Failing on the low side costs one config line per cleanup and
// buys the property that the recorded number is always the true one — which also turns the
// config file into a readable history of the prose getting tighter.
//
// WHAT THE NUMBER IS AND IS NOT
//
// The shipped budget is the count on the day the rule landed, not a target. It grandfathers
// what is already written and stops the total growing. It is not a claim that the current
// level is right: "how much em dash is too much" is a taste call about the voice of a repo,
// and it belongs to whoever owns that voice. Driving the budget to 0 is a one-line config edit
// plus the rewrites this rule will then name.
//
// THE HOLE, STATED PLAINLY
//
// A count is not an allowlist. Delete one em dash, add another elsewhere, and the total is
// unchanged and the gate is green. The diff shows it and a reviewer sees it. The alternative —
// pinning every site by file, line and content hash — churns on every unrelated edit above it.
// For a ratchet whose job is "do not get worse in aggregate", a count is the honest instrument;
// for "this exact sentence is approved", it is the wrong one.
//
// The scanner's own limits, and why the count is a lower bound, are at the top of
// `bin/lib/user-strings.mjs`. They are load-bearing.

export const id = "PC-26";
export const title = "User-facing prose stays at the em-dash budget recorded in config/slop-lint.json";

const CONFIG_PATH = "config/slop-lint.json";

/**
 * Defaults, used when `config/slop-lint.json` is absent. The budget defaults to 0 on purpose:
 * an unconfigured tree is held to the strict reading, so deleting the config file tightens
 * this rule instead of switching it off. Config can only ever widen what is tolerated, never
 * silence the check.
 */
const DEFAULTS = {
  roots: ["extensions", "bin"],
  exts: [".ts", ".mjs", ".js"],
  sinks: ["notify", "setStatus", "setWidget", "setWorkingIndicator", "setFooter", "setHeader", "Error", "TypeError", "RangeError"],
  proseKeys: ["message", "description", "title", "detail", "hint", "label", "summary", "reason"],
  budget: 0,
};

/** The one mark of house style this rule measures. */
const MARK = "—";

/** @param {unknown} value @param {string[]} fallback */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((v) => typeof v === "string");
}

/** @param {RuleContext} ctx */
function loadConfig(ctx) {
  if (!ctx.exists(CONFIG_PATH)) return { ...DEFAULTS, source: "defaults" };
  const raw = /** @type {Record<string, unknown>} */ (ctx.readJSON(CONFIG_PATH));
  return {
    roots: stringList(raw.roots, DEFAULTS.roots),
    exts: stringList(raw.exts, DEFAULTS.exts),
    sinks: stringList(raw.sinks, DEFAULTS.sinks),
    proseKeys: stringList(raw.proseKeys, DEFAULTS.proseKeys),
    budget: typeof raw.budget === "number" && Number.isInteger(raw.budget) && raw.budget >= 0 ? raw.budget : null,
    source: CONFIG_PATH,
  };
}

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const config = loadConfig(ctx);
  if (config.budget === null) {
    return [
      {
        rule: id,
        file: CONFIG_PATH,
        message:
          '"budget" is missing or is not a non-negative integer; it is the whole contract of this rule, ' +
          "so there is no safe value to assume",
      },
    ];
  }

  /** @type {Array<{ file: string, line: number }>} */
  const sites = [];
  for (const root of config.roots) {
    // `.d.ts` files are declarations: their strings are types, never output.
    for (const rel of ctx.listFiles({ dir: root, exts: config.exts })) {
      if (rel.endsWith(".d.ts")) continue;
      let source;
      try {
        source = readFileSync(join(ctx.repoRoot, rel), "utf8");
      } catch {
        continue; // unreadable file — the same tolerance ctx.listFiles takes
      }
      for (const record of scanStrings(source)) {
        if (!record.value.includes(MARK)) continue;
        if (!isUserFacing(record, config.sinks, config.proseKeys)) continue;
        sites.push({ file: rel, line: record.line });
      }
    }
  }

  const count = sites.length;
  if (count === config.budget) return [];

  const where = sites
    .slice(0, 12)
    .map((s) => `${s.file}:${s.line}`)
    .join(", ");
  const tail = count > 12 ? `, and ${count - 12} more` : "";

  if (count > config.budget) {
    return [
      {
        rule: id,
        file: CONFIG_PATH,
        message:
          `user-facing prose carries ${count} em dashes, ${count - config.budget} over the budget of ${config.budget} ` +
          `recorded in ${config.source}: rewrite the new ones, or raise the budget deliberately and say why in the commit. Sites: ${where}${tail}`,
      },
    ];
  }

  return [
    {
      rule: id,
      file: CONFIG_PATH,
      message:
        `user-facing prose carries ${count} em dashes but the budget in ${config.source} is still ${config.budget}: ` +
        `lower it to ${count} so the freed slots are not silently available to the next change`,
    },
  ];
}

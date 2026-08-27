/**
 * Prose that names a count is prose that goes stale the next time someone adds a file.
 *
 * This tree had twenty-five of them wrong at once, spread over `docs/`, `README.md`,
 * `CONTRIBUTING.md` and `wiki/`: every "27 modules" was written when `DECLARED_MODULES` held 27,
 * `docs/extensions/index.md` said "Thirty", and `docs/getting-started/first-run.md` promised
 * "22 rules (21 without `--live`)" while `bin/rules/` held 26. Nothing failed. A reader's first
 * two minutes with the repository were spent on numbers that had not been true for several waves —
 * and an audit that read the documentation by hand still found only sixteen of them. Nine more
 * came out of this file the first time it ran, in two directories the audit never opened.
 *
 * So: the counts are computed from the tree, and any sentence naming one has to agree.
 *
 * **Why a test and not a `PC-` rule.** `bin/pi-check --all` is step 1 of
 * [first run](../../docs/getting-started/first-run.md) — the first thing a colleague runs on a
 * fresh clone, and the install script runs it too. Everything it reports is a problem that person
 * can act on: an unresolvable tier, a surviving placeholder, a committed key. A stale sentence in
 * `docs/` is none of those. It is not caused by their install, it is not fixable from their
 * machine, and putting it in front of them teaches the one habit that gate cannot survive —
 * reading a finding and shrugging. Doc rot is created by whoever adds the 32nd module, and
 * `npm test` is what that person runs.
 *
 * **What is deliberately not checked.** A count below `SUBSET_FLOOR` is almost always a claim
 * about a *subset* — `docs/concepts/architecture.md`'s "## Four modules that are *not* composed
 * here" is the live example, and it is correct. There is no way to tell a subset sentence from a
 * total one by shape, so the floor is the judgement call: a sentence naming twenty-plus modules or
 * rules is claiming the inventory. If a genuine subset ever names more than that, the fix is to
 * rephrase the sentence, not to lower the floor.
 *
 * The floor's price is that small inventories are ungateable here. `docs/configuration/models.md`
 * introduced its provider-fragment table with "Six ship" while three did, and no threshold that
 * leaves "Four modules that are *not* composed here" alone can catch that. Small inventories need
 * a check against their own directory, which is a different test than this one.
 *
 * The other half of the fix is not in this file: several sentences that carried a count did not
 * need one. "PI would load all 27 modules independently" is about a failure mode, not an
 * inventory, and reads the same — and stays true — as "PI would load every module independently".
 * Deleting a number is a better repair than gating it. This file exists for the numbers that
 * survive that question.
 */
import "../lib/repo-config.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../lib/repo-config.ts";
import { DECLARED_MODULES } from "../../extensions/lib/manifest.ts";

/** Below this, a count is read as a subset claim and left alone. See the header. */
const SUBSET_FLOOR = 20;

/** The number-words this tree actually writes out. Digits are handled by `parseInt`. */
const WORDS: Record<string, number> = {
  twenty: 20, "twenty-one": 21, "twenty-two": 22, "twenty-three": 23, "twenty-four": 24,
  "twenty-five": 25, "twenty-six": 26, "twenty-seven": 27, "twenty-eight": 28, "twenty-nine": 29,
  thirty: 30, "thirty-one": 31, "thirty-two": 32, "thirty-three": 33, "thirty-four": 34,
  "thirty-five": 35, "thirty-six": 36, "thirty-seven": 37, "thirty-eight": 38, "thirty-nine": 39,
};

/**
 * `(count) (noun)`. The noun set is what this tree counts in prose: composed modules, the
 * `bin/rules/*.mjs` checks (named both ways — README calls them "repository invariants"), and the
 * parenthetical `(N without --live)` that follows a rule count.
 */
const COUNT_RE = new RegExp(
  String.raw`\b(\d+|${Object.keys(WORDS).sort((a, b) => b.length - a.length).join("|")})[ -]` +
    String.raw`(modules?|rules?|repository invariants?)\b`,
  "gi",
);
const WITHOUT_LIVE_RE = /\((\d+) without `--live`/g;

type Kind = "modules" | "rules";

function parseCount(raw: string): number {
  const word = WORDS[raw.toLowerCase()];
  return word ?? Number.parseInt(raw, 10);
}

function kindOf(noun: string): Kind {
  return noun.toLowerCase().startsWith("module") ? "modules" : "rules";
}

/** Tracked markdown only — the publication boundary, same argument as `publication.test.ts`. */
function trackedMarkdown(): string[] {
  return execFileSync("git", ["-C", REPO, "ls-files", "-z", "*.md"], { encoding: "utf8" })
    .split("\0")
    .filter(
      (f) =>
        f.length > 0 &&
        !f.startsWith("pi-packages/") &&
        !f.startsWith("examples/") &&
        // A release note records what shipped in that version. Once a version is tagged, its
        // counts are history and correcting them would be falsifying the record — the entry
        // for the tree as it is now is the one at the top, written by hand with the rest of it.
        f !== "wiki/Release-Notes.md",
    );
}

// --- the truth, computed ----------------------------------------------------------------------

const RULES_DIR = join(REPO, "bin", "rules");

/** Every rule `bin/pi-check --all` would run, and the subset it runs without `--live`. */
async function ruleCounts(): Promise<{ all: number; offline: number }> {
  const files = readdirSync(RULES_DIR).filter((f) => f.endsWith(".mjs")).sort();
  let live = 0;
  for (const f of files) {
    // Imported rather than grepped, so this counts what pi-check counts: it reads `requiresLive`
    // off the loaded module (bin/pi-check, the `mod.requiresLive && !live` branch).
    const mod = await import(pathToFileURL(join(RULES_DIR, f)).href);
    if (mod.requiresLive) live += 1;
  }
  return { all: files.length, offline: files.length - live };
}

describe("documented counts match the tree", () => {
  it("every count of twenty or more names the real number", async () => {
    const rules = await ruleCounts();
    const truth: Record<Kind, number> = { modules: DECLARED_MODULES.length, rules: rules.all };
    const stale: string[] = [];

    for (const file of trackedMarkdown()) {
      const lines = readFileSync(join(REPO, file), "utf8").split("\n");
      lines.forEach((text, i) => {
        for (const m of text.matchAll(COUNT_RE)) {
          const found = parseCount(m[1]);
          if (!Number.isFinite(found) || found < SUBSET_FLOOR) continue;
          const kind = kindOf(m[2]);
          if (found !== truth[kind]) {
            stale.push(`${file}:${i + 1}  "${m[0]}" — there are ${truth[kind]} ${kind}`);
          }
        }
        for (const m of text.matchAll(WITHOUT_LIVE_RE)) {
          const found = Number.parseInt(m[1], 10);
          if (found !== rules.offline) {
            stale.push(`${file}:${i + 1}  "${m[0]}" — ${rules.offline} rules run without --live`);
          }
        }
      });
    }

    assert.deepEqual(
      stale,
      [],
      `documentation names counts this tree no longer has:\n  ${stale.join("\n  ")}\n\n` +
        `truth: ${truth.modules} modules (extensions/lib/manifest.ts DECLARED_MODULES), ` +
        `${rules.all} rules in bin/rules/ (${rules.offline} without --live).\n` +
        `If a listed sentence is about a failure mode rather than an inventory, the better fix is ` +
        `to drop the number from it.`,
    );
  });
});

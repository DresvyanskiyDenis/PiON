// The `0.000` regression, guarded on the only surface this repository actually tracks.
//
// `cost` is REQUIRED on PI's runtime model type but OPTIONAL in the `models.json` schema, and the
// gap is closed silently: the provider composer substitutes
// `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` for any definition that omits it. Nothing
// warns and nothing fails — the status line simply reads a flat zero spend forever, on a provider
// that may be charging real money.
//
// A forgotten field and a deliberate zero are indistinguishable at runtime. Only the config can
// tell them apart, and only by insisting the author wrote something down. This file used to accept
// a `notes[]` entry as that writing-down, which was a category error: notes are read by people,
// `cost` is read by PI, and the note travelled while the price did not. So the rule enforced here
// is that a fragment defining models states a complete `cost` for each of them — either as numbers
// the fragment knows (four explicit zeros being the statement "this endpoint is not billed by the
// token"), or as template tokens the INTERVIEW fills in, which is what a gateway fragment does
// because it cannot know a price its operator configured.
//
// The two halves that read the result are `bin/rules/pc-27-declared-models-are-priced.mjs`, which
// asks the same question of the composed `config/models.json` at install time, and
// `extensions/cost-gate`, which asks it of a billed turn. Both accept four written zeros and both
// end on an omission. This test is the earliest of the three: it fails the build, before anybody
// installs anything.
//
// Fragments with `builtIn: true` are out of scope by construction: they override PI's own
// catalogues, which already carry complete non-zero cost objects, so they were never part of this
// defect.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

const PROVIDERS_DIR = fileURLToPath(new URL("../config/providers", import.meta.url));

/** The four required rate fields of PI's `ModelCostRates`. */
const COST_RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** A value that is EXACTLY one `{{token}}`, which is the only form that substitutes as a number. */
const WHOLE_TOKEN = /^\{\{([A-Za-z0-9_]+)\}\}$/;

interface Prompt {
  id: string;
  type: string;
  default?: unknown;
}

interface Fragment {
  id: string;
  builtIn: boolean;
  notes?: string[];
  prompts?: Prompt[];
  provider?: { models?: Array<{ id: string; cost?: Record<string, unknown> }> };
}

function fragments(): Array<{ file: string; fragment: Fragment }> {
  return readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      file,
      fragment: JSON.parse(readFileSync(join(PROVIDERS_DIR, file), "utf8")) as Fragment,
    }));
}

/**
 * A note that carries the cost story. Matched on the backticked field name rather than on the
 * English word: notes talk about what things "cost" all the time ("a flag turned off that was
 * needed costs a feature"), and a substring match on that would accept any of them as the
 * explanation. Naming the field is also what makes the note findable with `grep`.
 */
const COST_NOTE = /`cost`/;

describe("provider fragments — the silent 0.000", () => {
  const defining = fragments().filter(
    ({ fragment }) => !fragment.builtIn && (fragment.provider?.models?.length ?? 0) > 0,
  );

  it("there is at least one fragment that defines models, or this file is testing nothing", () => {
    assert.ok(defining.length > 0);
  });

  for (const { file, fragment } of defining) {
    it(`${file}: every model states a complete cost, in numbers or in answers`, () => {
      for (const model of fragment.provider?.models ?? []) {
        const cost = model.cost;
        assert.ok(
          cost !== undefined,
          `${file} defines "${model.id}" with no \`cost\` at all. The composer substitutes ` +
            `{input:0,output:0,cacheRead:0,cacheWrite:0} for that, so the session reads a flat ` +
            `0.000 while possibly costing real money, and nobody can tell afterwards whether the ` +
            `zero was decided or forgotten. Write the four rates, write four explicit zeros to say ` +
            `this endpoint is not billed by the token, or ask for them in \`prompts\` and reference ` +
            `the answers here.`,
        );
        for (const field of COST_RATE_FIELDS) {
          const value: unknown = cost?.[field];
          if (typeof value === "number") continue;
          const token: string | undefined = typeof value === "string" ? WHOLE_TOKEN.exec(value)?.[1] : undefined;
          assert.ok(
            token,
            `${file}: "${model.id}" states cost.${field} as ${JSON.stringify(value)}, which is ` +
              `neither a number nor a single {{token}}. A partial cost is an absent one: the ` +
              `substitution is whole-object, so the fields nobody wrote become the same invisible ` +
              `zeros as if there were no cost at all.`,
          );
          // The prompt behind the token has to exist, be typed `number`, and carry a numeric
          // default. The default is not decoration: a rate prompt is asked only `when` the
          // operator says the model is metered, and a skipped prompt resolves to its default — so
          // a fragment that forgets one writes `"input": ""` into models.json on the unmetered
          // path, which is a string where PI needs a number and reads as unpriced everywhere.
          const prompt: Prompt | undefined = (fragment.prompts ?? []).find((p) => p.id === token);
          assert.ok(prompt, `${file}: "${model.id}" reads cost.${field} from {{${token}}}, which is not a prompt`);
          assert.equal(
            prompt?.type,
            "number",
            `${file}: prompt "${token}" backs a cost rate and must be type number — any other type ` +
              `substitutes quoted, and a rate arriving as a string never multiplies anything`,
          );
          assert.equal(
            typeof prompt?.default,
            "number",
            `${file}: prompt "${token}" backs a cost rate and needs a numeric default, because it ` +
              `is skipped whenever the model is declared unmetered and a skipped prompt resolves ` +
              `to its default`,
          );
        }
      }
    });
  }

  it("a cost note states the units, because they are the easy thing to get wrong", () => {
    // Dollars per MILLION tokens: PI divides each rate by 1000000 before multiplying by the usage
    // counter, so a per-token figure pasted straight in is wrong by six orders of magnitude and
    // still renders happily. The gateways quote per TOKEN, so the conversion is the interview's
    // one real trap and every note that discusses `cost` has to name the units it is talking about.
    const notes = defining.flatMap(({ fragment }) => fragment.notes ?? []).filter((n) => COST_NOTE.test(n));
    assert.ok(notes.length > 0, "no cost note found at all");
    for (const note of notes) {
      assert.match(note, /DOLLARS PER MILLION TOKENS/, note.slice(0, 60));
    }
  });
});

// The `0.000` regression, guarded on the surface this repository actually tracks: the fragments.
//
// `cost` is REQUIRED on PI's runtime model type but OPTIONAL in the `models.json` schema, and the
// gap is closed silently: the provider composer substitutes
// `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` for any definition that omits it. Nothing
// warns and nothing fails — the status line simply reads a flat zero spend forever, on a provider
// that may be charging real money.
//
// WHAT THIS FILE USED TO PIN, AND WHY IT NO LONGER DOES
//
// Until now the rule here was "price the models, OR explain the zero in `notes[]`", and every
// gateway fragment took the second branch: leave `cost` out, tell the operator to fix it by hand
// later. That shape is what `extensions/cost-gate` ends a session for and what `bin/pi-check` rule
// PC-27 flags at install time, so the fragments were shipping the exact defect the two gates were
// added to catch — the note was addressed to a reader who, by construction, was not reading it
// until after the first bill. A note is not a declaration. Nothing reads it.
//
// WHAT IS PINNED NOW
//
// Every model a fragment defines must reach `config/models.json` with a complete `cost`, and there
// are exactly two ways to get there, the same two the gate and PC-27 accept:
//
//   * written down in the fragment — four literal numbers (`databricks`, which bills by DBU per
//     endpoint and therefore has no per-token rate to state);
//   * asked during the interview — each rate a `{{token}}` resolving to a `derived` entry that maps
//     the operator's choice onto either the `decimal` prompt they answered, or a literal 0 for the
//     deliberate opt-out (`litellm`, `openai-compatible`, whose prices are facts about somebody
//     else's deployment and cannot be guessed from the file).
//
// A third spelling would be worse than either: it would give the `cost` object two readings, and
// that is how this class of defect starts.
//
// `modelOverrides` IS THE SAME SURFACE, AND USED TO BE EXEMPT FOR A REASON THAT WAS WRONG
//
// A fragment with `builtIn: true` corrects PI's own catalogue instead of declaring models, and this
// file used to skip those whole, on the stated ground that `cost` is not overridable there. It is:
// PI's model documentation lists `cost` (partial) among the overridable fields, and the override
// preserves the built-in pricing metadata it does not mention. So a built-in fragment CAN author a
// rate, `openai` does — the published list price of a named product, which is knowledge a fragment
// has and an interview does not — and an authored rate is exactly the thing this file exists to
// keep honest. What stays out of scope is an override that says nothing about price: that is the
// built-in catalogue's own number, which was never part of this defect.
//
// Hence the two spellings of the metered branch. A price that is a fact about somebody else's
// deployment has to be ASKED (`litellm`, `openai-compatible`, `databricks`). A price a vendor
// publishes for a model this fragment names by id may be WRITTEN — and then the note that carries
// the units has to carry the URL it was read from too, so the next reader can check it against the
// page rather than against this repository's memory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

const PROVIDERS_DIR = fileURLToPath(new URL("../config/providers", import.meta.url));

/** The four required rate fields of PI's `ModelCostRates`. */
const COST_RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** A value the fragment defers to an answer: the string is EXACTLY one `{{token}}`. */
const WHOLE_TOKEN = /^\{\{([A-Za-z0-9_]+)\}\}$/;

interface Prompt {
  id: string;
  type: string;
  choices?: Array<{ value: string; label: string }>;
  when?: Record<string, string>;
}

interface Derived {
  id: string;
  from: string;
  map: Record<string, unknown>;
}

interface Fragment {
  id: string;
  builtIn: boolean;
  notes?: string[];
  prompts?: Prompt[];
  derived?: Derived[];
  provider?: {
    models?: Array<{ id: string; cost?: Record<string, unknown> }>;
    modelOverrides?: Record<string, { cost?: Record<string, unknown> }>;
  };
}

/** One priced thing a fragment ships, from either surface that can carry a `cost`. */
interface Priced {
  id: string;
  surface: string;
  cost?: Record<string, unknown>;
}

/**
 * Every model whose price this fragment is answerable for. A declared model always is: it reaches
 * `config/models.json` with whatever `cost` the fragment gave it, or with four zeros nobody wrote.
 * An override is answerable only once it mentions `cost` at all — an override silent on price
 * leaves PI's own catalogue rate in place, which is not this file's business.
 */
function priced(fragment: Fragment): Priced[] {
  const models = (fragment.provider?.models ?? []).map((m) => ({
    id: m.id,
    surface: "models",
    cost: m.cost,
  }));
  const overrides = Object.entries(fragment.provider?.modelOverrides ?? {})
    .filter(([, ov]) => ov?.cost !== undefined)
    .map(([id, ov]) => ({ id, surface: "modelOverrides", cost: ov.cost }));
  return [...models, ...overrides];
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
  const defining = fragments().filter(({ fragment }) => priced(fragment).length > 0);

  it("there is at least one fragment that prices a model, or this file is testing nothing", () => {
    assert.ok(defining.length > 0);
  });

  for (const { file, fragment } of defining) {
    it(`${file}: every model states all four rates, as a number or as an asked token`, () => {
      for (const model of priced(fragment)) {
        assert.ok(
          model.cost !== undefined && model.cost !== null,
          `${file} defines "${model.id}" with no \`cost\` at all. That is the shape the composer ` +
            `fills with four zeros nobody wrote, and the shape extensions/cost-gate ends a session ` +
            `for. Write the rates, write four zeros, or ask for them in the interview.`,
        );
        for (const field of COST_RATE_FIELDS) {
          const rate = model.cost?.[field];
          const ok =
            (typeof rate === "number" && Number.isFinite(rate)) ||
            (typeof rate === "string" && WHOLE_TOKEN.test(rate));
          assert.ok(
            ok,
            `${file}: ${model.surface} entry "${model.id}" states cost.${field} as ` +
              `${JSON.stringify(rate)}. It has to be a ` +
              `finite number or a lone {{token}} the interview fills; a partial cost object is read ` +
              `as unpriced, because the composer's substitution replaces the whole object rather ` +
              `than merging into it.`,
          );
        }
      }
    });

    it(`${file}: an asked rate offers both accepted declarations and no third one`, () => {
      const prompts = new Map((fragment.prompts ?? []).map((p) => [p.id, p]));
      const derived = new Map((fragment.derived ?? []).map((d) => [d.id, d]));
      const asked = priced(fragment).flatMap((model) =>
        COST_RATE_FIELDS.map((field) => model.cost?.[field]).filter(
          (rate): rate is string => typeof rate === "string",
        ),
      );
      if (asked.length === 0) return; // a fragment that states its rates outright has nothing to ask

      for (const token of asked) {
        const id = WHOLE_TOKEN.exec(token)?.[1] ?? "";
        const entry = derived.get(id);
        // Not "it resolves to something": it must resolve to the CHOICE, because a rate wired
        // straight to a prompt could only ever be metered, and the opt-out would then have to be
        // spelled by typing zeros into a question that asked for a price. That is the third
        // spelling this rule exists to keep out.
        assert.ok(
          entry,
          `${file}: cost rate ${token} is not a \`derived\` value. An asked rate has to come ` +
            `through the metered/unmetered choice, so that both accepted declarations are ` +
            `reachable and neither is the silent default.`,
        );
        const choice = prompts.get(entry.from);
        assert.equal(
          choice?.type,
          "choice",
          `${file}: derived "${id}" reads from "${entry.from}", which is not a choice prompt`,
        );
        const offered = new Set((choice?.choices ?? []).map((c) => c.value));
        assert.ok(
          offered.has("metered") && offered.has("unmetered"),
          `${file}: "${entry.from}" offers ${[...offered].join(", ")}. Both "metered" and ` +
            `"unmetered" have to be on the menu: the opt-out is a real answer, not something an ` +
            `operator falls into by leaving a price blank.`,
        );
        // The metered branch resolves to a prompt that can hold a fractional rate; the unmetered
        // branch is the literal 0 that PC-27 and the gate both read as authored. Anything else in
        // this map would be a rate nobody was asked for.
        const metered = entry.map.metered;
        const meteredPrompt = typeof metered === "string" ? prompts.get(WHOLE_TOKEN.exec(metered)?.[1] ?? "") : undefined;
        const written = typeof metered === "number" && Number.isFinite(metered) && metered > 0;
        assert.ok(
          meteredPrompt?.type === "decimal" || written,
          `${file}: derived "${id}" maps metered to ${JSON.stringify(metered)}. The metered branch ` +
            `is either a \`decimal\` prompt (a price only the operator knows) or a positive number ` +
            `written down (a rate the vendor publishes for a model this fragment names). A ` +
            `\`number\` prompt would refuse 2.5, and a zero here would make the two branches ` +
            `indistinguishable.`,
        );
        assert.equal(
          entry.map.unmetered,
          0,
          `${file}: derived "${id}" maps unmetered to ${JSON.stringify(entry.map.unmetered)}. The ` +
            `opt-out is the literal 0 that composes into four written zeros — no sentinel, no ` +
            `second spelling.`,
        );
        for (const [key, value] of Object.entries(entry.map)) {
          if (key === "metered" || key === "unmetered") continue;
          // The only other key a fragment may map is "": the answer to a pricing question that was
          // never asked because the model itself was left blank. It has to be there or generation
          // fatals on the unmapped key, and it has to be 0 for the same reason as the opt-out.
          assert.equal(key, "", `${file}: derived "${id}" maps an unexpected answer "${key}"`);
          assert.equal(value, 0, `${file}: derived "${id}" maps the skipped answer to ${JSON.stringify(value)}, not 0`);
        }
      }

      // The question has to be asked before the rate is typed, and the rate only when it applies.
      for (const prompt of fragment.prompts ?? []) {
        if (prompt.type !== "decimal") continue;
        const gate = Object.entries(prompt.when ?? {})[0];
        assert.ok(
          gate && prompts.get(gate[0])?.type === "choice" && gate[1] === "metered",
          `${file}: the rate prompt "${prompt.id}" is not gated on a metered answer, so it is asked ` +
            `of operators who already said this endpoint is unmetered.`,
        );
      }
    });
  }

  it("a cost note states the units, because they are the easy thing to get wrong", () => {
    // Dollars per MILLION tokens: PI divides each rate by 1000000 before multiplying by the usage
    // counter, so a per-token figure pasted straight in is wrong by six orders of magnitude and
    // still renders.
    const notes = defining.flatMap(({ fragment }) => fragment.notes ?? []).filter((n) => COST_NOTE.test(n));
    assert.ok(notes.length > 0, "no cost note found at all");
    for (const note of notes) {
      assert.match(note, /DOLLARS PER MILLION TOKENS/, note.slice(0, 60));
    }
  });

  it("a written rate names the page it was read from", () => {
    // The other half of allowing a literal in the metered branch. A rate nobody was asked for is
    // only as good as its provenance, and vendor list prices move — OpenAI cut two of these in the
    // month before they were written down here. A URL in the units note is what lets the next
    // reader check the number against the page instead of against this repository's memory, and
    // what stops a plausible-looking rate from being invented in an editor.
    for (const { file, fragment } of defining) {
      const writesRates = (fragment.derived ?? []).some(
        (d) => typeof d.map?.metered === "number" && d.map.metered > 0,
      );
      if (!writesRates) continue;
      const sourced = (fragment.notes ?? []).filter(
        (n) => /DOLLARS PER MILLION TOKENS/.test(n) && /https?:\/\/\S+/.test(n),
      );
      assert.ok(
        sourced.length > 0,
        `${file} writes per-token rates into the metered branch but no note gives the URL they ` +
          `were read from. State the page and the date you read it: these are somebody else's ` +
          `list prices, and they change.`,
      );
    }
  });

  it("no fragment still tells the operator to leave the price for later", () => {
    // The advice this repository used to ship, in the fragment that shipped it. It is the exact
    // shape `extensions/cost-gate` ends a session for, so a note reintroducing it would be
    // documentation that walks an operator into the abort.
    for (const { file, fragment } of defining) {
      for (const note of fragment.notes ?? []) {
        assert.doesNotMatch(
          note,
          /(leaves|left|leave) `?cost`? out/i,
          `${file} still advertises an absent \`cost\` as a supported outcome`,
        );
      }
    }
  });
});

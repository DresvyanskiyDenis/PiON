// The `0.000` regression, guarded on the only surface this repository actually tracks.
//
// `cost` is REQUIRED on PI's runtime model type but OPTIONAL in the `models.json` schema, and the
// gap is closed silently: the provider composer substitutes
// `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` for any definition that omits it. Nothing
// warns and nothing fails — the status line simply reads a flat zero spend forever, on a provider
// that may be charging real money.
//
// A forgotten field and a deliberate zero are indistinguishable at runtime. Only the config can
// tell them apart, and only by insisting the author wrote something down. So the rule enforced here
// is not "every model must be priced" — this repository ships template fragments and cannot know
// anybody's rates — but "a fragment that defines models must either price them or say, in its own
// `notes`, why the zero is what it is": unmetered, unpriced, or simply not established.
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

interface Fragment {
  id: string;
  builtIn: boolean;
  notes?: string[];
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
    it(`${file}: every model is priced, or the notes explain the zero`, () => {
      const models = fragment.provider?.models ?? [];
      const unpriced = models.filter(
        (m) =>
          m.cost === undefined ||
          COST_RATE_FIELDS.some((field) => typeof m.cost?.[field] !== "number"),
      );
      if (unpriced.length === 0) return;
      const explained = (fragment.notes ?? []).some((note) => COST_NOTE.test(note));
      assert.ok(
        explained,
        `${file} defines ${unpriced.length} model(s) without a complete cost block ` +
          `(${unpriced.map((m) => m.id).join(", ")}) and no note explains it. Sessions on this ` +
          `provider will display a flat 0.000 spend and nobody reading the fragment will know ` +
          `whether that is the truth. Price the models, or add a note naming \`cost\` and saying ` +
          `why the zero stands.`,
      );
    });
  }

  it("a cost note states the units, because they are the easy thing to get wrong", () => {
    // Dollars per MILLION tokens: PI divides each rate by 1000000 before multiplying by the usage
    // counter, so a per-token figure pasted straight in is wrong by six orders of magnitude and
    // still renders happily.
    const notes = defining.flatMap(({ fragment }) => fragment.notes ?? []).filter((n) => COST_NOTE.test(n));
    assert.ok(notes.length > 0, "no cost note found at all");
    for (const note of notes) {
      assert.match(note, /DOLLARS PER MILLION TOKENS/, note.slice(0, 60));
    }
  });
});

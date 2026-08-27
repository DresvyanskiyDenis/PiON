// EXT-56 — extensions/ask-user/dialog.ts.
//
// Everything here runs against a scripted fake `ui`: `select` and `input` return whatever the
// script says next and record what they were shown. That makes the interesting properties
// assertable without a terminal — which rows the operator was actually offered, that dismissal
// comes back as a decline rather than a choice, and that the multi-select loop is bounded.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  askQuestion,
  assertAnswerable,
  flattenOption,
  formatAnswers,
  MAX_TOGGLE_ROUNDS,
  OTHER_LABEL,
  SEPARATOR,
  type AskQuestion,
  type AskUi,
} from "../../extensions/ask-user/dialog.ts";

interface Recorded {
  readonly selects: { title: string; options: string[]; signal?: AbortSignal }[];
  readonly inputs: { title: string; placeholder?: string; signal?: AbortSignal }[];
}

/**
 * `selects` is consumed one per call. A number picks that row from what was offered, which keeps
 * the scripts readable when the rows carry checkbox markers; a string is returned verbatim, for
 * the cases that need to answer with something never offered.
 */
function fakeUi(script: {
  selects?: (number | string | undefined)[];
  inputs?: (string | undefined)[];
  selectAlways?: number;
}): { ui: AskUi; rec: Recorded } {
  const rec: Recorded = { selects: [], inputs: [] };
  const selects = [...(script.selects ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const ui: AskUi = {
    async select(title, options, opts) {
      rec.selects.push({ title, options: [...options], signal: opts?.signal });
      if (script.selectAlways !== undefined) return options[script.selectAlways];
      const next = selects.shift();
      if (typeof next === "number") return options[next];
      return next;
    },
    async input(title, placeholder, opts) {
      rec.inputs.push({ title, placeholder, signal: opts?.signal });
      return inputs.shift();
    },
  };
  return { ui, rec };
}

const QUESTION: AskQuestion = {
  question: "Which auth method?",
  header: "Auth",
  options: [
    { label: "OIDC", description: "delegate to the identity provider" },
    { label: "API key", description: "one shared secret, rotated by hand" },
    { label: "mTLS", description: "certificates on both ends" },
  ],
};

const MULTI: AskQuestion = { ...QUESTION, question: "Which do you want?", multiSelect: true };

describe("ask-user — flattening", () => {
  it("puts label and description on one line, separated by a middot", () => {
    assert.equal(
      flattenOption({ label: "OIDC", description: "delegate to the identity provider" }),
      `OIDC${SEPARATOR}delegate to the identity provider`,
    );
  });

  it("collapses whitespace so a wrapped description does not become a multi-line row", () => {
    assert.equal(
      flattenOption({ label: "A", description: "one   two\n  three " }),
      `A${SEPARATOR}one two three`,
    );
  });

  it("renders the label alone when there is no description to add", () => {
    assert.equal(flattenOption({ label: "A", description: "   " }), "A");
  });

  it("never uses an em dash: the separator is spent per option, per call, at runtime", () => {
    assert.ok(!SEPARATOR.includes("—"));
  });
});

describe("ask-user — inputs that would make an answer ambiguous", () => {
  const bad = (options: AskQuestion["options"]): AskQuestion => ({ ...QUESTION, options });

  it("rejects an empty label, since the label is what is reported back", () => {
    assert.throws(() => assertAnswerable(bad([{ label: " ", description: "x" }, QUESTION.options[0]])), /empty label/);
  });

  it("rejects a repeated label", () => {
    assert.throws(
      () => assertAnswerable(bad([QUESTION.options[0], { label: "OIDC", description: "again" }])),
      /repeats the option label/,
    );
  });

  it("rejects a hand-written Other, which would render twice", () => {
    assert.throws(
      () => assertAnswerable(bad([QUESTION.options[0], { label: OTHER_LABEL, description: "mine" }])),
      /Other is always appended|always appended/,
    );
  });

  it("rejects two options that render as the same line", () => {
    assert.throws(
      () =>
        assertAnswerable(
          bad([
            { label: "A", description: "same" },
            { label: "A ", description: "same" },
          ]),
        ),
      /repeats the option label|same line/,
    );
  });
});

describe("ask-user — single select", () => {
  it("offers every option plus Other, and returns the label of the row picked", async () => {
    const { ui, rec } = fakeUi({ selects: [1] });
    const answer = await askQuestion(ui, QUESTION);
    assert.deepEqual(answer, { kind: "answered", labels: ["API key"] });
    assert.equal(rec.selects.length, 1);
    assert.equal(rec.selects[0].options.length, QUESTION.options.length + 1);
    assert.ok(rec.selects[0].options.at(-1)?.startsWith(OTHER_LABEL));
    assert.equal(rec.selects[0].title, QUESTION.question);
  });

  it("treats a dismissed dialog as a decline, not as a choice", async () => {
    const { ui } = fakeUi({ selects: [undefined] });
    assert.deepEqual(await askQuestion(ui, QUESTION), { kind: "declined" });
  });

  it("routes Other to a text input and returns what was typed", async () => {
    const { ui, rec } = fakeUi({ selects: [3], inputs: ["something else entirely"] });
    assert.deepEqual(await askQuestion(ui, QUESTION), {
      kind: "answered",
      labels: [],
      other: "something else entirely",
    });
    assert.equal(rec.inputs.length, 1);
  });

  it("declines when Other is chosen and the text input is dismissed", async () => {
    const { ui } = fakeUi({ selects: [3], inputs: [undefined] });
    assert.deepEqual(await askQuestion(ui, QUESTION), { kind: "declined" });
  });

  it("declines when Other is chosen and only whitespace is typed", async () => {
    const { ui } = fakeUi({ selects: [3], inputs: ["   "] });
    assert.deepEqual(await askQuestion(ui, QUESTION), { kind: "declined" });
  });

  it("throws when the dialog returns something that was never offered", async () => {
    const { ui } = fakeUi({ selects: ["a row nobody showed"] });
    await assert.rejects(() => askQuestion(ui, QUESTION), /not one of the options offered/);
  });

  it("passes the caller's signal to every dialog it opens", async () => {
    const controller = new AbortController();
    const { ui, rec } = fakeUi({ selects: [3], inputs: ["x"] });
    await askQuestion(ui, QUESTION, controller.signal);
    assert.equal(rec.selects[0].signal, controller.signal);
    assert.equal(rec.inputs[0].signal, controller.signal);
  });
});

describe("ask-user — multi select", () => {
  it("toggles rows and returns them in option order, not in the order they were picked", async () => {
    // rows: 0..2 options, 3 Other, 4 Done. Pick the third, then the first, then Done.
    const { ui, rec } = fakeUi({ selects: [2, 0, 4] });
    assert.deepEqual(await askQuestion(ui, MULTI), {
      kind: "answered",
      labels: ["OIDC", "mTLS"],
    });
    assert.equal(rec.selects.length, 3);
    assert.ok(rec.selects[1].options[2].startsWith("[x]"), "the first pick must render as ticked");
  });

  it("shows a live count on the Done row so the operator can see what they have", async () => {
    const { ui, rec } = fakeUi({ selects: [0, 1, 4] });
    await askQuestion(ui, MULTI);
    assert.match(rec.selects[0].options.at(-1) ?? "", /nothing selected/);
    assert.match(rec.selects[2].options.at(-1) ?? "", /2 selected/);
  });

  it("un-ticks a row that is picked twice", async () => {
    const { ui } = fakeUi({ selects: [0, 1, 0, 4] });
    assert.deepEqual(await askQuestion(ui, MULTI), { kind: "answered", labels: ["API key"] });
  });

  it("treats Done with nothing selected as a decline rather than an empty answer", async () => {
    const { ui } = fakeUi({ selects: [4] });
    assert.deepEqual(await askQuestion(ui, MULTI), { kind: "declined" });
  });

  it("carries free text alongside the ticked options", async () => {
    const { ui } = fakeUi({ selects: [0, 3, 4], inputs: ["a fourth thing"] });
    assert.deepEqual(await askQuestion(ui, MULTI), {
      kind: "answered",
      labels: ["OIDC"],
      other: "a fourth thing",
    });
  });

  it("clears free text when Other is picked a second time", async () => {
    const { ui } = fakeUi({ selects: [0, 3, 3, 4], inputs: ["typed then reconsidered"] });
    assert.deepEqual(await askQuestion(ui, MULTI), { kind: "answered", labels: ["OIDC"] });
  });

  it("discards a half-toggled list the operator walked away from", async () => {
    const { ui } = fakeUi({ selects: [0, 1, undefined] });
    assert.deepEqual(await askQuestion(ui, MULTI), { kind: "declined" });
  });

  it("is bounded: a select that answers without a person cannot spin the turn forever", async () => {
    // Always picks row 0, so Done is never reached. Unbounded, this is a hang with no output.
    const { ui, rec } = fakeUi({ selectAlways: 0 });
    await assert.rejects(() => askQuestion(ui, MULTI), /without reaching Done/);
    assert.equal(rec.selects.length, MAX_TOGGLE_ROUNDS);
  });
});

describe("ask-user — what the model reads back", () => {
  it("keys each line by the question's own header", () => {
    const text = formatAnswers(
      [QUESTION, { ...QUESTION, header: "Store" }],
      [
        { kind: "answered", labels: ["OIDC"] },
        { kind: "answered", labels: ["A", "B"], other: "and a third" },
      ],
    );
    assert.equal(text, "Auth: OIDC\nStore: A, B, other: and a third");
  });

  it("says plainly that a question was declined, so nothing reads it as an answer", () => {
    assert.match(formatAnswers([QUESTION], [{ kind: "declined" }]), /^Auth: declined, no answer given$/);
  });

  it("reports a missing answer the same way rather than rendering undefined", () => {
    assert.match(formatAnswers([QUESTION], []), /declined, no answer given/);
  });
});

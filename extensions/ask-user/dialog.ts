/**
 * The dialog logic behind `ask_user`, kept free of any PI import so it can be tested against a
 * recorded fake instead of a terminal.
 *
 * PI gives extensions exactly three interactive primitives: `select(title, options: string[])`,
 * `input(title, placeholder)` and `confirm(title, message)`. Two consequences run through the file:
 *
 *   1. **Options are plain strings.** A `{ label, description }` pair flattens into one line,
 *      and that line is what comes back. Two options that render identically would make the
 *      answer ambiguous, so duplicate-rendering options are rejected rather than silently handled.
 *   2. **`select` is single-choice.** Multi-select is a loop over `select` rendering checkboxes.
 *      That costs one dialog per toggle, but buys real multi-select in every mode with `hasUI`
 *      true, without a custom TUI component (which would work in tui mode only).
 *
 * A dismissed dialog is not a failure. PI resolves `select` and `input` to `undefined` when the
 * user closes them, reported as `declined` so the caller proceeds on its own judgement.
 */

/** The two `ExtensionUIContext` methods this file uses, narrowed so tests need no PI. */
export interface AskUi {
  select(
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
}

export interface AskOption {
  readonly label: string;
  readonly description: string;
}

export interface AskQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly AskOption[];
  readonly multiSelect?: boolean;
}

export type AskAnswer =
  | { readonly kind: "answered"; readonly labels: readonly string[]; readonly other?: string }
  | { readonly kind: "declined" };

/**
 * Label and description on one line.
 *
 * The separator is a middot, not an em dash: `bin/rules/pc-26` counts em dashes in user-facing
 * strings against a budget, and a tool minting one line per option on every call would spend
 * that budget at runtime instead of review time.
 */
export const SEPARATOR = " · ";

export const OTHER_LABEL = "Other";
const OTHER_ROW = `${OTHER_LABEL}${SEPARATOR}type a different answer`;
const MARK_ON = "[x]";
const MARK_OFF = "[ ]";

/**
 * A ceiling on toggle rounds. A person cannot reach it; a `select` that resolves instantly
 * could, and an unbounded loop would spin forever. Bounded and loud beats a hang with no output.
 */
export const MAX_TOGGLE_ROUNDS = 200;

export function flattenOption(option: AskOption): string {
  const description = option.description.trim().replace(/\s+/g, " ");
  return description ? `${option.label}${SEPARATOR}${description}` : option.label;
}

/**
 * Rejects inputs that would make an answer ambiguous or a dialog unreadable. Thrown, not fixed:
 * a question whose options collide is a question the model wrote wrong, and silently answering
 * a different one is what this tool exists to prevent.
 */
export function assertAnswerable(question: AskQuestion): void {
  const labels = question.options.map((o) => o.label.trim());
  if (labels.some((l) => l.length === 0)) {
    throw new Error(`ask_user: question "${question.header}" has an option with an empty label.`);
  }
  if (labels.some((l) => l === OTHER_LABEL)) {
    throw new Error(
      `ask_user: question "${question.header}" declares its own "${OTHER_LABEL}" option. ` +
        `${OTHER_LABEL} is always appended, so declaring it duplicates the meaning.`,
    );
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      throw new Error(
        `ask_user: question "${question.header}" repeats the option label "${label}". ` +
          "Labels are how the answer is reported back, so they have to be distinct.",
      );
    }
    seen.add(label);
  }
  const rows = question.options.map(flattenOption);
  if (new Set(rows).size !== rows.length) {
    throw new Error(
      `ask_user: question "${question.header}" has two options that render as the same line. ` +
        "Give them descriptions that differ.",
    );
  }
}

/** Free text via `input`, shared by single and multi paths. Empty text counts as no answer. */
async function askOther(
  ui: AskUi,
  question: AskQuestion,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const text = await ui.input(question.question, "Type your answer", { signal });
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function askSingle(
  ui: AskUi,
  question: AskQuestion,
  signal: AbortSignal | undefined,
): Promise<AskAnswer> {
  const rows = question.options.map(flattenOption);
  const picked = await ui.select(question.question, [...rows, OTHER_ROW], { signal });
  if (picked === undefined) return { kind: "declined" };
  if (picked === OTHER_ROW) {
    const other = await askOther(ui, question, signal);
    return other === undefined ? { kind: "declined" } : { kind: "answered", labels: [], other };
  }
  const index = rows.indexOf(picked);
  if (index < 0) {
    throw new Error(
      `ask_user: the dialog returned "${picked}", which is not one of the options offered ` +
        `for "${question.header}".`,
    );
  }
  return { kind: "answered", labels: [question.options[index].label] };
}

async function askMulti(
  ui: AskUi,
  question: AskQuestion,
  signal: AbortSignal | undefined,
): Promise<AskAnswer> {
  const selected = new Set<number>();
  let other: string | undefined;

  for (let round = 0; round < MAX_TOGGLE_ROUNDS; round += 1) {
    const rows = question.options.map(
      (o, i) => `${selected.has(i) ? MARK_ON : MARK_OFF} ${flattenOption(o)}`,
    );
    const otherRow =
      other === undefined
        ? `${MARK_OFF} ${OTHER_ROW}`
        : `${MARK_ON} ${OTHER_LABEL}${SEPARATOR}${other}`;
    const count = selected.size + (other === undefined ? 0 : 1);
    const doneRow = count === 0 ? "Done, nothing selected" : `Done, ${count} selected`;
    const all = [...rows, otherRow, doneRow];

    const picked = await ui.select(question.question, all, { signal });
    if (picked === undefined) return { kind: "declined" };

    const index = all.indexOf(picked);
    if (index < 0) {
      throw new Error(
        `ask_user: the dialog returned "${picked}", which is not one of the rows offered ` +
          `for "${question.header}".`,
      );
    }
    if (index === all.length - 1) {
      if (count === 0) return { kind: "declined" };
      return {
        kind: "answered",
        labels: [...selected].sort((a, b) => a - b).map((i) => question.options[i].label),
        ...(other === undefined ? {} : { other }),
      };
    }
    if (index === all.length - 2) {
      if (other !== undefined) {
        other = undefined;
      } else {
        other = await askOther(ui, question, signal);
      }
      continue;
    }
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
  }

  throw new Error(
    `ask_user: the selector for "${question.header}" was answered ${MAX_TOGGLE_ROUNDS} times ` +
      "without reaching Done. Stopping rather than looping.",
  );
}

export async function askQuestion(
  ui: AskUi,
  question: AskQuestion,
  signal?: AbortSignal,
): Promise<AskAnswer> {
  assertAnswerable(question);
  return question.multiSelect === true
    ? askMulti(ui, question, signal)
    : askSingle(ui, question, signal);
}

export function formatAnswers(
  questions: readonly AskQuestion[],
  answers: readonly AskAnswer[],
): string {
  return questions
    .map((q, i) => {
      const answer = answers[i];
      if (answer === undefined || answer.kind === "declined") {
        return `${q.header}: declined, no answer given`;
      }
      const parts = [...answer.labels];
      if (answer.other !== undefined) parts.push(`other: ${answer.other}`);
      return `${q.header}: ${parts.join(", ")}`;
    })
    .join("\n");
}

/**
 * `EXT-56` — `ask_user`: a structured question the model can put to the operator.
 *
 * **Why it is custom.** PI 0.84.0's built-in tools are `bash`, `edit`, `grep`, `find`, `ls`,
 * `read` and `write`. No `ask_question` ships. This fills that gap.
 *
 * **Built on PI's own primitives.** A tool's `execute` receives the full `ExtensionContext` as
 * its fifth parameter, carrying `ui`, `hasUI` and `mode`. `ctx.ui.select` and `ctx.ui.input` are
 * the whole mechanism; `./dialog.ts` holds the logic and the reasoning about their limits.
 *
 * **Three behaviours worth stating here, each one a choice.**
 *
 * `hasUI === false` throws. There is no dialog subsystem in that mode, so inventing a reply,
 * defaulting to the first option, or returning "unavailable" would hand the model fabricated
 * data. The gate is `hasUI`, not a mode name: rpc mode round-trips a real dialog to a real
 * person, and refusing there would abort on someone perfectly able to answer. A subagent's case
 * is special: `pi-subagents` spawns each child as a separate headless process, so it physically
 * cannot render into the parent's terminal, and the remedy it gets says so.
 *
 * A dismissed dialog is not a failure. PI resolves `select` and `input` to `undefined` when the
 * user closes them, reported as `declined` so the model proceeds on its own judgement. Nothing
 * re-asks.
 *
 * `executionMode: "sequential"`. Two dialogs racing for the same terminal is not something a
 * person can answer, so this tool never runs beside another tool call.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { declareModule } from "../lib/manifest.ts";
import { askQuestion, formatAnswers, type AskAnswer, type AskQuestion } from "./dialog.ts";

export const id = "ask-user";
const MODULE_VERSION = "1.0.0";

const MAX_QUESTIONS = 4;
const MAX_HEADER = 12;

const OptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    description: "The choice itself, in one to five words. This is what comes back as the answer.",
  }),
  description: Type.String({
    description:
      "What choosing this means or what happens next. One line, the place to put the " +
      "trade-off the operator needs in order to decide.",
  }),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    minLength: 1,
    description: "The question, in full, ending with a question mark.",
  }),
  header: Type.String({
    minLength: 1,
    maxLength: MAX_HEADER,
    description:
      "A short label for the question, at most 12 characters, used to key the answer back to " +
      'you. For example "Auth method" or "Library".',
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "Two to four distinct choices. An Other option is always appended for free text, so do " +
      "not add one.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "True when the choices are not mutually exclusive. Phrase the question accordingly.",
    }),
  ),
});

const ParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "One to four questions, asked in order.",
  }),
});

/**
 * The message a caller gets when there is nobody to ask. Written to be actionable: which mode,
 * why that mode has no dialog, and what to do instead. The two readers need different advice, so
 * they get different sentences. A subagent may have a channel upwards and should try it; the
 * main agent has not got one, and sending it after a tool it lacks would be the same fabrication
 * this gate exists to stop.
 */
function noUiError(ctx: ExtensionContext): Error {
  // `PI_SUBAGENT_CHILD` is the marker `pi-subagents` sets on the child it spawns, so this reads
  // the package's own signal rather than guessing at how a subagent is recognised. Its
  // `contact_supervisor` tool reaches the parent agent, but only when the run's bridge
  // instructions supply it, which is why the sentence offers it rather than prescribing it.
  const inSubagent = process.env.PI_SUBAGENT_CHILD === "1";
  const remedy = inSubagent
    ? "This is a subagent, which runs as its own headless pi process and has no terminal of " +
      'its own. If your instructions offer contact_supervisor, use it with reason "need_decision" ' +
      "to put the question to the agent that spawned you. Otherwise decide with what you have " +
      "and say which assumption you made."
    : "Decide with what you have and say which assumption you made.";
  return new Error(
    `ask_user: no interactive UI is available in ${ctx.mode} mode, so there is nobody to ask. ` +
      `Nothing was asked and no answer is being invented. ${remedy}`,
  );
}

/**
 * Ask the operator, from anywhere. The model's tool call is the only caller today; it is
 * exported because anything else that needs a person rather than a model ends here, and because
 * that makes this the one place a queue would go if several blocked callers ever started
 * contending for the single terminal. Nothing in the loop below assumes it is alone: no shared
 * cursor, no module-level state, and the caller's `signal` travels with each dialog rather than
 * a global one.
 */
export async function askQuestions(
  ctx: ExtensionContext,
  questions: readonly AskQuestion[],
  signal?: AbortSignal,
): Promise<AskAnswer[]> {
  if (!ctx.hasUI) throw noUiError(ctx);

  const answers: AskAnswer[] = [];
  for (const question of questions) {
    answers.push(await askQuestion(ctx.ui, question, signal));
  }
  return answers;
}

export function register(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask the operator",
    description:
      "Put a multiple-choice question to the operator and wait for the answer. Use it when the " +
      "request has two readings that lead to materially different work, or when a decision is " +
      "genuinely theirs to make and you cannot settle it from the request, the code or a " +
      "sensible default. An Other option is always offered, so the operator can answer in their " +
      "own words. Available only where there is a person at a terminal: it fails loudly rather " +
      "than guessing.",
    promptSnippet: "Ask the operator a structured multiple-choice question and wait for the answer",
    promptGuidelines: [
      "Call ask_user when a prompt has two readings that lead to materially different work, and pick the obvious option yourself when it does not.",
      "Do not call ask_user for a choice with a conventional default, for a fact you can verify in the codebase, or to ask permission to continue work already asked for.",
      "Give every option a description that names the trade-off, not a restatement of the label. The operator is choosing between consequences.",
      "One call can carry up to four questions, so ask everything you need at once rather than in a chain of separate calls.",
      "A declined answer is an answer: proceed on your own judgement and say which assumption you made, and do not ask the same question again.",
    ],
    parameters: ParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = params.questions as readonly AskQuestion[];
      const answers = await askQuestions(ctx, questions, signal);

      return {
        content: [{ type: "text" as const, text: formatAnswers(questions, answers) }],
        details: {
          answers: questions.map((q, i) => ({
            header: q.header,
            multiSelect: q.multiSelect === true,
            answer: answers[i],
          })),
        },
      };
    },
  });

  declareModule({
    id,
    version: MODULE_VERSION,
    events: [],
    apis: ["registerTool"],
  });
}

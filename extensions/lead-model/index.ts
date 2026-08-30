/**
 * The lead model is a project decision, held for the length of a work stream.
 *
 * ## The failure this closes
 *
 * A session that changes its lead model repeatedly inside one investigation cannot answer the only
 * question the investigation is about. Models differ in context window, in structured-output
 * behaviour and in failure mode, so a lead that moves while you debug makes "is this the model or
 * is this the code" unanswerable, and every result before the switch incomparable with every result
 * after it. The cost lands days later, when the transcript is read back and nobody can say which
 * model produced which half of the evidence.
 *
 * The fix is not "pick a better model". It is to make the lead a **held** variable: pinned per
 * project, and changed only as a recorded act.
 *
 * ## Mechanism: revert, not block, because PI offers no veto
 *
 * `ModelSelectEvent` has no result type — unlike `tool_call`, which carries `{ block, reason }` —
 * so there is no seam that refuses a model change and a handler that "blocks" one cannot exist.
 * What does exist is `pi.setModel()`, which `path-defaults` already uses to decide where a session
 * starts. So this module holds the session on the pin by *putting it back*: on any selection away
 * from the pinned tier's model it re-selects the pin, and says loudly what it just undid and what
 * the sanctioned path is.
 *
 * A revert is strictly better than the silent no-op the alternative would be. The operator sees the
 * model they chose, sees it snap back, and reads one sentence naming the command that would make
 * the change stick. Nothing is lost quietly.
 *
 * ## Why the escape hatch is a command with a reason, and not a flag
 *
 * An ack flag — a boolean in a config file, an env var in a shell profile — is a workaround that
 * costs nothing to leave switched on forever. It converts the pin into a comment. This is a habit
 * problem, and a gate you disarm once does not touch a habit.
 *
 * So the only sanctioned path is `/lead-model <tier> <why>`: it costs one sentence, every time, and
 * the sentence goes to two places that outlive the moment — the pin file, and the session facts
 * file that survives compaction. Nothing about the mechanism is hard to get past on purpose. It is
 * hard to get past *without saying why*, which is the entire point.
 *
 * There is deliberately no `/lead-model off`. Removing a pin means editing or deleting
 * `<project>/.pi/lead-model.json`, which is a change in the working tree, visible in a diff and in
 * a commit. That is one act more than a verb would be, and it is the right amount of friction for
 * undoing a project decision — an unpin verb would be exactly the workaround an ack flag is, one
 * command away from having no pin at all.
 *
 * ## When the pin stands down
 *
 * If the pinned tier does not resolve to a model this install can select — no such model in the
 * registry, or no credential for its provider — the pin is announced as unenforced and this module
 * does nothing further for the session. Fighting every selection to hold a session on a model it
 * cannot reach would trap the session rather than protect it, which is the opposite of the point.
 * The announcement is at `error` level, so an unenforced pin is never a quiet one.
 *
 * ## Ordering
 *
 * Composed immediately after `path-defaults` in `extensions/index.ts`. `path-defaults` sets the
 * install-wide default tier at `session_start`; a project pin is the more specific statement and
 * must land after it, on the same event. The two agree in the common case, and when they disagree
 * the project wins.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFact, factsPathFor } from "../compaction/facts.ts";
import { emitNotice, type NoticeTarget } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { stateRoot } from "../lib/paths.ts";
import { loadRoutingTierTarget, type RoutingTierTarget } from "../path-defaults/routing.ts";
import { loadLeadModelPin, MIN_REASON_LENGTH, writeLeadModelPin, type LeadModelPin } from "./config.ts";
import { leadModelPinPath } from "./paths.ts";

export const id = "lead-model";

export type Resolution =
  /** No `<project>/.pi/lead-model.json`. The normal state of an unpinned project, and silent. */
  | { readonly kind: "unpinned"; readonly path: string }
  | { readonly kind: "config-error"; readonly path: string; readonly message: string }
  | {
      readonly kind: "pinned";
      readonly path: string;
      readonly pin: LeadModelPin;
      readonly target: RoutingTierTarget;
    };

/**
 * Everything decidable without `pi` or `ctx`: read the project's pin file and resolve its tier.
 *
 * Synchronous, never throws, and the seam every unit test drives. Same contract as
 * `resolvePathDefaults()`: a failure becomes a `"config-error"` resolution for the caller to
 * announce, never a silent substitution.
 */
export function resolveLeadModel(cwd: string, pinPath: string = leadModelPinPath(cwd)): Resolution {
  let pin: LeadModelPin;
  try {
    pin = loadLeadModelPin(pinPath);
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause as NodeJS.ErrnoException | undefined;
    if (cause?.code === "ENOENT") return { kind: "unpinned", path: pinPath };
    return { kind: "config-error", path: pinPath, message: describeError(err) };
  }
  try {
    return { kind: "pinned", path: pinPath, pin, target: loadRoutingTierTarget(pin.tier) };
  } catch (err) {
    return { kind: "config-error", path: pinPath, message: `tier "${pin.tier}": ${describeError(err)}` };
  }
}

/**
 * The half of PI's `ModelSelectEvent` this module reads.
 *
 * Structural rather than imported: the package's type declarations do not re-export the interface
 * from the entry point, and reaching into `dist/` for it would pin this module to an internal file
 * layout to gain nothing — `pi.on("model_select", …)` already types the handler's parameter from
 * its own overload. This shape is the contract we actually depend on.
 */
interface SelectedModel {
  readonly provider?: string;
  readonly id?: string;
}

/** What this session is holding the model to. `undefined` means nothing is being enforced. */
interface Enforcement {
  readonly path: string;
  readonly pin: LeadModelPin;
  readonly target: RoutingTierTarget;
}

/**
 * Module-level session state, safe for the same reason `lib/once.ts`'s is: this tree ships exactly
 * one PI extension file, so this module is instantiated once per process.
 */
let enforcing: Enforcement | undefined;

/**
 * True while this module is itself calling `pi.setModel()`. Every such call emits a `model_select`
 * back into our own handler, and without the guard the first revert would revert itself forever.
 * Set and cleared around the single `setModel` call site below.
 */
let applying = false;

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    enforcing = undefined;
    try {
      await applyPin(pi, ctx, resolveLeadModel(ctx.cwd));
    } catch (err) {
      surfaceOnce(ctx, `lead-model:session_start:${describeError(err).slice(0, 80)}`, () => {
        say(ctx, `session_start failed internally, so no pin is enforced: ${describeError(err)}`, "error");
      });
    }
  });

  pi.on("model_select", async (event, ctx: ExtensionContext) => {
    try {
      await holdThePin(pi, ctx, event.model as SelectedModel | undefined);
    } catch (err) {
      surfaceOnce(ctx, `lead-model:model_select:${describeError(err).slice(0, 80)}`, () => {
        say(ctx, `could not hold the pinned lead model: ${describeError(err)}`, "error");
      });
    }
  });

  pi.registerCommand("lead-model", {
    description: "Show this project's pinned lead model, or repoint it: /lead-model <tier> <why>",
    async handler(args: string, ctx: ExtensionCommandContext) {
      try {
        await runCommand(pi, ctx, args);
      } catch (err) {
        say(ctx, `/lead-model failed: ${describeError(err)}`, "error");
      }
    },
  });
}

/* ---------------------------------------------------------------------------------------------
 * Applying and holding
 * ------------------------------------------------------------------------------------------- */

async function applyPin(pi: ExtensionAPI, ctx: ExtensionContext, res: Resolution): Promise<void> {
  if (res.kind === "unpinned") return;
  if (res.kind === "config-error") {
    say(ctx, `${res.path} is unusable, so no lead model is pinned: ${res.message}`, "error");
    return;
  }

  const { pin, target } = res;
  const resolved = ctx.modelRegistry.find(target.provider, target.modelId);
  if (!resolved) {
    say(
      ctx,
      `this project pins the lead model to tier "${pin.tier}" (${target.model}), but this install ` +
        `cannot resolve that model. The pin is NOT enforced this session. Run: pi --list-models`,
      "error",
    );
    return;
  }
  if (!(await select(pi, resolved, target))) {
    say(
      ctx,
      `this project pins the lead model to tier "${pin.tier}" (${target.model}), but no credential ` +
        `is available for provider "${target.provider}". Staying on ${describeModel(ctx.model)}; the ` +
        `pin is NOT enforced this session.`,
      "error",
    );
    return;
  }

  enforcing = { path: res.path, pin, target };
  say(
    ctx,
    `lead model pinned to tier "${pin.tier}" (${target.model}) since ${pin.since}: ${pin.reason} ` +
      `A change mid stream is an event, not a convenience: /lead-model <tier> <why> records it.`,
    "info",
  );
}

/**
 * The revert.
 *
 * Runs on every `model_select` the session emits, including PI's own restore when a session is
 * resumed onto whatever model it was last using. A work stream resumed on a drifted model is
 * exactly the case this exists for, so every selection source is treated alike rather than
 * exempting the ones that did not come from a keystroke.
 */
async function holdThePin(pi: ExtensionAPI, ctx: ExtensionContext, selected: SelectedModel | undefined): Promise<void> {
  if (applying || enforcing === undefined) return;
  const { pin, target, path } = enforcing;
  if (isTarget(selected, target)) return;

  const attempted = describeModel(selected);
  const resolved = ctx.modelRegistry.find(target.provider, target.modelId);
  if (!resolved) {
    enforcing = undefined;
    say(
      ctx,
      `the pinned model ${target.model} can no longer be resolved, so the pin is standing down and ` +
        `this session is now on ${attempted}. Fix ${path} or run: pi --list-models`,
      "error",
    );
    return;
  }
  if (!(await select(pi, resolved, target))) {
    enforcing = undefined;
    say(
      ctx,
      `could not put the lead model back on ${target.model} (no usable credential for provider ` +
        `"${target.provider}"), so the pin is standing down and this session stays on ${attempted}.`,
      "error",
    );
    return;
  }

  say(
    ctx,
    `reverted the switch to ${attempted}. This project pins the lead model to tier "${pin.tier}" ` +
      `(${target.model}), set ${pin.since} because: ${pin.reason} Changing the lead model in the ` +
      `middle of a work stream makes a model problem and a code problem indistinguishable, which is ` +
      `the failure this pin exists for. If the change is right, run /lead-model <tier> <one sentence ` +
      `of why> and it will be recorded in ${path} and in this session's facts.`,
    "error",
  );
}

/* ---------------------------------------------------------------------------------------------
 * The command
 * ------------------------------------------------------------------------------------------- */

async function runCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const trimmed = args.trim();
  if (trimmed === "") {
    say(ctx, describeResolution(resolveLeadModel(ctx.cwd)), "info");
    return;
  }

  const space = trimmed.search(/\s/u);
  const tier = space < 0 ? trimmed : trimmed.slice(0, space);
  const reason = space < 0 ? "" : trimmed.slice(space + 1).replace(/\s+/gu, " ").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    say(
      ctx,
      `refused: a lead-model change needs a reason of at least ${MIN_REASON_LENGTH} characters, in ` +
        `the same breath as the change. Usage: /lead-model ${tier || "<tier>"} <why this stream needs ` +
        `a different lead>. The reason is written to the pin file and to this session's facts, which ` +
        `is what makes the change an event rather than a habit.`,
      "error",
    );
    return;
  }

  let target: RoutingTierTarget;
  try {
    target = loadRoutingTierTarget(tier);
  } catch (err) {
    say(ctx, `refused: ${describeError(err)}`, "error");
    return;
  }
  const resolved = ctx.modelRegistry.find(target.provider, target.modelId);
  if (!resolved) {
    say(
      ctx,
      `refused: tier "${tier}" resolves to ${target.model}, which this install cannot select. ` +
        `Nothing was written. Run: pi --list-models`,
      "error",
    );
    return;
  }

  const previous = enforcing;
  const path = leadModelPinPath(ctx.cwd);
  const pin: LeadModelPin = { version: 1, tier, since: today(), reason };
  await writeLeadModelPin(path, pin);

  enforcing = { path, pin, target };
  if (!(await select(pi, resolved, target))) {
    say(
      ctx,
      `${path} now pins tier "${tier}" (${target.model}), but this session could not switch onto it ` +
        `(no usable credential for provider "${target.provider}"). The pin is recorded; this session ` +
        `is not on it.`,
      "error",
    );
  } else {
    const from = previous ? `tier "${previous.pin.tier}" (${previous.target.model})` : "no pin";
    say(ctx, `lead model repointed from ${from} to tier "${tier}" (${target.model}). Recorded in ${path}.`, "info");
  }

  await recordChange(ctx, previous, pin, target, path);
}

/**
 * The change, written into the session's facts file.
 *
 * `fact` is this tree's existing channel for "something established this session that must survive
 * a compaction", and a lead-model change is exactly that: the next turn reading a strange result
 * needs to know the lead moved and why, and the summary that replaced this turn will not have kept
 * it. Written as an ordinary `fact` rather than a `ruled_out`, because a change of lead is an
 * outcome and not an abandoned approach.
 *
 * A failure here never fails the change. The pin is already on disk and already applied; losing the
 * fact is a real loss and is announced, but undoing a completed change in order to record it would
 * be worse.
 */
async function recordChange(
  ctx: ExtensionContext,
  previous: Enforcement | undefined,
  pin: LeadModelPin,
  target: RoutingTierTarget,
  path: string,
): Promise<void> {
  const from = previous ? `tier "${previous.pin.tier}" (${previous.target.model})` : "no pin";
  try {
    await appendFact(
      factsPathFor(ctx.sessionManager.getSessionFile() ?? undefined, sessionIdOf(ctx), stateRoot()),
      `The lead model for this project moved from ${from} to tier "${pin.tier}" (${target.model}); ` +
        `the pin is ${path}. Results from before and after this point were produced by different ` +
        `models and are not comparable without saying so.`,
      `operator ran /lead-model on ${pin.since}, stating: ${pin.reason}`,
    );
  } catch (err) {
    say(ctx, `the pin was changed but could not be recorded as a fact: ${describeError(err)}`, "error");
  }
}

/* ---------------------------------------------------------------------------------------------
 * Small shared pieces
 * ------------------------------------------------------------------------------------------- */

/** The one place this module calls `pi.setModel`, so the reentrancy guard cannot be forgotten. */
async function select(pi: ExtensionAPI, model: unknown, target: RoutingTierTarget): Promise<boolean> {
  applying = true;
  try {
    const ok = await pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]);
    if (ok && target.thinkingLevel !== undefined) pi.setThinkingLevel(target.thinkingLevel);
    return ok;
  } finally {
    applying = false;
  }
}

function isTarget(model: SelectedModel | undefined, target: RoutingTierTarget): boolean {
  return model?.provider === target.provider && model?.id === target.modelId;
}

function describeModel(model: SelectedModel | undefined): string {
  return model?.provider !== undefined && model?.id !== undefined ? `${model.provider}/${model.id}` : "no model";
}

function sessionIdOf(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionId() ?? "unknown-session";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** What `/lead-model` prints with no arguments. Pure, so the tests read it directly. */
export function describeResolution(res: Resolution): string {
  switch (res.kind) {
    case "unpinned":
      return (
        `no lead model is pinned for this project (${res.path} does not exist). Pin one with ` +
        `/lead-model <tier> <why>, and the lead stops moving under the work stream.`
      );
    case "config-error":
      return `${res.path} is unusable, so no lead model is pinned: ${res.message}`;
    case "pinned":
      return (
        `pinned to tier "${res.pin.tier}" (${res.target.model}) since ${res.pin.since}: ` +
        `${res.pin.reason} Enforced this session: ${enforcing !== undefined ? "yes" : "no"}. File: ${res.path}`
      );
  }
}

type Level = "info" | "warning" | "error";

function say(ctx: NoticeTarget, message: string, level: Level): void {
  emitNotice(ctx, `[pi-config] lead-model: ${message}`, level);
}

/**
 * EXT-20 — automatic session titling (REQ-CTX-27).
 *
 * One cheap `pi -p` sub-invocation fired after turn 2, over the first exchange, to set the
 * session display name. Never allowed to hang the session: the sub-invocation is bounded by
 * `ExecOptions.timeout` (Node's own timer inside `execCommand` — there is no `timeout` binary on
 * this machine) and any failure — timeout, non-zero exit, dead endpoint — leaves the session
 * carrying on untitled.
 *
 * Failure is non-fatal, but it is no longer SILENT: a dead endpoint says so, once, on the one
 * channel this run mode has. A hardcoded default that stops being served fails on every turn of
 * every session, and the only trace it used to leave was a `provider_failure` per session from the
 * child `pi` process — in the channel an operator scans for failures that matter. Which model is
 * used is now resolved through `routing.json`'s `light` tier rather than frozen into a literal
 * here, so a repointed or retired tier takes this with it. This module never registers a
 * `tool_call` handler, so the
 * `guardedHandler` fail-closed/fail-open contract does not apply here; the
 * try/catch below plays the equivalent "our bug must never block the session" role for a
 * `turn_end` listener instead.
 */
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { describeError } from "../lib/once.ts";
import { readRoutingFile, tierModel } from "../lib/routing-file.ts";

export const id = "auto-title";

const TITLE_AFTER_TURN = 2;
const TITLE_TIMEOUT_MS = 20_000;
const MIN_EXCHANGE_CHARS = 40;
const MAX_EXCHANGE_CHARS = 600;
const MAX_TITLE_CHARS = 60;
const MIN_TITLE_CHARS = 3;
const UNTITLED_RE = /^(untitled|session-)/i;
/** Enough of a failing endpoint's complaint to recognise it; not enough to flood a TUI. */
const MAX_REPORTED_STDERR_CHARS = 300;

/**
 * One line, one channel, at most once per session — titling runs once (`done`), so every call site
 * below is on that single path.
 */
function say(ctx: ExtensionContext, line: string): void {
  emitNotice(ctx, `[pi-config] auto-title: ${line}`, "warning");
}

/**
 * The tier this module titles on. `light` is the cheapest live tier and titling is the cheapest
 * possible job: one 20-second, ~600-character call whose output is six words.
 */
const TITLE_TIER = "light";

export interface TitleModelResolution {
  /** `provider/id` to hand to `--model`, or `undefined` when nothing usable was found. */
  readonly model?: string;
  /** Why there is no model. Said out loud, once — never swallowed. */
  readonly problem?: string;
  readonly source: "PI_TITLE_MODEL" | "routing.json" | "none";
}

/**
 * Which model titles a session.
 *
 * **The shape this replaces.** The default used to be a bare literal — the cheapest model of the
 * default provider, written here with a comment arguing that a standalone default was deliberate
 * because reading the tier map would put a file read on the `turn_end` path. That argument is
 * cheap to keep and expensive to be wrong about: a model id frozen into a source file outlives
 * the seat, the tier and the catalogue that made it correct, and when it stops being served this
 * module has no way to notice. Every session then pays one failed sub-invocation whose only trace
 * is a `provider_failure` from the child process, in the channel an operator scans for real
 * failures. A monitoring channel with a permanent known-false entry in it is a broken monitoring
 * channel.
 *
 * So the default is resolved through `routing.json`'s tiers, like everything else in this harness
 * that names a model, and it cannot rot the same way: a tier that is renamed or repointed takes
 * this with it. The file read is once per session, on the `turn_end` that titles — not on every
 * turn. It is still a bare `provider/id` on the wire, because auto-title shells out to
 * `pi -p --model <id>` rather than dispatching, so it needs the resolved id and not the tier name;
 * only the resolution moved.
 *
 * `PI_TITLE_MODEL` still wins, unchanged, and is now validated: a value that is not a
 * `provider/id` is a typo, and running with it would resurrect exactly the failure above.
 */
export function resolveTitleModel(
  env: NodeJS.ProcessEnv = process.env,
  routing = readRoutingFile(),
): TitleModelResolution {
  const pinned = env.PI_TITLE_MODEL?.trim();
  if (pinned !== undefined && pinned !== "") {
    return pinned.includes("/")
      ? { model: pinned, source: "PI_TITLE_MODEL" }
      : { problem: `PI_TITLE_MODEL is "${pinned}", which is not a provider/id`, source: "none" };
  }
  const fromTier = tierModel(routing, TITLE_TIER);
  if (fromTier !== undefined) return { model: fromTier, source: "routing.json" };
  return {
    problem:
      `no "${TITLE_TIER}" tier with a provider/id model in ${routing.source}` +
      (routing.problem !== undefined ? ` (${routing.problem})` : "") +
      "; set PI_TITLE_MODEL to title sessions",
    source: "none",
  };
}

interface TextBearingMessage {
  role?: string;
  content?: unknown;
}

function extractText(message: unknown): string {
  const m = message as TextBearingMessage;
  if (!m || typeof m !== "object") return "";
  if (m.role !== "user" && m.role !== "assistant") return "";
  const content = m.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text?: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => c.text ?? "")
    .join(" ");
}

/** Exported for tests: builds the first-exchange excerpt fed to the titling prompt. */
export function buildFirstExchange(entries: readonly { type: string; message?: unknown }[]): string {
  return entries
    .filter((e) => e.type === "message")
    .slice(0, 4)
    .map((e) => extractText(e.message).slice(0, MAX_EXCHANGE_CHARS))
    .filter((t) => t.length > 0)
    .join("\n---\n");
}

/** Exported for tests: cleans raw sub-invocation stdout into a candidate title, or undefined. */
export function extractTitle(stdout: string | undefined): string | undefined {
  if (!stdout) return undefined;
  const title = stdout
    .trim()
    .split("\n")
    .pop()
    ?.replace(/^["'`]|["'`]$/g, "")
    .slice(0, MAX_TITLE_CHARS);
  return title && title.length >= MIN_TITLE_CHARS ? title : undefined;
}

export function register(pi: ExtensionAPI): void {
  let done = false;

  pi.on("session_start", () => {
    done = false;
  });

  pi.on("turn_end", async (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (done || event.turnIndex < TITLE_AFTER_TURN) return;

    const existing = pi.getSessionName();
    if (existing && !UNTITLED_RE.test(existing)) {
      done = true; // user (or an earlier run) already named it — never overwrite
      return;
    }
    done = true; // set BEFORE the await: a re-entrant turn_end must not fire a second call

    try {
      const branch = ctx.sessionManager.getBranch();
      const firstExchange = buildFirstExchange(branch as readonly { type: string; message?: unknown }[]);
      if (firstExchange.trim().length < MIN_EXCHANGE_CHARS) return;

      const prompt =
        "Write a session title of at most 6 words for the exchange below. " +
        "Output ONLY the title, no quotes, no trailing punctuation.\n\n" +
        firstExchange;

      const resolved = resolveTitleModel();
      if (resolved.model === undefined) {
        say(ctx, `not titling this session — ${resolved.problem}`);
        return;
      }

      // Bounded and non-fatal: a dead title endpoint must never hold the session open.
      const result = await pi
        .exec(process.execPath, [process.argv[1] ?? "pi", "-p", prompt, "--model", resolved.model], {
          timeout: TITLE_TIMEOUT_MS,
        })
        .catch((err: unknown) => {
          say(ctx, `the titling call to ${resolved.model} could not be run: ${describeError(err)}`);
          return undefined;
        });
      if (result === undefined) return;

      const title = extractTitle(result.stdout);
      if (title === undefined) {
        // AUDIBLE ON PURPOSE (audit H9). This used to be `.catch(() => undefined)` and a silent
        // `if (title)`, which is how a model that answered HTTP 400 to every request for two weeks
        // went unnoticed here while filling the failure channel from the child process. One line,
        // once per session, naming the model and what came back: the session still carries on
        // untitled, but nobody has to reconstruct why from a transcript.
        say(
          ctx,
          `${resolved.model} (from ${resolved.source}) returned no usable title — exit ${result.code}` +
            `${result.killed ? `, killed after ${TITLE_TIMEOUT_MS} ms` : ""}` +
            `${result.stderr.trim() !== "" ? `: ${result.stderr.trim().slice(-MAX_REPORTED_STDERR_CHARS)}` : ""}`,
        );
        return;
      }
      pi.setSessionName(title);
    } catch (err) {
      // Fail open: our own bug in this module must never surface as a stuck or crashed session.
      // Fail open LOUDLY, though — see the `say` above.
      say(ctx, `failed internally and was skipped: ${describeError(err)}`);
    }
  });
}

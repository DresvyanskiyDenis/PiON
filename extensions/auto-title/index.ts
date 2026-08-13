/**
 * EXT-20 — automatic session titling (REQ-CTX-27).
 *
 * One cheap `pi -p` sub-invocation fired after turn 2, over the first exchange, to set the
 * session display name. Never allowed to hang the session: the sub-invocation is bounded by
 * `ExecOptions.timeout` (Node's own timer inside `execCommand` — there is no `timeout` binary on
 * this machine) and any failure — timeout, non-zero exit, dead endpoint — is swallowed and the
 * session carries on untitled. This module never registers a `tool_call` handler, so the
 * `guardedHandler` fail-closed/fail-open contract does not apply here; the
 * try/catch below plays the equivalent "our bug must never block the session" role for a
 * `turn_end` listener instead.
 */
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";

export const id = "auto-title";

const TITLE_AFTER_TURN = 2;
const TITLE_TIMEOUT_MS = 20_000;
const MIN_EXCHANGE_CHARS = 40;
const MAX_EXCHANGE_CHARS = 600;
const MAX_TITLE_CHARS = 60;
const MIN_TITLE_CHARS = 3;
const UNTITLED_RE = /^(untitled|session-)/i;

/**
 * Titling is a throwaway one-liner, so it wants the cheapest model that exists. It cannot read
 * `routing.json`'s `cheap` tier here, because this module has no config loader and adding one for a
 * cosmetic feature would put a file read on the `turn_end` path — so the default mirrors
 * `config/routing.default.json`'s `cheap` binding instead, and `PI_TITLE_MODEL` is how a different
 * install corrects it. A wrong id here costs an untitled session and nothing else: every failure of
 * the sub-invocation is swallowed by design.
 */
function defaultTitleModel(): string {
  return process.env.PI_TITLE_MODEL ?? "github-copilot/claude-haiku-4.5";
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

      // Bounded and non-fatal: a dead title endpoint must never hold the session open.
      const result = await pi
        .exec(process.execPath, [process.argv[1] ?? "pi", "-p", prompt, "--model", defaultTitleModel()], {
          timeout: TITLE_TIMEOUT_MS,
        })
        .catch(() => undefined);

      const title = extractTitle(result?.stdout);
      if (title) pi.setSessionName(title);
    } catch {
      // Fail open: our own bug in this module must never surface as a stuck or crashed session.
    }
  });
}

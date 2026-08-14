/**
 * Ports `nudge-verify.sh` onto PI's `(#33) input` event (REQ-EXT-20, `REQ-CTX-15` consumer).
 *
 * `input` is "the one place PI beats both predecessors" — Claude Code's
 * `UserPromptSubmit` could only append `additionalContext`; PI's `input` handler can return
 * `{ action: "transform", text }` and rewrite the user's message outright. This module still only
 * ever *appends* — the ported design rule is the point, not the new capability:
 *
 *   "Design rule: STAY SILENT. A hook that fires on every prompt is noise and gets tuned out
 *    ... Each signal is a concrete lexical marker, never a guess about intent."
 *
 * **`input` fires BEFORE skill and prompt-template expansion**. A `/skill:foo bar` prompt reaches this handler as the literal string
 * `/skill:foo bar` — the original script's `case "$PROMPT" in /*) exit 0 ;;` bailout is ported
 * unchanged for exactly that reason, and it still does the right thing here, but note the
 * ordering is the opposite of the intuition: this handler can never see an expanded template,
 * only ever the raw slash-prefixed input the user typed.
 *
 * Signals implemented:
 *   1. an explicit version string appears in the prompt
 *   2. the bailouts: a leading `/` (see above), and a too-short prompt
 *
 * DECISION — the dependency-name signal is REMOVED, not narrowed. It fired whenever any bare token
 * in the prompt equalled a declared dependency of the current project, which made every short
 * dependency name that is also an ordinary English word a tripwire. Reproduced in a project whose
 * `pyproject.toml` declares `mcp`: "we speak only about UI, client side. We do not touch mcp
 * wrapper" fired the nudge, with no library reference in the sentence at all. That is precisely the
 * failure the design rule quoted above forbids — a guess about intent wearing a lexical marker's
 * clothes. Narrowing was considered and rejected on two counts: requiring the dependency token to
 * co-occur with a version marker adds nothing, because the version marker already fires on its own;
 * and requiring an import- or install-shaped context would move the noise rather than remove it,
 * since a pasted snippet that merely *contains* an import of a project dependency is usually a
 * request to change code, not a question about the library. The signal's remaining value is already
 * covered statically: `AGENTS.md`'s "current docs before code touching a library" trigger names "a
 * package or tool name" in the standing instructions. So this follows the same reasoning the
 * DEVIATION below already applied to the recency and pricing signals — a rule the harness states
 * once, statically, does not also need a per-prompt hook. The manifest reader (`package.json` /
 * `pyproject.toml` parsing, its mtime cache and the `smol-toml` import) existed only to feed this
 * signal and was removed with it.
 *
 * DEVIATION: an earlier survey lists five original signals (manifest dependency, version number,
 * recency words EN+RU, pricing words, pasted stack trace) as "directly portable", but
 * the more specific, non-frozen porting decision — with a concrete acceptance
 * test — names only the two lexical *marker* signals plus the bailouts as what actually ports
 * into `EXT-17`. Recency/pricing words are already covered statically by the harness's own
 * "verify instead of recalling" instruction rather than by a hook, and a pasted stack trace is a
 * different behaviour (triage, not verification) with no PI event mapping given here. Implemented
 * per that narrower list, then narrowed once more by the decision above; whether the other three
 * should be added is left open.
 *
 * DEVIATION: the original bash script's exact version-string regex and short-prompt threshold are
 * not present anywhere in this repo (they live in `~/.claude/hooks/nudge-verify.sh`, outside this
 * repo). The constants below are a reasonable reimplementation against the documented behaviour
 * and its acceptance test, not a byte-for-byte port.
 *
 * Collapse-into-EXT-15 decision (this module was asked to make the call): STILL TYPESCRIPT, but the
 * original justification is void and this is worth re-deciding. The old answer rested entirely on
 * the dependency-name signal, which required reading and parsing this project's own manifest files
 * at runtime — dynamic per-project computation that `EXT-15`'s YAML schema is deliberately capped
 * short of (`REQ-EXT-17`: "cap it at deny/warn/inject ... let anything else be TypeScript"). With
 * that signal gone, what remains is a single static regex plus two bailouts. What still keeps it
 * here is not the fail-open argument — a missed nudge is cheap — but the hook schema: `input`'s
 * `HookAction` is capped at `block`/`warn` (`extensions/hooks/schema.ts`), and neither can append
 * text back to the model (`warn` calls `ctx.ui.notify`, a no-op headless). There is no action that
 * expresses "append a nudge", so YAML cannot express this module at all.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { declareModule } from "./lib/manifest.ts";
import { emitNotice } from "./lib/announce.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";

export const id = "input-transform";

const MODULE_VERSION = "2.0.0";

/**
 * Appended, never substituted — see the file header. Points at the two tools the harness's own
 * "current docs before code touching a library" / "verify instead of recalling" instructions name,
 * per the ported design's "nudge text points at web_search/web_fetch/context7-if-enabled".
 */
const NUDGE_SUFFIX =
  "\n\n[verify] This mentions a version — check Context7 (or web_search for anything date-, " +
  "pricing-, or limit-sensitive) before answering from memory.";

/**
 * Below this many words, no signal is trusted — mirrors the original's short-prompt bailout.
 * ASSUMPTION (see file header DEVIATION note): the literal original threshold is not available
 * in this repo. 3 words is chosen so "ok continue" (2 words) always bails regardless of what it
 * happens to contain, while the acceptance test's "why does pydantic v2.11 fail here" (6 words)
 * clears it easily.
 */
const MIN_PROMPT_WORDS = 3;

/** `\bv?\d+\.\d+(\.\d+)?\b` — "2.11", "v2.11", "3.13.0". A concrete lexical marker, not a guess. */
const VERSION_MARKER_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/;

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    declareModule({
      id,
      version: MODULE_VERSION,
      events: ["input", "session_start"],
      apis: ["on"],
    });
  });
  pi.on("input", handleInput);
}

function handleInput(event: InputEvent, ctx: ExtensionContext): InputEventResult {
  try {
    if (!event.text || event.text.trim().length === 0) return { action: "continue" };
    if (!decide(event.text).fire) return { action: "continue" };
    return { action: "transform", text: event.text + NUDGE_SUFFIX };
  } catch (err) {
    // Belt-and-braces: PI's own runner already catches a throwing `input` handler and continues
    // with the text unchanged (`emitInput` in `dist/core/extensions/runner.js`), so this branch
    // is not load-bearing for correctness — but REQ-EXT-16 wants the error surfaced once, in our
    // own words, rather than left to the platform's generic per-extension error report.
    surfaceOnce(ctx, `${id}:handler:${signature(err)}`, () => {
      emitNotice(
        ctx,
        `[pi-config] ${id}: failed internally, prompt left unchanged: ${describeError(err)}`,
        "error",
      );
    });
    return { action: "continue" };
  }
}

export interface NudgeDecision {
  readonly fire: boolean;
  readonly reason?: "version";
}

/** Pure decision function — the whole signal + bailout logic, independent of I/O. */
export function decide(text: string): NudgeDecision {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { fire: false };
  if (trimmed.startsWith("/")) return { fire: false }; // leading-slash bailout; see file header
  if (trimmed.split(/\s+/).length < MIN_PROMPT_WORDS) return { fire: false };
  if (VERSION_MARKER_RE.test(trimmed)) return { fire: true, reason: "version" };
  return { fire: false };
}

function signature(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return msg.slice(0, 120);
}

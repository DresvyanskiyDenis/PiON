/**
 * `path-rules` — path-scoped context rules, fingerprinted at `session_start` and topped up
 * mid-turn.
 *
 * PI's `AGENTS.md`/`PRIVATE.md` are flat: always-on or never-on, no "only when the agent is
 * working on files matching a glob" — that gap is what `rules/*.md` (`./config.ts`) closes. Three
 * mechanisms, layered because no single PI event can do this alone
 * (`docs/extensions/path-rules.md` has the full trace):
 *
 *   1. `session_start` (`./scan.ts`) — a bounded walk of the project seeds the durable rule set
 *      from files that ALREADY exist. This is the primary path and covers the common case with
 *      zero lag: the rule is in the system prompt before the model's first token.
 *   2. `tool_call` on `read`/`edit`/`write` — detects a file the startup scan could not have seen
 *      (created mid-session, or simply not visited before the first match of another rule stopped
 *      the scan early) and marks its rule active. ALWAYS returns `undefined`: `tool_call` can only
 *      veto a call, never inject text into one (traced JS evidence in the integration report), so
 *      this handler observes only and must never become a second way to block a tool call.
 *   3. `context` (`./context.ts`) fires before every LLM call within a turn, including mid-turn
 *      after a tool result — this is what actually delivers a rule activated by (2) before the
 *      model's NEXT action, closing the "read a file, then edit it, same turn" gap that a
 *      `before_agent_start`-only design misses entirely (not "one round trip late" — invisible
 *      until the following turn).
 *   4. `before_agent_start` (`./inject.ts`) is the durable net: recomputed live every turn from
 *      whatever `session_start` and `tool_call` have accumulated, so the block survives
 *      compaction, `/reload`, and fork the same way `session-context.ts`'s does.
 *
 * A rule carrying `mask:` (`./config.ts`) is not part of any of that. It answers a touch by
 * narrowing the tool surface for the rest of the turn (`../tool-masks/`) instead of by
 * contributing text, so it never enters `durable` or `pending`, is never rendered into a block,
 * and is skipped by the startup scan: a mask is a response to touching a file now, not a standing
 * fact about the project. Staying out of `durable` is also what lets it fire again next turn,
 * after `turn_end` has released the previous one.
 *
 * `pending` is what keeps (3) and (4) from double-injecting the same rule: `before_agent_start`
 * clears it the moment it folds `durable` into the system prompt for this turn — anything added to
 * `durable` by `tool_call` AFTER that point (mid-turn) lands in `pending` again, which is exactly
 * what `context` reads. A rule already reflected in this turn's system prompt is never re-sent
 * through `context`; one that surfaces mid-turn is sent through `context` only, until the NEXT
 * turn's `before_agent_start` absorbs it into the durable block.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { emitNotice, type NoticeTarget } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { loadRules, type PathRule } from "./config.ts";
import { injectContext } from "./context.ts";
import { injectOnce } from "./inject.ts";
import { rulesDir } from "./paths.ts";
import { renderBlock } from "./render.ts";
import { matchesAny } from "./glob.ts";
import { scanProject, type ScanResult } from "./scan.ts";
import { requestTurnMask } from "../tool-masks/index.ts";
import type { MaskName } from "../tool-masks/masks.ts";

export const id = "path-rules";

/** REQ item 4: the scan's own reporting threshold — not a hard cap, just when to say something. */
const SCAN_BUDGET_MS = 100;

export interface PathRulesState {
  readonly rules: readonly PathRule[];
  /** Rule ids currently injected via `before_agent_start` every turn. Grows monotonically within a session. */
  readonly durable: Set<string>;
  /** Rule ids added to `durable` since the last `before_agent_start` — what `context` still owes this turn. */
  readonly pending: Set<string>;
  readonly scan: ScanResult;
  readonly rulesDirPath: string;
}

let state: PathRulesState | null = null;

/** Test-only: drop all module state so each test starts clean. */
export function __resetForTests(): void {
  state = null;
}

/** Test-only: read back what `session_start` computed. */
export function __state(): PathRulesState | null {
  return state;
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const announce = makeAnnounce(ctx);
    try {
      const dir = rulesDir();
      const { rules, warnings } = loadRules(dir);
      for (const w of warnings) announce(w, "warning");
      // Mask rules are deliberately excluded: the scan answers "does this project contain such a
      // file", and a mask must answer "is the model touching one right now".
      const scan = scanProject(
        ctx.cwd,
        rules.filter((rule) => rule.mask === null),
      );
      state = { rules, durable: new Set(scan.activated), pending: new Set(), scan, rulesDirPath: dir };
      const overBudget = scan.elapsedMs > SCAN_BUDGET_MS;
      if (scan.truncated || overBudget) {
        announce(
          `fingerprint scan visited ${scan.filesVisited} file(s) in ${scan.dirsVisited} dir(s) in ` +
            `${scan.elapsedMs.toFixed(1)}ms${scan.truncated ? ", truncated by the depth/file cap" : ""}` +
            (overBudget ? ` — over the ${SCAN_BUDGET_MS}ms budget` : ""),
          "warning",
        );
      }
    } catch (err) {
      state = null;
      surfaceOnce(ctx, "path-rules:session_start", () => {
        announce(`session_start failed; path rules disabled for this session: ${describeError(err)}`, "error");
      });
    }
  });

  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined => {
    if (state && (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write")) {
      try {
        for (const mask of detectTouch(state, event, ctx.cwd)) requestTurnMask(ctx, mask);
      } catch (err) {
        surfaceOnce(ctx, "path-rules:tool_call", () => {
          makeAnnounce(ctx)(`mid-session detection failed (non-fatal): ${describeError(err)}`, "error");
        });
      }
    }
    // Always undefined: this handler observes, it never blocks and never mutates `event.input`.
    return undefined;
  });

  // No `ContextEventResult` return-type annotation: the type is not part of this package's public
  // surface (only `ContextEvent` is) — `pi.on("context", ...)` still checks this handler
  // structurally against it at the call site below.
  pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    if (!state || state.pending.size === 0) return undefined;
    try {
      const block = renderBlock(state.rules, state.pending);
      return { messages: injectContext(event.messages, block) };
    } catch (err) {
      surfaceOnce(ctx, "path-rules:context", () => {
        makeAnnounce(ctx)(`mid-turn injection failed, prompt left unmodified: ${describeError(err)}`, "error");
      });
      return undefined;
    }
  });

  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined => {
      if (!state || state.durable.size === 0) return undefined;
      try {
        const block = renderBlock(state.rules, state.durable);
        // Everything in `durable` is about to be reflected in the system prompt returned below —
        // `context` must not re-send it mid-turn until `tool_call` adds something NEW to `pending`.
        state.pending.clear();
        return { systemPrompt: injectOnce(event.systemPrompt, block) };
      } catch (err) {
        surfaceOnce(ctx, "path-rules:before_agent_start", () => {
          makeAnnounce(ctx)(`injection failed, prompt left unmodified: ${describeError(err)}`, "error");
        });
        return undefined;
      }
    },
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * Marks every not-yet-active conditional text rule whose `paths:` match this tool call's target,
 * and returns the mask of every `mask:` rule that matched, for the caller to request.
 *
 * A mask rule is outside the `durable` dedupe on purpose: `durable` exists so a rule's text is
 * injected once, and a mask is not text. It has to fire again on the turn after `turn_end`
 * released it, so it is neither recorded nor skipped here.
 */
function detectTouch(s: PathRulesState, event: ToolCallEvent, cwd: string): MaskName[] {
  const masks: MaskName[] = [];
  const rawPath = (event.input as { path?: unknown }).path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return masks;
  const relPath = toRelativePath(rawPath, cwd);
  if (relPath === null) return masks;
  for (const rule of s.rules) {
    if (rule.matchers === null) continue;
    if (rule.mask === null && s.durable.has(rule.id)) continue;
    if (!matchesAny(rule.matchers, relPath)) continue;
    if (rule.mask !== null) {
      masks.push(rule.mask);
      continue;
    }
    s.durable.add(rule.id);
    s.pending.add(rule.id);
  }
  return masks;
}

/**
 * Resolves a tool's `path` input (absolute or relative) against `cwd` into a `/`-separated path
 * relative to it, or `null` when the target is outside the project — a rule's `paths:` never
 * matches something outside the tree it was written for.
 */
export function toRelativePath(rawPath: string, cwd: string): string | null {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function makeAnnounce(ctx?: NoticeTarget): (line: string, level?: "info" | "warning" | "error") => void {
  return (line, level = "warning") => emitNotice(ctx, `[pi-config] path-rules: ${line}`, level);
}

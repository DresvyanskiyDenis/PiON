/**
 * `tool-masks` — run-time tool masks over `pi.getActiveTools()` / `pi.setActiveTools()`.
 *
 * The guard is audit-only: it judges a call the model already spent tokens choosing. A mask
 * removes the choice instead. Under `/review` there is no `write` in the tool list to call, so
 * there is no denial to argue with, no escape hatch to write, and no prompt text to ignore.
 *
 * THREE COMMANDS, ONE STATE MACHINE:
 *
 *   `/review`  — the reading tools only (`./masks.ts`).
 *   `/explore` — the same, plus `web`.
 *   `/ship`    — restores the EXACT list captured when the first mask went on, not a hardcoded
 *                full set. Tools registered dynamically (an MCP server that connected mid-session,
 *                an adopted package's tool) are in that capture and come back with it; anything
 *                registered WHILE a mask was on is added back on top rather than silently dropped.
 *
 * WHY A BASELINE AND NOT A RE-DERIVATION. `setActiveTools` has no inverse: PI keeps a registry of
 * everything configured (`getAllTools()`), but "everything configured" is not "what this session
 * had active" — `settings.json`, another extension, or the operator may have narrowed it long
 * before any mask existed. Restoring from `getAllTools()` would hand back tools the session had
 * deliberately switched off. The baseline is captured once, on the transition out of the unmasked
 * state, and is the only thing `/ship` trusts.
 *
 * SURVIVING `/compact` AND FORK. The mask lives in module state, and module state dies with the
 * extension runtime: a fork, a session switch or a reload tears the runtime down and stands a new
 * one up, and compaction rebuilds the context under it. So every operator-driven transition is
 * also appended to the session as a `tool-masks.state` custom entry (`pi.appendEntry`, never LLM
 * context), and `session_start`/`session_compact` replay the last one. That is `subagent-cost`'s
 * "seed from the session file" idiom applied to a capability instead of a number, and it is why
 * the baseline travels inside the entry: a resumed session must be able to `/ship` back to the
 * list its ancestor had, which nothing in the live runtime still knows.
 *
 * TURN MASKS (the `path-rules` composition). `requestTurnMask()` is the seam for "you touched a
 * sensitive path, so the rest of this turn is read-only". It may only ever TIGHTEN what is in
 * force, it records what to fall back to, `turn_end` releases it, and it is never persisted: an
 * automatic mask must not outlive the turn that provoked it. An operator's `/review` is never
 * widened or cleared by a path rule; only `/ship` clears an operator's mask.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { declareModule } from "../lib/manifest.ts";
import { describeError } from "../lib/once.ts";
import { isMaskName, MASKS, type MaskName, maskTools, strictness } from "./masks.ts";

export const id = "tool-masks";
const MODULE_VERSION = "1.0.0";

/** `ctx.ui.setStatus` key, and the key `config/pi-statusline.json` gives an icon under. */
export const STATUS_KEY = "tool-masks";

/** Session entry type carrying the operator transitions across compaction, fork and resume. */
export const STATE_ENTRY = "tool-masks.state";

/** What a `tool-masks.state` entry carries. `mask: null` is the record of a `/ship`. */
export interface MaskEntryData {
  readonly mask: MaskName | null;
  /** The unmasked tool list. Present on a `/ship` entry too, so a replay can still restore it. */
  readonly baseline: readonly string[];
  readonly at: number;
}

interface MaskState {
  readonly mask: MaskName;
  /** What was active before the FIRST mask went on. `/ship` restores exactly this. */
  readonly baseline: readonly string[];
  /** A `"turn"` mask is released by `turn_end`; a `"command"` mask only by `/ship`. */
  readonly source: "command" | "turn";
  /** For a turn mask that tightened an operator's mask: what to fall back to at `turn_end`. */
  readonly restoreTo: MaskName | null;
}

let state: MaskState | null = null;

/**
 * The `pi` handle from `register()`.
 *
 * `getActiveTools`/`setActiveTools`/`appendEntry` are members of `ExtensionAPI`, not of the
 * `ExtensionContext` a handler is passed, so a module that has to change the tool list from
 * outside its own `register()` closure (here: `requestTurnMask`, called by `path-rules`) cannot
 * reach them except through a stored handle. Same module-level-state caveat as everywhere else in
 * this tree (`lib/once.ts`): one runtime, one extension file, one handle.
 */
let api: ExtensionAPI | null = null;

/** Test-only: drop module state so each test starts unmasked. */
export function __resetForTests(): void {
  state = null;
  api = null;
}

/** Test-only: read back the mask currently in force. */
export function __state(): MaskState | null {
  return state;
}

/** The mask in force for any surface that wants it, or `null` when the full set is active. */
export function activeMask(): MaskName | null {
  return state?.mask ?? null;
}

export function register(pi: ExtensionAPI): void {
  api = pi;

  for (const name of ["review", "explore"] as const) {
    pi.registerCommand(name, {
      description: `Mask the tool list down to ${MASKS[name].summary}. /ship restores it.`,
      handler: async (_args: string, ctx: ExtensionContext) => {
        applyMask(pi, ctx, name, "command");
      },
    });
  }

  pi.registerCommand("ship", {
    description: "Restore the tool list that was active before the first mask.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      ship(pi, ctx);
    },
  });

  // Replay the last operator transition. `session_start` covers resume, fork and session switch;
  // `session_compact` covers the in-place rebuild, which does not fire `session_start`.
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    guarded("session_start", () => {
      replay(pi, ctx);
      declareModule({
        id,
        version: MODULE_VERSION,
        events: ["session_start", "session_compact", "turn_end"],
        apis: [
          "on",
          "registerCommand",
          "getActiveTools",
          "setActiveTools",
          "appendEntry",
          "ui.setStatus",
        ],
      });
    });
  });

  pi.on("session_compact", (_event, ctx: ExtensionContext) => {
    guarded("session_compact", () => replay(pi, ctx));
  });

  pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
    guarded("turn_end", () => releaseTurnMask(pi, ctx));
  });
}

/**
 * The `path-rules` seam: narrow the tool surface for the rest of the turn because a rule matching
 * a sensitive path just fired. Tightens only, never loosens, and never persists.
 *
 * Returns the mask now in force, or `null` when the request changed nothing (no `register()` yet,
 * or something at least as strict is already on).
 */
export function requestTurnMask(ctx: ExtensionContext, mask: MaskName): MaskName | null {
  if (api === null) return null;
  if (state !== null && strictness(state.mask) <= strictness(mask)) return null;
  const restoreTo = state?.source === "command" ? state.mask : (state?.restoreTo ?? null);
  applyMask(api, ctx, mask, "turn", restoreTo);
  return mask;
}

// ---------------------------------------------------------------------------------------------

function applyMask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mask: MaskName,
  source: MaskState["source"],
  restoreTo: MaskName | null = null,
): void {
  const baseline = state?.baseline ?? [...pi.getActiveTools()];
  const masked = maskTools(baseline, mask);
  state = { mask, baseline, source, restoreTo };
  pi.setActiveTools(masked);
  publish(ctx);
  // Only an operator transition is persisted: a turn mask must not be replayed into a resumed
  // session, and `turn_end` is what ends it.
  if (source === "command") persist(pi, mask, baseline);
  announce(
    ctx,
    `${mask}: ${MASKS[mask].summary}. ${baseline.length - masked.length} of ${baseline.length} tools masked out.`,
  );
}

function ship(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (state === null) {
    publish(ctx);
    announce(ctx, "no mask is active; the full tool list is already in force.");
    return;
  }
  const { baseline } = state;
  // A tool registered while the mask was on is not in the baseline and restoring the baseline
  // alone would drop it for good. `/ship` means everything back, so it is added on top.
  const added = pi.getActiveTools().filter((name) => !baseline.includes(name));
  const restored = [...baseline, ...added];
  state = null;
  pi.setActiveTools(restored);
  publish(ctx);
  persist(pi, null, baseline);
  announce(ctx, `mask lifted, ${restored.length} tools active.`);
}

/** Releases a turn mask at `turn_end`, falling back to the operator's own mask if there was one. */
function releaseTurnMask(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (state === null || state.source !== "turn") return;
  const { baseline, restoreTo } = state;
  state =
    restoreTo === null ? null : { mask: restoreTo, baseline, source: "command", restoreTo: null };
  pi.setActiveTools(restoreTo === null ? [...baseline] : maskTools(baseline, restoreTo));
  publish(ctx);
}

/** Re-applies the last persisted operator transition after a compaction, fork, switch or resume. */
function replay(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const last = lastEntry(ctx);
  if (last === null) {
    publish(ctx);
    return;
  }
  if (last.mask === null) {
    state = null;
    pi.setActiveTools([...last.baseline]);
    publish(ctx);
    return;
  }
  state = { mask: last.mask, baseline: [...last.baseline], source: "command", restoreTo: null };
  pi.setActiveTools(maskTools(last.baseline, last.mask));
  publish(ctx);
}

/** The newest well-formed `tool-masks.state` entry, or `null` when this session has none. */
function lastEntry(ctx: ExtensionContext): MaskEntryData | null {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data as Partial<MaskEntryData> | undefined;
    // A malformed newest entry is not silently skipped in favour of an older one: the newest
    // record is the truth about this session, and replaying an older one would restore a mask the
    // operator has since lifted.
    if (!data || !Array.isArray(data.baseline)) return null;
    if (data.mask != null && !isMaskName(data.mask)) return null;
    return { mask: data.mask ?? null, baseline: [...(data.baseline as string[])], at: data.at ?? 0 };
  }
  return null;
}

function persist(pi: ExtensionAPI, mask: MaskName | null, baseline: readonly string[]): void {
  const data: MaskEntryData = { mask, baseline: [...baseline], at: Date.now() };
  pi.appendEntry(STATE_ENTRY, data);
}

/** The statusline half: the mask in force, or `full` when nothing is masked. */
function publish(ctx: ExtensionContext): void {
  ctx.ui?.setStatus?.(STATUS_KEY, renderStatus());
}

/** Exported for the statusline test: exactly what `ctx.ui.setStatus` is handed. */
export function renderStatus(): string {
  if (state === null) return "tools full";
  return state.source === "turn" ? `tools ${state.mask} (auto)` : `tools ${state.mask}`;
}

function announce(ctx: ExtensionContext, line: string): void {
  emitNotice(ctx, `[pi-config] tool-masks: ${line}`, "info");
}

/** A mask bug must never take down the lifecycle event it rode in on. */
function guarded(reason: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    process.stderr.write(`[pi-config] tool-masks: ${reason} failed: ${describeError(err)}\n`);
  }
}

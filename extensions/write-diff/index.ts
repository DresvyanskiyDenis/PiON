/**
 * `write` over an existing file, rendered as a diff.
 *
 * See `diff-card.ts` for why this targets `write` rather than `edit`, with the file:line evidence
 * that PI already diffs `edit` results properly.
 *
 * WHERE THE PRE-IMAGE COMES FROM. Nothing in a `write` result carries the old bytes:
 * `core/tools/write.js:161` returns `details: undefined`, and by the time `tool_result` fires the
 * file on disk already holds the new content. `tool_call` is therefore the last moment at which
 * the old file still exists, and that is where the pre-image is read and held until the result
 * lands.
 *
 * Deliberately NOT `tool_execution_start`. That event is emitted from the agent's event stream
 * (`core/agent-session.js:500`) with no ordering guarantee against the execution it announces, so
 * a pre-image read from it can arrive one moment too late — and the failure mode is silent: an
 * empty diff that confidently claims nothing changed.
 *
 * COSTS, AND THE CAPS ON THEM. This adds one `stat` and, below the cap, one read to every `write`,
 * on the same path the gates already run on. `MAX_PREIMAGE_BYTES` stops a rewrite of a very large
 * file from paying for a card nobody will read. `MAX_PENDING` keeps the map bounded when a call is
 * blocked by a gate or abandoned mid-turn and no `tool_result` ever arrives to clear its entry.
 *
 * POSTURE: presentation. Every handler returns `undefined` and swallows its own failures. A diff
 * card must never be the reason a write does not happen.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DIFF_ENTRY, buildWriteDiff, registerWriteDiffRenderer } from "./diff-card.ts";
import { describeError } from "../lib/once.ts";

export const id = "write-diff";

/** Files above this size are rewritten, not reviewed. Reading one back for a card is pure cost. */
const MAX_PREIMAGE_BYTES = 512 * 1024;
/** Pre-images held for calls whose result never arrived (blocked, aborted, abandoned). */
const MAX_PENDING = 32;

export function register(pi: ExtensionAPI): void {
  registerWriteDiffRenderer(pi);

  /** `toolCallId` -> the file's content before this call ran. */
  const pending = new Map<string, { path: string; before: string }>();

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "write") return undefined;
    try {
      const input = event.input as { path?: unknown };
      const path = typeof input.path === "string" ? absolute(input.path, ctx) : undefined;
      if (!path) return undefined;
      const info = await stat(path).catch(() => undefined);
      // A new file has no pre-image, and PI's own ten-line preview is the right display for it.
      if (!info?.isFile() || info.size > MAX_PREIMAGE_BYTES) return undefined;
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
      pending.set(event.toolCallId, { path, before: await readFile(path, "utf8") });
    } catch (err) {
      warn(`pre-image read failed: ${describeError(err)}`);
    }
    return undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (event.toolName !== "write") return undefined;
    const captured = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    try {
      // A failed write left the file alone: there is no change to show.
      if (!captured || event.isError) return undefined;
      const after = (event.input as { content?: unknown }).content;
      if (typeof after !== "string") return undefined;
      const card = buildWriteDiff(captured.path, captured.before, after);
      if (card) pi.appendEntry(DIFF_ENTRY, card);
    } catch (err) {
      warn(`diff card failed: ${describeError(err)}`);
    }
    return undefined;
  });
}

/** `write` accepts a relative path and resolves it against the session cwd, so this must too. */
function absolute(path: string, ctx: ExtensionContext): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

function warn(message: string): void {
  process.stderr.write(`[pi-config] write-diff: ${message}\n`);
}

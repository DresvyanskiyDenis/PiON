/**
 * EXT-29 — tool-result externalisation (REQ-CTX-38).
 *
 * PI already truncates built-in tool output at 2000 lines / 50 KB and, for `bash`, points
 * `BashToolDetails.fullOutputPath` at the overflow file it wrote. This module is the HYBRID
 * half the spec calls for: handlers that (a) extend the same 50 KB boundary to every tool result
 * — custom tools, MCP tool results, sub-agent returns — that PI's own truncation does not cover,
 * and (b) hand back a *re-expand handle* instead of a one-shot head/tail summary, so the full
 * text can be read back later without re-running the tool.
 *
 * This is deliberately NOT what `pi-lean-ctx` does (VP-11):
 * shrinking is lossy and irreversible, a handle is neither.
 *
 * WHAT THE BOUNDARY COVERS — TWO CHANNELS, NOT ONE.
 *
 * `tool_result` is not the whole of what reaches a provider request, so it is not the whole of
 * what this module watches. `buildSessionContext()` turns exactly four entry kinds into wire
 * messages (`dist/core/session-manager.js:166` `sessionEntryToContextMessages`): `message`,
 * `custom_message`, `branch_summary` and `compaction`. Of those, the only one an extension can
 * fill with unbounded third-party text is `custom_message` — what `pi.sendMessage()` writes.
 * `convertToLlm` renders it as a plain user message carrying the whole `content` and dropping
 * `details` (`dist/core/messages.js:89`, `case "custom"`), so an oversized one is re-sent on
 * every subsequent request of the session, unbounded. The adopted `pi-web-access` (0.18.0, the
 * package behind `extensions/web.ts`) uses exactly that channel for its search-curator follow-up
 * (`index.ts:2882`, `customType: "web-search-results"`), which is how a
 * single large fetch turns into a permanent per-request cost. That channel never passes through
 * `tool_result`; it is covered by the `context` handler below, which spills through the same
 * `spill()` the tool path uses.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, AND WHY THAT IS NOT A GAP. The `{"type":"custom"}` session
 * entries that `pi.appendEntry()` writes — which the same package uses to stash whole fetched
 * pages — are not context: `sessionEntryToContextMessages` falls through to `[]` for them
 * (`dist/core/session-manager.d.ts`: "Does NOT participate in LLM context"). Verified against the
 * pinned 0.84.0 by running that function on a 336 KB entry of that shape: 0 messages out, against
 * 1 message and 344 KB through `convertToLlm` for the `custom_message` of the same size. Those
 * entries cost session-file bytes and no tokens, and no extension hook can bound them anyway —
 * they are written by a third-party package calling `pi.appendEntry` directly, with no event in
 * between. This module bounds what the model is charged for; the on-disk transcript stays
 * complete on purpose, so a package's own "read that fetch back by id" tool still works.
 *
 * Auto-discovered as a standalone extension via the `~/.pi/agent/extensions/<dir>/index.ts`
 * subdirectory pattern (PI's own extension docs, "Extension Locations") — it does not go through wave1's single
 * composed `extensions/index.ts`, so `settings.json`'s `"extensions"` array needs no entry.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ContextEvent, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, isBashToolResult, truncateTail } from "@earendil-works/pi-coding-agent";
import { CARD_ENTRY, PREVIEW_LINES, registerCardRenderer, type ExternalisedCard } from "./card.ts";
import { renderExpandResult } from "./expand-render.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { scratchDir } from "../lib/paths.ts";

export const id = "big-results";

/** Match the built-in boundary, do not invent a new one. */
const THRESHOLD_BYTES = DEFAULT_MAX_BYTES; // 50 KB
const HEAD_LINES = 40;
const TAIL_LINES = 40;
const TAIL_MAX_BYTES = 8192;

/**
 * Per-handle sidecar. Needed because the externalised file is not always ours: a bash result
 * reuses PI's own `fullOutputPath`, which lives outside `results/` and is not named after the
 * handle. Without this, `expand_result` would have no way to find that file back — the spec's
 * own pseudocode hardcodes `results/<handle>.txt` on the read side and would silently 404 on
 * every reused-bash-overflow case.
 */
interface ExternalisedMeta {
  readonly path: string;
  readonly lines: number;
  readonly totalBytes: number;
  /** The tool that produced it, or `custom:<customType>` when it came off the `context` channel. */
  readonly toolName: string;
  /** Absent on the `context` channel: a custom message is not the result of a tool call. */
  readonly toolCallId?: string;
  readonly reusedExisting: boolean;
  readonly createdAt: string;
}

/** One wire message of a single provider call, as `context` hands them over. */
type ContextMessage = ContextEvent["messages"][number];

function resultsDir(sessionId: string): string {
  return join(scratchDir(sessionId), "results");
}

function metaPath(sessionId: string, handle: string): string {
  return join(resultsDir(sessionId), `${handle}.json`);
}

function ownPath(sessionId: string, handle: string): string {
  return join(resultsDir(sessionId), `${handle}.txt`);
}

export function register(pi: ExtensionAPI): void {
  registerCardRenderer(pi);
  pi.on("tool_result", async (event, ctx) => externaliseIfOversized(event, ctx, pi));
  // The second channel (see the header). No `ContextEventResult` return-type annotation: like
  // `ToolResultEventResult`, that type is not on this package's public surface at 0.84.0 (only
  // `ContextEvent` is), so the handler is checked structurally at this call site — the same
  // reason `path-rules/index.ts` gives for its own `context` handler.
  pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) =>
    externaliseOversizedMessages(event, ctx, pi),
  );

  pi.registerTool({
    name: "expand_result",
    label: "Expand externalised result",
    description: "Read back part of a tool result that was externalised to disk, by handle.",
    promptSnippet: "Read back part of an externalised tool result",
    promptGuidelines: [
      "Use expand_result with the handle from an externalised result instead of re-running the original tool.",
    ],
    parameters: Type.Object({
      handle: Type.String(),
      grep: Type.Optional(Type.String({ description: "regex; returns matching lines with 2 lines of context" })),
      fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, default: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const meta = await readMeta(sessionId, params.handle);
      const body = await readFile(meta.path, "utf8").catch((err: unknown) => {
        // The handle is known but its file is gone (scratch cleaned up, disk issue, …).
        // Signalling errors from a tool means throwing (PI's own extension docs, "Signaling errors")
        // — `execute()`'s return type carries no `isError` field to set instead.
        throw new Error(
          `externalised result "${params.handle}" is recorded but its file is unreadable: ${describeError(err)}`,
          { cause: err },
        );
      });

      const all = body.split("\n");
      let out: string[];
      if (params.grep) {
        const re = new RegExp(params.grep);
        out = all.flatMap((l, i) => (re.test(l) ? all.slice(Math.max(0, i - 2), i + 3) : []));
      } else {
        const from = (params.fromLine ?? 1) - 1;
        out = all.slice(from, from + (params.lines ?? 200));
      }

      const t = truncateTail(out.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      return {
        content: [{ type: "text" as const, text: t.content || "(no matching lines)" }],
        details: { handle: params.handle, matched: out.length, sourcePath: meta.path },
      };
    },
    // Without this, a call falls into PI's generic tool-result fallback (first 10 raw lines,
    // collapsed) instead of the header + informative-line summary this renders.
    renderResult: renderExpandResult,
  });
}

/**
 * Returns a patch shaped like `ToolResultEventResult` — that type is not re-exported from this
 * package's public entry point at 0.84.0 (present in `core/extensions/index.ts`, dropped from
 * `dist/index.d.ts`'s re-export list), so the annotation is left to structural inference via the
 * `pi.on("tool_result", ...)` call site below rather than importing a name that does not exist
 * at the package boundary.
 */
async function externaliseIfOversized(event: ToolResultEvent, ctx: ExtensionContext, pi: ExtensionAPI) {
  try {
    // A result can carry images alongside text. Collapsing the whole `content` array into a
    // text-only head/tail summary would silently drop them from what the model sees — the
    // exact silent-corruption failure mode REQ-EXT-16 forbids. A mixed result is left alone;
    // text-only oversized results (bash, grep, read, MCP tool text, sub-agent returns) are the
    // case this item targets.
    if (event.content.some((c) => c.type !== "text")) return undefined;

    const text = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const totalBytes = Buffer.byteLength(text, "utf8");
    if (totalBytes <= THRESHOLD_BYTES) return undefined;

    const sessionId = ctx.sessionManager.getSessionId();
    const handle = createHash("sha256")
      .update(`${event.toolCallId}:${totalBytes}:${text.length}`)
      .digest("hex")
      .slice(0, 12);

    const spilled = await spill(
      {
        text,
        sessionId,
        handle,
        source: event.toolName,
        toolCallId: event.toolCallId,
        // PI already wrote the overflow file for bash — reuse it rather than duplicating the bytes.
        existingPath: isBashToolResult(event) ? event.details?.fullOutputPath : undefined,
      },
      pi,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: summarise(
            spilled,
            `Re-expand a slice with expand_result(handle="${handle}", grep="…") — do NOT re-run the tool.`,
          ),
        },
      ],
      details: {
        ...asDetailsObject(event.details),
        externalised: { handle, path: spilled.path, lines: spilled.lines.length },
      },
    };
  } catch (err) {
    // Fail open (REQ-EXT-16's spirit, applied to a non-gate module): a bug in the externaliser
    // must not corrupt or drop the tool's real result. Returning `undefined` leaves PI's own
    // (possibly oversized) content exactly as it was; the error is still surfaced, once.
    surfaceOnce(ctx, `big-results:externalise:${describeError(err).slice(0, 120)}`, () => {
      emitNotice(
        ctx,
        `[pi-config] big-results: externalisation failed internally and was skipped: ${describeError(err)}`,
        "error",
      );
    });
    return undefined;
  }
}

/**
 * The `context` channel: bound an oversized `custom_message` the same way an oversized tool
 * result is bounded.
 *
 * `context` fires immediately before every provider request with that call's wire message list
 * (`dist/core/sdk.js` `transformContext` → `runner.emitContext`, which clones and chains handlers,
 * each seeing the previous one's result). Patching HERE rather than at the message's source is
 * deliberate on three counts:
 *
 *   - It is the only boundary this harness owns. `pi.sendMessage()` is called inside the
 *     third-party package; nothing fires between that call and the entry landing in the session.
 *   - The session file keeps the full text. The wire copy is the only thing shrunk, so the
 *     transcript stays a complete record and a `/reload` re-derives the same patch.
 *   - It is prompt-cache safe. The handle is content-addressed, the patch is a pure function of
 *     the message, and `contextPatches` memoises it — so firing N times over one session produces
 *     byte-identical messages and the provider's cached prefix survives. A patch that varied per
 *     call (a timestamp, a counter) would invalidate the whole conversation behind it once per
 *     request, which is the exact cost this module exists to avoid.
 *
 * Only `role: "custom"` messages are touched. User and assistant turns are the conversation
 * itself, tool results already have their own channel above, and summaries are bounded by the
 * compactor that wrote them.
 */
async function externaliseOversizedMessages(event: ContextEvent, ctx: ExtensionContext, pi: ExtensionAPI) {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const messages: ContextMessage[] = [];
    let patchedAny = false;
    for (const message of event.messages) {
      const patched = await patchOversizedCustomMessage(message, sessionId, pi);
      messages.push(patched ?? message);
      patchedAny ||= patched !== undefined;
    }
    // No patch → no return value, so the chain keeps the array it already had rather than a copy.
    return patchedAny ? { messages } : undefined;
  } catch (err) {
    // Fail open, exactly as the tool_result path does: an unpatched oversized message is
    // expensive, a dropped or corrupted one is wrong.
    surfaceOnce(ctx, `big-results:context:${describeError(err).slice(0, 120)}`, () => {
      emitNotice(
        ctx,
        `[pi-config] big-results: context externalisation failed internally and was skipped: ${describeError(err)}`,
        "error",
      );
    });
    return undefined;
  }
}

/**
 * Patches already computed this process, keyed `<sessionId>:<handle>`. `context` fires once per
 * provider request while the message it patches lives in the session forever, so without this a
 * single 336 KB fetch would be re-split and re-written to disk on every request of that session.
 * Bounded by the number of DISTINCT oversized custom messages a process sees, not by its length.
 */
const contextPatches = new Map<string, string>();

/** One message's worth of the above. Returns `undefined` when the message is to be left alone. */
async function patchOversizedCustomMessage(
  message: ContextMessage,
  sessionId: string,
  pi: ExtensionAPI,
): Promise<ContextMessage | undefined> {
  if (message.role !== "custom") return undefined;
  // Same rule as the tool path: a message carrying an image is left whole rather than flattened
  // into text that silently loses it.
  const text = textOnlyContent(message.content);
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, "utf8") <= THRESHOLD_BYTES) return undefined;

  // Content-addressed, unlike the tool path's `toolCallId` seed: a custom message has no call id,
  // and the same text must yield the same handle on every firing for the patch to be stable.
  const handle = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const key = `${sessionId}:${handle}`;
  const cached = contextPatches.get(key);
  if (cached !== undefined) return { ...message, content: cached };

  const spilled = await spill({ text, sessionId, handle, source: `custom:${message.customType}` }, pi);
  const patch = summarise(
    spilled,
    `Read a slice back with expand_result(handle="${handle}", grep="…") — the full text is on ` +
      `disk, do NOT re-fetch it.`,
  );
  contextPatches.set(key, patch);
  return { ...message, content: patch };
}

/** The message text, or `undefined` if the content carries anything that is not text. */
function textOnlyContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((part) => (part as { type?: unknown }).type !== "text")) return undefined;
  return content.map((part) => String((part as { text?: unknown }).text ?? "")).join("\n");
}

interface SpillArgs {
  readonly text: string;
  readonly sessionId: string;
  readonly handle: string;
  /** Recorded as `toolName` in the sidecar and shown on the card: the tool, or `custom:<type>`. */
  readonly source: string;
  readonly toolCallId?: string;
  /** A copy already on disk (PI's bash overflow file) to point at instead of writing our own. */
  readonly existingPath?: string;
}

interface Spilled {
  readonly handle: string;
  readonly path: string;
  readonly lines: readonly string[];
  readonly totalBytes: number;
}

/**
 * The one place that externalises. Both channels are adapters around it, so a body spilled from a
 * custom message is indistinguishable from one spilled from a tool result: same `results/` layout,
 * same sidecar, same card, same `expand_result` handle. The axis of variation is the source of the
 * text, which is a parameter here rather than a second module (`AGENTS.md`, extend not sprawl).
 */
async function spill(args: SpillArgs, pi: ExtensionAPI): Promise<Spilled> {
  await mkdir(resultsDir(args.sessionId), { recursive: true, mode: 0o700 });

  const path = args.existingPath ?? ownPath(args.sessionId, args.handle);
  if (args.existingPath === undefined) await writeFile(path, args.text, "utf8");

  const lines = args.text.split("\n");
  const totalBytes = Buffer.byteLength(args.text, "utf8");
  const meta: ExternalisedMeta = {
    path,
    lines: lines.length,
    totalBytes,
    toolName: args.source,
    toolCallId: args.toolCallId,
    reusedExisting: args.existingPath !== undefined,
    createdAt: new Date().toISOString(),
  };
  await writeFile(metaPath(args.sessionId, args.handle), JSON.stringify(meta), "utf8");

  // The same externalisation, said once more for the human watching the transcript. Display
  // only — see `card.ts` for why this goes through an entry rather than a second message.
  const card: ExternalisedCard = {
    handle: args.handle,
    toolName: args.source,
    path,
    lines: lines.length,
    totalBytes,
    preview: lines.slice(0, PREVIEW_LINES),
  };
  pi.appendEntry(CARD_ENTRY, card);

  return { handle: args.handle, path, lines, totalBytes };
}

/** Head, tail, size, handle, path — what replaces the body on whichever channel carried it. */
function summarise(spilled: Spilled, readBack: string): string {
  const head = spilled.lines.slice(0, HEAD_LINES).join("\n");
  const tail = truncateTail(spilled.lines.slice(-TAIL_LINES).join("\n"), {
    maxLines: TAIL_LINES,
    maxBytes: TAIL_MAX_BYTES,
  }).content;
  return (
    `${head}\n\n… [${spilled.lines.length} lines, ${formatSize(spilled.totalBytes)} externalised; ` +
    `handle "${spilled.handle}"] …\n\n${tail}\n\n` +
    `Full output: ${spilled.path}\n${readBack}`
  );
}

function asDetailsObject(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
}

async function readMeta(sessionId: string, handle: string): Promise<ExternalisedMeta> {
  const raw = await readFile(metaPath(sessionId, handle), "utf8").catch(() => undefined);
  if (raw === undefined) {
    throw new Error(`no externalised result "${handle}" in this session`);
  }
  return JSON.parse(raw) as ExternalisedMeta;
}

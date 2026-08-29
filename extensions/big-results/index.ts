/**
 * EXT-29 — tool-result externalisation (REQ-CTX-38).
 *
 * PI already truncates built-in tool output at 2000 lines / 50 KB and, for `bash`, points
 * `BashToolDetails.fullOutputPath` at the overflow file it wrote. This module is the HYBRID
 * half the spec calls for: a `tool_result` handler that (a) extends the same 50 KB boundary to
 * every tool result — custom tools, MCP tool results, sub-agent returns — that PI's own
 * truncation does not cover, and (b) hands back a *re-expand handle* instead of a one-shot
 * head/tail summary, so the full text can be read back later without re-running the tool.
 *
 * This is deliberately NOT what `pi-lean-ctx` does (VP-11):
 * shrinking is lossy and irreversible, a handle is neither.
 *
 * Auto-discovered as a standalone extension via the `~/.pi/agent/extensions/<dir>/index.ts`
 * subdirectory pattern (PI's own extension docs, "Extension Locations") — it does not go through wave1's single
 * composed `extensions/index.ts`, so `settings.json`'s `"extensions"` array needs no entry.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, isBashToolResult, truncateTail } from "@earendil-works/pi-coding-agent";
import { CARD_ENTRY, PREVIEW_LINES, registerCardRenderer, type ExternalisedCard } from "./card.ts";
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
  readonly toolName: string;
  readonly toolCallId: string;
  readonly reusedExisting: boolean;
  readonly createdAt: string;
}

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
    const dir = resultsDir(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const handle = createHash("sha256")
      .update(`${event.toolCallId}:${totalBytes}:${text.length}`)
      .digest("hex")
      .slice(0, 12);

    // PI already wrote the overflow file for bash — reuse it rather than duplicating the bytes.
    const existing = isBashToolResult(event) ? event.details?.fullOutputPath : undefined;
    const path = existing ?? ownPath(sessionId, handle);
    if (existing === undefined) await writeFile(path, text, "utf8");

    const lines = text.split("\n");
    const meta: ExternalisedMeta = {
      path,
      lines: lines.length,
      totalBytes,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      reusedExisting: existing !== undefined,
      createdAt: new Date().toISOString(),
    };
    await writeFile(metaPath(sessionId, handle), JSON.stringify(meta), "utf8");

    // The same externalisation, said once more for the human watching the transcript. Display
    // only — see `card.ts` for why this goes through an entry rather than a second message.
    const card: ExternalisedCard = {
      handle,
      toolName: event.toolName,
      path,
      lines: lines.length,
      totalBytes,
      preview: lines.slice(0, PREVIEW_LINES),
    };
    pi.appendEntry(CARD_ENTRY, card);

    const head = lines.slice(0, HEAD_LINES).join("\n");
    const tail = truncateTail(lines.slice(-TAIL_LINES).join("\n"), {
      maxLines: TAIL_LINES,
      maxBytes: TAIL_MAX_BYTES,
    }).content;

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${head}\n\n… [${lines.length} lines, ${formatSize(totalBytes)} externalised; ` +
            `handle "${handle}"] …\n\n${tail}\n\n` +
            `Full output: ${path}\n` +
            `Re-expand a slice with expand_result(handle="${handle}", grep="…") — do NOT re-run the tool.`,
        },
      ],
      details: { ...asDetailsObject(event.details), externalised: { handle, path, lines: lines.length } },
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

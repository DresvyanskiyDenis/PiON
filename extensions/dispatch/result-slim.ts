/**
 * `EXT-05` — keeping a detached child's message transcript out of the session record.
 *
 * ## The claim that started this, and the half of it that is false
 *
 * The report was that a finished sub-agent's whole transcript is read back into the orchestrator's
 * context, so every dispatch pays for the child's turns a second time. The context half of that was
 * checked against the pinned packages rather than assumed, and it is not true:
 *
 * - a tool result reaches the model as a `ToolResultMessage`, whose `details` field PI's own session
 *   format documents as **"not sent to LLM"** (`@earendil-works/pi-coding-agent` 0.84.0,
 *   `docs/session-format.md:98` and `:284`);
 * - the provider layer bears that out. `convertToolResult` serialises `toolCallId`, `content` and
 *   `isError` and reads nothing else (`@earendil-works/pi-ai` 0.84.0,
 *   `dist/api/anthropic-messages.js:825-830`), and a search for `.details` across that package's
 *   `dist/` matches one unrelated OAuth page and nothing on any request path.
 *
 * Nor does `content` carry a transcript: a completed single run returns the child's final output,
 * and a detached one returns a one-paragraph recovery instruction naming the run id
 * (`pi-subagents` 0.57.0, `src/runs/foreground/subagent-executor.ts:3876-3895` and `:3903-3906`).
 *
 * So this module saves no provider tokens, and does not claim to.
 *
 * ## What is true, and is the whole reason this exists
 *
 * `details` **is** written verbatim into the session JSONL, and this harness feeds that file to a
 * model BY BYTE COUNT: [`digest`](../../docs/extensions/digest.md) spools a job and
 * `bin/pi-digest-drain` summarises `readFile(sessionFile).slice(-maxTranscriptBytes)`. A child's
 * message array landing in that file therefore costs real tokens in the digest AND pushes an equal
 * number of bytes of real conversation out of the window the summariser is shown. The second is the
 * damage worth fixing, because it is silent: the digest is not wrong-looking, it is merely missing
 * the end of the session, and nothing says so.
 *
 * The package already prevents this for the ordinary case. `runSinglePath` builds its `Details`
 * through `compactForegroundDetails`, which sets `messages: undefined` on each child
 * (`pi-subagents` 0.57.0, `src/shared/utils.ts:435-445`, applied at `subagent-executor.ts:3837`).
 * But `compactForegroundResult` returns the result **untouched** when `progress?.status ===
 * "running"` (`utils.ts:436`) — and a child that was detached or interrupted is precisely a child
 * still running when its result is handed back, at `subagent-executor.ts:3876-3895`. Those runs, and
 * only those, carry the live `messages` array into the session file, unbounded by anything.
 *
 * This closes that gap and nothing wider.
 *
 * ## The rule, and the one case it refuses
 *
 * `messages` is dropped from a child **only while that child still says where its full record
 * lives** — `transcriptPath` (`pi-subagents` 0.57.0, `src/shared/types.ts:1066`, set at
 * `src/runs/foreground/execution.ts:2082` when a transcript writer is configured) or `sessionFile`
 * (`types.ts:1037`). When neither survives, the array in hand is the only copy of what the child
 * did, and a run that died without writing a transcript is exactly the run somebody will need it
 * for. Deleting it there would trade a token bill for lost evidence, so it is kept and the caller is
 * told there is nothing to patch — the same "no classification, no change" stance
 * [`failure-slot.ts`](./failure-slot.ts) takes when a tail carries no classified abort.
 *
 * Nothing else is touched. `progress` stays: it is a bounded snapshot rather than the transcript,
 * and the package keeps it for a running child deliberately. `transcriptPath`, `sessionFile`,
 * `finalOutput`, `error`, `toolCalls`, `asyncId` and `asyncDir` all ride through unchanged —
 * `async-fleet.ts` reads the last two off this very object.
 *
 * Pure data in, pure data out, no PI runtime imports, so `test/dispatch/result-slim.test.ts` drives
 * it directly.
 */

/** The one field removed. Exported so a test can assert the list has not quietly grown. */
export const TRANSCRIPT_FIELD = "messages" as const;

/** Fields that keep a child's full record findable once `messages` is gone. Either one suffices. */
export const TRANSCRIPT_POINTERS = ["transcriptPath", "sessionFile"] as const;

/** The plain-object view of an unknown value, or `undefined` for anything else (arrays included). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function namesItsTranscript(child: Record<string, unknown>): boolean {
  return TRANSCRIPT_POINTERS.some((key) => {
    const pointer = child[key];
    return typeof pointer === "string" && pointer.trim() !== "";
  });
}

/** True when this child carries a message array droppable without losing the only copy of it. */
export function carriesDroppableTranscript(value: unknown): boolean {
  const child = asRecord(value);
  if (child === undefined) return false;
  return Array.isArray(child[TRANSCRIPT_FIELD]) && namesItsTranscript(child);
}

/**
 * A copy of `details` with every droppable child transcript removed, or `undefined` when there was
 * nothing to drop — no `results` array, no `messages` on any child, or messages on a child that no
 * longer says where else to read them. The caller then returns no `details` patch at all, so a
 * result the package already compacted passes on as itself rather than as a field-for-field restate.
 *
 * The input is never mutated: a `details` object PI may still hold a reference to is not ours to
 * edit in place.
 */
export function slimDispatchDetails(details: unknown): Record<string, unknown> | undefined {
  const source = asRecord(details);
  if (source === undefined) return undefined;
  const results = source.results;
  if (!Array.isArray(results)) return undefined;
  if (!results.some(carriesDroppableTranscript)) return undefined;

  return {
    ...source,
    results: results.map((entry) => {
      if (!carriesDroppableTranscript(entry)) return entry;
      const { [TRANSCRIPT_FIELD]: _transcript, ...kept } = entry as Record<string, unknown>;
      return kept;
    }),
  };
}

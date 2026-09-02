/**
 * EXT-11 — the `"compact"` control kind: a peer asking this session to run its own `/compact`
 * instead of waking a turn to relay the request.
 *
 * Registered against `EXT-32`'s control lane (`../message-agent/control.ts`), not called directly —
 * `message-agent/index.ts`'s `dispatchControl()` is the only caller, and it already owns retry
 * (`"deferred"` -> back to the inbox) and the terminal cases (`"ok"`/`"refused"` -> cleared). This
 * module only decides which of those three the request deserves and, on `"ok"`, starts the compact.
 *
 * Two guards, two different reasons a request does not run immediately:
 *
 * - **Mid-run.** `ctx.compact()` is PI's own trigger for the same machinery `session_before_compact`
 *   guards — running it while a turn is in flight races the turn's own context accounting. This is
 *   transient: the turn will end on its own, so the request is deferred, not refused, and the next
 *   drain (this session's own idle-triggered one, not a busy-loop) retries it for free.
 * - **Rate limit.** `peerCompact.minIntervalMs` (`config/compaction.json`) protects the session's own
 *   progress from being interrupted repeatedly by more than one peer — or the same peer twice — in
 *   quick succession. Unlike the mid-run guard, waiting does not make this pass on its own within a
 *   drain cycle that matters, so it is refused with the remaining wait stated, and it is on the
 *   sender to decide whether to ask again later.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeError } from "../lib/once.ts";
import { agentsRoot, deliver } from "../message-agent/directory.ts";
import type { ControlContext, ControlEnvelope, ControlHandler, ControlHandlerResult } from "../message-agent/control.ts";
import { logEvent } from "../session-index/index.ts";
import { formatShortCount } from "./gauge.ts";

/** Wall-clock timestamp of the last peer-triggered compact this session actually ran, by session id. */
const lastPeerCompactAt = new Map<string, number>();

/** Envelope ids already reported as deferred, so a redelivered envelope does not re-announce. */
const notifiedDeferred = new Set<string>();

async function replyToSender(
  control: ControlContext,
  sender: string,
  message: string,
): Promise<void> {
  try {
    await deliver({
      root: agentsRoot(),
      target: sender,
      from: control.selfName,
      fromSessionId: control.selfSessionId,
      message,
    });
  } catch {
    // The sender may have exited between asking and this reply — nothing to recover into, and
    // nobody left to tell.
  }
}

/**
 * `minIntervalMs` is threaded in rather than read from config here, so this module stays free of
 * `./index.ts`'s config loading — `createPeerCompactHandler(cfg.peerCompact.minIntervalMs)` is the
 * one call site, in `register()`.
 */
export function createPeerCompactHandler(minIntervalMs: number): ControlHandler {
  return async (
    envelope: ControlEnvelope,
    ctx: ExtensionContext,
    control: ControlContext,
  ): Promise<ControlHandlerResult> => {
    const sessionId = control.selfSessionId;

    if (!ctx.isIdle()) {
      if (!notifiedDeferred.has(envelope.id)) {
        notifiedDeferred.add(envelope.id);
        logEvent(sessionId, "compaction", "peer_compact.deferred", true, undefined, {
          id: envelope.id,
          from: envelope.from,
        });
      }
      return { outcome: "deferred", detail: "session is mid-turn" };
    }

    const last = lastPeerCompactAt.get(sessionId);
    const now = Date.now();
    if (last !== undefined && now - last < minIntervalMs) {
      const waitMs = minIntervalMs - (now - last);
      await replyToSender(
        control,
        envelope.from,
        `refused: this session compacted for a peer ${Math.round((now - last) / 1000)}s ago; ` +
          `try again in ${Math.round(waitMs / 1000)}s.`,
      );
      logEvent(sessionId, "compaction", "peer_compact.refused", false, undefined, {
        id: envelope.id,
        from: envelope.from,
        waitMs,
      });
      return { outcome: "refused", detail: "rate limited" };
    }

    lastPeerCompactAt.set(sessionId, now);
    notifiedDeferred.delete(envelope.id);
    try {
      ctx.compact({
        customInstructions: envelope.instructions,
        onComplete: (result) => {
          const reclaimed = Math.max(0, result.tokensBefore - (result.estimatedTokensAfter ?? result.tokensBefore));
          logEvent(sessionId, "compaction", "peer_compact.completed", true, undefined, {
            from: envelope.from,
            reclaimed,
          });
          void replyToSender(
            control,
            envelope.from,
            `ok: compacted at your request, reclaiming ~${formatShortCount(reclaimed)} tokens.`,
          );
        },
        onError: (err) => {
          logEvent(sessionId, "compaction", "peer_compact.failed", false, undefined, {
            from: envelope.from,
            error: describeError(err),
          });
          void replyToSender(control, envelope.from, `refused: compact failed internally: ${describeError(err)}`);
        },
      });
    } catch (err) {
      // `compact()` itself threw rather than calling `onError` — same reply, same accounting, so a
      // synchronous failure and an asynchronous one look identical to the sender.
      logEvent(sessionId, "compaction", "peer_compact.failed", false, undefined, {
        from: envelope.from,
        error: describeError(err),
      });
      await replyToSender(control, envelope.from, `refused: compact failed internally: ${describeError(err)}`);
      return { outcome: "refused", detail: "compact threw" };
    }

    return { outcome: "ok" };
  };
}

/** Run at `session_shutdown`: the session's own rate-limit state is meaningless once it is gone. */
export function resetPeerCompactStateForSession(sessionId: string): void {
  lastPeerCompactAt.delete(sessionId);
}

export function __resetPeerCompactStateForTests(): void {
  lastPeerCompactAt.clear();
  notifiedDeferred.clear();
}

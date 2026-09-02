/**
 * REQ-CTX-35 — the context watchdog's pure decision function.
 *
 * `bin/pi-compact-watchdog` (a cron-friendly plain script, not an extension) is the only caller: it
 * reads the live signals this file's types describe out of the session index and calls
 * `shouldTriggerCompact` once per candidate session. Kept dependency-free and side-effect-free on
 * purpose — the script owns reading the database and writing a control envelope; this file owns only
 * the one decision neither of those should have to re-derive: is *this* session, *right now*, one
 * this watchdog should nudge.
 *
 * `DEFAULT_WATCHDOG_THRESHOLD` reuses `./gauge.ts`'s `GAUGE_AMBER_THRESHOLD` rather than restating
 * `80` — both modules are already pure and dependency-free, so importing costs nothing and the
 * watchdog's default and the gauge's own amber line cannot drift apart by accident.
 */
import { GAUGE_AMBER_THRESHOLD } from "./gauge.ts";

/** The live-context signal a session's most recent `"context"`/`"usage"` event carries. */
export interface WatchdogSignal {
  readonly sessionId: string;
  /** Event timestamp, epoch ms. */
  readonly at: number;
  readonly percent: number | null;
  /** Epoch ms of this session's most recent `"compaction"`/`"compacted"` event, if any. */
  readonly lastCompactedAt: number | null;
}

/** `GAUGE_AMBER_THRESHOLD` — the same line the ctx gauge turns amber at (`./gauge.ts`). */
export const DEFAULT_WATCHDOG_THRESHOLD = GAUGE_AMBER_THRESHOLD;

/**
 * How stale a `"context"`/`"usage"` event may be and still count as "this session is live right
 * now". A cron-triggered watchdog has no persistent state between runs, so it cannot track "have I
 * already asked this session" the way `EXT-11`'s own `peerCompact.minIntervalMs` tracks it
 * session-side — a second nudge before the first lands just gets `"refused"` by that rate limit, not
 * acted on twice. What this bound is actually for is REQ-PRV-91's "silent when idle": a session whose
 * last usage sample is older than this has gone idle or exited, and idle is not a session to nudge.
 */
export const DEFAULT_WATCHDOG_COOLDOWN_MS = 5 * 60_000;

/** Overrides `DEFAULT_WATCHDOG_THRESHOLD`, read by `bin/pi-compact-watchdog`. */
export const WATCHDOG_THRESHOLD_ENV = "PI_COMPACT_WATCHDOG_THRESHOLD";

/**
 * `--threshold <n>` on argv wins over `PI_COMPACT_WATCHDOG_THRESHOLD`, which wins over
 * `DEFAULT_WATCHDOG_THRESHOLD` — same precedence `pollIntervalMs` (`../message-agent/index.ts`)
 * uses for its own env override, flag added on top since this is a CLI script rather than a
 * session-scoped extension. Malformed input throws rather than silently falling back, for the same
 * reason: a typo that reads as "use the default" is an operator who believes they raised the bar
 * and did not.
 */
export function readThreshold(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const flagIndex = argv.indexOf("--threshold");
  const raw = flagIndex !== -1 ? argv[flagIndex + 1] : env[WATCHDOG_THRESHOLD_ENV];
  if (raw === undefined) return DEFAULT_WATCHDOG_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`threshold ${JSON.stringify(raw)} is not a number between 0 and 100`);
  }
  return parsed;
}

/**
 * `true` exactly when this signal is over threshold, live (not the watchdog's own scan looking at
 * ancient history), and not already covered by a compact this session ran, or was just asked to run,
 * recently enough that asking again would be noise rather than help.
 *
 * `percent === null` (no model selected yet, or usage genuinely unknown) is never a trigger — REQ-
 * PRV-91 forbids guessing at a session's content, and an unknown percentage is not evidence of
 * anything, amber or otherwise.
 */
export function shouldTriggerCompact(
  signal: WatchdogSignal,
  now: number,
  threshold: number = DEFAULT_WATCHDOG_THRESHOLD,
  cooldownMs: number = DEFAULT_WATCHDOG_COOLDOWN_MS,
): boolean {
  if (signal.percent === null || signal.percent < threshold) return false;
  if (signal.lastCompactedAt !== null && signal.lastCompactedAt >= signal.at) {
    // A compact already landed after this usage sample was taken — the sample is stale evidence of
    // a problem that no longer exists.
    return false;
  }
  if (now - signal.at > cooldownMs) {
    // The signal itself is old enough that a live session would have produced a fresher one; a gap
    // this size means the session went idle or exited, and REQ-PRV-91's "silent when idle" is what
    // the caller enforces by not calling this at all for a session with no recent signal. Treated as
    // "nothing to trigger" here too, defensively.
    return false;
  }
  return true;
}

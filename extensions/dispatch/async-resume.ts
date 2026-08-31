/**
 * `subagents.watchdog.asyncCompletion`, given a consumer.
 *
 * The block has been in `config/settings.default.json` since it was written, and it bought
 * nothing. The pinned `pi-subagents` parses `asyncCompletion` in `watchdog/settings.ts`, types it
 * in `watchdog/types.ts`, and reads it in no runtime — `test/dispatch/watchdog-settings.test.ts`
 * pins that two-file list and still does, because nothing here changes what upstream does. So an
 * async child that came back with no output at all ended the way it began: a terminal
 * `status.json`, one announcement, and a manual full-price re-dispatch by whoever read it.
 *
 * This module is the missing half, on our side of the boundary. When a tracked async run reaches a
 * terminal state carrying the runner's own empty-completion error, exactly ONE automatic `resume`
 * goes out over the package's in-process RPC, carrying a message that tells the child to produce
 * its result rather than to try again in the abstract.
 *
 * ## Why the budget is one, and why it is on disk
 *
 * The failure being recovered from is "the child said nothing". A resume that also says nothing is
 * the same failure, and a consumer that answers it the same way is a loop that spends a model call
 * per iteration for as long as the session lives. So every run gets one attempt, and the attempt is
 * recorded in `~/.local/state/pi-config/dispatch/async-resume.jsonl` **before** the request is
 * emitted: a crash between the write and the send costs one lost follow-up, a crash between the
 * send and a write would cost an unbounded number of them. When the ledger cannot be written the
 * request is not sent at all — an unrecordable attempt is indistinguishable from an infinite one.
 *
 * The run a successful resume starts is stamped as spent too, before it is adopted into the fleet.
 * It is a normal tracked run from that moment — its ending is announced by the same sweep as any
 * other — but it can never earn its own follow-up, which is what stops a chain of empty children
 * from walking the budget forward one run at a time.
 *
 * ## What gates it
 *
 * `subagents.watchdog.enabled` AND `subagents.watchdog.asyncCompletion.enabled`, both read from the
 * agent settings file the package itself reads (`getAgentDir()/settings.json`), both required to be
 * literally `true`. The AND is not invention: it is how the package composes its own endpoint flags
 * (`watchdog/child-status.ts` ANDs `children.enabled` with the top-level one), and both flags ship
 * OFF upstream, so anything looser would turn this on for a tree that never asked.
 *
 * `asyncCompletion.autoFollowBlockers` is read and reported, and deliberately does **not** gate
 * anything here. A *blocked* child — one that came back with a question or a stated obstacle — is a
 * different recovery with a different message and a different budget, and that is the watchdog's
 * follow-up cycle, not this one. Reading the flag without honouring it would be worse than not
 * reading it, so the resolved value is carried on the gate and named in `/agents`-facing text
 * rather than quietly dropped.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { configDir, stateRoot } from "../lib/paths.ts";
import { shortId, trackedAsyncRuns, type AsyncRunReport, type AsyncRunVerdict } from "./async-fleet.ts";

/**
 * The three RPC strings this module needs, copied rather than imported.
 *
 * `pi-subagents` exports its RPC constants from `src/extension/rpc.ts`, which is not in the
 * package's `exports` map (`./capability-ceiling` and friends are; `./rpc` is not) and is
 * `.ts` under `node_modules`, which bare `node --test` refuses to strip types for. Same constraint
 * and same answer as `test/dispatch/ceiling.test.ts`: name the source file, and let a test assert
 * the literals against it, so a rename upstream is a failing assertion rather than an event nobody
 * is listening on.
 */
const RPC_PROTOCOL_VERSION = 1;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

/**
 * The runner's verbatim words for "the child produced nothing", from
 * `pi-subagents/src/runs/background/subagent-runner.ts`. The package writes the identical sentence
 * in `runs/foreground/execution.ts` and matches on it *by equality* in
 * `runs/shared/model-fallback.ts`, which is the reason it can be treated as a marker at all rather
 * than as prose.
 *
 * Matched with `includes`, not `===`: by the time it reaches a verdict it has been through
 * `readAsyncRunState`, which prefers the failed step's error over the run-level summary and hands
 * the whole stderr tail along with it.
 */
export const EMPTY_COMPLETION_ERROR = "Subagent produced no output (possible model cold-start or empty response).";

/** One automatic follow-up per run, ever. */
export const RESUME_BUDGET = 1;

/** How long a request waits for its reply before the outcome is reported as unknown. */
export const REPLY_TIMEOUT_MS = 30_000;

/**
 * A terminal run whose ending is "said nothing".
 *
 * `failed` is required, not decoration: `readAsyncRunState` takes the first failed *step*'s error
 * whatever the run-level state says, so a run that came back empty once, was retried by the package
 * and then `complete`d still carries this sentence. Following that up would re-run work that
 * already succeeded.
 */
export function emptyCompletion(verdict: AsyncRunVerdict): boolean {
  return verdict.kind === "terminal" && verdict.failed && (verdict.error?.includes(EMPTY_COMPLETION_ERROR) ?? false);
}

/** The resolved `subagents.watchdog.asyncCompletion` decision, with the reason it came out that way. */
export interface AsyncCompletionGate {
  /** `watchdog.enabled && watchdog.asyncCompletion.enabled`, both literally `true`. */
  readonly enabled: boolean;
  /** Read, reported, and not honoured here — see this file's header. */
  readonly autoFollowBlockers: boolean;
  /** Why `enabled` is what it is, in words a person can act on. */
  readonly why: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The agent settings file — the same one `watchdog/settings.ts` resolves through `getAgentDir()`. */
export function watchdogSettingsPath(): string {
  return join(configDir(), "settings.json");
}

/**
 * Reads the gate off the agent settings file. Never throws: an unreadable or absent settings file
 * is a disabled gate with a reason, because a harness that follows up async children *because it
 * could not read its own configuration* is the failure this module is supposed to prevent.
 */
export function readAsyncCompletionGate(settingsFile: string = watchdogSettingsPath()): AsyncCompletionGate {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(readFileSync(settingsFile, "utf8")) as unknown);
  } catch (err) {
    const why =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `${settingsFile} does not exist`
        : `${settingsFile} is unreadable: ${(err as Error).message}`;
    return { enabled: false, autoFollowBlockers: false, why };
  }
  const watchdog = record(record(parsed?.subagents)?.watchdog);
  if (watchdog === undefined) {
    return { enabled: false, autoFollowBlockers: false, why: `${settingsFile} carries no subagents.watchdog block` };
  }
  const asyncCompletion = record(watchdog.asyncCompletion);
  const autoFollowBlockers = asyncCompletion?.autoFollowBlockers === true;
  if (watchdog.enabled !== true) {
    return { enabled: false, autoFollowBlockers, why: "subagents.watchdog.enabled is not true" };
  }
  if (asyncCompletion?.enabled !== true) {
    return { enabled: false, autoFollowBlockers, why: "subagents.watchdog.asyncCompletion.enabled is not true" };
  }
  return { enabled: true, autoFollowBlockers, why: "subagents.watchdog.asyncCompletion.enabled is true" };
}

/** The loop guard. One line per run that has spent its budget; append-only, survives the session. */
export function resumeLedgerPath(): string {
  return join(stateRoot(), "dispatch", "async-resume.jsonl");
}

/**
 * How many automatic follow-ups this run has already been given, read fresh from disk.
 *
 * Re-read rather than cached, for the same reason the fleet re-reads `status.json`: the budget has
 * to hold across a restart, and a number held in memory is a number that resets with the process.
 */
export function resumeAttempts(runId: string, ledgerFile: string = resumeLedgerPath()): number {
  let body: string;
  try {
    body = readFileSync(ledgerFile, "utf8");
  } catch {
    return 0;
  }
  let spent = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line) as unknown);
    } catch {
      // A torn or hand-edited line is not evidence that this run was followed up. Skipping it can
      // only ever cost one extra attempt; treating it as a match would silently disable the feature.
      continue;
    }
    if (entry?.runId === runId) spent += 1;
  }
  return spent;
}

/**
 * Claims this run's one attempt, returning `false` when there is nothing left to claim.
 *
 * Fails CLOSED. A ledger that cannot be appended to is a budget that cannot be enforced, and the
 * caller must then not send anything — see the header.
 */
export function spendResumeBudget(
  runId: string,
  ledgerFile: string = resumeLedgerPath(),
  now: number = Date.now(),
): boolean {
  if (resumeAttempts(runId, ledgerFile) >= RESUME_BUDGET) return false;
  try {
    mkdirSync(dirname(ledgerFile), { recursive: true, mode: 0o700 });
    appendFileSync(ledgerFile, `${JSON.stringify({ runId, at: new Date(now).toISOString() })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * What the resumed child is told.
 *
 * It names the failure in the runner's own words and says the follow-up is the only one, because
 * the child cannot see this ledger and would otherwise be free to treat "produce nothing" as a
 * state it can sit in. The instruction to answer partially is deliberate: an empty completion is
 * most often a cold start or a dropped first token, and the recovery worth having is output, not a
 * perfect answer.
 */
export function followUpMessage(): string {
  return [
    `Your previous run ended without producing any output at all. The runner recorded it as: ${EMPTY_COMPLETION_ERROR}`,
    ``,
    `This is one automatic follow-up and there will not be another — nothing will ask again. Do the ` +
      `work you were dispatched for and write the result now, even if it is partial. If something ` +
      `genuinely blocks you, say what it is in one sentence rather than returning empty a second time.`,
  ].join("\n");
}

/** The slice of PI's `EventBus` this module uses. Narrowed so a test can pass a fake. */
export interface ResumeBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

export interface ResumeDeps {
  readonly bus: ResumeBus;
  /** How one follow-up's outcome reaches the session. Called exactly once per request. */
  readonly deliver: (text: string) => void;
  /** Takes the run a successful resume started into the fleet, so its own ending is announced. */
  readonly adopt?: (result: unknown) => void;
  /** Resolved once by the caller when it has one; read from the settings file otherwise. */
  readonly gate?: AsyncCompletionGate;
  readonly ledgerFile?: string;
  readonly now?: () => number;
  readonly newRequestId?: () => string;
  readonly replyTimeoutMs?: number;
  /** Anything that went wrong inside the follow-up itself, for the extension's own problem channel. */
  readonly onProblem?: (problem: string) => void;
}

function label(report: AsyncRunReport): string {
  const agent = report.verdict.kind === "terminal" ? report.verdict.agent : undefined;
  return `${agent ?? report.run.agent ?? "subagent"} [${shortId(report.run.runId)}]`;
}

const NOTHING_RESUMED = "Nothing was resumed — re-dispatch it yourself if you still need the result.";

/**
 * Turns one RPC reply into the sentence the session gets, and adopts whatever it started.
 *
 * The adoption order matters: the new run's budget is stamped BEFORE it enters the fleet, so there
 * is no sweep in which it is both tracked and unspent.
 */
function describeReply(report: AsyncRunReport, reply: unknown, deps: ResumeDeps): string {
  const envelope = record(reply);
  const head = `Automatic follow-up for empty async run ${label(report)}`;
  if (envelope?.success !== true) {
    const error = record(envelope?.error);
    const code = typeof error?.code === "string" ? error.code : "unknown";
    const message = typeof error?.message === "string" ? error.message : "no message";
    return `${head} was refused by pi-subagents (${code}): ${message}. ${NOTHING_RESUMED}`;
  }
  const payload = envelope.data;
  const started = trackedAsyncRuns(payload, deps.now?.() ?? Date.now());
  if (started.length === 0) {
    return (
      `${head} was accepted, but the reply named no new async run. ${NOTHING_RESUMED} ` +
      `/subagents-fleet shows what actually exists.`
    );
  }
  const ledgerFile = deps.ledgerFile ?? resumeLedgerPath();
  for (const run of started) spendResumeBudget(run.runId, ledgerFile, deps.now?.() ?? Date.now());
  deps.adopt?.(payload);
  const names = started.map((run) => `[${shortId(run.runId)}]`).join(", ");
  return (
    `${head}: resumed as ${names}, now tracked by this session — its ending will be announced here ` +
    `like any other. The one automatic follow-up allowed per run is spent for both, so if it comes ` +
    `back empty again, re-dispatch it yourself.`
  );
}

/**
 * Sends one resume request and arms exactly one delivery of its outcome.
 *
 * Nothing here returns a promise. The RPC is a pair of bus events, and the reply arrives on a
 * channel named after the request — so the outcome is a callback that either fires or times out,
 * and there is no floating promise whose rejection could reach the lead's turn.
 */
function requestResume(report: AsyncRunReport, deps: ResumeDeps): void {
  const requestId = deps.newRequestId?.() ?? randomUUID();
  let settled = false;
  let unsubscribe: (() => void) | void;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (text: string): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      unsubscribe?.();
    } catch (err) {
      deps.onProblem?.(`could not unsubscribe from the resume reply channel: ${(err as Error).message}`);
    }
    deps.deliver(text);
  };

  // Subscribed before the request is emitted: the bus delivers synchronously, so a reply to a
  // request nobody is listening for yet is a reply that is simply lost.
  unsubscribe = deps.bus.on(`${RPC_REPLY_EVENT_PREFIX}${requestId}`, (data) => {
    try {
      finish(describeReply(report, data, deps));
    } catch (err) {
      deps.onProblem?.(`resume reply for ${report.run.runId} could not be read: ${(err as Error).message}`);
      finish(`Automatic follow-up for empty async run ${label(report)} replied unreadably. ${NOTHING_RESUMED}`);
    }
  });

  const timeoutMs = deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
  timer = setTimeout(() => {
    finish(
      `Automatic follow-up for empty async run ${label(report)} got no reply in ${Math.round(timeoutMs / 1000)}s — ` +
        `pi-subagents' RPC bridge may not be loaded. ${NOTHING_RESUMED}`,
    );
  }, timeoutMs);
  // A pending follow-up must never be the reason the process stays up.
  timer.unref?.();

  try {
    deps.bus.emit(RPC_REQUEST_EVENT, {
      version: RPC_PROTOCOL_VERSION,
      requestId,
      method: "resume",
      // `id`, not `dir`: the package resolves an async run by id against its own root
      // (`runs/background/async-resume.ts` `resolveAsyncRunLocation`), and a directory this side
      // guessed would have to agree with it anyway.
      params: { id: report.run.runId, message: followUpMessage() },
      source: { extension: "dispatch", reason: "async-empty-completion" },
    });
  } catch (err) {
    deps.onProblem?.(`resume request for ${report.run.runId} could not be emitted: ${(err as Error).message}`);
    finish(`Automatic follow-up for empty async run ${label(report)} could not be sent. ${NOTHING_RESUMED}`);
  }
}

/**
 * The sweep's half of it: every reconciled run that ended empty and still has its budget gets one
 * resume request. Returns the ids that got one, so the announcement can say so — an announcement
 * that tells the model to re-dispatch a run this module has just resumed is two instructions that
 * contradict each other.
 *
 * The gate is resolved only once there is a candidate, so a session that never loses a child never
 * reads the settings file at all.
 */
export function followUpEmptyRuns(reports: readonly AsyncRunReport[], deps: ResumeDeps): string[] {
  const candidates = reports.filter((report) => emptyCompletion(report.verdict));
  if (candidates.length === 0) return [];
  const gate = deps.gate ?? readAsyncCompletionGate();
  if (!gate.enabled) return [];

  const ledgerFile = deps.ledgerFile ?? resumeLedgerPath();
  const requested: string[] = [];
  for (const report of candidates) {
    if (!spendResumeBudget(report.run.runId, ledgerFile, deps.now?.() ?? Date.now())) continue;
    requestResume(report, deps);
    requested.push(report.run.runId);
  }
  return requested;
}

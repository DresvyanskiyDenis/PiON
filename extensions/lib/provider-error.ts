/**
 * Provider error surfacing — the deliverable that replaced the cancelled `EXT-08`
 * (`implementation_plan.md` §3.4a, `REQ-PRV-32`).
 *
 * The rule, in one sentence: when a provider call fails, the session names the **provider, the
 * model, an error class and the upstream message**, keeps the cause chain, and stops. Nothing in
 * this file — or anywhere downstream of it — re-issues the request against another provider,
 * another tier or another model. If `strong` is down, the turn fails as `strong`.
 *
 * Three deliberate properties:
 *   1. **No substitution.** There is no fallback table here, on purpose. `routing.json`
 *      `onProviderError.substituteProvider` is `false` and `test/ext-13-provider-error.test.ts`
 *      asserts it stays false.
 *   2. **No truncation.** `message` is the upstream text verbatim; `cause` carries the original
 *      error object so a stack trace survives to the log.
 *   3. **Never throws.** `surfaceProviderFailure` runs inside a `message_end` handler. An error
 *      reporter that throws while reporting an error is worse than the error.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describeError } from "./once.ts";
import { providerAbortLogPath } from "./paths.ts";

/** The seven classes fixed by `config/routing.json` -> `onProviderError.errorClasses`. */
export type ProviderErrorClass =
  | "auth" // 401/403, expired or missing credential
  | "quota" // 429/402 with a quota, rate-limit or billing signal
  | "network" // DNS, TLS, proxy, timeout — anything that never reached the model
  | "model-not-found" // the id is not served by this provider (the Databricks endpoint trap, V-30)
  | "policy" // the provider refused on tenant policy (the V-12 outcome-D shape)
  | "cancellation" // user cancelled the call before it finished (never retry, never resume)
  | "empty-response"; // a well-formed 200 whose body carried no completion at all

/**
 * PI's own carrier for "what actually threw": `AssistantMessage.diagnostics`, shaped by
 * `@earendil-works/pi-ai`'s `createAssistantMessageDiagnostic`. Re-declared structurally rather
 * than imported, because the type lives in a deep subpath of that package.
 *
 * This is as much of the exception chain as PI hands to an extension. By the time a provider
 * failure reaches `message_end` the thrown value has already been flattened into
 * `errorMessage: string`; `diagnostics[].error` is the only place `name`, `code` and `stack`
 * survive. `REQ-PRV-32`'s "cause chain preserved" is therefore honoured by carrying these
 * through untouched — and by *not* fabricating an `Error` around the message string, which would
 * look like a preserved chain while carrying no information the message did not already have.
 */
export interface DiagnosticErrorInfo {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string | number;
}

export interface ProviderDiagnostic {
  readonly type: string;
  readonly timestamp?: number;
  readonly error?: DiagnosticErrorInfo;
  readonly details?: Record<string, unknown>;
}

export interface ProviderFailure {
  readonly provider: string;
  readonly model: string;
  readonly klass: ProviderErrorClass;
  /** Upstream text, untruncated. */
  readonly message: string;
  /** The original error, when the call site has one. The chain is preserved, never flattened. */
  readonly cause?: unknown;
  /** PI's structured record of the throw: name, code and stack. Rendered verbatim. */
  readonly diagnostics?: readonly ProviderDiagnostic[];
  /** `AssistantMessage.rawStopReason` — the provider's own termination token, when it sent one. */
  readonly rawStopReason?: string;
  /**
   * HTTP status of the response that carried the failure — observed on the wire, or recovered
   * from the upstream text by `recoverStatus` when the SDK threw before a response object
   * existed. Absent only when neither source had one.
   */
  readonly status?: number;
  /**
   * True when the transport returned 2xx and the failure happened while the body streamed.
   *
   * This is the path the spec flagged: a 200 that dies mid-stream reaches
   * `after_provider_response` with `status: 200` — the event fires on the response headers,
   * before the body is consumed — so the status alone says "fine". The stream's terminal
   * `error` event is what turns the assistant message's `stopReason` into `"error"`, and that
   * is the signal we act on. Classification for these falls back to the message text, and the
   * rendered block says so explicitly rather than reporting a misleading "http 200".
   */
  readonly midStream: boolean;
  /**
   * Gateway correlation headers, already filtered to the ones worth printing, in render order.
   *
   * These are what makes a report actionable on the OTHER side of the gateway: `x-litellm-call-id`
   * is the handle a proxy admin greps their own logs for. They were being discarded — the
   * `after_provider_response` handler kept `event.status` and dropped `event.headers`, which is
   * public on `AfterProviderResponseEvent` and populated by `pi-ai`
   * (`dist/api/openai-completions.js:144`). An empty 200 has no body to quote, so a header that
   * identifies the request server-side is the single most useful thing the block can carry.
   *
   * Absent headers are omitted rather than rendered empty: `x-litellm-call-id: undefined` reads as
   * a value the gateway sent, and it is not.
   */
  readonly gatewayHeaders?: readonly (readonly [string, string])[];
  /**
   * What the harness decided to DO about this failure, when the class was transient enough to be
   * worth another attempt (`lib/provider-retry.ts`).
   *
   * Absent means "no retry was in play" — a terminal class, or a policy with `maxAttempts: 0` —
   * and the block then renders exactly the abort line it always rendered. Present, it changes one
   * line and nothing else: the same marker, the same fields, the same evidence.
   */
  readonly retry?: RetryDisposition;
  /**
   * True when this `empty-response` consumed zero prompt tokens AND produced zero completion
   * tokens — `buildEmptyCompletionFailure`'s `inTokens === 0 && outTokens === 0`, the same counts
   * the block already prints. `undefined` for every other class, and for an `empty-response` built
   * by anything other than `buildEmptyCompletionFailure`.
   *
   * This is the observable signal the working-path hop (`hop` below) acts on, not an invented one:
   * 0/0 does not distinguish "no usage chunk arrived" from "the provider genuinely reported zero"
   * (see the caveat in the rendered message), but it does not need to — either way nothing was sent
   * and nothing came back, so there is no partial work whose provenance a hop could put at risk.
   */
  readonly zeroTokenEmpty?: boolean;
  /**
   * What the harness decided to do about a zero-token `empty-response` — `credentials.ts`'s
   * `handleZeroTokenEmpty`. Mutually exclusive with `retry`: this class never goes through
   * `report()`'s same-provider retry, so a `ProviderFailure` carries at most one of the two.
   *
   * Absent means this was not a zero-token `empty-response` at all. Present only when the hop
   * ended in abort — a hop that SUCCEEDED is never surfaced through this module (mirrors
   * `compaction/index.ts`'s `recordHop`: a routing decision is announced on its own channel, not
   * reported as the turn's verdict).
   */
  readonly hop?: HopDisposition;
}

/**
 * What `handleZeroTokenEmpty` decided about the one working-path hop this streak gets, rendered
 * into the `policy` line when the streak ends in abort.
 *
 * Never reused from `RetryDisposition`: that type's wording ("re-issued against the same provider
 * and model", "no failover, no substitution, no retry against another provider") is exactly false
 * for a hop, which by definition targets a DIFFERENT provider and model.
 */
export interface HopDisposition {
  /** True when the one hop for this streak was already spent and the hop target failed again. */
  readonly exhausted: boolean;
  /** `provider/id` this streak hopped to. Present exactly when `exhausted` is true. */
  readonly target?: string;
  /** Why no hop was attempted at all. Present exactly when `exhausted` is false. */
  readonly declinedReason?: string;
}

/**
 * One attempt's place in a retry budget. Rendered into the `policy` line, so a reader of a single
 * block can tell "this failed and the harness is trying again" from "this failed twice and that
 * was the end of it" without correlating two blocks by hand.
 */
export interface RetryDisposition {
  /** 1-based: this failure was the Nth of `maxAttempts + 1` attempts at the CURRENT streak. */
  readonly attempt: number;
  /** Retries after the first attempt — `routing.json` -> `onProviderError.retry.maxAttempts`. */
  readonly maxAttempts: number;
  /** True when the harness re-issued the request after this failure. */
  readonly willRetry: boolean;
  /**
   * How many of the session's bounded `maxStreakRestarts` this streak has already spent restarting
   * after a DIFFERENT class's exhausted streak — see `shouldRetry` in `lib/provider-retry.ts`. `0`
   * for the ordinary case: a first exhaustion that never needed a restart. `policyLine` changes its
   * wording once this is nonzero, because `attempt`/`maxAttempts` alone would then understate how
   * much of this session's overall retry budget the operator has actually spent.
   */
  readonly streakRestarts?: number;
  /** `routing.json` -> `onProviderError.retry.maxStreakRestarts`, alongside `streakRestarts`. */
  readonly maxStreakRestarts?: number;
}

export interface ClassifyInput {
  /** HTTP status, when one was observed. Absent for a transport error that never got a response. */
  readonly status?: number;
  /** Upstream error text. */
  readonly message?: string;
  /** Original error object, if any — its `cause` chain is searched too. */
  readonly cause?: unknown;
  /** PI diagnostics; `error.code` here is often the only place `ECONNREFUSED` appears. */
  readonly diagnostics?: readonly ProviderDiagnostic[];
}

/**
 * Tenant-policy refusals. Checked FIRST, before any status rule: a policy refusal arrives as
 * 400 on one gateway, 403 on another and 422 on a third, so status is the least reliable
 * signal for this class and the most reliable one for `auth`.
 */
const POLICY_PATTERNS: readonly RegExp[] = [
  /\bcontent[_ -]?filter(ing)?\b/i,
  /\bcontent[_ -]?(management[_ -]?)?polic(y|ies)\b/i,
  /\bresponsible[_ -]?ai\b/i,
  /\bpolicy[_ -]?violation\b/i,
  /\bblocked by (the )?(content |safety |usage )?polic(y|ies)\b/i,
  /\bdata[_ -]?loss[_ -]?prevention\b/i,
  /\bjailbreak\b/i,
];

/** "This provider does not serve that id." Includes the Databricks endpoint-name trap (V-30). */
const MODEL_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /\bmodel[_ -]?not[_ -]?found\b/i,
  /\bunknown model\b/i,
  /\bno such (model|endpoint|deployment)\b/i,
  /\bmodel .{0,80}?\bdoes not exist\b/i,
  /\bRESOURCE_DOES_NOT_EXIST\b/,
  /\bendpoint .{0,80}?\b(does not exist|not found)\b/i,
  /\bdeployment .{0,80}?\bnot found\b/i,
  /\bthe model `[^`]+` does not exist\b/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /\binvalid[_ -]?api[_ -]?key\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bauthenticat(ion|ed|e) (failed|required|error)\b/i,
  /\bbad credentials\b/i,
  /\b(token|credential)s? (has )?expired\b/i,
  /\bexpired (token|credential)\b/i,
  /\binvalid[_ -]?token\b/i,
  /\bpermission[_ -]?denied\b/i,
  /\bmissing (api[_ -]?key|credential|authorization)\b/i,
  /\bno api key found\b/i,
];

const QUOTA_PATTERNS: readonly RegExp[] = [
  /\bquota\b/i,
  /\brate[_ -]?limit(ed|s)?\b/i,
  /\btoo many requests\b/i,
  /\binsufficient[_ -]?(quota|credit|funds|balance)\b/i,
  /\bcredit balance\b/i,
  /\bbilling\b/i,
  /\bpayment required\b/i,
  /\busage limit\b/i,
];

const CANCELLATION_PATTERNS: readonly RegExp[] = [
  /\bAbortError\b/,
  /\bcancell(ed|ation)\b/i,
  /\buser cancel(led|s)\b/i,
  /\boperator cancel(led|s)\b/i,
  /\binterrupt(ed)?\b/i,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bUND_ERR_/,
  /\bfetch failed\b/i,
  /\bsocket hang up\b/i,
  /\b(self[- ]signed )?certificate\b/i,
  /\bunable to verify the first certificate\b/i,
  /\bTLS\b/,
  /\bproxy\b/i,
  /\btimed? ?out\b/i,
  /\bterminated\b/i,
];

function matchesAny(haystack: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(haystack));
}

/**
 * The searchable text for a failure: the upstream message plus every level of the cause chain.
 * A wrapped `TypeError: fetch failed` whose cause is `Error: connect ECONNREFUSED` classifies as
 * `network` only because the chain is searched, not just the outermost message.
 */
export function classificationHaystack(input: ClassifyInput): string {
  const parts = [input.message ?? ""];
  if (input.cause !== undefined && input.cause !== null) parts.push(describeError(input.cause));
  for (const diagnostic of input.diagnostics ?? []) {
    parts.push(diagnostic.type);
    const err = diagnostic.error;
    if (!err) continue;
    parts.push([err.name, err.code, err.message].filter((v) => v !== undefined).join(" "));
  }
  return parts.join("\n");
}

/**
 * Shapes an HTTP status takes when it survives only as text. Ordered most-specific first; the
 * first match wins. Each is anchored on a keyword so a bare three-digit number in prose — a port,
 * a token count, a line number — cannot be mistaken for a status.
 */
const STATUS_IN_MESSAGE: readonly RegExp[] = [
  /\b([1-5]\d{2}) status code\b/i, // `@earendil-works/pi-ai`, openai-node: "403 status code (no body)"
  /\bstatus(?: code)?[:= ]\s*([1-5]\d{2})\b/i, // "status: 429", "status code 500"
  /\bHTTP\/?[0-9.]*\s+([1-5]\d{2})\b/i, // "HTTP 401", "HTTP/1.1 502"
];

/**
 * The status to reason with: the one observed on the wire, or — when there was none — one
 * recovered from the upstream text.
 *
 * The recovery half is not belt-and-braces, it is load-bearing. `after_provider_response` only
 * fires when the SDK produced a response object; some upstream failures are thrown before that
 * and reach `message_end` as nothing but `errorMessage: "403 status code (no body)"`. Without
 * this, such a failure classifies by the catch-all as `network` and renders as "the request never
 * reached the provider" — a statement that is not merely vague but false, and false in the one
 * direction that costs debugging time, because it points at DNS and proxies when the provider in
 * fact answered and its answer was the whole diagnosis.
 *
 * Observed 2026-08-07 on `databricks/databricks-claude-sonnet-4-5`: the rendered block said
 * `class: network` / `http: (no response …)` while the real cause, visible only by curling the
 * endpoint by hand, was an Azure Databricks workspace IP ACL rejecting a non-corporate source
 * address — a 403, i.e. `auth`.
 *
 * An observed status always wins; text is consulted only in its absence.
 */
export function recoverStatus(input: ClassifyInput): number | undefined {
  if (input.status !== undefined) return input.status;
  for (const re of STATUS_IN_MESSAGE) {
    const match = re.exec(classificationHaystack(input));
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * Map a failure onto one of the seven classes.
 *
 * Order is load-bearing and each step is justified:
 *   1. policy — status is unreliable for this class (see POLICY_PATTERNS).
 *   2. model-not-found — a 404, or an explicit "no such model/endpoint" at any status.
 *   3. auth — 401/403 are unambiguous once policy has been excluded.
 *   4. quota — 402/429, or an explicit quota/billing signal at any status.
 *   5. cancellation — `AbortError`, or an explicit "cancelled"/"interrupted" signal.
 *   6. network — 5xx, 408, or a transport-shaped error with no status at all.
 *
 * The status feeding those steps comes from `recoverStatus`, so a status that only ever existed
 * inside the error text steers the class exactly as one read off the wire would.
 *
 * The last resort is `network`, and it is a deliberate choice rather than a guess: with the
 * classes closed by `routing.json` there is no "unknown", and a response that we cannot classify
 * demonstrably did not produce a usable completion. Nothing is hidden by it — the rendered block
 * always carries the raw status and the untruncated upstream text, so the class is a routing
 * hint, never the evidence.
 *
 * `empty-response` is deliberately NOT reachable from here. It is not a property of any text —
 * an empty completion carries none — but of the message's shape, so it is recognised by
 * `isEmptyCompletion` and built by `buildEmptyCompletionFailure`, never guessed at from a string.
 */
export function classifyProviderError(input: ClassifyInput): ProviderErrorClass {
  const text = classificationHaystack(input);
  const status = recoverStatus(input);

  if (matchesAny(text, POLICY_PATTERNS)) return "policy";
  if (status === 404 || matchesAny(text, MODEL_NOT_FOUND_PATTERNS)) return "model-not-found";
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (matchesAny(text, AUTH_PATTERNS)) return "auth";
  if (matchesAny(text, QUOTA_PATTERNS)) return "quota";
  if (matchesAny(text, CANCELLATION_PATTERNS)) return "cancellation";
  if (status !== undefined && status >= 500) return "network";
  if (status === 408) return "network";
  if (matchesAny(text, NETWORK_PATTERNS)) return "network";
  return "network";
}

export interface BuildFailureInput extends ClassifyInput {
  readonly provider: string;
  readonly model: string;
  /** True when the response headers were 2xx and the body failed afterwards. */
  readonly midStream?: boolean;
  readonly rawStopReason?: string;
}

export function buildProviderFailure(input: BuildFailureInput): ProviderFailure {
  return {
    provider: input.provider,
    model: input.model,
    klass: classifyProviderError(input),
    message: input.message ?? "(no message from the provider)",
    cause: input.cause,
    diagnostics: input.diagnostics,
    rawStopReason: input.rawStopReason,
    // `recoverStatus`, not `input.status`: the class and the rendered `http` line must agree, and
    // a status the classifier acted on must be visible in the evidence it is justified by.
    status: recoverStatus(input),
    midStream: input.midStream ?? false,
  };
}

/**
 * The shape `isEmptyCompletion` needs from `AssistantMessage`. Declared structurally rather than
 * imported so the predicate can be exercised from a recorded transcript record, which is where the
 * evidence for this failure lives (`.pi-subagents/artifacts/*_transcript.jsonl`).
 */
export interface CompletionShape {
  readonly content?: readonly { readonly type: string }[];
  readonly stopReason: string;
  readonly rawStopReason?: string;
  readonly responseId?: string;
  readonly usage?: { readonly input?: number; readonly output?: number };
}

/**
 * Stop reasons for which "no content" is a legitimate state rather than a failed turn:
 * `error` and `aborted` are reported elsewhere (the first by the `stopReason === "error"` branch,
 * the second is the operator pressing Esc), `pending` is a message that has not finished, and
 * `deferred` is a batch handle whose content arrives later by design.
 */
const NOT_AN_ANSWER: readonly string[] = ["error", "aborted", "pending", "deferred"];

/**
 * A turn that ended with a completion carrying **nothing** — no text, no thinking block, no tool
 * call — while the provider called it a normal termination.
 *
 * Observed 2026-08-14 on `litellm/gpt-5.6-luna`, in nine subagent runs whose transcripts all end
 * on the identical record: `content: []`, `stopReason: "stop"`, `rawStopReason: "stop"`,
 * `usage` zero on every field, and a `chatcmpl-<uuid4>` `responseId` — i.e. the gateway answered
 * 200 with a stream that carried no delta at all. Observed first on luna and NOT luna-only: the
 * session history holds 30 empty litellm responses, `gpt-5.6-terra` among them.
 *
 * The id FORM is not evidence and was briefly treated as though it were. It is decided by whether
 * the request body carries `tools` — toolless gets the upstream Azure form, `tools` gets a uuid4 —
 * and PI attaches `tools` on every agent turn, so this harness only ever sees uuid4: 2644 uuid4 /
 * 0 upstream-form across `~/.pi/agent/sessions`, of which 2614 are healthy. Zero discriminating
 * power; `config/routing.json`'s `_concurrencyNote` carries the full refutation. Nothing downstream could tell that from
 * a model that simply had nothing to say: `pi-subagents` reported it as "Subagent produced no
 * output (possible model cold-start or empty response)", a guess that named a cause nobody had
 * established and cost hours of transcript archaeology.
 *
 * `content.length === 0` is the whole predicate. `usage` is NOT part of it and must not become
 * part of it: `pi-ai` pre-initialises usage to zeros and only overwrites it from a usage chunk, so
 * an all-zero `usage` is the default rather than a measurement — see `buildEmptyCompletionFailure`.
 *
 * The predicate is shape-only and was checked against the counter-example set before being
 * wired up: across the 19 successful runs in the same artifact directory, 304 assistant messages,
 * **zero** carry an empty `content`. An empty completion is the failure and nothing else.
 */
export function isEmptyCompletion(message: CompletionShape): boolean {
  if (NOT_AN_ANSWER.includes(message.stopReason)) return false;
  // A message with no `content` array at all is not evidence of an empty completion — PI always
  // sets one — so it is left alone rather than reported on a shape nobody has seen.
  return Array.isArray(message.content) && message.content.length === 0;
}

export interface EmptyCompletionInput {
  readonly provider: string;
  readonly model: string;
  /** HTTP status of the response that carried the empty body, when `after_provider_response` saw one. */
  readonly status?: number;
  readonly stopReason: string;
  readonly rawStopReason?: string;
  readonly responseId?: string;
  readonly usage?: { readonly input?: number; readonly output?: number };
  /**
   * The session's reasoning effort at the time of the call — `ctx.thinkingLevel`, i.e. the level
   * PI had already clamped to the model's `thinkingLevelMap`, which is what actually went on the
   * wire. It is here because the level was the first suspect when this failure was investigated
   * and it took a live probe to rule out: a run that names `:max` in its metadata but reports
   * `high` here has been clamped, and the gateway's `reasoning_effort` vocabulary is not the cause.
   */
  readonly thinkingLevel?: string;
  /** `AfterProviderResponseEvent.headers`, raw. Filtered by `pickGatewayHeaders`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The response headers worth carrying into a failure report, lower-cased, in this order.
 *
 * Four, and only four, chosen because each answers a question the report otherwise cannot:
 *   - `x-litellm-call-id` — the handle a proxy admin greps for. Without it a report of an empty 200
 *     is unactionable on the gateway side, which is where the fault now looks like it lives.
 *   - `x-litellm-model-id` — WHICH deployment behind the model group served it. A model group fans
 *     out, and "gpt-5.6-luna failed" does not say which member did.
 *   - `x-litellm-response-duration-ms` — the gateway's own timing, independent of ours.
 *   - `x-litellm-version` — so a report stays readable after the proxy is upgraded.
 *
 * Named explicitly rather than swept in by an `x-litellm-*` prefix match: a blanket copy would put
 * whatever the proxy adds next into a message that reaches a log and a Telegram report, and
 * `x-litellm-key-*` headers on that surface are spend and key metadata. An allow-list is the safe
 * default when the producer is not ours.
 */
const GATEWAY_HEADERS: readonly string[] = [
  "x-litellm-call-id",
  "x-litellm-model-id",
  "x-litellm-response-duration-ms",
  "x-litellm-version",
];

/**
 * The subset of `headers` that is present and non-empty, in `GATEWAY_HEADERS` order.
 *
 * Header names are matched case-insensitively: HTTP header names are case-insensitive by spec, and
 * what reaches `AfterProviderResponseEvent.headers` is whatever the fetch implementation chose to
 * key them by. Returns `undefined` — never `[]` — when nothing matched, so the caller can omit the
 * field rather than render an empty one.
 */
export function pickGatewayHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): readonly (readonly [string, string])[] | undefined {
  if (headers === undefined) return undefined;
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) lowered.set(key.toLowerCase(), value);
  const picked: (readonly [string, string])[] = [];
  for (const name of GATEWAY_HEADERS) {
    const value = lowered.get(name);
    if (typeof value === "string" && value.trim() !== "") picked.push([name, value.trim()] as const);
  }
  return picked.length > 0 ? picked : undefined;
}

/**
 * The `empty-response` failure, built from what was observed and nothing else.
 *
 * There is no upstream text to quote here — that is the entire complaint — so `message` states the
 * facts a reader needs to tell "the gateway dropped this" from "the model chose to say nothing":
 * the part count, both stop reasons, the post-clamp reasoning effort, the response id and the token
 * counts. It explains none of them.
 *
 * ## The one sentence that WAS a cause, and how it was refuted
 *
 * Until 2026-08-14 this function appended: *"Zero prompt tokens on a request that carried a prompt
 * means the gateway billed nothing for it — the request did not reach the model behind it."* That
 * is an inference, it was printed as fact, and it is wrong on the instrument alone.
 *
 * `pi-ai`'s OpenAI-completions stream initialises `output.usage` to zeros on every field
 * (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:105-118`) and overwrites it
 * ONLY from `chunk.usage` / `choice.usage` (`:315` and `:323`). On this failure no usage chunk
 * arrives at all, so the assistant message reports 0/0 no matter what the gateway did or did not
 * bill. `0 prompt tokens` is therefore the DEFAULT, not a measurement, and it carries no
 * information about whether the request reached the model.
 *
 * A live probe then contradicted the claim outright: 549/549 reproductions of the empty 200 had no
 * usage chunk, 211/211 healthy responses had one, and an identical NON-streaming request returned a
 * real `litellm.RateLimitError` seconds later (0 of 38 non-streaming requests ever went empty). The
 * leading hypothesis is now the opposite of what the sentence said — LiteLLM's streaming path
 * swallowing an upstream 429 — and it is a hypothesis, so it is not printed either.
 *
 * ## Why the absence is not reported as the discriminator
 *
 * Usage-chunk absence is the real signal and it would be worth printing, but it is not observable
 * from here. Because `output.usage` is pre-initialised, "no usage chunk arrived" and "the provider
 * reported zero" reach `message_end` as the byte-identical object `{input: 0, output: 0, …}`.
 * Nothing on `CompletionShape` can separate them, so the distinction is NOT invented: the counts
 * are printed with the caveat that they do not discriminate, and the shape check in
 * `isEmptyCompletion` is left exactly as it was.
 */
export function buildEmptyCompletionFailure(input: EmptyCompletionInput): ProviderFailure {
  const inTokens = input.usage?.input ?? 0;
  const outTokens = input.usage?.output ?? 0;
  const gatewayHeaders = pickGatewayHeaders(input.headers);
  return {
    provider: input.provider,
    model: input.model,
    klass: "empty-response",
    message:
      `the provider returned an empty completion: 0 content parts (no text, no thinking, no ` +
      `tool call), stopReason=${input.stopReason}, ` +
      `finish_reason=${input.rawStopReason ?? "(none reported)"}, ` +
      `reasoning effort=${input.thinkingLevel ?? "(not reported by the session)"}, ` +
      `responseId=${input.responseId ?? "(none reported)"}, ` +
      `usage ${inTokens} prompt / ${outTokens} completion token(s). ` +
      (inTokens === 0 && outTokens === 0
        ? `Those counts are not evidence: pi-ai initialises usage to zero and overwrites it only ` +
          `from a usage chunk, so 0/0 is what arrives both when no usage chunk was sent and when ` +
          `the provider genuinely reported zero, and the two are indistinguishable from here. `
        : "") +
      `The turn produced no answer.`,
    ...(input.rawStopReason !== undefined ? { rawStopReason: input.rawStopReason } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(gatewayHeaders !== undefined ? { gatewayHeaders } : {}),
    midStream: false,
    zeroTokenEmpty: inTokens === 0 && outTokens === 0,
  };
}

/**
 * Whether `failure` qualifies for the working-path hop: an `empty-response` that consumed no
 * prompt tokens and produced no completion tokens. Every other class, and a non-zero-token
 * `empty-response` (which MAY carry partial provenance), keep `report()`'s existing behaviour.
 */
export function shouldRouteZeroTokenEmpty(failure: ProviderFailure): boolean {
  return failure.klass === "empty-response" && failure.zeroTokenEmpty === true;
}

/**
 * Where the failure happened, in one clause. `empty-response` gets its own because a bare
 * `http 200` on a turn that produced nothing reads as "the call was fine", which is the exact
 * misreading this class exists to prevent — the headers were fine and the body was the failure.
 */
function describeWhere(f: ProviderFailure): string {
  if (f.klass === "empty-response") return `http ${f.status ?? "2xx"}, empty body`;
  if (f.midStream) return `http ${f.status ?? "2xx"} then stream failure`;
  return f.status !== undefined ? `http ${f.status}` : "no status";
}

/**
 * The stable head of every block this module renders, and the ONLY way anything downstream is
 * allowed to recognise one.
 *
 * It exists because a classified failure has to survive a process boundary. A subagent child
 * reports through `surfaceProviderFailure`'s log sink, i.e. stderr; `pi-subagents` then hands the
 * child's whole stderr tail to the parent as the run's error text
 * (`runs/foreground/execution.ts:1094-1095`), startup notices and all. `extensions/dispatch/
 * failure-slot.ts` finds the classified block inside that tail by this marker so the parent can
 * lead with it. Producer owns the marker so the two cannot drift apart.
 */
export const PROVIDER_FAILURE_MARKER = "[pi-config] provider call failed:";

/** The one-line form, for a TUI toast and for grepping a log. */
export function summariseProviderFailure(f: ProviderFailure): string {
  return `${PROVIDER_FAILURE_MARKER} ${f.provider}/${f.model} — ${f.klass} (${describeWhere(f)})`;
}

/**
 * The full block. Every field `routing.json` -> `onProviderError.report` names is present:
 * provider, model, errorClass, message, causeChain.
 */
export function formatProviderFailure(f: ProviderFailure): string {
  const lines = [
    summariseProviderFailure(f),
    `  provider : ${f.provider}`,
    `  model    : ${f.model}`,
    `  class    : ${f.klass}`,
    `  http     : ${
      f.klass === "empty-response"
        ? `${f.status ?? "2xx"} (a complete, well-formed response whose body carried no completion — ` +
          `the status is not the error)`
        : f.midStream
        ? `${f.status ?? "2xx"} (headers ok; the stream failed after them, so the status is not the error)`
        : // Not "the request never reached the provider": that is an inference, and it was the
          // wrong one on the Databricks 403 that `recoverStatus` now catches. State only what was
          // established — no status anywhere — and leave the message line to say the rest.
          (f.status?.toString() ?? "(no status — none on the wire, none in the upstream text)")
    }`,
    `  message  : ${f.message}`,
  ];
  if (f.rawStopReason !== undefined) {
    lines.push(`  rawStop  : ${f.rawStopReason}`);
  }
  // One line, so it survives being pasted into a ticket, and named `gateway` rather than `headers`
  // because who reads it is the point: this is the proxy admin's half of the report.
  if (f.gatewayHeaders !== undefined && f.gatewayHeaders.length > 0) {
    lines.push(`  gateway  : ${f.gatewayHeaders.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (f.cause !== undefined && f.cause !== null) {
    lines.push(`  cause    : ${describeError(f.cause)}`);
  }
  for (const line of formatDiagnostics(f.diagnostics)) {
    lines.push(line);
  }
  lines.push(`  policy   : ${policyLine(f)}`);
  return lines.join("\n");
}

/**
 * The `policy` line, which is the one line in the block that says what happens next.
 *
 * Three forms, and the wording of each is load-bearing:
 *
 *   - **no retry in play** — the line this block has always carried, unchanged to the byte. Five
 *     of the seven classes are verdicts about the request and end here, and so does every class
 *     when an operator sets `maxAttempts: 0`.
 *   - **retrying** — says which attempt this was and that the next one goes to the SAME provider
 *     and model. A reader who sees this line has not lost their turn, and the block above it is
 *     evidence rather than a postmortem.
 *   - **aborting after retries** — the case the operator actually needs to recognise. It names
 *     how many attempts were spent, so "one empty 200" and "two empty 200s in a row" are
 *     distinguishable in the transcript, and it repeats that no other provider was tried, because
 *     the word "retry" in a failover-free harness is exactly the word that invites that reading.
 *
 * A fourth form — the working-path hop — is checked first and is the one case where "no other
 * provider was tried" would be a lie: `hop` is set only by `credentials.ts`'s
 * `handleZeroTokenEmpty`, and only on the abort, never on the hop that succeeded.
 */
function policyLine(f: Pick<ProviderFailure, "retry" | "hop">): string {
  if (f.hop !== undefined) return hopPolicyLine(f.hop);
  const retry = f.retry;
  const noFailover = "no failover, no substitution, no retry against another provider";
  if (retry === undefined) {
    return `abort — ${noFailover} (routing.json onProviderError.policy)`;
  }
  if (retry.willRetry) {
    return (
      `retry ${retry.attempt} of ${retry.maxAttempts} — transient class, re-issued against the same ` +
      `provider and model, then abort (routing.json onProviderError.retry)`
    );
  }
  const spent = retry.attempt === 1 ? "1 attempt" : `${retry.attempt} attempts`;
  // `attempt`/`maxAttempts` reset to a fresh count on every restart, so once one has actually
  // happened they no longer say how much of the session's retry budget is gone — "1 attempt" reads
  // as a single coin flip when it may be the Nth. Name the real cap instead of the reset one.
  if ((retry.streakRestarts ?? 0) > 0) {
    const restarts = retry.streakRestarts === 1 ? "1 restart" : `${retry.streakRestarts} restarts`;
    return (
      `abort after ${spent} — the transient retry budget is maxed out (used all ${restarts} this ` +
      `session gets); ${noFailover} (routing.json onProviderError.policy, onProviderError.retry)`
    );
  }
  return (
    `abort after ${spent} — the transient retry budget (${retry.maxAttempts}) is spent and the class ` +
    `recurred; ${noFailover} (routing.json onProviderError.policy, onProviderError.retry)`
  );
}

/**
 * The `policy` line for a zero-token `empty-response` — always an abort, since a hop that
 * succeeded is never surfaced through this module in the first place.
 *
 *   - **exhausted** — the one hop for this streak was already spent, and the target it hopped to
 *     failed too. No second hop: "no chain on the working path" is a promise this line keeps.
 *   - **declined** — no hop was available at all (unconfigured, unresolvable, the same deployment
 *     that just failed, no credential, or the session's streak-restart cap was already reached),
 *     so this failure aborts exactly as it would have without the working-path hop.
 */
function hopPolicyLine(hop: HopDisposition): string {
  if (hop.exhausted) {
    return (
      `abort — the one working-path hop for this streak is already spent (routed to ${hop.target}, ` +
      `which failed again); no second hop, no failover into a third provider ` +
      `(routing.json onProviderError.workingRoute)`
    );
  }
  return (
    `abort — zero-token empty-response qualifies for the working-path hop but ${hop.declinedReason}; ` +
    `no failover, no substitution otherwise (routing.json onProviderError.workingRoute)`
  );
}

/**
 * Render PI's diagnostics. Untruncated on purpose, stack included: this block is the only place
 * a stack trace from a provider failure survives to a log, and `implementation_plan.md` §3.4a
 * spells out "no truncation" as one of the three rules of this item.
 */
export function formatDiagnostics(
  diagnostics: readonly ProviderDiagnostic[] | undefined,
): string[] {
  const lines: string[] = [];
  for (const [index, diagnostic] of (diagnostics ?? []).entries()) {
    const err = diagnostic.error;
    const head = [
      err?.name ?? "Error",
      err?.code !== undefined ? `[${err.code}]` : undefined,
      err?.message !== undefined ? `: ${err.message}` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join("");
    lines.push(`  diag[${index}] : ${diagnostic.type} — ${head}`);
    if (diagnostic.details !== undefined) {
      lines.push(`             details: ${safeJson(diagnostic.details)}`);
    }
    for (const stackLine of (err?.stack ?? "").split("\n").filter((l) => l.trim().length > 0)) {
      lines.push(`             ${stackLine.trim()}`);
    }
  }
  return lines;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (err) {
    return `(unserialisable: ${describeError(err)})`;
  }
}

export interface SurfaceSinks {
  /** Defaults to stderr — the only channel that exists in `-p` and `--mode json`. */
  readonly log?: (line: string) => void;
  /** Defaults to `process.exitCode`. A seam so tests can assert it without poisoning the run. */
  readonly setExitCode?: (code: number) => void;
  /**
   * Persist the classified block to the session record. No default: a caller with no session to
   * write to (a bare unit test, or a call site not yet threaded through to `pi.appendEntry`) must
   * not be forced to fabricate one, and `surfaceProviderFailure` must not import `ExtensionAPI`
   * just to type a parameter most call sites cannot supply.
   *
   * Without this, `causeChain` reaches an interactive operator's own top-level failures nowhere
   * durable: `hasUI` sessions run inside an alt-screen TUI that never displays raw `stderr`, and
   * `ctx.ui.notify` deliberately carries only `summariseProviderFailure`'s one-line form (below).
   * A dispatched subagent's causeChain still reaches the operator — `pi-subagents` hands the
   * child's whole stderr tail up as the run's own tool-result text, which `failure-slot.ts`
   * promotes and which lands in the session like any other tool output — but that path is a side
   * effect of how dispatch propagates a child's stderr, not something this module arranged, and it
   * says nothing about a failure in the top-level session itself. This sink closes that half.
   */
  readonly appendEntry?: (customType: string, data: unknown) => void;
  /**
   * Persist a headless abort to `providerAbortLogPath()`. Defaults to appending one JSON line
   * (timestamp, pid, provider, model, class, retry counters, message) to that file.
   *
   * A detached `-p`/`--mode json` run has no TUI and its stderr is frequently piped somewhere no
   * one reads until well after the process exits — the non-zero exit code says a run failed, but
   * by itself gives an operator nothing to grep for *why*, or across which provider/model pairs it
   * keeps happening. This sink is the durable side of that: called on the exact same condition as
   * `setExitCode` above, and only there, so it is exactly as noisy as the exit code it explains.
   */
  readonly recordHeadlessAbort?: (line: string) => void;
}

/**
 * Report a failure exactly once, on every channel that exists, and make a headless run fail.
 *
 * The exit code is the half that is easy to get wrong, so here is the evidence
 * (pi-coding-agent 0.84.0, verified 2026-08-07):
 *
 *   - `dist/modes/print-mode.js` sets `exitCode = 1` for an assistant message whose `stopReason`
 *     is `"error"` or `"aborted"` — but the whole branch is inside `if (mode === "text")`. So
 *     `pi -p` is covered natively and **`pi --mode json` returns 0 on a turn that never reached a
 *     model**, which is exactly what `implementation_plan.md` §3.4a forbids. It also inspects only
 *     the LAST message, so a failed turn with anything after it is invisible even in text mode.
 *   - `dist/main.js` applies it as `if (exitCode !== 0) process.exitCode = exitCode` — it never
 *     resets a non-zero code back to 0, so a code set from an extension survives.
 *
 * Hence: set it when there is no UI, which is `-p` and `--mode json` (`07` §4 — `ctx.hasUI` is
 * false in both) and never in interactive mode, where a single failed turn must not poison the
 * exit status of an otherwise normal quit.
 *
 * And never for an attempt the harness is about to retry (`failure.retry.willRetry`). `main.js`
 * never resets a non-zero code back to zero, so setting it on the first of two attempts would
 * make a headless run that RECOVERED exit 1 — `bin/pi-run` would report a failure that did not
 * happen, and every gate downstream of it would agree.
 */
export function surfaceProviderFailure(
  ctx: ExtensionContext | undefined,
  failure: ProviderFailure,
  sinks: SurfaceSinks = {},
): void {
  const block = formatProviderFailure(failure);
  // A failure the harness is about to retry is not the turn's outcome yet, and the three sinks
  // below each have to know that: the session record must not file it under the entry type an
  // operator greps for dead turns, the toast must not shout, and — the one that would be an
  // outright lie — the process must not take a non-zero exit code for a run that then succeeds.
  const retrying = failure.retry?.willRetry === true;
  const write = sinks.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  try {
    write(block);
  } catch {
    // The log sink itself is broken. There is no third channel; losing the block beats
    // throwing out of a message_end handler.
  }
  try {
    sinks.appendEntry?.(retrying ? "provider_retry" : "provider_failure", { classified: block });
  } catch {
    // A broken session write must not turn a reported error into an unreported crash.
  }
  try {
    if (ctx?.hasUI) {
      ctx.ui.notify(
        retrying
          ? `${summariseProviderFailure(failure)} (retrying: attempt ${failure.retry?.attempt} of ${failure.retry?.maxAttempts})`
          : summariseProviderFailure(failure),
        retrying ? "warning" : "error",
      );
    }
  } catch {
    // A closed TUI must not turn a reported error into an unreported crash.
  }
  if (ctx?.hasUI === false && !retrying) {
    try {
      const setExitCode = sinks.setExitCode ?? ((code: number) => void (process.exitCode = code));
      setExitCode(1);
    } catch {
      // Nothing left to do. An unsettable exit code must not become a thrown error.
    }
    try {
      const recordHeadlessAbort = sinks.recordHeadlessAbort ?? defaultRecordHeadlessAbort;
      recordHeadlessAbort(headlessAbortLine(failure));
    } catch {
      // The log file itself is unwritable (e.g. a read-only state root). The exit code already
      // carries the pass/fail signal; losing the "why" must not turn into a thrown error.
    }
  }
}

/** One JSON line for `providerAbortLogPath()`: everything needed to grep an abort without the TUI. */
function headlessAbortLine(failure: ProviderFailure): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    pid: process.pid,
    provider: failure.provider,
    model: failure.model,
    class: failure.klass,
    attempt: failure.retry?.attempt,
    maxAttempts: failure.retry?.maxAttempts,
    streakRestarts: failure.retry?.streakRestarts,
    maxStreakRestarts: failure.retry?.maxStreakRestarts,
    message: failure.message,
  });
}

function defaultRecordHeadlessAbort(line: string): void {
  const path = providerAbortLogPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${line}\n`, "utf8");
}

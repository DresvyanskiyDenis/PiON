/**
 * Provider error surfacing — the deliverable that replaced the cancelled `EXT-08`
 * (`REQ-PRV-32`).
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
import { describeError } from "./once.ts";

/** The five classes fixed by `config/routing.json` -> `onProviderError.errorClasses`. */
export type ProviderErrorClass =
  | "auth" // 401/403, expired or missing credential
  | "quota" // 429/402 with a quota, rate-limit or billing signal
  | "network" // DNS, TLS, proxy, timeout — anything that never reached the model
  | "model-not-found" // the id is not served by this provider (the Databricks endpoint trap, V-30)
  | "policy"; // the provider refused on tenant policy (the V-12 outcome-D shape)

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
  /\bAbortError\b/,
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
 * Map a failure onto one of the five classes.
 *
 * Order is load-bearing and each step is justified:
 *   1. policy — status is unreliable for this class (see POLICY_PATTERNS).
 *   2. model-not-found — a 404, or an explicit "no such model/endpoint" at any status.
 *   3. auth — 401/403 are unambiguous once policy has been excluded.
 *   4. quota — 402/429, or an explicit quota/billing signal at any status.
 *   5. network — 5xx, 408, or a transport-shaped error with no status at all.
 *
 * The status feeding those steps comes from `recoverStatus`, so a status that only ever existed
 * inside the error text steers the class exactly as one read off the wire would.
 *
 * The last resort is `network`, and it is a deliberate choice rather than a guess: with the five
 * classes closed by `routing.json` there is no "unknown", and a response that we cannot classify
 * demonstrably did not produce a usable completion. Nothing is hidden by it — the rendered block
 * always carries the raw status and the untruncated upstream text, so the class is a routing
 * hint, never the evidence.
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

/** The one-line form, for a TUI toast and for grepping a log. */
export function summariseProviderFailure(f: ProviderFailure): string {
  const where = f.midStream
    ? `http ${f.status ?? "2xx"} then stream failure`
    : f.status !== undefined
      ? `http ${f.status}`
      : "no status";
  return `[pi-config] provider call failed: ${f.provider}/${f.model} — ${f.klass} (${where})`;
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
      f.midStream
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
  if (f.cause !== undefined && f.cause !== null) {
    lines.push(`  cause    : ${describeError(f.cause)}`);
  }
  for (const line of formatDiagnostics(f.diagnostics)) {
    lines.push(line);
  }
  lines.push(
    "  policy   : abort — no failover, no substitution, no retry against another provider " +
      "(routing.json onProviderError.policy)",
  );
  return lines.join("\n");
}

/**
 * Render PI's diagnostics. Untruncated on purpose, stack included: this block is the only place
 * a stack trace from a provider failure survives to a log, and "no truncation" is
 * one of the three rules of this item.
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
 *     model**, which is exactly what this item's rules forbid. It also inspects only
 *     the LAST message, so a failed turn with anything after it is invisible even in text mode.
 *   - `dist/main.js` applies it as `if (exitCode !== 0) process.exitCode = exitCode` — it never
 *     resets a non-zero code back to 0, so a code set from an extension survives.
 *
 * Hence: set it when there is no UI, which is `-p` and `--mode json` (`ctx.hasUI` is
 * false in both) and never in interactive mode, where a single failed turn must not poison the
 * exit status of an otherwise normal quit.
 */
export function surfaceProviderFailure(
  ctx: ExtensionContext | undefined,
  failure: ProviderFailure,
  sinks: SurfaceSinks = {},
): void {
  const write = sinks.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  try {
    write(formatProviderFailure(failure));
  } catch {
    // The log sink itself is broken. There is no third channel; losing the block beats
    // throwing out of a message_end handler.
  }
  try {
    if (ctx?.hasUI) ctx.ui.notify(summariseProviderFailure(failure), "error");
  } catch {
    // A closed TUI must not turn a reported error into an unreported crash.
  }
  if (ctx?.hasUI === false) {
    try {
      const setExitCode = sinks.setExitCode ?? ((code: number) => void (process.exitCode = code));
      setExitCode(1);
    } catch {
      // Nothing left to do. An unsettable exit code must not become a thrown error.
    }
  }
}

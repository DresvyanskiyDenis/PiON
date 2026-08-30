// EXT-13 — the wiring in `extensions/credentials.ts`, driven through a fake `ExtensionAPI`.
//
// `provider-error` is tested as a unit elsewhere. What is left, and what this file covers, is the
// part that only exists as event plumbing:
//   * no provider is registered at all — the `local` lane is deleted (owner decision, 2026-08-15)
//     and a built-in must never be re-registered, whose OAuth block that would destroy
//     (`REQ-PRV-22`);
//   * a failed turn is surfaced once, with provider/model/class/message, and a succeeded or
//     user-aborted turn is not surfaced at all;
//   * the observed HTTP status belongs to the request it came from, so a 401 seen on one turn is
//     never attributed to the next one;
//   * the mid-stream 200 — the case `after_provider_response` structurally cannot see — is
//     reported as a stream failure rather than as a healthy `http 200`.
//
// Nothing here reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { id, register } from "../extensions/credentials.ts";

/**
 * A `models.json` that still declares a `providers.local` block. `register()` used to be gated on
 * exactly this — no block, no `local` provider. The gate and the lane are both gone, so this
 * fixture now exists to prove the opposite: even a models.json that still asks for the lane gets
 * nothing.
 */
const LOCAL_LANE_FIXTURE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ext13-models-"));
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify({ providers: { local: { models: [] } } }), "utf8");
  return path;
})();

/* ------------------------------------------------------------------------------------------- *
 * A fake ExtensionAPI / ExtensionContext, structural and deliberately minimal
 * ------------------------------------------------------------------------------------------- */

type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
  readonly providers: Map<string, any>;
  readonly handlers: Map<string, Handler[]>;
  /** Every `pi.sendMessage` — the retry lever (`lib/provider-retry.ts`) and nothing else uses it. */
  readonly sent: Array<{ message: any; options: any }>;
  /** Every `pi.appendEntry` — `provider_failure` for a final failure, `provider_retry` for one
   *  the harness is about to try again. Which of the two is used is load-bearing. */
  readonly entries: Array<{ customType: string; data: any }>;
  registerProvider(name: string, config: any): void;
  on(event: string, handler: Handler): void;
  sendMessage(message: any, options?: any): void;
  appendEntry(customType: string, data?: any): void;
  emit(event: string, payload: any, ctx: any): void;
}

function fakePi(): FakePi {
  const providers = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const entries: Array<{ customType: string; data: any }> = [];
  return {
    providers,
    handlers,
    sent,
    entries,
    registerProvider(name, config) {
      providers.set(name, config);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
}

interface FakeCtx {
  hasUI: boolean;
  readonly notices: Array<{ text: string; level: string }>;
  readonly statuses: Array<[string, string | undefined]>;
  readonly ui: { notify(text: string, level: string): void; setStatus(k: string, v?: string): void };
}

function fakeCtx(hasUI = true): FakeCtx {
  const notices: Array<{ text: string; level: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  return {
    hasUI,
    notices,
    statuses,
    ui: {
      notify: (text, level) => void notices.push({ text, level }),
      setStatus: (k, v) => void statuses.push([k, v]),
    },
  };
}

/** Capture what the module writes to stderr — its default channel for the failure block. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as any).write = (chunk: any) => {
    captured += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as any).write = original;
  }
  return captured;
}

function assistantFailure(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant",
      stopReason: "error",
      provider: "databricks",
      model: "databricks-claude-sonnet-4-5",
      errorMessage: "RESOURCE_DOES_NOT_EXIST: endpoint 'sonnet' not found",
      ...overrides,
    },
  };
}

/**
 * The 2026-08-14 shape, copied off a recorded transcript record and confirmed against a stub
 * gateway that answers 200 with a stream carrying no content delta: a normal-looking assistant
 * message with nothing in it.
 */
function emptyCompletion(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant",
      content: [] as unknown[],
      provider: "litellm",
      model: "gpt-5.6-luna",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      rawStopReason: "stop",
      responseId: "chatcmpl-2e6c1517-8984-4434-9673-a0fb231c5e3f",
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------------------------------------- */

describe("register()", () => {
  it("registers no provider at all — the local lane is gone", () => {
    // Owner decision, 2026-08-15: the live provider set is exactly `github-copilot`, `litellm`
    // and `databricks`, all of them supplied by PI's own registry plus `models.json`. This module
    // used to hand-register a `local` provider pointing at llama-swap. It no longer does, and the
    // point of this assertion is that a later pass cannot quietly put one back.
    const pi = fakePi();
    register(pi as any);
    assert.deepEqual([...pi.providers.keys()], []);
  });

  it("registers nothing even when models.json still declares a providers.local block", () => {
    // The registration used to be gated on this block's presence. The gate is gone with the lane,
    // so a stale or hand-edited models.json cannot revive a provider that nothing else resolves.
    const previous = process.env.PI_CONFIG_MODELS_JSON;
    process.env.PI_CONFIG_MODELS_JSON = LOCAL_LANE_FIXTURE;
    try {
      const pi = fakePi();
      register(pi as any);
      assert.deepEqual([...pi.providers.keys()], []);
    } finally {
      if (previous === undefined) delete process.env.PI_CONFIG_MODELS_JSON;
      else process.env.PI_CONFIG_MODELS_JSON = previous;
    }
  });

  it("never touches a built-in provider — re-registering one destroys its OAuth block", () => {
    // The Copilot lane in particular is already resolved (raw `gho_` token as an apiKey credential
    // plus a `baseUrl` override) and `/login github-copilot` must never run. Nothing in this
    // module may put `github-copilot` back through registerProvider.
    const pi = fakePi();
    register(pi as any);
    for (const builtIn of ["github-copilot", "anthropic", "databricks", "litellm"]) {
      assert.equal(pi.providers.has(builtIn), false, `${builtIn} must not be re-registered`);
    }
  });

  it("arms no session_start or session_shutdown handler — nothing is warmed up any more", () => {
    // The only reason this module ever subscribed to the session lifecycle was the local lane's
    // warm-up ping and its footer status marker. Both are deleted; no replacement warning was
    // invented, because a provider that does not exist cannot be unreachable.
    const pi = fakePi();
    register(pi as any);
    assert.equal(pi.handlers.has("session_start"), false);
    assert.equal(pi.handlers.has("session_shutdown"), false);
  });

  it("starts no timers, sockets or watchers — the factory also runs for `pi --list-models`", () => {
    const pi = fakePi();
    const before = (process as any)._getActiveHandles?.().length ?? 0;
    register(pi as any);
    const after_ = (process as any)._getActiveHandles?.().length ?? 0;
    assert.equal(after_, before);
  });

  it("exports a stable module id", () => {
    assert.equal(id, "credentials");
  });
});

describe("provider error surfacing on message_end", () => {
  function drive(
    events: Array<[string, any]>,
  ): { out: string; ctx: FakeCtx } {
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();
    const out = captureStderr(() => {
      for (const [name, payload] of events) pi.emit(name, payload, ctx);
    });
    return { out, ctx };
  }

  it("names provider, model, class and message, and states that nothing was substituted", () => {
    const { out, ctx } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      ["after_provider_response", { type: "after_provider_response", status: 404, headers: {} }],
      ["message_end", assistantFailure()],
    ]);
    assert.match(out, /provider : databricks/);
    assert.match(out, /model {4}: databricks-claude-sonnet-4-5/);
    assert.match(out, /class {4}: model-not-found/);
    assert.match(out, /RESOURCE_DOES_NOT_EXIST/);
    assert.match(out, /no failover, no substitution, no retry/);
    assert.equal(ctx.notices.length, 1);
    assert.equal(ctx.notices[0]?.level, "error");
  });

  it("says nothing at all for a turn that succeeded", () => {
    const { out, ctx } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      ["after_provider_response", { type: "after_provider_response", status: 200, headers: {} }],
      ["message_end", assistantFailure({ stopReason: "end_turn", errorMessage: undefined })],
    ]);
    assert.equal(out, "");
    assert.deepEqual(ctx.notices, []);
  });

  it("says nothing for a user-aborted turn — Esc is not a provider failure", () => {
    const { out } = drive([
      ["message_end", assistantFailure({ stopReason: "aborted" })],
    ]);
    assert.equal(out, "");
  });

  it("ignores non-assistant messages", () => {
    const { out } = drive([
      ["message_end", { message: { role: "user", stopReason: "error", errorMessage: "x" } }],
    ]);
    assert.equal(out, "");
  });

  it("does not attribute a previous turn's status to a later failure", () => {
    // Without the reset on before_provider_request, the 401 below would be remembered and the
    // second failure — which never reached the provider at all — would be reported as `auth`.
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();
    const out = captureStderr(() => {
      pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
      pi.emit("after_provider_response", { type: "after_provider_response", status: 401 }, ctx);
      pi.emit("message_end", assistantFailure({ stopReason: "end_turn" }), ctx);
      pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
      pi.emit(
        "message_end",
        assistantFailure({ errorMessage: "TypeError: fetch failed" }),
        ctx,
      );
    });
    assert.match(out, /class {4}: network/);
    assert.match(out, /http {5}: \(no status/);
    assert.doesNotMatch(out, /http {5}: 401/);
  });

  it("reports a 200 that died mid-stream as a stream failure, not as a healthy 200", () => {
    // `after_provider_response` fires on the response headers, before the body is consumed, so a
    // stream that fails afterwards arrives here with status 200. Reporting a bare `http 200` on a
    // failed turn would be the single most misleading line this module could print.
    const { out } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      ["after_provider_response", { type: "after_provider_response", status: 200, headers: {} }],
      [
        "message_end",
        assistantFailure({ errorMessage: "terminated: socket hang up mid-stream" }),
      ],
    ]);
    assert.match(out, /headers ok; the stream failed after them/);
    assert.match(out, /class {4}: network/);
  });

  it("sets a non-zero exit code in headless mode, through the real production sink", () => {
    // The unit test in ext-13-provider-error.test.ts injects a sink; this one exercises the
    // default path end to end, so `process.exitCode` really is what the wiring touches. It is
    // saved and restored, because leaving it set would fail this very test run.
    const previous = process.exitCode;
    try {
      const pi = fakePi();
      register(pi as any);
      const ctx = fakeCtx(false);
      captureStderr(() => pi.emit("message_end", assistantFailure(), ctx));
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previous;
    }
  });

  it("still reports when the provider and model are unknown", () => {
    const { out } = drive([
      ["message_end", assistantFailure({ provider: undefined, model: undefined })],
    ]);
    assert.match(out, /\(unknown provider\)/);
    assert.match(out, /\(unknown model\)/);
  });

  it("reports a 200 that carried no completion, instead of letting it pass as a normal turn", () => {
    // The 2026-08-14 subagent failures. `stopReason` is `"stop"`, so neither the `error` branch
    // above nor PI's own `isRetryableAssistantError` sees anything wrong; the only trace is the
    // shape of the message. Left unreported, it reaches `pi-subagents` as an exit-0 run with no
    // final text and is renamed there into "possible model cold-start or empty response".
    const { out, ctx } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      ["after_provider_response", { type: "after_provider_response", status: 200, headers: {} }],
      ["message_end", emptyCompletion()],
    ]);
    assert.match(out, /class {4}: empty-response/);
    assert.match(out, /provider : litellm/);
    assert.match(out, /model {4}: gpt-5\.6-luna/);
    assert.match(out, /0 content parts/);
    assert.match(out, /responseId=chatcmpl-2e6c1517-8984-4434-9673-a0fb231c5e3f/);
    assert.doesNotMatch(out, /cold[- ]start/i);
    // The second guessed cause, refuted 2026-08-14 by a 549-reproduction probe and by `pi-ai`
    // pre-initialising `usage` to zero. Pinned end-to-end here, as the cold-start guess is.
    assert.doesNotMatch(out, /did not reach/i);
    assert.doesNotMatch(out, /billed/i);
    assert.equal(ctx.notices.length, 1);
  });

  it("carries the gateway's correlation headers into the empty-response report", () => {
    // The one part of an empty-200 report that is actionable on the other side of the gateway: with
    // no body to quote, `x-litellm-call-id` is what a proxy admin greps their own logs for. These
    // were being discarded one line from where they were needed.
    const { out } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      [
        "after_provider_response",
        {
          type: "after_provider_response",
          status: 200,
          headers: {
            "x-litellm-call-id": "3f2b19c4-6a1e-4c7d-9b02-2f5d8e41ab77",
            "X-LiteLLM-Model-Id": "example-deployment/gpt-5.6-luna-2",
            "x-litellm-response-duration-ms": "1174",
            "x-litellm-version": "1.89.7",
            "x-litellm-key-spend": "0.0",
            "content-type": "text/event-stream",
          },
        },
      ],
      ["message_end", emptyCompletion()],
    ]);
    assert.match(out, /gateway {2}: x-litellm-call-id=3f2b19c4-6a1e-4c7d-9b02-2f5d8e41ab77/);
    // Header names are case-insensitive by spec, and what lands on the event is whatever the fetch
    // implementation keyed them by. A capture that only matched lower-case would miss this one.
    assert.match(out, /x-litellm-model-id=example-deployment\/gpt-5\.6-luna-2/);
    assert.match(out, /x-litellm-response-duration-ms=1174/);
    assert.match(out, /x-litellm-version=1\.89\.7/);
    // Allow-list, not an `x-litellm-*` sweep: this block reaches logs and Telegram, and the key
    // headers are spend and credential metadata.
    assert.doesNotMatch(out, /x-litellm-key-spend/);
    assert.doesNotMatch(out, /content-type/);
  });

  it("omits the gateway line entirely when the response carried none of those headers", () => {
    // An absent header must not render as empty or `undefined` — that reads as a value the gateway
    // sent, and the whole point of the line is that it is quotable evidence.
    const { out } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      ["after_provider_response", { type: "after_provider_response", status: 200, headers: { "content-type": "x" } }],
      ["message_end", emptyCompletion()],
    ]);
    assert.match(out, /class {4}: empty-response/);
    assert.doesNotMatch(out, /gateway/);
    assert.doesNotMatch(out, /undefined/);
  });

  it("does not attribute one turn's headers to the next turn's failure", () => {
    // The headers ride on the same `observed` record as the status, so the existing
    // `before_provider_request` reset covers both. A second subscriber with its own lifetime is
    // exactly how this would rot.
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();
    const out = captureStderr(() => {
      pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
      pi.emit(
        "after_provider_response",
        { type: "after_provider_response", status: 200, headers: { "x-litellm-call-id": "first-turn" } },
        ctx,
      );
      pi.emit("message_end", assistantFailure({ stopReason: "end_turn", errorMessage: undefined }), ctx);
      pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
      pi.emit("message_end", emptyCompletion(), ctx);
    });
    assert.match(out, /class {4}: empty-response/);
    assert.doesNotMatch(out, /first-turn/);
  });

  it("keeps quiet for a normal turn that actually said something", () => {
    // The counter-example set for the check above: across the 19 successful subagent runs in
    // `.pi-subagents/artifacts/`, 304 assistant messages, none with an empty `content`.
    const { out, ctx } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      ["after_provider_response", { type: "after_provider_response", status: 200, headers: {} }],
      [
        "message_end",
        emptyCompletion({ content: [{ type: "text", text: "done" }], usage: { input: 68, output: 3609 } }),
      ],
    ]);
    assert.equal(out, "");
    assert.deepEqual(ctx.notices, []);
  });

  it("names the reasoning effort that actually reached the wire", () => {
    // The metadata of the runs this fix comes from says `litellm/gpt-5.6-luna:max`, and the
    // gateway answers 400 to `max` — which made the level the obvious suspect and cost a live
    // probe to clear. `ctx.thinkingLevel` is post-clamp, so printing it settles that in one line.
    const pi = fakePi();
    register(pi as any);
    const ctx = { ...fakeCtx(), thinkingLevel: "high" };
    const out = captureStderr(() => pi.emit("message_end", emptyCompletion(), ctx));
    assert.match(out, /reasoning effort=high/);
  });

  it("fails a headless child on an empty completion — but only once the retry budget is spent", () => {
    // A subagent child runs `pi --mode json -p`, and PI's own non-zero-exit branch is gated on
    // text mode. Without this, the child exits 0 with no output and `pi-subagents` invents a
    // cause for it.
    //
    // AMENDED 2026-08-30: `empty-response` is retried once first (`onProviderError.retry`), and
    // the exit code must not be set on an attempt that is about to be retried — `main.js` never
    // resets a non-zero code back to 0, so a run that RECOVERED would still exit 1 and every gate
    // reading that code would report a failure that did not happen. The invariant this test
    // guards is unchanged: a child that ENDS on an empty completion exits non-zero.
    const previous = process.exitCode;
    try {
      const pi = fakePi();
      register(pi as any);
      const ctx = fakeCtx(false);
      process.exitCode = undefined;

      captureStderr(() => pi.emit("message_end", emptyCompletion(), ctx));
      assert.equal(process.exitCode, undefined, "the retried attempt must not fail the run");
      assert.equal(pi.sent.length, 1, "the turn is re-issued");
      assert.equal(pi.sent[0]?.options?.triggerTurn, true);
      assert.deepEqual(pi.entries.map((e) => e.customType), ["provider_retry"]);

      captureStderr(() => pi.emit("message_end", emptyCompletion(), ctx));
      assert.equal(process.exitCode, 1, "the second one is the outcome, and it is a failure");
      assert.equal(pi.sent.length, 1, "the budget is one retry, not one per failure");
      assert.deepEqual(pi.entries.map((e) => e.customType), ["provider_retry", "provider_failure"]);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("onProviderError.retry — the wiring", () => {
  /** The text of the failure block, plus what the extension did about it. */
  function run(pi: FakePi, ctx: any, ...events: Array<{ status?: number; end: any }>) {
    const blocks: string[] = [];
    for (const event of events) {
      if (event.status !== undefined) pi.emit("after_provider_response", { status: event.status }, ctx);
      blocks.push(captureStderr(() => pi.emit("message_end", event.end, ctx)));
    }
    return blocks;
  }

  it("re-issues an empty completion exactly once, then aborts", () => {
    // The 2026-08-30 evidence: an empty 200 in the middle of otherwise healthy traffic killed a
    // lead turn on one provider and a dispatched subagent mid-mission on another. One more attempt
    // at the same endpoint recovers the first shape; a second empty body is not weather any more
    // and the operator has to hear about it.
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();

    const [first, second] = run(pi, ctx, { end: emptyCompletion() }, { end: emptyCompletion() });

    assert.match(first!, /retry 1 of 1 — transient class, re-issued against the same provider and model/);
    assert.equal(pi.sent.length, 1, "exactly one re-issue");
    assert.equal(pi.sent[0]?.options?.deliverAs, "followUp");
    assert.equal(pi.sent[0]?.options?.triggerTurn, true, "a queued message that triggers no turn is a hang");
    assert.equal(pi.sent[0]?.message?.display, true, "a turn that silently ran twice is unreadable");
    assert.match(pi.sent[0]?.message?.content?.[0]?.text ?? "", /attempt 2/);
    assert.match(pi.sent[0]?.message?.content?.[0]?.text ?? "", /no other\s+provider was tried/);

    assert.match(second!, /abort after 2 attempts/);
    assert.equal(pi.sent.length, 1, "the budget is one retry per streak, not one per failure");
    assert.deepEqual(pi.entries.map((e) => e.customType), ["provider_retry", "provider_failure"]);
  });

  it("never retries an auth failure — the credential was just rejected", () => {
    // Re-presenting a credential a 401 has just refused asks the same question one round trip
    // later. `quota`, `model-not-found` and `policy` are the same kind of answer; `policy` on a
    // loop is additionally how an account gets flagged.
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();

    const [block] = run(pi, ctx, {
      status: 401,
      end: assistantFailure({ errorMessage: "401 Unauthorized: invalid api key" }),
    });

    assert.match(block!, /class {4}: auth/);
    assert.match(block!, /policy {3}: abort — no failover/, "the pre-retry line, unchanged");
    assert.doesNotMatch(block!, /retry \d of/);
    assert.deepEqual(pi.sent, [], "nothing is re-issued");
    assert.deepEqual(pi.entries.map((e) => e.customType), ["provider_failure"]);
  });

  it("restores the budget after a turn that worked", () => {
    // The budget belongs to a streak of consecutive failures, not to the session: a transient
    // failure an hour after a recovered one is a new coin flip.
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();

    run(
      pi,
      ctx,
      { end: emptyCompletion() },
      { end: { message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" } } },
      { end: emptyCompletion() },
    );

    assert.equal(pi.sent.length, 2, "the second streak gets its own retry");
    assert.deepEqual(pi.entries.map((e) => e.customType), ["provider_retry", "provider_retry"]);
  });

  it("gives a forked or switched session a full budget", () => {
    const pi = fakePi();
    register(pi as any);
    const first = { ...fakeCtx(), sessionManager: { getSessionId: () => "session-a" } };
    const second = { ...fakeCtx(), sessionManager: { getSessionId: () => "session-b" } };

    run(pi, first, { end: emptyCompletion() });
    run(pi, second, { end: emptyCompletion() });

    assert.equal(pi.sent.length, 2);
  });
});

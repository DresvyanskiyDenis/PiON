// EXT-13 — the wiring in `extensions/credentials.ts`, driven through a fake `ExtensionAPI`.
//
// `local-catalogue` and `provider-error` are tested as units elsewhere. What is left, and what
// this file covers, is the part that only exists as event plumbing:
//   * exactly one provider is registered, and it is `local` — never a built-in, whose OAuth block
//     re-registration would destroy (`REQ-PRV-22`);
//   * a failed turn is surfaced once, with provider/model/class/message, and a succeeded or
//     user-aborted turn is not surfaced at all;
//   * the observed HTTP status belongs to the request it came from, so a 401 seen on one turn is
//     never attributed to the next one;
//   * the mid-stream 200 — the case `after_provider_response` structurally cannot see — is
//     reported as a stream failure rather than as a healthy `http 200`.
//
// Nothing here reaches the network except a local `http.createServer` on port 0.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { id, register, warmUp } from "../extensions/credentials.ts";

const PI_LLAMA_CPP_CONSTANTS = fileURLToPath(
  new URL("../node_modules/pi-llama-cpp/src/constants.ts", import.meta.url),
);

/* ------------------------------------------------------------------------------------------- *
 * A fake ExtensionAPI / ExtensionContext, structural and deliberately minimal
 * ------------------------------------------------------------------------------------------- */

type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
  readonly providers: Map<string, any>;
  readonly handlers: Map<string, Handler[]>;
  registerProvider(name: string, config: any): void;
  on(event: string, handler: Handler): void;
  emit(event: string, payload: any, ctx: any): void;
}

function fakePi(): FakePi {
  const providers = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  return {
    providers,
    handlers,
    registerProvider(name, config) {
      providers.set(name, config);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
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
      provider: "openai",
      model: "gpt-5.6-luna",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      rawStopReason: "stop",
      responseId: "chatcmpl-2e6c1517-8984-4434-9673-a0fb231c5e3f",
      ...overrides,
    },
  };
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/v1`;
}

/* ------------------------------------------------------------------------------------------- */

describe("register()", () => {
  it("registers the `local` provider and nothing else", () => {
    const pi = fakePi();
    register(pi as any);
    assert.deepEqual([...pi.providers.keys()], ["local"]);
  });

  it("never touches a built-in provider — re-registering one destroys its OAuth block", () => {
    // The Copilot lane in particular is already resolved (raw `gho_` token as an apiKey credential
    // plus a `baseUrl` override) and `/login github-copilot` must never run. Nothing in this
    // module may put `github-copilot` or `openai` back through registerProvider.
    const pi = fakePi();
    register(pi as any);
    for (const builtIn of ["github-copilot", "openai", "anthropic", "databricks"]) {
      assert.equal(pi.providers.has(builtIn), false, `${builtIn} must not be re-registered`);
    }
  });

  it("declares no apiKey — models.json owns the credential", () => {
    // The key belongs to the BACKEND, and only the backend knows whether it needs one: a bare
    // llama-swap front door usually leaves `GET /v1/models` open, while a hosted OpenAI-compatible
    // endpoint serving the same GGUFs enforces a bearer token — measured against one such endpoint:
    // no header → 401 `Not authenticated`, a placeholder value → 401 `Invalid token payload`, the
    // real key → 200. So the literal this used to declare was not just misplaced, it was wrong.
    // `config/providers/local.json` owns the `apiKey` field (the `{{apiKey}}` answer, defaulting to
    // the inert `not-required`) and must be the ONLY place it lives: an extension-declared key is
    // not a harmless duplicate
    // — `configuredApiKey()` in provider-composer.js reads `extension?.apiKey ?? config?.apiKey`,
    // so it overrides models.json outright.
    const pi = fakePi();
    register(pi as any);
    assert.equal(pi.providers.get("local").apiKey, undefined);
    assert.equal(pi.providers.get("local").api, "openai-completions");
  });

  it("starts no timers, sockets or watchers — the factory also runs for `pi --list-models`", () => {
    const pi = fakePi();
    const before = (process as any)._getActiveHandles?.().length ?? 0;
    register(pi as any);
    const after_ = (process as any)._getActiveHandles?.().length ?? 0;
    assert.equal(after_, before);
    // All I/O is deferred to session_start and refreshModels.
    assert.ok(pi.handlers.has("session_start"));
    assert.ok(pi.handlers.has("session_shutdown"));
  });

  it("exports a stable module id", () => {
    assert.equal(id, "credentials");
  });
});

describe("the warm-up ping", () => {
  it("marks the lane healthy and says nothing when llama-swap answers", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "unsloth/GLM-4.7-Flash-GGUF" }] }));
    });
    const previous = process.env.PI_LOCAL_BASE_URL;
    process.env.PI_LOCAL_BASE_URL = base;
    const ctx = fakeCtx();
    try {
      await warmUp(ctx as any);
    } finally {
      if (previous === undefined) delete process.env.PI_LOCAL_BASE_URL;
      else process.env.PI_LOCAL_BASE_URL = previous;
    }
    assert.deepEqual(ctx.statuses, [["local", "local ✓"]]);
    assert.deepEqual(ctx.notices, []);
  });

  it("warns once and never throws when llama-swap is absent", async () => {
    // This is the environment-specific half of the item: a colleague without llama-swap must
    // still be able to start the agent. `routing.json` marks the tier optional, so an unreachable
    // server is information, not an error anybody has to act on.
    const previous = process.env.PI_LOCAL_BASE_URL;
    process.env.PI_LOCAL_BASE_URL = "http://127.0.0.1:1/v1";
    const ctx = fakeCtx();
    try {
      await warmUp(ctx as any);
    } finally {
      if (previous === undefined) delete process.env.PI_LOCAL_BASE_URL;
      else process.env.PI_LOCAL_BASE_URL = previous;
    }
    assert.deepEqual(ctx.statuses, [["local", "local ✗"]]);
    assert.equal(ctx.notices.length, 1);
    assert.equal(ctx.notices[0]?.level, "warning");
    assert.match(ctx.notices[0]?.text ?? "", /every other provider is unaffected/);
  });

  it("falls back to stderr with no UI, so `-p` and `--mode json` still say it", async () => {
    const previous = process.env.PI_LOCAL_BASE_URL;
    process.env.PI_LOCAL_BASE_URL = "http://127.0.0.1:1/v1";
    const ctx = fakeCtx(false);
    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      captured += String(chunk);
      return true;
    };
    try {
      await warmUp(ctx as any);
    } finally {
      (process.stderr as any).write = original;
      if (previous === undefined) delete process.env.PI_LOCAL_BASE_URL;
      else process.env.PI_LOCAL_BASE_URL = previous;
    }
    assert.match(captured, /local provider unreachable/);
  });

  it("is fired at most once per session and cleared on shutdown", () => {
    const pi = fakePi();
    register(pi as any);
    const ctx = fakeCtx();
    pi.emit("session_start", { type: "session_start" }, ctx);
    pi.emit("session_start", { type: "session_start" }, ctx);
    pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    // Two starts, one shutdown: the shutdown clears the marker and no second ping was armed.
    assert.deepEqual(
      ctx.statuses.filter(([, value]) => value === undefined),
      [["local", undefined]],
    );
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
    assert.match(out, /provider : openai/);
    assert.match(out, /model {4}: gpt-5\.6-luna/);
    assert.match(out, /0 content parts/);
    assert.match(out, /responseId=chatcmpl-2e6c1517-8984-4434-9673-a0fb231c5e3f/);
    assert.doesNotMatch(out, /cold[- ]start/i);
    assert.equal(ctx.notices.length, 1);
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

  it("carries the gateway's correlation headers from after_provider_response into the report", () => {
    // `after_provider_response` fires before the body, `message_end` fires after — the headers
    // captured in between are the only proof, on the OTHER side of the gateway, of which request
    // this was. Losing them between the two events would make an empty-200 report unactionable.
    const { out } = drive([
      ["before_provider_request", { type: "before_provider_request", payload: {} }],
      [
        "after_provider_response",
        {
          type: "after_provider_response",
          status: 200,
          headers: { "x-litellm-call-id": "req-9f3a", "x-litellm-key-hash": "must-not-appear" },
        },
      ],
      ["message_end", emptyCompletion()],
    ]);
    assert.match(out, /gateway {2}: x-litellm-call-id=req-9f3a/);
    assert.doesNotMatch(out, /must-not-appear/);
  });

  it("names the reasoning effort that actually reached the wire", () => {
    // The metadata of the runs this fix comes from says `openai/gpt-5.6-luna:max`, and the
    // gateway answers 400 to `max` — which made the level the obvious suspect and cost a live
    // probe to clear. `ctx.thinkingLevel` is post-clamp, so printing it settles that in one line.
    const pi = fakePi();
    register(pi as any);
    const ctx = { ...fakeCtx(), thinkingLevel: "high" };
    const out = captureStderr(() => pi.emit("message_end", emptyCompletion(), ctx));
    assert.match(out, /reasoning effort=high/);
  });

  it("fails a headless child on an empty completion — the exit code is how dispatch hears about it", () => {
    // A subagent child runs `pi --mode json -p`, and PI's own non-zero-exit branch is gated on
    // text mode. Without this, the child exits 0 with no output and `pi-subagents` invents a
    // cause for it.
    const previous = process.exitCode;
    try {
      const pi = fakePi();
      register(pi as any);
      const ctx = fakeCtx(false);
      captureStderr(() => pi.emit("message_end", emptyCompletion(), ctx));
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("coexistence with pi-llama-cpp 0.9.1", () => {
  // The plan adopts `pi-llama-cpp` for the local lane. It is installed and pinned, and it is NOT
  // the owner of the provider id `local` — these assertions pin why, so that a later integration
  // pass cannot delete the hand-registered provider on the assumption that the package covers it.
  const constants = readFileSync(PI_LLAMA_CPP_CONSTANTS, "utf8");

  it("uses a different provider prefix, so the two never collide", () => {
    const prefix = /PROVIDER_PREFIX = "([^"]+)"/.exec(constants)?.[1];
    assert.equal(prefix, "llama-server");
    assert.notEqual(prefix, "local");
  });

  it("defaults to :8080, not the llama-swap port routing.json's tier depends on", () => {
    assert.match(constants, /DEFAULT_LLAMA_SERVER_URL = "http:\/\/127\.0\.0\.1:8080"/);
  });

  it("never reads models.json, which is where every local model's tuning lives", () => {
    // `config/models.json` carries per-model `samplingParams`, `compat.thinkingFormat` and the
    // tuned context windows, plus the provider-level `supportsDeveloperRole: false`. The package
    // builds its catalogue from the server alone, so adopting it AS the `local` provider would
    // silently drop all of it — which is exactly what `mergeLocalCatalogue` exists to prevent.
    const sources = readFileSync(
      fileURLToPath(new URL("../node_modules/pi-llama-cpp/src/resolver.ts", import.meta.url)),
      "utf8",
    );
    assert.doesNotMatch(sources, /models\.json/);
    assert.doesNotMatch(constants, /models\.json/);
  });
});

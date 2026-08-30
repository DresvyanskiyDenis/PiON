import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildFirstExchange,
  extractTitle,
  id,
  register,
  resolveTitleModel,
} from "../../extensions/auto-title/index.ts";

const ROUTING_PATH = fileURLToPath(new URL("../../config/routing.default.json", import.meta.url));

test("id is stable", () => {
  assert.equal(id, "auto-title");
});

test("buildFirstExchange joins user/assistant text, ignoring other entry types", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "help me port the web extension" }] } },
    { type: "custom", message: undefined },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure, here is a plan" }] } },
  ];
  const out = buildFirstExchange(entries);
  assert.equal(out, "help me port the web extension\n---\nsure, here is a plan");
});

test("buildFirstExchange caps at the first 4 message entries and truncates each to 600 chars", () => {
  const long = "x".repeat(1000);
  const entries = Array.from({ length: 6 }, (_, i) => ({
    type: "message",
    message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: long }] },
  }));
  const out = buildFirstExchange(entries);
  const parts = out.split("\n---\n");
  assert.equal(parts.length, 4);
  for (const p of parts) assert.equal(p.length, 600);
});

test("buildFirstExchange returns empty string for a session with no text messages", () => {
  assert.equal(buildFirstExchange([]), "");
  assert.equal(buildFirstExchange([{ type: "message", message: { role: "assistant", content: [] } }]), "");
});

test("extractTitle strips quotes and enforces min/max length", () => {
  assert.equal(extractTitle('"Port web-search extension to PI"'), "Port web-search extension to PI");
  assert.equal(extractTitle("  \n  Fix flaky auth test  \n"), "Fix flaky auth test");
  assert.equal(extractTitle("ab"), undefined); // below MIN_TITLE_CHARS
  assert.equal(extractTitle(undefined), undefined);
  assert.equal(extractTitle(""), undefined);
});

test("extractTitle takes the last non-empty line (models sometimes preface with reasoning)", () => {
  assert.equal(extractTitle("Sure, here it is:\nRefactor session titling"), "Refactor session titling");
});

test("extractTitle truncates to 60 chars", () => {
  const long = "T".repeat(120);
  const out = extractTitle(long);
  assert.equal(out?.length, 60);
});

// --- F3/F4-shaped behavioural tests against a fake ExtensionAPI/ExtensionContext ---

type FakeExec = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string } | undefined>;

function makeHarness(execImpl: FakeExec, branch: unknown[], initialName?: string) {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  let name = initialName;

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    getSessionName: () => name,
    setSessionName: (n: string) => {
      name = n;
    },
    exec: execImpl,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  register(pi);

  const ctx = { sessionManager: { getBranch: () => branch } };

  return {
    fireSessionStart: () => handlers["session_start"]?.forEach((h) => h({}, ctx)),
    fireTurnEnd: async (turnIndex: number) => {
      for (const h of handlers["turn_end"] ?? []) await h({ turnIndex }, ctx);
    },
    getName: () => name,
  };
}

test("F1: titles by turn 2 from a substantial first exchange", async () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "help me port the OpenCode web-search extension to PI" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "here is a plan for the port" }] } },
  ];
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    return { stdout: "Port web-search extension to PI" };
  }, branch);

  await h.fireTurnEnd(2);
  assert.equal(calls, 1);
  assert.equal(h.getName(), "Port web-search extension to PI");
});

test("F2: an explicitly named session is never overwritten", async () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "help me port the OpenCode web-search extension to PI" }] } },
  ];
  let calls = 0;
  const h = makeHarness(
    async () => {
      calls += 1;
      return { stdout: "Some other title" };
    },
    branch,
    "my important session",
  );

  await h.fireTurnEnd(2);
  assert.equal(calls, 0);
  assert.equal(h.getName(), "my important session");
});

test("F3: a dead title endpoint (exec rejects/times out) never throws and leaves the session untitled", async () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "help me port the OpenCode web-search extension to PI" }] } },
  ];
  const h = makeHarness(async () => {
    throw new Error("ETIMEDOUT");
  }, branch);

  await assert.doesNotReject(h.fireTurnEnd(2));
  assert.equal(h.getName(), undefined);
});

test("F4: fires at most once per session even if turn_end re-enters", async () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "help me port the OpenCode web-search extension to PI" }] } },
  ];
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    return { stdout: "Port web-search extension to PI" };
  }, branch);

  await Promise.all([h.fireTurnEnd(2), h.fireTurnEnd(3), h.fireTurnEnd(4)]);
  assert.equal(calls, 1);
});

test("does not title on a short/trivial first exchange", async () => {
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }];
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    return { stdout: "irrelevant" };
  }, branch);

  await h.fireTurnEnd(2);
  assert.equal(calls, 0);
  assert.equal(h.getName(), undefined);
});

// --- which model titles a session, and what happens when it cannot be resolved ---

test("the default model is the live `light` tier from the shipped routing table, not a literal", () => {
  // The shape this guards: a model id frozen into the source of this module. It outlives the seat,
  // the tier and the catalogue that made it correct, and when it stops being served nothing here
  // notices. Resolving through the routing table means a retired or repointed tier takes it along.
  const routing = JSON.parse(readFileSync(ROUTING_PATH, "utf8")) as { tiers: Record<string, { model: string }> };
  const resolved = resolveTitleModel({} as NodeJS.ProcessEnv);
  assert.equal(resolved.source, "routing.json");
  assert.equal(resolved.model, routing.tiers.light?.model);
  assert.match(resolved.model ?? "", /^[^/]+\/[^/]+$/);
});

test("no literal survives in the module: every tier's model comes out of the routing table", () => {
  // Not "is not <one dead id>" — that only ever catches the literal someone already removed. The
  // check that keeps working is that the resolved id is one the shipped table actually declares.
  const routing = JSON.parse(readFileSync(ROUTING_PATH, "utf8")) as { tiers: Record<string, { model: string }> };
  const declared = Object.values(routing.tiers).map((t) => t.model);
  assert.ok(declared.includes(resolveTitleModel({} as NodeJS.ProcessEnv).model ?? ""));
});

test("PI_TITLE_MODEL still wins, and is rejected when it is not a provider/id", () => {
  assert.deepEqual(resolveTitleModel({ PI_TITLE_MODEL: "litellm/gpt-5.6-luna" } as NodeJS.ProcessEnv), {
    model: "litellm/gpt-5.6-luna",
    source: "PI_TITLE_MODEL",
  });
  const bad = resolveTitleModel({ PI_TITLE_MODEL: "gpt-5.6-luna" } as NodeJS.ProcessEnv);
  assert.equal(bad.model, undefined);
  assert.match(bad.problem ?? "", /not a provider\/id/);
});

test("an unreadable routing.json yields no model and a stated reason — never a guessed default", () => {
  const resolved = resolveTitleModel({} as NodeJS.ProcessEnv, {
    raw: undefined,
    source: "<absent>",
    problem: "routing.json not found",
  });
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.source, "none");
  assert.match(resolved.problem ?? "", /no "light" tier/);
  assert.match(resolved.problem ?? "", /PI_TITLE_MODEL/);
});

test("a routing.json whose light tier carries no usable model is refused, not half-used", () => {
  const resolved = resolveTitleModel({} as NodeJS.ProcessEnv, {
    raw: { tiers: { light: { model: "not-a-provider-id" } } },
    source: "/fixture/routing.json",
  });
  assert.equal(resolved.model, undefined);
  assert.match(resolved.problem ?? "", /\/fixture\/routing\.json/);
});

/**
 * `EXT-30` — the wiring: what `register(pi)` actually binds, and what `session_start` does with
 * the verdict. The decision and verdict rules themselves are covered by `decide.test.ts` and
 * `deadman.test.ts`; this file asserts they are reachable from a live-shaped `ExtensionAPI`.
 */
import assert from "node:assert/strict";
import type { ExtensionContext, ProjectTrustEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { id, register } from "../../extensions/trust.ts";
import {
  DECLARED_MODULES,
  manifestReport,
  recordLoad,
  resetManifest,
} from "../../extensions/lib/manifest.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { fakeCtx, fakePi, recorder, toolEvent, writeRootsFile, type FakePi } from "./helpers.ts";

const DECLARED_ROOT = join(sep, "srv", "ext30-declared");

type TrustHandler = (event: ProjectTrustEvent, ctx: unknown) => { trusted: string; remember?: boolean };
type SessionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type ToolHandler = (event: ToolCallEvent, ctx?: unknown) => { block?: boolean; reason?: string } | undefined;

function handler<T>(pi: FakePi, event: string, index = 0): T {
  const list = pi.handlers.get(event);
  assert.ok(list && list[index], `no handler registered for "${event}"[${index}]`);
  return list[index] as unknown as T;
}

/** Every declared module loads except the ones named. */
function loadAllExcept(...skip: string[]): void {
  resetManifest();
  for (const moduleId of DECLARED_MODULES) {
    if (!skip.includes(moduleId)) recordLoad(moduleId);
  }
}

beforeEach(() => {
  resetSurfaced();
  process.env.PI_TRUSTED_ROOTS = writeRootsFile({ version: 1, roots: [DECLARED_ROOT] });
});

afterEach(() => {
  delete process.env.PI_TRUSTED_ROOTS;
  resetManifest();
});

describe("register", () => {
  it("declares the module id lib/manifest.ts expects", () => {
    assert.equal(id, "trust");
    assert.ok((DECLARED_MODULES as readonly string[]).includes(id));
  });

  it("binds project_trust and session_start, and nothing else up front", () => {
    const pi = fakePi();
    register(pi.api);
    assert.deepEqual([...pi.handlers.keys()].sort(), ["project_trust", "session_start"]);
  });

  it("subscribes to guard:ready and sends the guard:whois probe", () => {
    const pi = fakePi();
    register(pi.api);
    assert.ok(pi.busListeners.has("guard:ready"));
    assert.deepEqual(pi.busEmits.map(([channel]) => channel), ["guard:whois"]);
  });
});

describe("the project_trust handler", () => {
  it("answers yes inside the declared root and undecided outside it", () => {
    const pi = fakePi();
    register(pi.api);
    const decide = handler<TrustHandler>(pi, "project_trust");

    assert.deepEqual(decide({ type: "project_trust", cwd: join(DECLARED_ROOT, "repo") }, {}), {
      trusted: "yes",
      remember: false,
    });
    assert.deepEqual(decide({ type: "project_trust", cwd: join(sep, "tmp", "cloned-repo") }, {}), {
      trusted: "undecided",
    });
  });

  it("answers undecided everywhere when the config is unusable — never a blanket yes", () => {
    process.env.PI_TRUSTED_ROOTS = writeRootsFile("{ broken");
    const pi = fakePi();
    register(pi.api);
    const decide = handler<TrustHandler>(pi, "project_trust");
    for (const cwd of [DECLARED_ROOT, join(DECLARED_ROOT, "repo"), sep]) {
      assert.deepEqual(decide({ type: "project_trust", cwd }, {}), { trusted: "undecided" }, cwd);
    }
  });
});

describe("session_start — the deadman", () => {
  it("sets a guard status and blocks nothing when the guardrails loaded", async () => {
    loadAllExcept();
    const pi = fakePi();
    register(pi.api);
    const rec = recorder();
    await handler<SessionHandler>(pi, "session_start")({}, fakeCtx(rec));

    assert.deepEqual(pi.handlers.get("tool_call"), undefined, "no tool_call handler when disarmed");
    assert.deepEqual(rec.statuses, [["guard", "guard on"]]);
    assert.deepEqual(rec.notified, []);
    assert.ok(pi.entries.some(([type]) => type === "trust.session"));
    assert.ok(!pi.entries.some(([type]) => type === "trust.deadman"));
  });

  it("reports the guard version from the handshake when one arrived", async () => {
    loadAllExcept();
    const pi = fakePi();
    register(pi.api);
    for (const listener of pi.busListeners.get("guard:ready") ?? []) {
      listener({ version: "1.0.0", gates: ["SEC", "DB"] });
    }
    const rec = recorder();
    await handler<SessionHandler>(pi, "session_start")({}, fakeCtx(rec));
    assert.deepEqual(rec.statuses, [["guard", "guard 1.0.0"]]);
  });

  it("arms, shouts on every surface and blocks bash when guard is missing", async () => {
    loadAllExcept("guard");
    const pi = fakePi();
    register(pi.api);
    const rec = recorder();
    await handler<SessionHandler>(pi, "session_start")({}, fakeCtx(rec));

    assert.deepEqual(rec.statuses, [["guard", "GUARD OFF"]]);
    assert.equal(rec.notified.length, 1);
    assert.match(rec.notified[0]![0], /GUARDRAILS NOT LOADED/);
    assert.equal(rec.notified[0]![1], "error");

    const audited = pi.entries.find(([type]) => type === "trust.deadman");
    assert.ok(audited, "the deadman must leave an audit entry");

    const block = handler<ToolHandler>(pi, "tool_call");
    assert.equal(block(toolEvent("bash"))?.block, true);
    assert.equal(block(toolEvent("write"))?.block, true);
    // `read` and `grep` return file CONTENT, and the gate that keeps them off ~/.ssh and
    // ~/.cache/pi/dbx-token-* lives in the very module that is missing. See deadman.test.ts.
    assert.equal(block(toolEvent("read"))?.block, true);
    assert.equal(block(toolEvent("grep"))?.block, true);
    assert.equal(block(toolEvent("find")), undefined, "path-only tools stay usable");
  });

  it("records tool_call in its declaration only when armed", async () => {
    loadAllExcept("guard");
    const pi = fakePi();
    register(pi.api);
    await handler<SessionHandler>(pi, "session_start")({}, fakeCtx(recorder()));
    const status = manifestReport().modules.find((m) => m.id === "trust");
    assert.deepEqual([...(status?.events ?? [])].sort(), ["project_trust", "session_start", "tool_call"]);
    assert.ok(status?.heartbeat, "trust must send a heartbeat even while the deadman is armed");
  });

  it("raises the config problem as an error notification, once", async () => {
    process.env.PI_TRUSTED_ROOTS = join(sep, "nonexistent", "trusted-roots.json");
    loadAllExcept();
    const pi = fakePi();
    register(pi.api);
    const rec = recorder();
    const start = handler<SessionHandler>(pi, "session_start");
    await start({}, fakeCtx(rec));
    await start({}, fakeCtx(rec));

    assert.equal(rec.notified.length, 1, "surfaceOnce must dedupe the config complaint");
    assert.match(rec.notified[0]![0], /NOTHING is auto-trusted/);
    assert.equal(rec.notified[0]![1], "error");
  });
});

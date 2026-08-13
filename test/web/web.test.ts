// EXT-07 — extensions/web.ts's session_start handler.
//
// F6 (adversarial security review): a `throw` from a `session_start` handler is caught by PI's
// own runner (`core/extensions/runner.js`'s `emitError`) — the session CONTINUES. So the two
// config-guard asserts here have to call `ctx.shutdown()` themselves to actually refuse, the
// same pattern `extensions/doctor.ts`'s D-06 branch uses. (`extensions/hooks/index.ts` used to be
// the other example; since 2026-08-11 a broken `hooks.yaml` degrades instead of shutting down —
// see `docs/DENYLIST.md` §4a finding #5. A pinned *search backend* is not the same case: there is
// no degraded mode for it, the alternative to refusing is silently querying the wrong provider.)
// `installNetworkDispatcher()` has to run BEFORE those asserts, so a
// refusal never also means "and the corporate proxy/CA bundle silently never got installed".
//
// Isolation follows test/web/config-guard.test.ts: PI_CODING_AGENT_DIR points configDir() and
// pi-web-access's own getWebSearchConfigPath() at the same throwaway directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadUndici } from "../../extensions/web/undici-runtime.ts";

const { getGlobalDispatcher } = loadUndici();

type SessionStartHandler = (
  event: { type: "session_start"; reason: string },
  ctx: ExtensionContext,
) => void | Promise<void>;

function fakePi(): { pi: ExtensionAPI; sessionStart: SessionStartHandler[] } {
  const sessionStart: SessionStartHandler[] = [];
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "session_start") sessionStart.push(handler as SessionStartHandler);
    },
  } as unknown as ExtensionAPI;
  return { pi, sessionStart };
}

interface FakeCtxHandle {
  readonly ctx: ExtensionContext;
  readonly notified: Array<[string, string | undefined]>;
  shutdownCalls: number;
}

function fakeCtx(): FakeCtxHandle {
  const notified: Array<[string, string | undefined]> = [];
  const handle: FakeCtxHandle = { notified, shutdownCalls: 0 } as FakeCtxHandle;
  const ctx = {
    hasUI: true,
    shutdown: () => {
      handle.shutdownCalls += 1;
    },
    ui: {
      notify(message: string, type?: string) {
        notified.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;
  (handle as { ctx: ExtensionContext }).ctx = ctx;
  return handle;
}

let dir: string;
const originalDir = process.env.PI_CODING_AGENT_DIR;
const originalHttpsProxy = process.env.HTTPS_PROXY;

function write(name: string, doc: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(doc));
}

test("web.ts session_start", async (t) => {
  t.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-config-ext07-web-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  t.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
  });

  // Fresh module instance per PI_CODING_AGENT_DIR value — same reasoning as config-guard.test.ts.
  const { register } = await import("../../extensions/web.ts");

  await t.test(
    "assertPinnedSearchBackend fails (web.json missing) -> ctx.shutdown() called once, message names the assertion and the underlying detail, and installNetworkDispatcher() STILL ran first",
    async () => {
      write("web-search.json", { provider: "searxng", toolNames: { fetchContent: "web_fetch" } });
      // No web.json written -> assertPinnedSearchBackend() throws.

      const before = getGlobalDispatcher();
      process.env.HTTPS_PROXY = "http://127.0.0.1:9"; // unreachable on purpose; never actually connected to

      const { pi, sessionStart } = fakePi();
      register(pi);
      assert.equal(sessionStart.length, 1);
      const h = fakeCtx();

      await sessionStart[0]!({ type: "session_start", reason: "test" }, h.ctx);

      assert.equal(h.shutdownCalls, 1, "a failed assert must call ctx.shutdown(), not just throw");
      assert.equal(h.notified.length, 1);
      const [message, level] = h.notified[0]!;
      assert.match(message, /assertPinnedSearchBackend/);
      assert.match(message, /EXT-07's declared-backend file.*web\.json/s);
      assert.equal(level, "error");

      // The regression this test exists for: installNetworkDispatcher() must run BEFORE the
      // asserts, so a refusal still leaves the proxy dispatcher installed.
      assert.notEqual(getGlobalDispatcher(), before, "proxy dispatcher must be installed even though the session was refused");
    },
  );

  await t.test(
    "assertFetchToolAliasedToWebFetch fails (no toolNames alias) -> ctx.shutdown() called once, message names that assertion",
    async () => {
      write("web.json", { version: 1, search: { backend: "searxng" } });
      write("web-search.json", { provider: "searxng" }); // no toolNames.fetchContent override

      const { pi, sessionStart } = fakePi();
      register(pi);
      const h = fakeCtx();

      await sessionStart[0]!({ type: "session_start", reason: "test" }, h.ctx);

      assert.equal(h.shutdownCalls, 1);
      const [message] = h.notified[0]!;
      assert.match(message, /assertFetchToolAliasedToWebFetch/);
      assert.match(message, /toolNames.*fetchContent.*web_fetch/s);
    },
  );

  await t.test("both asserts pass -> ctx.shutdown() is never called", async () => {
    write("web.json", { version: 1, search: { backend: "searxng" } });
    write("web-search.json", { provider: "searxng", toolNames: { fetchContent: "web_fetch" } });

    const { pi, sessionStart } = fakePi();
    register(pi);
    const h = fakeCtx();

    await sessionStart[0]!({ type: "session_start", reason: "test" }, h.ctx);

    assert.equal(h.shutdownCalls, 0);
  });
});

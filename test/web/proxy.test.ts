// EXT-07 — extensions/web/proxy.ts
//
// The proxy-CONNECT test below is not a mock of undici's internals: it is a real TCP server that
// records the first request line it receives, and a real `fetch()` made after
// `installNetworkDispatcher()` has installed the global dispatcher. It is the same technique used
// to answer V-15 empirically against a real `pi` binary before this file was written, reduced to
// something `node --test` can run in milliseconds with no
// network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUndici } from "../../extensions/web/undici-runtime.ts";
import { installNetworkDispatcher } from "../../extensions/web/proxy.ts";

// See extensions/web/undici-runtime.ts's docstring: a bare `import ... from "undici"` does not
// resolve from this repo (it is a nested dependency of @earendil-works/pi-coding-agent, not
// hoisted to the tree root) — the test uses the same resolution path production code uses instead
// of a second, divergent workaround.
const { getGlobalDispatcher } = loadUndici();

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    NODE_EXTRA_CA_CERTS: undefined,
  } as unknown as NodeJS.ProcessEnv;
}

/** A one-shot mock forward proxy: replies 502 to whatever it receives, after recording it. */
async function startMockProxy(): Promise<{ port: number; firstLine: Promise<string>; close: () => Promise<void> }> {
  let resolveFirstLine!: (line: string) => void;
  const firstLine = new Promise<string>((resolve) => {
    resolveFirstLine = resolve;
  });
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\r\n");
      if (idx !== -1) {
        resolveFirstLine(buf.slice(0, idx));
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP port");
  return {
    port: address.port,
    firstLine,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("installNetworkDispatcher: no proxy, no extra CA -> no-op, dispatcher untouched", () => {
  const before = getGlobalDispatcher();
  const result = installNetworkDispatcher(baseEnv());
  assert.deepEqual(result, { proxied: false, extraCa: false });
  assert.equal(getGlobalDispatcher(), before, "must not replace the global dispatcher when unconfigured");
});

test("installNetworkDispatcher: NODE_EXTRA_CA_CERTS pointing at a missing file throws, names the path", () => {
  const env = { ...baseEnv(), NODE_EXTRA_CA_CERTS: "/definitely/not/a/real/path.pem" };
  assert.throws(
    () => installNetworkDispatcher(env),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /NODE_EXTRA_CA_CERTS=\/definitely\/not\/a\/real\/path\.pem/);
      return true;
    },
  );
});

test("installNetworkDispatcher: HTTPS_PROXY + readable NODE_EXTRA_CA_CERTS -> installs, reports both flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-ext07-"));
  try {
    const caPath = join(dir, "corp-ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    const env = { ...baseEnv(), HTTPS_PROXY: "http://127.0.0.1:9", NODE_EXTRA_CA_CERTS: caPath };
    const result = installNetworkDispatcher(env);
    assert.deepEqual(result, { proxied: true, extraCa: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installNetworkDispatcher: a global fetch() after install actually CONNECTs through HTTPS_PROXY", async () => {
  const proxy = await startMockProxy();
  try {
    const env = { ...baseEnv(), HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    const result = installNetworkDispatcher(env);
    assert.equal(result.proxied, true);

    // Real fetch, real dispatcher — the proxy is expected to see the CONNECT before this rejects
    // (our mock proxy always answers 502, so the fetch always fails; what we assert is *how* it
    // failed — it reached the proxy at all).
    await assert.rejects(() => fetch("https://example.invalid/", { signal: AbortSignal.timeout(2000) }));
    const line = await proxy.firstLine;
    assert.match(line, /^CONNECT example\.invalid:443 HTTP\/1\.1$/);
  } finally {
    await proxy.close();
  }
});

test("installNetworkDispatcher: the passed-in env, not ambient process.env, decides the proxy — regression for the EnvHttpProxyAgent env-fallback bug", async () => {
  // undici's EnvHttpProxyAgent falls back to ambient process.env for httpProxy/httpsProxy/noProxy
  // whenever the matching constructor option is omitted (lib/dispatcher/env-http-proxy-agent.js).
  // Passing only { connect, requestTls, proxyTls } (no httpProxy/httpsProxy/noProxy) silently
  // ignores installNetworkDispatcher's own `env` parameter for the one thing it exists to control —
  // reproduced empirically: it degrades to a direct connection whenever the *real* process.env has
  // no proxy set, which hangs a fetch to a non-resolving host instead of failing fast. This test
  // proves the fix: a bogus, unreachable proxy sitting in the REAL process.env.HTTPS_PROXY must be
  // overridden by the mock proxy passed through installNetworkDispatcher's `env` argument.
  const proxy = await startMockProxy();
  const realHttpsProxy = process.env.HTTPS_PROXY;
  try {
    process.env.HTTPS_PROXY = "http://127.0.0.1:1"; // reserved/unreachable — would hang or refuse fast
    const env = { ...baseEnv(), HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    const result = installNetworkDispatcher(env);
    assert.equal(result.proxied, true);

    await assert.rejects(() => fetch("https://example.invalid/", { signal: AbortSignal.timeout(2000) }));
    const line = await proxy.firstLine;
    assert.match(
      line,
      /^CONNECT example\.invalid:443 HTTP\/1\.1$/,
      "the mock proxy from the passed env must receive the CONNECT, not process.env.HTTPS_PROXY's bogus target",
    );
  } finally {
    if (realHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = realHttpsProxy;
    await proxy.close();
  }
});

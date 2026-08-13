/**
 * `EXT-07` §11.5 / V-15 — corporate proxy and CA bundle plumbing for `pi-web-access`'s fetch path.
 *
 * `pi-web-access` performs every network call through the global `fetch` (confirmed by reading
 * `ssrf-protection.ts`: `const fetchImpl = options.fetch ?? fetch`), so one process-wide `undici`
 * dispatcher covers `web_search`, `source_check`, `fetch_content` and `get_search_content` alike —
 * there is no per-tool proxy surface to plumb separately.
 *
 * An earlier draft named three paths for V-15, in preference order. Path 1
 * (`NODE_USE_ENV_PROXY=1` / Node's `--use-env-proxy`) was **verified bad** against the actual
 * installed `~/bin/pi` binary (Node 22.22.3, standalone build): a real `node` CLI given an invalid
 * `NODE_OPTIONS` value refuses to start ("... is not allowed in NODE_OPTIONS", exit 9); the `pi`
 * binary given the *same* invalid value printed its version and exited 0 — it does not parse
 * `NODE_OPTIONS` at all, consistent with a Node Single Executable Application (SEA support for
 * `NODE_OPTIONS` is not implemented). A valid `--use-env-proxy` therefore silently does nothing
 * either. Path 2 (a hand-rolled CONNECT tunnel over `node:https`) was rejected on inspection: it
 * only intercepts classic `http.request`/`https.request` calls, and `fetch()` ignores a legacy
 * `http.Agent` — it needs an object implementing undici's `Dispatcher` interface, which a ~60-line
 * tunnel does not provide. This file is path 3: `setGlobalDispatcher` with undici's
 * `EnvHttpProxyAgent`, which already implements correct `NO_PROXY` matching (subdomain-aware,
 * port-aware) instead of hand-rolling that logic again.
 *
 * `undici` is not a *new* dependency — it is already a direct `dependencies` entry of
 * `@earendil-works/pi-coding-agent@0.84.0` itself (`8.9.0`). It is currently only resolvable at
 * `node_modules/@earendil-works/pi-coding-agent/node_modules/undici` (not hoisted to the tree
 * root), so a bare `"undici"` import does not resolve from this file (`MODULE_NOT_FOUND` at
 * runtime, `TS2307` under `tsc` — both reproduced empirically) — see `./undici-runtime.ts` for the
 * resolution, and the `package.json` follow-up it leaves behind. The old
 * "rejected because it is a third-party dependency" reasoning is void per `pi_agent/CLAUDE.md`'s
 * package-first pivot.
 */
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { loadUndici } from "./undici-runtime.ts";

export interface DispatcherInstallResult {
  readonly proxied: boolean;
  readonly extraCa: boolean;
}

function proxyIsConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

/**
 * Reads `NODE_EXTRA_CA_CERTS` (already exported by `config/shell/pi-env.sh` when the corporate CA
 * file is present) and returns Node's default trust store plus that PEM appended — `ca` *replaces*
 * the default store rather than extending it, so the defaults have to be re-added by hand.
 *
 * Fails loud: an env var that points at an unreadable file is a misconfiguration the operator
 * needs to see, never a silent "proxy works, TLS just happens to fail everywhere."
 */
function readExtraCa(env: NodeJS.ProcessEnv): string[] | undefined {
  const path = env.NODE_EXTRA_CA_CERTS;
  if (!path) return undefined;
  try {
    const pem = readFileSync(path, "utf8");
    return [...rootCertificates, pem];
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `web: NODE_EXTRA_CA_CERTS=${path} is set but could not be read (${cause}). ` +
        "Fix the path or unset the variable in config/shell/pi-env.sh.",
    );
  }
}

/**
 * Installs a process-wide `undici` dispatcher when a proxy and/or an extra CA bundle is
 * configured; a no-op (platform default dispatcher untouched) when neither is set. Idempotent —
 * safe to call more than once per process (e.g. `/reload`), since it only ever *replaces* the
 * global dispatcher with a freshly built one from the current environment.
 *
 * Takes `env` as a parameter (defaulting to `process.env`) purely so tests can exercise both
 * branches without mutating global process state.
 */
export function installNetworkDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): DispatcherInstallResult {
  const ca = readExtraCa(env);
  const proxied = proxyIsConfigured(env);
  if (!proxied && !ca) return { proxied: false, extraCa: false };

  // `connect` covers the no-proxy (`Agent`) path inside EnvHttpProxyAgent; `requestTls`/`proxyTls`
  // cover the two proxy-aware (`ProxyAgent`) legs. All three are harmless no-ops for whichever
  // internal dispatcher does not read them.
  const { EnvHttpProxyAgent, setGlobalDispatcher } = loadUndici();
  const tls = ca ? { ca } : undefined;
  // `EnvHttpProxyAgent`'s constructor falls back to the AMBIENT `process.env` for every one of
  // `httpProxy`/`httpsProxy`/`noProxy` when the matching option is omitted (confirmed by reading
  // undici's env-http-proxy-agent.js: `httpsProxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY`)
  // — passing only `connect`/`requestTls`/`proxyTls` above silently ignores the injected `env`
  // parameter for the one thing this function exists to control. Reproduced empirically: a test that
  // passes a synthetic `env.HTTPS_PROXY` pointing at a mock proxy, without also mutating the real
  // `process.env`, produced a dispatcher that proxied nothing and let `fetch()` attempt a direct
  // connection instead — which hung for the whole 300s `node --test` sandbox rather than failing
  // fast, and would have shipped invisibly because it degrades to the *correct* behaviour whenever
  // `installNetworkDispatcher()` is called with no argument (`env` defaults to `process.env` itself).
  // These three options are explicit here so the passed-in `env` is authoritative, matching this
  // function's own doc comment ("tests can exercise both branches without mutating global process
  // state").
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: env.HTTP_PROXY ?? env.http_proxy,
      httpsProxy: env.HTTPS_PROXY ?? env.https_proxy,
      noProxy: env.NO_PROXY ?? env.no_proxy,
      connect: tls,
      requestTls: tls,
      proxyTls: tls,
    }),
  );
  return { proxied, extraCa: Boolean(ca) };
}

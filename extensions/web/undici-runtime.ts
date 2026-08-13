/**
 * `EXT-07` §11.5 / V-15 — resolves `undici`'s network dispatcher without a bare `import "undici"`.
 *
 * `undici` is not a *new* dependency: `@earendil-works/pi-coding-agent@0.84.0` already declares it
 * as a direct `dependencies` entry (`8.9.0`, confirmed by reading its installed `package.json`).
 * But it is not hoisted to this repo's own `node_modules/` root — it resolves only at
 * `node_modules/@earendil-works/pi-coding-agent/node_modules/undici` — so a bare
 * `import { setGlobalDispatcher } from "undici"` from anywhere in `extensions/` throws
 * `MODULE_NOT_FOUND` at runtime (reproduced empirically, 2026-08-07: `node --input-type=module -e
 * "import('undici')"` fails with `ERR_MODULE_NOT_FOUND`) and `TS2307` under `tsc` for the exact
 * same reason (bundler `moduleResolution` walks the same node_modules chain). This is `package.json`
 * drift (`undici@8.9.0` belongs in `package.json` directly) that this module works around
 * rather than blocks on, since `package.json` is a
 * shared file this item may not edit.
 *
 * `@earendil-works/pi-coding-agent` is a mandatory `peerDependencies` entry of every module in this
 * tree, so it is always resolvable. Anchoring `createRequire` at *its own*
 * resolved entry point makes Node walk the same node_modules chain Node would use for code living
 * inside that package — not a hardcoded, version-pinned path straight to `node_modules/undici` that
 * would silently break the moment `undici`'s nested version changes.
 *
 * `import.meta.resolve` (not `require.resolve`) is used for the anchor step: `pi-coding-agent`'s
 * `package.json` `exports` map declares only an `"import"` condition, no `"require"` — a CJS-style
 * `require.resolve("@earendil-works/pi-coding-agent")` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * (reproduced). `import.meta.resolve` respects the `"import"` condition and needs no flag on Node
 * 22.22.3 (confirmed live, no `--experimental-import-meta-resolve`). The second leg — reaching
 * `undici` itself from that anchor — uses `createRequire(...)("undici")` (synchronous CJS require,
 * not dynamic `import()`) so `installNetworkDispatcher` can stay synchronous, matching every caller
 * (`web.ts`'s `session_start` handler, and this module's own test) — `undici` does expose a
 * `"require"` condition, so this leg succeeds where the first could not.
 *
 * Only the two `undici` symbols this module actually calls are typed here, by hand, rather than by
 * importing `undici`'s own `.d.ts` — which would hit the identical `TS2307` this file exists to
 * avoid. `EnvHttpProxyAgentOptions` mirrors the constructor options this repo passes: `httpProxy` /
 * `httpsProxy` / `noProxy` (each an explicit override — see `undici`'s own
 * `lib/dispatcher/env-http-proxy-agent.js`, which falls back to ambient `process.env` only when the
 * matching option is `undefined`) and `connect` / `requestTls` / `proxyTls`, each `{ ca?: string[] }`;
 * nothing else of `undici`'s surface is used.
 */
import { createRequire } from "node:module";

export interface EnvHttpProxyAgentTlsOptions {
  readonly ca?: readonly string[];
}

export interface EnvHttpProxyAgentOptions {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
  readonly connect?: EnvHttpProxyAgentTlsOptions;
  readonly requestTls?: EnvHttpProxyAgentTlsOptions;
  readonly proxyTls?: EnvHttpProxyAgentTlsOptions;
}

export interface UndiciDispatcher {
  // Opaque from this module's point of view — only ever passed to setGlobalDispatcher or compared
  // by reference (getGlobalDispatcher() === before) in tests.
}

export interface UndiciRuntime {
  readonly EnvHttpProxyAgent: new (opts?: EnvHttpProxyAgentOptions) => UndiciDispatcher;
  readonly setGlobalDispatcher: (dispatcher: UndiciDispatcher) => void;
  readonly getGlobalDispatcher: () => UndiciDispatcher;
}

let cached: UndiciRuntime | undefined;

/** Resolves and `require()`s `undici` from `@earendil-works/pi-coding-agent`'s own dependency tree. */
export function loadUndici(): UndiciRuntime {
  if (cached) return cached;
  const anchor = import.meta.resolve("@earendil-works/pi-coding-agent");
  cached = createRequire(anchor)("undici") as UndiciRuntime;
  return cached;
}

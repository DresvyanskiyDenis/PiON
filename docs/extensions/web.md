# `web` — provider-independent search and fetch

The web tools themselves come from an adopted package. This module owns the four things the package
adoption does not cover.

Configured by [`config/web.json` and `config/web-search.json`](../configuration/tools.md#web).

## 1. Exactly one search backend, pinned

Enforced at **every** `session_start`, not merely declared in a config file nobody re-checks.
`extensions/web/config-guard.ts` asserts that `web.json`'s `search.backend` equals
`web-search.json`'s `provider`. A mismatch is a fail-loud error.

Two files exist because they answer to different owners: `web.json` is ours and is what a human and
a `jq` script read; `web-search.json` follows the **package's** foreign schema and is what the
package actually loads at runtime.

One backend rather than a list with fallbacks, for the same reason there is no provider failover: a
result that silently came from somewhere else is a result you cannot attribute.

## 2. Proxy and CA plumbing

!!! note "The standalone `pi` binary does not parse `NODE_OPTIONS` at all"
    Verified: an invalid value is silently ignored, where a real `node` CLI refuses to start. So
    Node's own proxy-from-environment route never reaches it.

`extensions/web/proxy.ts` reads `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` directly, builds an
`EnvHttpProxyAgent`, and installs it as the **global fetch dispatcher**. That is what actually makes
the web tools honour a proxy. `NODE_EXTRA_CA_CERTS` covers the TLS-interception case.

See [Environment](../configuration/environment.md#tls-and-proxy).

## 3. Denying the browser-cookie path

The package ships a browser-cookie credential path, scoped and off by default. `bin/pi-check`'s rule
asserts the enabling variables stay unset in `config/shell/pi-env.sh`, `config/settings.json` and
the ambient environment.

!!! danger "Why this is not a preference"
    Browser cookies let the fetcher retrieve pages **as you, authenticated**. The value of a fetch
    tool is reading public pages; the cost of that flag is every private page you happen to be
    logged into.

## 4. Aliasing the fetch tool

The package's default tool name is `fetch_content`; this repository's instruction text calls it
`web_fetch`. The alias is set in `web-search.json`'s `toolNames.fetchContent` and **enforced at
`session_start`** the same way as the backend pin — a rename that silently stops applying leaves
every instruction referring to a tool that does not exist.

## Cost

`register()` starts no timers, sockets or watchers; all I/O is in `session_start`. Reading two small
JSON files and installing a dispatcher.

## Related
[`web.json` / `web-search.json`](../configuration/tools.md#web) ·
[Environment](../configuration/environment.md)

# `web` — provider-independent search and fetch

The web tools themselves come from an adopted package. This module owns the four things the package
adoption does not cover, and adds one tool of its own.

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

## 5. `web_answer` — search that reads the pages

`web_search` hands back ten titles and leaves the agent to pick, fetch one at a time, and reconcile
what they said. That is several round trips of context for a question whose answer is a paragraph.
`web_answer` asks the search host to do the whole loop — search, screen, open the top pages, read
them — and returns prose with `[n]` citations plus the source list those markers point at.

It does not replace `web_search`. Reach for `web_search` when the answer is *which page*, or when
the query is navigational; reach for `web_answer` when the answer is a fact, a version, a default,
a config key, or a comparison.

!!! note "Off until you give it an address"
    A stock SearXNG serves `/search` and nothing else. Search-read-and-cite is a **second endpoint
    you put in front of it**, so `web.json`'s `search.answerPath` ships `null` and the tool is not
    registered at all while it is unset — the same shape as answering "none" at install time
    removing `web_search` cleanly rather than leaving it to fail at the first call. Set it to the
    path your host serves (`"/answer"`, say) and it is joined to the `searxngBaseUrl` `web_search`
    already uses, so there stays exactly one address to keep correct.

The request rides the same global fetch dispatcher section 2 installs, so a proxy and a custom CA
bundle apply here too. If the engine is unreachable, `web_answer` throws rather than degrading to a
link list: the agent still has `web_search` and `web_fetch` in the same session, so a throw costs
one turn, while a quietly weaker answer costs the attribution.

The question may carry a SearXNG engine bang (`!arxiv`, `!gh`, `!so`, …) to restrict the search to
one source — useful only when the question names the kind of source it wants, since a bang turns off
the cross-engine fusion answer quality normally comes from.

## Cost

`register()` starts no timers, sockets or watchers. Its one read is `web.json`, which decides
whether `web_answer` exists — a tool has to be registered before the session it is offered to
opens, and PI has no way to withdraw one later. Everything else — the two config asserts, the
dispatcher — is in `session_start`.

## Related
[`web.json` / `web-search.json`](../configuration/tools.md#web) ·
[Environment](../configuration/environment.md)

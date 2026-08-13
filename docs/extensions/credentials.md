# `credentials` — the local lane, token caching, and provider errors

Three things that are the same subject: what it takes to talk to a model, and what happens when
that fails.

## (a) The local lane

`local` is whatever OpenAI-compatible server is running on loopback — llama.cpp, a swapping router,
Ollama, LM Studio, vLLM. This module re-registers the provider with:

- its own **3-second discovery budget**, because PI's provider schema has **no timeout fields** and
  a cold start that pages tens of GB of weights can exceed the default HTTP timeout;
- a `/v1/models` **warm-up ping** at `session_start`.

!!! warning "The ping is worth exactly what it measures"
    It proves the server is up and answering. It does **not** prove a model is loaded, that a
    completion will succeed, or anything at all about the API key. A wrong key surfaces on the first
    real completion as a fail-loud abort naming the provider.

!!! danger "This module's `baseUrl` wins over `models.json`"
    PI's provider composer resolves `extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl`, and
    this module registers `process.env.PI_LOCAL_BASE_URL ?? "http://127.0.0.1:8888/v1"`. On any
    other port you **must** export `PI_LOCAL_BASE_URL` — see
    [Environment](../configuration/environment.md#pi_local_base_url).

    It deliberately declares `baseUrl`, `api` and `refreshModels` only, and **not** `apiKey`: the
    composer resolves `extension?.apiKey ?? config?.apiKey`, so declaring a key here would make two
    files obliged to agree about a value only one of them owns.

Re-registering a **custom** provider is safe. Re-registering a **built-in** one would destroy its
auth block.

A missing local server is **one warning line**, never a fatal. The whole point of a portable
harness is that a machine without your local setup still gets a working agent.

## (b) Cached command credentials

No code here — `config/bin/dbx-token-cached` is the whole implementation, referenced from
`models.json` as `"apiKey": "!$HOME/bin/dbx-token-cached"`.

It exists because **PI re-executes an `!command` credential on every request with no TTL of its
own**. An unwrapped CLI token call costs one OAuth round trip per LLM call. The wrapper puts a TTL
cache (a `0600` file in a `0700` directory) in front of it, turning that into a file read.

## (c) Provider error surfacing

This is what replaced the cancelled failover item. A failed provider call names the provider, the
model, the error class and the message, keeps the cause chain, and **the turn aborts**:

```text
[pi-config] provider call failed:
  provider    : <name>
  model       : <id>
  error class : auth | quota | network | model-not-found | policy
  message     : <upstream text>
  caused by   : <cause chain>
```

No substitution, no retry into a different provider, no silent degradation. Classification and
rendering live in `extensions/lib/provider-error.ts`.

## Related
[`models.json`](../configuration/models.md) · [`routing.json`](../configuration/routing.md#onprovidererror) ·
[Providers and tiers](../concepts/providers-and-tiers.md)

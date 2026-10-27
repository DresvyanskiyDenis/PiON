# `local` — one model on this machine

Use this for a model served from your own machine over an OpenAI-compatible endpoint: llama-swap, a
llama.cpp server, vLLM on loopback. It is configured at install time from
`config/providers/local.json` and lands in [`config/models.json`](models.md) and
[`config/routing.json`](routing.md), both generated and gitignored. It is not selected by default.

Selecting a model of this provider puts the session on the **local lane**. The decision and its
trade-offs are in [ADR 0009](../adr/0009-local-provider-lane.md).

## What the lane does

When the session's active model belongs to this provider:

| Part | Behaviour on the lane | Off the lane |
|---|---|---|
| Sub-agent dispatch | Every dispatch runs on the session's model. A tier name and an explicit `provider/model` pin are both rewritten to it, and each rewrite is reported | Unchanged |
| Compaction | Runs on the session's model only. The remote compaction route is never used | Unchanged |
| Compaction threshold | `min(absoluteTokens, 0.75 x contextWindow)` | The flat `absoluteTokens` |
| Empty-reply fallback hop | Not taken | See ADR 0007 |
| Server down | The turn aborts with provider, model, error class and cause chain | Unchanged |

The `Sub-agent model selection` block carries one line saying every dispatch runs on `local/<id>`,
and `/agents` says the same.

## The interview

| # | Question | Notes |
|---|---|---|
| 1 | Base URL | Include `/v1`. Default `http://127.0.0.1:8888/v1` |
| 2 | Name of the API-key variable | The name only, default `LOCAL_API_KEY`. A server that checks no key still needs it set to any non-empty value |
| 3 | Model id | Exactly as `GET <baseUrl>/models` lists it |
| 4 | Context window | The window the server really allows. The lane compacts at 75% of it |
| 5 | Maximum output tokens | Default 32768 |

## What is fixed

- Egress class `local`, concurrency 1.
- Cost is four written zeros. The status line reads `0.000` for this provider, and that is correct.
- `supportsDeveloperRole` and `supportsReasoningEffort` are `false` and the `thinkingLevelMap` is all
  `null`: no reasoning level is steerable here. A server that forces thinking on still returns it
  as `reasoning_content`, which PI shows.

## What can go wrong

- **The model does not emit the dispatch call.** Small local models call tools unevenly. The lane
  forces the model of a dispatch that is made; it cannot make a weak model make one.
- **Sub-agents run one at a time.** Concurrency is 1 because one model serves one request at a time.
- **An overstated context window.** The session overflows before the lane compacts.

## Verify

```bash
curl -s "$(jq -r '.providers.local.baseUrl' config/models.json)/models" | jq -r '.data[].id'
pi --list-models | grep '^local/'
pi -p 'reply with OK' --model "local/$(jq -r '.providers.local.models[0].id' config/models.json)"
```

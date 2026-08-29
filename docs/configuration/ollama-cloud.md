# `ollama-cloud` — the models ollama.com runs for you

Use this for **Ollama Cloud**, the hosted product: models running on ollama.com's hardware, reached
over its OpenAI-compatible surface at `https://ollama.com/v1`. It is configured at install time from
`config/providers/ollama-cloud.json` and lands in [`config/models.json`](models.md) and
[`config/routing.json`](routing.md), both generated and gitignored. It is **not** selected by
default in the provider picker.

!!! danger "A local `ollama` is a different thing, and the difference is not cosmetic"

    A server on your own machine is [`openai-compatible`](openai-compatible.md) answered with
    `http://127.0.0.1:11434/v1` — that is what retired this repository's old `local` fragment, and
    nothing here changes it.

    Two things differ from local in ways that bite. The hosted endpoint **requires a key** (an
    unauthenticated `POST /v1/chat/completions` returns 401, measured 2026-08-29) where a local one
    accepts any string. And the prompt **leaves your machine** — see [egress](#egress-is-public)
    below. Do not carry an intuition about local ollama over to this fragment.

---

## Before you start

You need an **ollama.com API key** and a plan that includes the models you intend to call. Put the
key in `~/.pi/secrets.env` (chmod 600) as an `OLLAMA_API_KEY` line, or let the installer do it.

Cloud access is sold as a **subscription with usage limits**, not as metered tokens, and those
limits are what decide whether a long agent session completes. The free tier is small enough that a
single subagent fan-out can exhaust it. Check the plan before binding a tier to this provider.

---

## What the interview asks

| Prompt | Asked when | What it does |
|---|---|---|
| `concurrency` | always | Becomes `concurrency["ollama-cloud"]` in `routing.json` — a semaphore in the dispatcher |

This is the one field the fragment defers, and `config/providers/README.md` §2.8 asks for a reason
each time: the cap is a fact about **your plan**, not about ollama.com, and the plans differ by an
order of magnitude. The default is `1`, which is the honest answer on the free tier.

The semaphore **queues** rather than errors, so a low number costs latency and never correctness.
Raise it one step at a time and watch for 429s. There is no failover in this harness: a rate-limited
request aborts naming the provider and the error class rather than quietly moving the work
somewhere else.

---

## The catalogue this fragment declares

Four ids, taken from the **live endpoint** on 2026-08-29 rather than from a page:

| Model | Declared window | Tier it backs |
|---|---|---|
| `kimi-k3` | 128 000 | `strong` |
| `kimi-k2.7-code` | 128 000 | — |
| `glm-5.3` | 128 000 | — |
| `glm-5.3-flash` | 128 000 | `light` |

The same call returned 19 ids that day; the rest were `deepseek-v4-pro:0813`,
`deepseek-v4-flash:0731`, `nemotron-3-nano:30b`, `nemotron-3-super`, `nemotron-3-ultra`,
`minimax-m2.7`, `minimax-m3`, `gpt-oss:20b`, `gpt-oss:120b`, `glm-5.1`, `glm-5.2`, `gemma4:31b`,
`mistral-large-3:675b` and `qwen3.5:397b`. The catalogue moves — models arrive and are retired
without notice — so re-run the listing rather than trusting that list:

```bash
curl -sS -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/v1/models | jq -r '.data[].id'
```

!!! note "A tag after a colon is part of the id"

    `gpt-oss:120b` is the id, and the qualified form is `ollama-cloud/gpt-oss:120b`. Provider ids
    are split at the **first** slash, so this resolves correctly in `routing.json`, in `--model` and
    in PC-01/PC-02. Write it byte for byte as the endpoint serves it.

### The four zeros are a declaration

Ollama sells cloud access by subscription, not by token: there is no per-token rate to write, and
any number here would be a conversion this repository invented. `config/providers/README.md` §5
calls this the **unmetered** spelling. [`cost-gate`](../extensions/cost-gate.md) and `PC-27` both
read four written zeros as *authored* and accept them permanently — an **absent** `cost` is what
ends the first billed turn. A session on this provider reports a flat `$0.000` on purpose. The
number that constrains you here is a rate limit, not a bill; track it at ollama.com.

### Every context window here is a floor this repository chose

The OpenAI-compatible listing route returns ids and nothing else — no window, no capability — and a
hosted deployment commonly serves a smaller window than the model card claims, because the window is
a property of how the server was launched. `128000` is written for all four, and `maxTokens` is
`8192`, both conservative on the same reasoning: PI's compaction fires against the declared number,
so too high means the endpoint truncates before compaction ever triggers. Measure with `/context`
inside a session and raise both on purpose.

---

## Egress is `public`

`config/providers/README.md` §5: a third-party API is `public` even if the vendor is trustworthy,
because the class records **where the traffic physically goes and who can read it there**. These
models run on ollama.com's hardware, outside any boundary this harness controls.

It is worth saying out loud because the local `ollama` this product shares a name with is the
opposite case, where the prompt never leaves the machine. `routing.json`'s `egress` map is where a
confidential session's ceiling is read from, and a class that is wrong there is wrong on every
surface that tells a human or a model where a prompt is going.

---

## `compat` starts fully conservative

Nothing here was measured on a live key beyond the 401 and the model listing, so the block is the
same all-off shape [`openai-compatible`](openai-compatible.md) ships for an unknown endpoint:
everything off plus `max_tokens`, the setting most likely to complete one turn.

What you give up until you test:

* `supportsUsageInStreaming: false` — no token counts arrive during a stream, so the
  [`quota`](../extensions/quota.md) extension cannot track usage here. That matters more on this
  provider than elsewhere, because a plan's limit is the thing you actually need to watch.
* `supportsReasoningEffort: false` — PI's thinking levels are not forwarded, so a reasoning model
  runs at its own default.
* `supportsDeveloperRole: false` — the system prompt is sent as `system` rather than `developer`.
* `supportsFinishReason: false` — PI infers stop/toolUse when the stream closes.

Turn them on one at a time, keeping a turn working between changes.

---

## Verifying

```bash
curl -sS -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/v1/models | jq -r '.data[].id'
jq -r '.providers["ollama-cloud"].models[].id' config/models.json
pi --list-models | grep '^ollama-cloud/'
pi -p 'reply with OK' --model ollama-cloud/glm-5.3-flash
```

The first two together are the check that matters: the ids you configured have to be ids the
endpoint still serves.

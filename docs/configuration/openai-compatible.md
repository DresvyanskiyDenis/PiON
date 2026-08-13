# `openai-compatible` — gateways (LiteLLM, vLLM, OpenRouter, in-house)

The sixth provider fragment. Use it for **any endpoint that speaks `/v1/chat/completions` and serves
its own model names**: a LiteLLM proxy, a vLLM server, OpenRouter, or a router someone in your
organisation runs. You supply the base URL, the model ids and the context windows; the fragment
supplies everything else.

It is configured at install time from `config/providers/openai-compatible.json` and lands in
[`config/models.json`](models.md) and [`config/routing.json`](routing.md), both of which are
generated and gitignored.

---

## Is this the one you want?

There are two different things behind the words "route OpenAI somewhere else", and picking the
wrong one produces an error that reads like a broken install.

| Your endpoint | Use | Why |
|---|---|---|
| A **transparent proxy** in front of `api.openai.com` — still answers to `gpt-…` names | the `openai` fragment, answering **yes** to "route through a proxy" | Overriding `baseUrl` on a built-in provider keeps OpenAI's catalogue *and* its auth, which is exactly right here |
| A **gateway** publishing its own catalogue — LiteLLM, vLLM, OpenRouter, an in-house router | **this fragment** | The gateway has never heard of `gpt-5.4`; keeping OpenAI's catalogue means every request names a model that does not exist there |

!!! warning "The trap this fragment exists to close"

    Overriding `baseUrl` on the built-in `openai` provider **keeps OpenAI's model list**. Point that
    at a gateway and `config/models.json` still says `gpt-5.4`, so the first request comes back as an
    unknown-model error from an endpoint you just configured correctly. Nothing is misconfigured
    except the catalogue.

---

## The interview

Seven questions, plus three more if you configure more than one model. In order:

| # | Question | Notes |
|---|---|---|
| 1 | Full base URL of the gateway, including the `/v1` suffix if it wants one | Absolute `http(s)`. Whatever you would put in `OPENAI_BASE_URL`. PI appends `/chat/completions` to it |
| 2 | Name of the environment variable that will hold the gateway's API key | The **name**, not the key. Defaults to `GATEWAY_API_KEY` |
| 3 | Where does this gateway physically send your prompts? | `public` / `internal` / `confidential`, default `internal` |
| 4 | How many requests may this harness have in flight at once? | Default `2` |
| 5 | Model id, exactly as the gateway serves it | Suggested for the `strong` tier |
| 6 | Context window for that model — `min(200000, what this endpoint actually serves)` | Default `32768` |
| 7 | A second model id, or blank if you only want one | Suggested for the `fast` tier |
| 8 | Context window for the second model | Only asked if you gave one |
| 9 | A third model id, or blank | Only offered if you gave a second. Suggested for the `cheap` tier |
| 10 | Context window for the third model | Only asked if you gave one |

The credential's **value** is asked for later, in the credentials step, and is written to
`~/.pi/secrets.env` (chmod 0600) or the macOS Keychain. `config/models.json` gets the indirection
only:

```json
"apiKey": "$ACME_GATEWAY_KEY"
```

To reconfigure afterwards: `./scripts/install.sh --section providers`.

---

## What it writes

```json title="config/models.json (excerpt)"
"openai-compatible": {
  "baseUrl": "https://gateway.example.com/v1",
  "api": "openai-completions",
  "apiKey": "$ACME_GATEWAY_KEY",
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": false,
    "supportsFinishReason": false,
    "maxTokensField": "max_tokens"
  },
  "models": [
    { "id": "vendor-a/big-instruct", "name": "[gateway] vendor-a/big-instruct",
      "input": ["text"], "contextWindow": 131072, "maxTokens": 8192 }
  ]
}
```

```json title="config/routing.json (excerpt)"
"egress":      { "openai-compatible": "internal" },
"concurrency": { "openai-compatible": 2 },
"tiers": {
  "strong": { "model": "openai-compatible/vendor-a/big-instruct", "thinkingLevel": "high" }
}
```

---

## The four numbers to get right

### 1. `contextWindow` — `min(200000, what the endpoint actually serves)`

A gateway is the worst place to trust a model card. Gateways routinely re-declare an upstream's
advertised window while imposing a smaller one of their own, or truncate silently when a request
exceeds what the backend was launched with.

PI's compaction fires against the number in `models.json`. Too high and the endpoint truncates
*before* compaction ever triggers — which presents as the agent forgetting the start of the task,
not as an error. Too low costs only an earlier compaction. That is why the default is deliberately
small: start low, confirm with `/context` inside a session (it prints the resolved window **and
where the number came from**), then raise it on purpose.

### 2. `egress` — an answer, not a property of the URL

Every other fragment states its class as a fact: `api.openai.com` is `public`, loopback is
`confidential`. A gateway URL says nothing — the same shape covers OpenRouter, a corporate LiteLLM
and a private deployment.

Whatever you chose is written to `routing.json`'s `egress` map, and that is the word printed beside
this provider wherever a model is offered or an agent is listed. It is a **label**: since the
containment rule was withdrawn on 2026-08-13, nothing refuses a dispatch on account of it
([ADR 0004](../adr/0004-egress-classes-are-declarative.md)). So the class is a note to the humans
and models reading the menu, not a gate that keeps confidential work off the gateway. Pick
`internal` if you are unsure; if you later confirm the deployment is private, change the one word in
`config/routing.json`.

### 3. `concurrency` — a guess until you measure it

The value is a semaphore in the dispatcher, keyed on the resolved provider id. It **queues** rather
than errors, so a low number costs latency and never correctness. Gateways in front of shared
upstreams usually enforce a rate limit that is not published to their users; raise the cap one step
at a time and watch for 429s.

### 4. `compat` — starts fully conservative, and each `false` costs something

Everything off plus `max_tokens` is the setting most likely to complete one turn against an unknown
endpoint. What you give up until you test:

| Flag at `false` | What you lose |
|---|---|
| `supportsUsageInStreaming` | No token counts during a stream — the quota extension cannot track spend on this provider |
| `supportsReasoningEffort` | PI's thinking levels are not forwarded; a reasoning model runs at its own default |
| `supportsDeveloperRole` | The system prompt is sent as `system` rather than `developer` |
| `supportsFinishReason` | PI infers stop/tool-use when the stream closes instead of reading `finish_reason` |

Turn them on **one at a time**, keeping a working turn between changes. A flag turned off that was
needed costs a feature; a flag turned on that is unsupported costs a 400 on every request.

---

## Adding more models later

The installer asks for at most three, because a longer prompt list stops being an interview.
Afterwards the file is yours:

1. Append an object to `providers.openai-compatible.models` in `config/models.json` — copy one of
   the blocks already there and change `id`, `name` and `contextWindow`.
2. To route a tier at it, set `tiers.<name>.model` in `config/routing.json` to
   `openai-compatible/<the new id>`, or re-run `./scripts/install.sh --section tiers`.
3. `bin/pi-check --all` verifies both files (PC-01 wants every id provider-qualified, PC-02 wants
   every bound tier to resolve).

Nothing needs restarting beyond a new session: `models.json` is read at session start.

!!! note "A model id containing a slash is fine"

    Aggregators serve ids like `vendor/model-name`, making the qualified form
    `openai-compatible/vendor/model-name`. The provider is split off at the **first** slash and
    everything after it is the model id, so this resolves correctly in `routing.json`, in `--model`
    and in `pi-check`. Do not rewrite the id to remove the slash — it must match what the gateway
    serves, byte for byte.

---

## Two gateways

The id `openai-compatible` is the key in `models.json`, so a second gateway would collide with it.
Install the first one, then copy `providers.openai-compatible` to a second key of any name, give it
its own `baseUrl`, API-key variable and models, and add matching rows to `egress` and `concurrency`
in `routing.json`. Both files are yours after installation; the fragment is only how the first one
gets written.

---

## Verifying

```bash
# the gateway is reachable, and these are its real model ids
curl -s "$(jq -r '.providers["openai-compatible"].baseUrl' config/models.json)/models" | jq -r '.data[].id'

# the ids you configured
jq -r '.providers["openai-compatible"].models[].id' config/models.json

# PI sees the provider as configured
pi --list-models | grep '^openai-compatible/'

# one real turn
pi -p 'reply with OK' --model "openai-compatible/$(jq -r '.providers["openai-compatible"].models[0].id' config/models.json)"
```

!!! danger "There is no failover, here or anywhere"

    A gateway that is down, rate-limited or returning 5xx **aborts** the request, naming the
    provider, the model, the error class and the cause chain. It does not silently move the work to
    another provider you also configured. See
    [ADR 0001](../adr/0001-no-provider-failover.md) — a quiet substitution sends a confidential
    prompt somewhere you did not choose, and hides an outage until the bill shows it.

## Related

- [`config/models.json`](models.md) — the file this writes into
- [`config/routing.json`](routing.md) — tiers, egress classes, concurrency caps
- [Providers and tiers](../concepts/providers-and-tiers.md) — the concepts
- [Context windows](../concepts/context-windows.md) — the rule that matters most
- [Adding a provider](../extending/providers.md) — writing a fragment of your own

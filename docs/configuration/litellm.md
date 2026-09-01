# `litellm` — a LiteLLM proxy

Use this for a [LiteLLM](https://docs.litellm.ai/) proxy: your organisation runs it, it holds the
upstream vendor credentials, and it issues you a *virtual key*. You supply the base URL, the model
ids and the context windows. Everything about how LiteLLM behaves on the wire is already in the
fragment.

It is configured at install time from `config/providers/litellm.json` and lands in
[`config/models.json`](models.md) and [`config/routing.json`](routing.md), both generated and
gitignored.

---

## Is this the one you want?

Yes, if the endpoint is a LiteLLM proxy. If it is a vLLM server, OpenRouter, a first-party vendor
API or an in-house router, use [`openai-compatible`](openai-compatible.md) — that fragment fits
anything speaking `/v1/chat/completions` under its own model names.

Both fragments would technically fit a LiteLLM proxy, and the interview differs by two questions.
The split rests on the fields **you cannot be asked about**: `compat`, `reasoning` and
`thinkingLevelMap` are literals in a fragment, never answers, so only a fragment that names the
product can state them. Two facts qualify — both about LiteLLM itself rather than about anyone's
deployment:

1. **The [thinking-level map's shape](#thinking-levels).** `xhigh` and `none` are opt-in while `low`
   and `minimal` are opt-out. That asymmetry lives in LiteLLM's own transformation code and has no
   counterpart in vLLM or OpenRouter.
2. **`maxTokensField: max_tokens`.** Right here because LiteLLM *translates* it per upstream
   provider; wrong for a direct GPT-5-class endpoint, which requires `max_completion_tokens`. Same
   value, opposite reason — which the generic fragment cannot state.

Everything else this page tells you — the reasoning-effort passthrough, streamed usage, the pricing
probe — is *useful* knowledge about LiteLLM, and none of it is a reason for a second fragment.

---

## Before you start

Get two things from whoever runs the proxy:

1. **The base URL, with `/v1`** — e.g. `https://litellm.example.internal/v1`.
2. **A virtual key** (`sk-…`). This is minted *by the proxy*, not by a vendor. If you administer the
   proxy yourself it is under **Virtual Keys** in its admin UI.

Then one call tells you everything the installer is about to ask:

```bash
curl -sS -H "Authorization: Bearer $LITELLM_API_KEY" "$BASE_URL/model/info" \
  | jq -r '.data[] | [.model_name,
                      .model_info.max_input_tokens,
                      .model_info.input_cost_per_token,
                      .model_info.output_cost_per_token,
                      .model_info.supports_xhigh_reasoning_effort] | @tsv'
```

Column by column: the **id to type**, the **context window to declare**, the two **prices** (see
[price](#price-is-asked-not-guessed)), and whether **xhigh thinking** is enabled for that
deployment.

---

## The interview

Thirteen questions for one model, plus eight more if you configure a second. Five of each set are the
price, and four of those five are asked only if you answer `metered`.

| # | Question | Notes |
|---|---|---|
| 1 | Full base URL of the proxy, including `/v1` | PI appends `/chat/completions`; the verification commands append `/model/info`. Both live under `/v1` |
| 2 | Name of the environment variable that will hold the virtual key | The **name**, not the key. Defaults to `LITELLM_API_KEY` |
| 3 | Where does this proxy physically send your prompts? | `public` / `internal` / `confidential`, default `internal`. See [egress](#egress-describes-where-the-bytes-end-up) |
| 4 | How many requests may be in flight at once? | Default `2`. LiteLLM enforces rpm/tpm per key |
| 5 | Does this proxy partition its prompt cache by `prompt_cache_key`? | Default `false`, and **inert on an unpatched runtime**. See [prompt cache keys](#prompt-cache-keys-through-a-proxy) |
| 6 | Model id, exactly as the proxy serves it | `model_name` from the call above. Suggested for the `strong` tier |
| 7 | Context window for that model | `min(200000, max_input_tokens)` |
| 8 | Does that model take a `reasoning_effort`? | Default `false`. See [thinking](#thinking-levels) |
| 9 | How is that model billed? | `metered` or `unmetered`. **No default** — an unstated price is refused by name rather than composed as a zero. See [price](#price-is-asked-not-guessed) |
| 10-13 | Its input, output, cached-input and cache-write rates | Only asked if you said `metered`. **Dollars per million tokens**: `input_cost_per_token` from the call above **× 1 000 000**. The two cache rates default to `0` |
| 14 | A second model id, or blank | Suggested for the `light` tier |
| 15 | Context window for the second model | Only asked if you gave one |
| 16 | Does the second model take a `reasoning_effort`? | Only asked if you gave one |
| 17 | How is the second model billed? | Only asked if you gave one. Asked separately because the light tier is frequently the cheap alias, and sometimes the free one |
| 18-21 | Its four rates | Only asked if you said `metered` for it |

The credential's **value** is asked for later, in the credentials step, and written to
`~/.pi/secrets.env` (chmod 0600) or the macOS Keychain. `config/models.json` gets only the
indirection: `"apiKey": "$LITELLM_API_KEY"`.

To reconfigure afterwards: `./scripts/install.sh --section providers`.

---

## Thinking levels

The fragment ships this map on every model:

```json
"thinkingLevelMap": { "minimal": "minimal", "low": "low", "medium": "medium", "high": "high" }
```

What is **missing** carries most of the meaning.

- **`xhigh` and `max` are absent**, which PI reads as *unsupported*. That is correct against a proxy
  you have not tuned: `gpt_5_transformation.py:236-247` makes `xhigh` an **opt-in** capability —
  "only allow if model explicitly supports it" — so `supports_xhigh_reasoning_effort` must be
  literally `true` in that deployment's `model_info`, and otherwise LiteLLM raises
  `UnsupportedParamsError` with **status 400** unless the proxy runs with `drop_params`. An unknown
  model — anything newer than the bundled price table, or a `base_model` naming a deployment rather
  than a model — reads as `false`.

    The counterpart at `:249-259` makes `minimal` and `low` **opt-out**: unknown models pass
    through, and only an explicit `false` blocks them. `none` is gated like `xhigh` (`:188`, `:279`,
    and the Azure subclass at `:107-109`). That asymmetry is the first of the two reasons this
    fragment is separate: it is a property of LiteLLM's transformation code, identical on every
    LiteLLM proxy, with no counterpart in vLLM or OpenRouter.
- **`off` is absent, and absent is not the same as `null`.** An absent level stays supported and
  reaches the wire as *no parameter at all*, which means your endpoint applies **its own default
  effort** — not none. Nulling `off` would be the worse of the two: PI would clamp a request for
  `off` **upwards** to `minimal` — the clamp walks up before it walks down — so asking for less
  thinking would quietly buy more. Absent is the right default here only because the spelling for
  no reasoning belongs to the endpoint behind your proxy and cannot be known from this file. If
  yours accepts one, map it — [`models.md`](models.md) lays out all three states side by side, and
  says how to prove which one you got.

To enable `xhigh` after your operator sets the flag: confirm it through `/model/info`, then add
`"xhigh": "xhigh"` to that model's map in `config/models.json`.

The per-model **reasoning** question defaults to `false` on purpose. A wrong `false` only costs you
the thinking menu — PI emits nothing for a non-reasoning model. A wrong `true` sends
`reasoning_effort` to a model that has no use for it, and a proxy not running with `drop_params`
answers **400 on every turn**.

---

## What the `compat` flags say, and how sure we are

These are read out of the **installed `litellm` 1.89.7 wheel**, not probed against your proxy — a
weaker claim than the measured tables in the Databricks and Copilot fragments, and labelled as such
deliberately. Every row names the file it came from, so you can check it rather than trust it.

| Flag | Value | Why |
|---|---|---|
| `supportsReasoningEffort` | `true` | `router.py:1877-1883` builds the call as `{**litellm_params, …, **kwargs}` — caller last — and `gpt_5_transformation.py:171` lists `reasoning_effort` as a first-class param, so it reaches the upstream transformation |
| `supportsUsageInStreaming` | `true` | Usage rides in the final chunk only if the request asked for it. See below |
| `supportsFinishReason` | `true` | The proxy returns the OpenAI response schema. If a turn never ends, flip this to `false` and PI infers the stop itself |
| `maxTokensField` | `max_tokens` | `gpt_5_transformation.py:270-275` — "max_tokens is not supported for gpt-5 models on OpenAI API", and LiteLLM rewrites it to `max_completion_tokens` for you. The legacy field is right *through* a proxy and wrong *at* the endpoint |
| `supportsDeveloperRole` | `false` | Depends on the model behind the id, not on LiteLLM. Under-declaring costs nothing: the turn is sent with a `system` message instead |
| `supportsPromptCacheKey` | *your answer* | The one key here that states a fact about **your gateway** rather than about LiteLLM, so it is asked. Written only when you answer yes; a no deletes the key rather than writing `false`. See [below](#prompt-cache-keys-through-a-proxy) |

`supportsStrictMode` and `cacheControlFormat` are deliberately left unset — both depend on the model
behind the alias, and declaring `cacheControlFormat` would report prompt-cache savings that did not
happen.

The [verification commands](#verifying) turn every one of these from derived into measured in about
a minute.

!!! info "Why streamed usage must be requested"

    Usage rides in the **final streamed chunk only when the request carried
    `stream_options.include_usage`** — `streaming_handler.py:174` sets `send_stream_usage` from
    `check_send_stream_usage(self.stream_options)`, and that helper (`:251`) is true only when the
    client asked. `supportsUsageInStreaming: true` is what makes PI ask, and it is the only way the
    token counters on the status line get real numbers on a streamed turn.

    A LiteLLM operator can additionally force it on for every client with
    `general_settings.always_include_stream_usage`
    (`proxy/common_request_processing.py:948-961`), which is **off by default** and is not something
    you set from here.

    This is plain OpenAI streaming semantics, equally true of vLLM and OpenRouter — which is why it
    is *not* one of the [two reasons](#is-this-the-one-you-want) this fragment is separate. An
    earlier draft of this page claimed the proxy adds `include_usage` itself and then strips the
    usage block back out; no such code exists in litellm 1.89.7 and the symbol it named exists
    nowhere. The flag was right, the mechanism was invented.

---

## Prompt cache keys through a proxy

A gateway in front of Azure OpenAI or another OpenAI-compatible backend may partition its prompt
cache by the client-sent **`prompt_cache_key`**. Without one, every session of every client shares a
single partition and evicts the others: the cache does not error, it just never hits, and the only
symptom is a bill that never falls.

**PI does not send one through a proxy.** `pi-ai` builds the field under exactly two conditions
(`dist/api/openai-completions.js:523-527` in 0.84.0):

```js
prompt_cache_key: (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
    (cacheRetention === "long" && compat.supportsLongCacheRetention)
    ? clampOpenAIPromptCacheKey(options?.sessionId)
    : undefined,
prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
```

Read that against a gateway. Your `baseUrl` is the proxy's, so the first branch can never fire. The
second one can — and it is not a workaround, because the *same* condition on the next line also sends
`prompt_cache_retention: "24h"`. You would be buying a cache key at the price of a retention request
your gateway may answer **400** to, and asking for 24-hour retention of your prompts on somebody
else's infrastructure is a different decision than asking it to partition a cache.

So the fragment asks the deployment question separately, and writes a **third, independent gate**:

```json title="config/models.json, if you answered yes"
"compat": { "…": "…", "supportsPromptCacheKey": true }
```

Answer **no** — the default — and the key is *deleted*, not written as `false`: a fragment token that
resolves to `null` removes the key it sits in (`config/providers/README.md` §3 rule 3), so a
default install's `models.json` is unchanged from before the question existed, and an answers file
written before it existed still resolves.

!!! danger "The flag is not in `pi-ai` 0.84.4. Answering yes changes nothing on its own."

    `supportsPromptCacheKey` is a **patch**, not a feature. The shipped runtime has no such
    condition and ignores the key, so a yes with an unpatched runtime is a declaration in your config
    and no change on the wire — the same silent nothing the flag exists to fix. This repository ships
    no patch. What follows is how to make one, and what it costs.

### Patching the runtime, and the copy nobody patches

The patch itself is three lines: add `compat.supportsPromptCacheKey` as a third disjunct on the
`prompt_cache_key` expression above, and **leave `prompt_cache_retention` alone**. Keeping the two
independent is the whole point; a patch that reuses the long-retention branch reintroduces the 400.

[`patch-package`](https://www.npmjs.com/package/patch-package) is the right tool for generating and
naming the diff. Two facts about *this* tree change how you use it.

**1. npm installs `pi-ai` twice, and the second copy is the one that runs.**
`@earendil-works/pi-coding-agent` declares its own dependency on `@earendil-works/pi-ai`, and npm
leaves a nested copy under it even when the versions match:

```bash
find . -path '*@earendil-works/pi-ai/package.json' -not -path '*/dist/*'
# node_modules/@earendil-works/pi-ai/package.json
# node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/package.json
```

A patch named for the package alone — `@earendil-works+pi-ai+<version>.patch` — lands on the
**top-level** copy only. That copy is what `tsc` reads for types; the nested one is what the agent
loads to build a request. Patch the first and the gates stay green, the diff looks applied, and the
wire is unchanged. Name the nesting explicitly instead:

```bash
# generate: the path you pass is the nesting, and the filename it writes records it
npx patch-package @earendil-works/pi-coding-agent/@earendil-works/pi-ai
# -> patches/@earendil-works+pi-coding-agent++@earendil-works+pi-ai+<version>.patch
```

The `++` between the two package names is what makes the patch resolve into the nested tree. Read the
filename the command actually writes rather than typing it from here: it is the authority, and it
carries the version, so an upgrade renames it and a stale patch stops applying instead of applying to
the wrong source.

**2. `postinstall` will not run it.** The usual `"postinstall": "patch-package"` wiring is
unavailable here: `scripts/install.sh` runs `npm install --ignore-scripts`, and says so as a
property — *"no piped shells; npm is always `--ignore-scripts`"*. Dropping that flag to gain a patch
hook trades a supply-chain guarantee for a convenience. Apply the patch as an explicit, visible step
instead — `npx patch-package` with no arguments, or `git apply patches/<file>` — and remember that
**every `npm install` and every runtime update reverts it**. It is a re-applied edit, not an
installed one.

**Patch the copy that serves your turns.** Which one that is depends on how PI was installed
([install modes](../getting-started/install.md#the-pi-runtime-itself)):

| Install mode | What runs your turns | Can `patch-package` reach it? |
|---|---|---|
| `--mode npm` | the global package under `$(npm root -g)/@earendil-works/pi-coding-agent`, with its own nested `pi-ai` | Yes, but the patch has to be applied *there*, not in this checkout |
| `--mode binary` (the default) | an unpacked release archive under `~/.local/share/pi-config/runtime/<version>/` with its modules beside it | No — there is no package tree to run `patch-package` against. Edit in place after each update, or switch to `--mode npm` |

This checkout's own `node_modules` is a **development** dependency: it is what `npm run typecheck`
and the test suite read. Patching it makes the flag typecheck, and does not make it send anything.

Verify rather than assume — the fragment ships this as its last `verify` line:

```bash
grep -rl supportsPromptCacheKey "$(npm root -g)/@earendil-works" ~/.local/share/pi-config/runtime 2>/dev/null \
  || echo 'no installed copy reads it: the flag is inert'
```

### The pinning test

`test/providers-prompt-cache-key.test.ts` walks `node_modules` for **every** copy of `pi-ai` and
holds each one to the same two statements: `prompt_cache_key` is still gated on `api.openai.com` or
`supportsLongCacheRetention`, and no copy reads `supportsPromptCacheKey`.

It fails in both directions on purpose. If upstream adopts the flag, the patch is redundant and this
section is wrong — that should be read, not absorbed. If a tree is patched, it fails until *every*
copy is patched, which is exactly the half-applied state that otherwise produces a green suite and an
unchanged request.

---

## `egress` describes where the bytes end up

Not who owns the first hop. A proxy your own company runs that fans out to a third-party vendor API
is **`public`**: the class is a declaration about the destination, and it is what lets the
dispatcher refuse to send a confidential session to a public-class provider *by name*. Nothing in
this harness can stop the packet — see
[ADR 0004](../adr/0004-egress-classes-are-declarative.md).

---

## Price is asked, not guessed

`cost` is optional in a fragment and required on PI's runtime model type, so the composer fills the
gap with `{input:0,output:0,cacheRead:0,cacheWrite:0}` — and every session on a model that omits it
shows a flat `0.000` spend while really costing money.

The fragment cannot state the price, because the price behind a proxy is whatever that deployment's
operator configured rather than the vendor's list price. So it asks, per model, and writes your
answer into `config/models.json` before the first request. Two answers exist and there is no third:

```json title="metered — the four rates"
"cost": { "input": 1.25, "output": 10.0, "cacheRead": 0, "cacheWrite": 0 }
```

```json title="unmetered — this alias is not billed by the token"
"cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
```

The second is a decision, not a gap: written down, it satisfies `bin/pi-check`'s `PC-27` and
[`cost-gate`](../extensions/cost-gate.md) permanently. An omitted `cost` satisfies neither — it is
what the gate ends the first billed turn on. To change an answer later, re-run
`./scripts/install.sh --section providers`, or edit `cost` beside the model in `config/models.json`
and re-run `bin/pi-check --all`.

!!! warning "Six orders of magnitude, silently"

    LiteLLM quotes **dollars per token**. PI's `cost` is **dollars per million tokens** and divides
    by 1 000 000 before multiplying by the usage counter. A per-token figure pasted straight in is
    wrong by a factor of a million and renders perfectly happily.

---

## Two proxies

The id `litellm` is the key in `models.json`, so a second deployment would collide with it. Copy
`config/providers/litellm.json` to `litellm-<something>.json`, change `id` to match the filename,
and select both at install time. (Or install one and copy the block in `models.json` afterwards,
adding matching rows to `egress` and `concurrency` in `routing.json`.)

---

## Verifying

The installer writes these into `~/.pi/agent/provider-notes.md` with your base URL and credential
variable already substituted in, and names that file in its closing list of manual steps. It does
not run them: they need a credential collected later and a reachable endpoint.

```bash
# the proxy answers, and these are the ids it will serve you
curl -sS -H "Authorization: Bearer $LITELLM_API_KEY" "$BASE_URL/model/info" \
  | jq -r '.data[] | [.model_name, .model_info.max_input_tokens] | @tsv'

# PI sees the provider as configured
pi --list-models | grep '^litellm/'

# reasoning_effort is accepted (expect 200; a 400 means answer `false` to the reasoning question)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $LITELLM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"reasoning_effort":"low"}' \
  "$BASE_URL/chat/completions"

# one real turn
pi -p 'reply with OK' --model litellm/<id>

# whether the runtime that serves your turns reads supportsPromptCacheKey (a stock pi-ai does not)
grep -rl supportsPromptCacheKey "$(npm root -g)/@earendil-works" ~/.local/share/pi-config/runtime 2>/dev/null \
  || echo 'no installed copy reads it: the flag is inert'
```

A **429** is your key's budget, not an outage: LiteLLM enforces rpm/tpm and `max_budget` per virtual
key. Lower the concurrency answer or ask for a larger budget — retrying harder makes it worse.

!!! danger "There is no failover, here or anywhere"

    A proxy that is down, rate-limited or returning 5xx **aborts** the request, naming the provider,
    the model, the error class and the cause chain. It does not silently move the work to another
    provider you also configured. See [ADR 0001](../adr/0001-no-provider-failover.md).

## Related

- [`openai-compatible`](openai-compatible.md) — the generic fragment, for everything unnamed
- [`config/models.json`](models.md) — the file this writes into
- [`config/routing.json`](routing.md) — tiers, egress classes, concurrency caps
- [Providers and tiers](../concepts/providers-and-tiers.md) — the concepts
- [Context windows](../concepts/context-windows.md) — the rule that matters most

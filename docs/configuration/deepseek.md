# `deepseek` — DeepSeek V4, with the price corrected

Use this if you call DeepSeek directly on a platform API key. PI ships the `deepseek` provider
itself, so this fragment **overrides the minimum** and never declares a model list: it corrects the
two things a bundled catalogue cannot keep current, and touches nothing else.

It is configured at install time from `config/providers/deepseek.json` and lands in
[`config/models.json`](models.md) and [`config/routing.json`](routing.md), both generated and
gitignored. It is **not** selected by default in the provider picker.

!!! danger "The whole point of the fragment: PI's bundled rates are behind the vendor's page"

    On 2026-08-29 PI's catalogue stated **0.14 / 0.28** for `deepseek-v4-flash` and
    **0.435 / 0.87** for `deepseek-v4-pro`, where the vendor's own pricing page stated materially
    higher rates. An under-declared rate is the same defect as an absent one seen from the invoice:
    the status line reports less than you are paying, and nothing warns.

    That is what this fragment exists to fix. If you install it and later find the vendor cheaper
    than what is written here, edit `config/models.json` — being wrong upward is recoverable and
    visible; being wrong downward is neither.

---

## Before you start

You need a **DeepSeek platform API key** — the only credential this API takes, sent as a Bearer
token. Put it in `~/.pi/secrets.env` (chmod 600) as a `DEEPSEEK_API_KEY` line, or let the installer
do it. It never goes into this repository; `bin/pi-check` rule PC-06 fails the tree if a key value
reaches `config/shell/pi-env.sh`.

---

## What the interview asks

| Prompt | Asked when | What it does |
|---|---|---|
| `endpoint` | always | `direct` **deletes** the `baseUrl` key so PI uses the endpoint its own catalogue already carries; `proxy` asks for yours |
| `proxyBaseUrl` | `endpoint = proxy` | Substituted literally — PI does not expand `$VAR` or `!cmd` inside `baseUrl` |

The deletion is the substitution rule at work: a token resolving to `null` removes the key that
holds it. An empty string would be a base URL that resolves to nowhere and fails at request time
instead of at install time. DeepSeek's own base URL carries **no** `/v1` suffix; match what your
proxy expects rather than copying that.

---

## The catalogue this fragment corrects

Rates read from
[DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing) on 2026-08-29, in
**dollars per million tokens**, from the **standard-rate** column:

| Model | Input (cache miss) | Input (cache hit) | Output | Declared window | Tier it backs |
|---|---|---|---|---|---|
| `deepseek-v4-pro` | 1.32 | 0.044 | 3.96 | 200 000 | `strong` |
| `deepseek-v4-flash` | 0.44 | 0.014 | 1.32 | 200 000 | `light` |

!!! note "There are two columns, and this writes the higher one"

    DeepSeek publishes a standard rate and a lower **off-peak** rate (roughly a third off), with the
    discount window given on that page in UTC. The window has moved before, so read it there rather
    than here. The composed `models.json` carries one rate per model and has no notion of the clock,
    so the standard column is what is written: a rate that is only true for part of the day would
    under-report the rest of it. A session run entirely inside the discount window over-reports.

### The cache discount here is real, and it is large

A cache hit costs about a **thirtieth** of a miss on both models — the largest cache discount of any
provider this repository ships a fragment for. `cacheWrite` is `0` because no charge for placing an
entry is published: that zero is the rate, not a gap.

The saving only reaches the status line if the endpoint reports cached tokens back. If `cacheRead`
never moves off zero across a long session, check that before assuming the cache is working.

### Why the context window says 200 000

The vendor and PI's own catalogue both state 1 000 000 tokens. `config/providers/README.md` §5 asks
for `min(200000, measured)`: PI's compaction threshold is `contextWindow - reserveTokens`, so an
over-declared window makes compaction fire **too late** and the endpoint truncates instead. Under-
declaring only makes compaction fire earlier.

`maxTokens` is deliberately **not** overridden — PI's catalogue says 384 000, and that is an output
cap, not a context budget.

### What is deliberately *not* overridden

`compat`, `thinkingLevelMap`, `api` and `maxTokens`. PI's bundled entries state
`thinkingFormat: "deepseek"`, `requiresReasoningContentOnAssistantMessages: true`,
`supportsStore: false`, `supportsDeveloperRole: false`, and a `thinkingLevelMap` that answers only
`high` and `max`. Those are wire facts about a reasoning model, measured by whoever generated that
catalogue and not re-measured on this tree. The rule is that `compat` flags are *measured, not
copied* — an unmeasured flag written into a fragment reads exactly like a measured one.

---

## Egress is `public`

`config/providers/README.md` §5: a third-party API is `public` even if the vendor is trustworthy,
because the class records **where the traffic physically goes and who can read it there**.
`api.deepseek.com` is a multi-tenant vendor API outside any boundary this harness controls, and
`routing.json`'s `egress` map is where a confidential session's ceiling is read from. A private or
self-hosted DeepSeek deployment inside your own boundary is
[`openai-compatible`](openai-compatible.md), answered with your host and your class.

---

## The third id, and why it is not shipped

The pricing page also lists `deepseek-v4-flash-vision-exp` at the same rates as
`deepseek-v4-flash`. It is experimental and it is not in PI's bundled catalogue, and an **override**
cannot introduce a model PI does not know — so adding it means declaring it in full: `id`, `name`,
`api`, `input` including `"image"`, `contextWindow`, `maxTokens` and all four rates, appended to
`providers.deepseek.models` in `config/models.json`.

!!! warning "A `models` array on a built-in provider replaces the built-in model of the same id"

    Give the new entry an id no built-in uses and the two coexist. Re-declare `deepseek-v4-pro`
    there and you drop everything PI knows about it, `compat` included.

---

## Verifying

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" https://api.deepseek.com/models
pi --list-models | grep '^deepseek/'
pi -p 'reply with OK' --model deepseek/deepseek-v4-flash
jq '.providers.deepseek.modelOverrides | to_entries[] | {model: .key, cost: .value.cost}' \
  config/models.json
```

The last one is worth running after every install: it prints the rates that actually reached
`models.json`, which is the number the status line and [`cost-gate`](../extensions/cost-gate.md)
will use.

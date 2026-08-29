# `qwen` — Alibaba's Qwen models, bought per token

Use this if you call Qwen from **Alibaba Cloud Model Studio** (DashScope) on a pay-per-token API
key. It is configured at install time from `config/providers/qwen.json` and lands in
[`config/models.json`](models.md) and [`config/routing.json`](routing.md), both generated and
gitignored. It is **not** selected by default in the provider picker.

!!! danger "This is not PI's built-in `qwen-token-plan`"

    PI ships a `qwen-token-plan` provider of its own, pointed at a different host, and it is a
    different product: Alibaba's **flat-rate plan**, whose catalogue carries four written zeros
    because a plan has no per-token rate, and which serves other vendors' models (MiniMax, GLM,
    Kimi, DeepSeek) alongside Qwen.

    This fragment is the **metered** Model Studio surface, under the id `qwen`. Installing it does
    not disturb the built-in. Dispatch at `qwen/…` if you buy tokens and at `qwen-token-plan/…` if
    you have the plan — the status line is only truthful if the id matches how you actually pay.

---

## Before you start

You need a **Model Studio API key** and an account with Model Studio activated **in the region you
intend to call**. Put the key in `~/.pi/secrets.env` (chmod 600) as a `DASHSCOPE_API_KEY` line, or
let the installer do it. It never goes into this repository.

!!! warning "Regions are separate services, not mirrors"

    Singapore (international) and Beijing (mainland China) have separate consoles, separate keys and
    **different prices for the same model id**. A key issued in one does not authenticate against
    the other: if a valid-looking key returns 401, check the region before you check the key.

Alibaba Cloud also issues RAM access keys — an id and a secret — for its other APIs. They do **not**
authenticate this endpoint, which wants `Authorization: Bearer <the Model Studio API key>`. If that
pair is all you have, issue an API key in the console rather than trying to convert them.

---

## What the interview asks

| Prompt | Asked when | What it does |
|---|---|---|
| `endpoint` | always | Picks the base URL: `singapore` → `dashscope-intl.aliyuncs.com`, `beijing` → `dashscope.aliyuncs.com`, or `workspace` for the workspace-scoped host your console hands you |
| `workspaceHost` | `endpoint = workspace` | The bare hostname, no scheme and no path — the fragment appends `/compatible-mode/v1` itself |

A host pasted **with** the path already on it produces a doubled path and a 404 on every request.
The base URL is substituted literally at install time: PI does not expand `$VAR` or `!cmd` inside
`baseUrl`, so it can never be an environment variable.

---

## The catalogue this fragment declares

List prices read from
[Alibaba Cloud's Model Studio pricing page](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
on 2026-08-29, **Singapore (international)**, in **dollars per million tokens**:

| Model | Input | Output | Declared window | Tier it backs |
|---|---|---|---|---|
| `qwen3.8-max` | 2.00 | 6.00 | 200 000 | `strong` |
| `qwen3.7-plus` | 0.40 | 1.60 | 200 000 | — |
| `qwen3.8-flash` | 0.15 | 0.47 | 200 000 | `light` |
| `qwen3-coder-plus` | 1.80 | 9.00 | 128 000 | — |
| `qwen-vl-max` | 0.80 | 3.20 | 128 000 | — |

!!! warning "The Beijing deployment bills less, and the fragment writes the international numbers"

    On the same page and date: `qwen3.8-max` 1.65 / 4.951, `qwen3.7-plus` 0.276 / 1.101,
    `qwen3.8-flash` 0.113 / 0.382, `qwen3-coder-plus` 0.861 / 3.441, `qwen-vl-max` 0.23 / 0.574.
    The composed `models.json` carries **one** rate per model, so if you answered `beijing` those
    five cost blocks over-report until you edit them. Over-reporting is the safe direction to be
    wrong in; it is still wrong.

### Two models are priced in bands, and the declared rate is the top band the window can reach

`qwen3.7-plus` is 0.40 / 1.60 up to 256K input tokens and 1.20 / 4.80 above it. The 200 000 window
never crosses that line, so its rate is exact.

`qwen3-coder-plus` is banded at 1.00 / 5.00 (to 32K), **1.80 / 9.00 (32K–128K)**, 3.00 / 15.00
(128K–256K) and 6.00 / 60.00 above. Its window is declared at 128 000 and it is priced at the band a
full context can reach, so a short turn reports up to 1.8× what it cost. If coder-plus is your main
model and your turns are small, lower the declared window **and** the rate together — not the rate
alone.

### Why `cacheRead` equals the miss rate

Model Studio documents a context cache, but the pricing page states one input rate per model rather
than a separate cached-input rate, and this repository has not measured what the endpoint reports in
`prompt_tokens_details` on a live key. Writing `0` there would claim cached reads are free — the
under-reporting shape [`cost-gate`](../extensions/cost-gate.md) exists to catch. Writing the miss
rate claims no discount, which can only over-report. `cacheWrite` is `0` because no charge for
placing an entry is published. Correct both in `config/models.json` once an invoice shows the real
cached-input line.

### Why the context windows say 200 000 and 128 000

The vendor documents 1 000 000 tokens for the `qwen3.x` ids. PI's compaction threshold is
`contextWindow - reserveTokens`, so an over-declared window makes compaction fire **too late** and
the endpoint truncates instead — which presents as the agent forgetting the start of the task.
`config/providers/README.md` §5 asks for `min(200000, measured)`; 128 000 on `qwen3-coder-plus` is
the price band and on `qwen-vl-max` the smaller documented window. Under-declaring only makes
compaction fire earlier. `/context` inside a session prints the resolved window and where it came
from.

---

## Egress is `public`

Not a comment on Alibaba's trustworthiness. The class records **where the traffic physically goes
and who can read it there**, and `config/providers/README.md` §5 is explicit: a third-party API is
`public` even if the vendor is trustworthy. Model Studio is multi-tenant SaaS outside any boundary
this harness controls, on either deployment, so `confidential` would be a false statement in the one
map every surface reads to tell a human or a model where a prompt is going.

A **private** Model Studio deployment inside your own boundary is
[`openai-compatible`](openai-compatible.md), answered with your host and your class — not this file.

---

## What `compat` says, and where it came from

`thinkingFormat: "qwen"`, `supportsDeveloperRole: false` and `supportsStore: false` are what PI's
bundled catalogue states for `qwen-token-plan` — Alibaba's compatible-mode surface on a different
host. Same protocol, same vendor, different deployment. That is a stronger source than a guess and a
weaker one than a turn on the wire, so it is carried across **with its provenance** rather than
presented as measured here.

`supportsReasoningEffort` is `false` for every model although PI's catalogue sets it **true** for
`qwen3.8-max`. §5 of the fragment contract says start with everything off, get one successful turn,
then enable one at a time. Turning it on for `qwen3.8-max` is the first thing to try if you want
thinking levels forwarded; the cost of being wrong is a 400 on every request rather than a silent
behaviour change.

---

## Verifying

```bash
curl -sS -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models | head -c 400
pi --list-models | grep '^qwen/'
pi -p 'reply with OK' --model qwen/qwen3.8-flash
```

Five ids ship because five cover the tiers plus a coder and a vision model; Model Studio serves many
more on the same key. To add one, append a block to `providers.qwen.models` in
`config/models.json` — `id`, `name`, `contextWindow` and all four rates — then run
`bin/pi-check --all` (PC-01 wants every id provider-qualified, PC-02 wants every bound tier to
resolve, PC-27 wants every declared model priced).

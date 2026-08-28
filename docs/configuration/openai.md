# `openai` — GPT-5.6 on an API key, or on a ChatGPT subscription

Use this if you buy GPT models from OpenAI directly. It covers both ways they sell the same models,
and the interview's first question is which one you have:

* **pay-as-you-go** — a platform API key, billed per token at the published rates;
* **a ChatGPT plan** — Plus, Pro, Business, Enterprise or Edu, signed in through PI's own
  `/login`, billed as a flat monthly subscription.

PI ships the `openai` provider itself, so this fragment **overrides the minimum** and never declares
a model list. It is configured at install time from `config/providers/openai.json` and lands in
[`config/models.json`](models.md) and [`config/routing.json`](routing.md), both generated and
gitignored. It is **not** selected by default in the provider picker.

!!! tip "This is not `openai-compatible`"

    [`openai-compatible`](openai-compatible.md) is named after the **wire protocol** and fits any
    gateway serving its own model names. This fragment is named after the **company**. If you are
    pointing at a LiteLLM proxy, an in-house router or a loopback server, you want that one.

---

## Before you start

**On the pay-as-you-go branch** you need a platform API key — an `sk-…` value from
[platform.openai.com](https://platform.openai.com/) under Settings → API keys. Put it in
`~/.pi/secrets.env` (chmod 600) as an `OPENAI_API_KEY` line, or let the installer do it for you. It
never goes into this repository; `bin/pi-check` rule PC-06 fails the tree if a key value reaches
`config/shell/pi-env.sh`.

**On the subscription branch you need no key at all.** Run `/login` inside PI, pick the ChatGPT
Plus/Pro (Codex) method, and finish the browser sign-in. The credential lands in
`~/.pi/agent/auth.json` (0600) and is refreshed there.

!!! warning "Do not set `OPENAI_API_KEY` *and* sign in"

    A configured API key takes precedence over the sign-in. Setting one "just in case" moves you
    onto metered billing while the fragment's cost block still says you are unmetered, which is the
    one way to get a real invoice and a status line reading `$0.000` at the same time. Pick a
    branch; if you switch, re-run the installer with `--reconfigure` rather than adding the key.

---

## What the interview asks

| Prompt | Asked when | What it does |
|---|---|---|
| `acquisition` | always | `metered` writes `apiKey: "$OPENAI_API_KEY"` and the published rates; `unmetered` **deletes** the `apiKey` key so PI resolves the sign-in, and writes four zeros |
| `endpoint` | always | `direct` **deletes** the `baseUrl` key so PI uses the vendor default it already knows; `proxy` asks for your own |
| `proxyBaseUrl` | `endpoint = proxy` | Substituted literally — PI does not expand `$VAR` or `!cmd` inside `baseUrl` |

Both deletions are the same substitution rule: a token that resolves to `null` removes the key that
holds it. An empty string would be a credential that resolves to nothing and a base URL that
resolves to nowhere, and both fail at request time instead of at install time.

---

## The catalogue this fragment corrects

Three ids, with the list prices read from
[OpenAI's pricing page](https://developers.openai.com/api/docs/pricing.md) on 2026-08-28, in
**dollars per million tokens**:

| Model | Input | Cached input | Output | Tier it backs |
|---|---|---|---|---|
| `gpt-5.6-sol` | 4.00 | 0.40 | 20.00 | `strong` |
| `gpt-5.6-terra` | 2.00 | 0.20 | 12.00 | — |
| `gpt-5.6-luna` | 0.20 | 0.02 | 1.20 | `light` |

`cacheWrite` is `0` because OpenAI does not charge for it: prompt caching discounts cached *input*
and bills nothing to place an entry, so that zero is the rate rather than a gap.

!!! danger "These are somebody else's list prices, and they move"

    Sol's rate above is promotional through at least 2026-11-21; Terra and Luna were cut on
    2026-07-30. A discounted or committed-use account pays less than list, and nothing in a template
    can know that. `test/providers-cost.test.ts` insists a fragment that *writes* rates also names
    the page it read them from, so you can check them against the page rather than against this
    repository's memory. If your invoice disagrees, edit `config/models.json` — or edit the fragment
    and re-run the installer, which is the version that survives.

### Why the context window says 200 000

OpenAI documents 1 050 000 tokens for all three ids. The fragment declares `200000`, on purpose, for
two reasons that point the same way:

* PI's compaction threshold is `contextWindow - reserveTokens`, so an over-declared window makes
  compaction fire **too late** — the failure mode `github-copilot` carries the same correction for;
* above 272 000 input tokens OpenAI prices the **whole request** at 2× input and 1.5× output, so a
  window that lets a session drift past that line quietly doubles the bill on every turn after it.

Under-declaring only makes compaction fire earlier. Raise it in `config/models.json` if you have
measured your own need for the room and priced it.

### What is deliberately *not* overridden

`thinkingLevelMap`, `compat` and `api`. OpenAI documents reasoning efforts of
`none, low, medium, high, xhigh, max` and serves both Chat Completions and Responses, but this
repository has measured neither on a live key, and PI's bundled catalogue for its own first-party
provider is a better source than a fragment's guess. The rule in `config/providers/README.md` is
that `compat` flags are *measured, not copied* — an unmeasured flag written into a fragment reads
exactly like a measured one.

---

## The subscription branch and the `$0.000` status line

A ChatGPT plan bills a flat monthly rate and meters usage in plan credits. There is no per-token
rate to write, so the fragment writes **four explicit zeros** — a declaration, not an omission.
[`cost-gate`](../extensions/cost-gate.md) and `PC-27` both read four written zeros as authored and
accept them permanently; an *absent* `cost` is what ends the first billed turn. A session on this
branch reports a flat `$0.000` spend on purpose. Track the plan's own usage in ChatGPT settings.

---

## Verifying

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models   # PAYG branch
pi --list-models | grep '^openai/'                                             # both branches
pi -p 'reply with OK' --model openai/gpt-5.6-sol
```

The middle one is the check that matters on the subscription branch. A built-in provider whose block
carries no `apiKey` is expected to fall through to the OAuth credential — that is how all of PI's
subscription logins work — but that fall-through was not measured against this tree, and it is the
one claim in this fragment that is reasoned rather than observed. If the models are missing after a
successful `/login`, say so rather than pasting an API key in to make the symptom go away: that
silently moves you onto the metered branch with the unmetered cost block still in place.

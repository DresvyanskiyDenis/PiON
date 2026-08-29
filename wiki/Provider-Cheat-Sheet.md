# Provider cheat sheet

The eight provider fragments that ship in `config/providers/`. The installer offers exactly these
and composes `config/models.json` from whichever you select.

Reasoning and the full fragment schema:
[Adding a provider](https://dresvyanskiydenis.github.io/PiON/extending/providers/) and
[`config/models.json`](https://dresvyanskiydenis.github.io/PiON/configuration/models/).

## At a glance

| Provider | Built into PI | Egress class | Concurrency | Needs |
|---|---|---|---|---|
| `github-copilot` | yes | `public` | 4 | `COPILOT_GITHUB_TOKEN` |
| `openai` | yes | `public` | 4 | `OPENAI_API_KEY` — **or** nothing at all, on a ChatGPT plan |
| `deepseek` | yes | `public` | 4 | `DEEPSEEK_API_KEY` |
| `qwen` | **no** | `public` | 2 | `DASHSCOPE_API_KEY`, and the deployment you call |
| `ollama-cloud` | **no** | `public` | **you choose** (default 1) | `OLLAMA_API_KEY`, and a plan that runs the models |
| `litellm` | **no** | **you choose** | **you choose** (default 2) | a proxy URL, an env-var name you pick, and the proxy's own model ids |
| `databricks` | **no** | `confidential` | 4 | `DATABRICKS_HOST` (+ a token or the CLI) |
| `openai-compatible` | **no** | **you choose** | **you choose** (default 2) | a base URL, an env-var name you pick, and the gateway's own model ids |

`openai-compatible` is the catch-all: **anything** speaking `/v1/chat/completions` under its own
model names — a gateway (LiteLLM, vLLM, OpenRouter, an in-house router), a first-party vendor API, or
a server on your own loopback. `openai` in that fragment's name is the **wire protocol**, not a
vendor: the fragment has nothing to do with any particular company's account.

Fragments for individual vendors are the exception, not the pattern: one exists only when it knows
something the interview cannot ask for. `litellm` knows four wire fields that may not be deferred to
a prompt. `openai` knows that a ChatGPT subscription has no API key at all, which a gateway fragment
cannot express — no answer produces an *absent* field — and it knows the published list prices for
models it names by id. `deepseek` knows that PI's own bundled rates for those ids had fallen behind
the vendor's page. `qwen` knows that Alibaba sells the same models twice — metered on Model Studio
and flat-rate on the plan PI already ships as `qwen-token-plan` — and that they are different hosts.
`ollama-cloud` knows that the hosted product needs a key where the local one does not, and that it
bills by plan rather than by token. The `local` fragment knew none of this and was retired for it
(owner decision, 2026-08-15): it was this fragment with different answers.

"Built into PI" matters: for a built-in provider you **override the minimum** and never re-declare
the whole catalogue. Re-declaring `models` on a built-in provider is how an OAuth block gets
destroyed.

## Which tier suits which

| Tier | Sensible binding | Why |
|---|---|---|
| `strong` | your best reasoning model | main loop, architecture, hard debugging |
| `light` | a mid model | everything the main loop delegates: reviews, docs, mechanical multi-file edits, summaries, digests, classification, grep-and-report |
| `confidential` | `databricks`, or `openai-compatible` **if** you classed your gateway confidential | the endpoint has to be inside a boundary you control — for a gateway that is your answer to give, not the URL's |

Three tiers, not one per price point. `strong` and `light` are the two *roles* a bound tier can play;
for a single call that needs something else, pin `provider/id` on that call rather than growing the
vocabulary.

`confidential` ships **unbound**, and asking for an unbound tier fails loudly. That is the feature:
binding `confidential` to a public endpoint would make the word meaningless.

---

## `github-copilot`

Claude / GPT / Gemini / Grok through a Copilot seat. The default in the shipped `settings.json`
because it is the one seat that reaches several model families at once.

- **Credential:** `COPILOT_GITHUB_TOKEN` (required). `PI_COPILOT_QUOTA_TOKEN` is optional and only
  feeds the quota meter.
- **Enterprise:** a GitHub Enterprise Cloud data-residency tenant is supported — the Copilot API host
  becomes `copilot-api.<tenant>.ghe.com`. The installer asks for the slug only.
- **Watch out:** PI's bundled Copilot catalogue declares context windows of 1 000 000+ for models
  whose Copilot endpoint serves far less. The fragment ships `modelOverrides` correcting them to
  what the endpoint actually serves — do not "fix" those numbers upwards. See
  [Context windows](https://dresvyanskiydenis.github.io/PiON/concepts/context-windows/).

## `openai`

GPT-5.6 straight from OpenAI, on either of the two ways they sell it. The interview asks which one
you have before anything else.

- **Credential:** `OPENAI_API_KEY` on the pay-as-you-go branch; **none** on the ChatGPT
  Plus/Pro/Business branch, where `/login` puts the sign-in in `~/.pi/agent/auth.json` and the
  fragment writes a block with no `apiKey` key at all so PI resolves it from there.
- **Do not set the key *and* sign in.** A configured key wins over the sign-in, which puts you on
  metered billing while the cost block still says unmetered — a real invoice beside a `$0.000`
  status line. Re-run the installer instead.
- **Prices are written down, dated, and sourced:** 4.00 / 20.00 per million tokens for
  `gpt-5.6-sol`, 2.00 / 12.00 for `gpt-5.6-terra`, 0.20 / 1.20 for `gpt-5.6-luna`, read from
  OpenAI's pricing page on 2026-08-28. On the subscription branch all four rates are explicit zeros:
  a flat monthly plan has no per-token rate, and inventing one would be worse than declaring none.
- **Watch out:** the fragment declares a 200 000 context window where the vendor documents
  1 050 000. That is deliberate twice over — compaction fires on the declared window, and above
  272 000 input tokens OpenAI charges 2x input and 1.5x output for the *whole* request.

## `deepseek`

DeepSeek V4 on a platform API key. PI ships the provider; the fragment corrects **two fields per
model** and nothing else.

- **Credential:** `DEEPSEEK_API_KEY`.
- **Why it exists:** PI's bundled catalogue stated 0.14 / 0.28 for `deepseek-v4-flash` and
  0.435 / 0.87 for `deepseek-v4-pro` on 2026-08-29, where the vendor's page stated materially more.
  An under-declared rate reads exactly like a correct one until the invoice arrives.
- **Rates written:** 1.32 / 3.96 for `deepseek-v4-pro`, 0.44 / 1.32 for `deepseek-v4-flash`, cache
  hits at 0.044 and 0.014, per million tokens, read from
  <https://api-docs.deepseek.com/quick_start/pricing> on 2026-08-29. That is the **standard** column;
  the vendor also publishes a cheaper off-peak one, and a session inside that window over-reports.
- **Watch out:** the cache hit is about a thirtieth of a miss. If `cacheRead` never moves off zero
  over a long session, the cache is not working — check that before assuming the prices are wrong.

## `qwen`

Alibaba's Qwen models bought **per token** from Model Studio (DashScope).

- **Credential:** `DASHSCOPE_API_KEY`. RAM access-key pairs do not authenticate this surface.
- **Not `qwen-token-plan`.** PI ships that one already: it is Alibaba's **flat-rate plan**, on a
  different host, priced at four written zeros, and it serves other vendors' models too. Dispatch at
  `qwen/…` if you buy tokens and `qwen-token-plan/…` if you have the plan, or the status line lies.
- **Regions are separate services.** Singapore and Beijing have separate consoles, separate keys and
  different prices for the same id. A key from one returns 401 against the other.
- **Rates written** are the Singapore list, read from
  <https://www.alibabacloud.com/help/en/model-studio/model-pricing> on 2026-08-29. Beijing bills
  less; if you answered `beijing`, edit the five cost blocks in `config/models.json`.
- **Watch out:** `qwen3-coder-plus` is priced in bands by request size. It is declared at the
  32K–128K band (1.80 / 9.00) with a 128 000 window, so short turns over-report.

## `ollama-cloud`

The **hosted** ollama.com, over its OpenAI-compatible surface at `https://ollama.com/v1`.

- **Credential:** `OLLAMA_API_KEY`. The hosted endpoint returns 401 without one, unlike a local
  ollama, which accepts any string.
- **A local ollama is not this fragment.** It is `openai-compatible` answered with
  `http://127.0.0.1:11434/v1`. The egress classes are opposite: local never leaves the machine, and
  this one is somebody else's hardware.
- **Cost is four written zeros**, on purpose: the plan bills by subscription, not by token, so no
  per-token rate exists to write. A flat `$0.000` in the status line is correct here. Watch the
  plan's rate limit at ollama.com instead.
- **Watch out:** the model ids move. Four are declared out of the 19 the endpoint served on
  2026-08-29; re-run `curl -sS -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/v1/models`
  and write ids byte for byte, tag included (`gpt-oss:120b`).

## `databricks`

Models served from **your own** workspace over its OpenAI-compatible surface. The usual choice for
the `confidential` tier.

- **Credential:** `DATABRICKS_HOST` (required) plus either `DATABRICKS_TOKEN` or the `databricks`
  CLI. `jq` is used by the token wrapper.
- **Model ids are serving-endpoint names, and they are per workspace.** There is no public list; ask
  your own workspace:

  ```bash
  databricks serving-endpoints list --output json | jq -r '.[].name'
  ```

  Do not copy ids out of anyone else's configuration, including the illustrative ones in the
  fragment.
- **Pay-per-token endpoints are the same surface, not a second one.** A Foundation Model endpoint
  billed per token lives on the same workspace host, under the same `/serving-endpoints` path,
  behind the same token as a provisioned one; only the billing differs, which is why the interview
  asks per endpoint rather than offering a second provider. Answer `metered` and you type the two
  rates; answer `unmetered` and the endpoint composes four explicit zeros, which is correct for
  provisioned-throughput, custom and external-model endpoints that bill by DBU-hour.
- **The rates have to be converted, and only you can do it.** Databricks publishes pay-per-token
  prices in **DBUs** per million tokens; the dollar value of a DBU depends on your cloud, region and
  contract. Multiply before you type, or read the dollar figure off the pricing calculator.
- **Why the API is pinned to `openai-completions`:** Model Serving exposes Chat Completions and *not*
  a Responses surface, so leaving the API to default would pick the wrong one.
- **Why the credential is a cached wrapper rather than a bare `!databricks auth token`:** PI
  re-executes an `!command` credential on **every request**, with no TTL of its own. Unwrapped, that
  is one OAuth round trip per request.

---

## Adding one that is not here

First check whether `openai-compatible` already covers it: any endpoint speaking
`/v1/chat/completions` under its own model names is that fragment, answered differently, and a new
file buys you nothing. If it genuinely does not fit, write a fragment (`schemaVersion: 1`) into
`config/providers/`, answer four questions in it — egress class, whether PI has it built in, the
context window your endpoint really serves, and which compatibility flags you **measured** — then
re-run `./scripts/install.sh --section providers`.

Two PI constraints that catch people out: `baseUrl` is **not** variable-expanded, and `apiKey` must
resolve to something at session start. Details on
[Adding a provider](https://dresvyanskiydenis.github.io/PiON/extending/providers/).

---

See also: [[Cookbook]] · [[Troubleshooting]] · [[FAQ]]

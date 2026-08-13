# Provider cheat sheet

The six provider fragments that ship in `config/providers/`. The installer offers exactly these and
composes `config/models.json` from whichever you select.

Reasoning and the full fragment schema:
[Adding a provider](https://dresvyanskiydenis.github.io/PiON/extending/providers/) and
[`config/models.json`](https://dresvyanskiydenis.github.io/PiON/configuration/models/).

## At a glance

| Provider | Built into PI | Egress class | Concurrency | Needs |
|---|---|---|---|---|
| `github-copilot` | yes | `public` | 4 | `COPILOT_GITHUB_TOKEN` |
| `anthropic` | yes | `public` | 4 | `ANTHROPIC_API_KEY`, *or* a Pro/Max subscription login |
| `openai` | yes | `public` | 4 | `OPENAI_API_KEY` |
| `databricks` | **no** | `confidential` | 4 | `DATABRICKS_HOST` (+ a token or the CLI) |
| `local` | **no** | `confidential` | **1** | a server on loopback |
| `openai-compatible` | **no** | **you choose** | **you choose** (default 2) | a base URL, an env-var name you pick, and the gateway's own model ids |

`openai-compatible` is the one for a **gateway** — LiteLLM, vLLM, OpenRouter, an in-house router.
Reach for it whenever the endpoint serves its own model names. A *transparent* proxy in front of
`api.openai.com`, which still answers to OpenAI's names, is the `openai` fragment with
`useProxy` instead: overriding `baseUrl` there keeps OpenAI's catalogue, which is right for a proxy
and wrong for a gateway.

"Built into PI" matters: for a built-in provider you **override the minimum** and never re-declare
the whole catalogue. Re-declaring `models` on a built-in provider is how an OAuth block gets
destroyed.

## Which tier suits which

| Tier | Sensible binding | Why |
|---|---|---|
| `strong` | your best reasoning model | main loop, architecture, hard debugging |
| `fast` | a mid model | reviews, docs, mechanical multi-file edits |
| `cheap` | a small model | summaries, digests, classification, grep-and-report |
| `confidential` | `databricks`, `local`, or `openai-compatible` **if** you classed your gateway confidential | the endpoint has to be inside a boundary you control — for a gateway that is your answer to give, not the URL's |
| `local` | `local` | nothing leaves the machine |

`confidential` and `local` ship **unbound**, and asking for an unbound tier fails loudly. That is the
feature: binding `confidential` to a public endpoint would make the word meaningless.

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

## `anthropic`

Claude models straight from the vendor.

- **Credential:** `ANTHROPIC_API_KEY`, or a subscription login handled by PI itself — which is why
  the key is marked *not* required in the fragment.
- **Watch out:** the same over-declared window problem. The bundled catalogue declares 1 000 000 for
  the recent Opus/Sonnet family; on the API that window is a beta enabled per account, and most
  accounts are served 200 000. The fragment corrects it, deliberately.

## `openai`

GPT models straight from the vendor.

- **Credential:** `OPENAI_API_KEY` (required).
- Optionally routed through an egress proxy; the fragment carries the shape for it.

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
- **Why the API is pinned to `openai-completions`:** Model Serving exposes Chat Completions and *not*
  a Responses surface, so leaving the API to default would pick the wrong one.
- **Why the credential is a cached wrapper rather than a bare `!databricks auth token`:** PI
  re-executes an `!command` credential on **every request**, with no TTL of its own. Unwrapped, that
  is one OAuth round trip per request.

## `local`

Anything on loopback that speaks `/v1/chat/completions` — llama.cpp, llama-swap, Ollama, LM Studio,
vLLM.

- **Needs:** a server answering `GET /v1/models` and `POST /v1/chat/completions`.
- **Default port is 8888.** On any other port you **must** set `PI_LOCAL_BASE_URL`:

  ```bash
  export PI_LOCAL_BASE_URL="http://127.0.0.1:<port>/v1"
  ```

  The credentials module registers `process.env.PI_LOCAL_BASE_URL ?? "http://127.0.0.1:8888/v1"`, and
  PI resolves the extension's `baseUrl` **before** the one in `models.json` — so without the
  variable, requests go to 8888 while `models.json` innocently says otherwise. The installer writes
  the export into `config/shell/pi-env.sh` from your port answer.
- **Concurrency ships at 1** — one machine, one GPU, one queue. Raising it makes a local server
  thrash rather than go faster.
- **Ollama** serves on 11434 and prefixes ids with the model name; set the base URL accordingly.

---

## Adding one that is not here

Write a fragment (`schemaVersion: 1`) into `config/providers/`, answer four questions in it — egress
class, whether PI has it built in, the context window your endpoint really serves, and which
compatibility flags you **measured** — then re-run `./scripts/install.sh --section providers`.

Two PI constraints that catch people out: `baseUrl` is **not** variable-expanded, and `apiKey` must
resolve to something at session start. Details on
[Adding a provider](https://dresvyanskiydenis.github.io/PiON/extending/providers/).

---

See also: [[Cookbook]] · [[Troubleshooting]] · [[FAQ]]

# `github-copilot` — Claude, GPT, Gemini and Grok through a Copilot seat

Use this if you have a GitHub Copilot seat. One credential gets you the whole Copilot catalogue, and
PI ships the provider itself — this fragment only corrects the parts that are wrong for a coding
agent.

It is configured at install time from `config/providers/github-copilot.json` and lands in
[`config/models.json`](models.md) and [`config/routing.json`](routing.md), both generated and
gitignored. It is selected **by default** in the installer's provider picker.

---

## Before you start

You need a **Copilot OAuth access token** — a `gho_…` value. PI sends it straight through as the API
key; there is no token exchange on this path. Two ways to get one:

1. **Reuse the token an editor integration already holds.** VS Code and other OAuth clients store
   one.
2. **Run `/login github-copilot` once in PI**, on a *public* seat, and copy the value out of
   `~/.pi/agent/auth.json`.

Then put it in `~/.pi/secrets.env` (chmod 600) as a `COPILOT_GITHUB_TOKEN` line holding that value, or
let the installer do it for you.

!!! danger "Never leave `/login github-copilot` as your credential path"

    PI's Copilot provider registers **two** auth methods. The `apiKey` method sends
    `COPILOT_GITHUB_TOKEN` through and leaves the configured `baseUrl` intact. The OAuth method's
    resolver **always** returns its own `baseUrl`, derived from the token's `proxy-ep` hint, and at
    request time `applyAuth()` does `auth.baseUrl ? {...model, baseUrl: auth.baseUrl} : model` — so
    an OAuth credential silently overrides the host written here.

    On the public endpoint that is harmless. On an enterprise data-residency tenant it sends your
    traffic somewhere else. Use `/login` to *mint* a token, then configure it as an env var.

An optional second credential, `PI_COPILOT_QUOTA_TOKEN`, is used only by the quota-meter extension
and never for chat. It must be a **classic** `ghp_…` PAT — the premium-usage endpoint rejects a
fine-grained `github_pat_…` token.

---

## The interview

One question, or two.

| # | Question | Notes |
|---|---|---|
| 1 | Which Copilot endpoint does your seat use? | `public` (api.githubcopilot.com) — the normal answer — or `enterprise` |
| 2 | Your GHE data-residency tenant slug | Only asked for `enterprise`. The **slug only**: for an enterprise at `https://<tenant>.ghe.com`, the Copilot API host is `copilot-api.<tenant>.ghe.com` |

Everything else is stated by the fragment: egress class `public`, concurrency cap `4`, and the model
catalogue's context windows.

To reconfigure afterwards: `./scripts/install.sh --section providers`.

---

## Why the fragment overrides context windows

PI's bundled Copilot catalogue declares a **1 000 000** token context window (1 050 000 for some
ids) for models whose Copilot endpoint serves far less.

PI's compaction threshold is `contextWindow - reserveTokens`. An over-declared window makes
compaction fire far too late: by the time PI decides to compact, the request is already larger than
the endpoint accepts, and the turn dies — or is silently truncated upstream — instead of compacting.

The rule the fragment follows is **`min(200000, what the endpoint actually serves)`**, and the
numbers in it were measured on one tenant. They are deliberately conservative: under-declaring only
makes compaction fire earlier, which is safe. Over-declaring is what breaks.

To re-measure on your own seat, send a request whose prompt is a known token count and grow it until
the endpoint returns a context-length error; the largest size that still succeeds is the real
window. `pi --list-models` shows what PI currently believes. **Do not raise a number you have not
observed.**

---

## Three things about the model list

**It is unfiltered.** PI narrows the catalogue to the credential's entitlement only for *OAuth*
credentials. On the `apiKey` path, `/model` lists every model in the bundled catalogue regardless of
what your seat actually grants. A **403 or 404 on a specific id is account policy** surfacing
through an unfiltered list, not a bug. Some seats also require enabling a model once in the editor's
model picker before the API will accept it.

**`api` is deliberately unset.** Copilot dispatches three different wire APIs depending on the
model, and PI picks the right one from its own catalogue. Setting `api` here would force one of them
onto all of them.

**`apiKey` is not optional.** A `github-copilot` block with no `apiKey` key *at all* is read as
unconfigured, and PI drops the **entire** built-in Copilot catalogue from `/model`, Ctrl+P and every
tier naming a `github-copilot/*` id. That is a stronger failure than a present-but-empty reference,
which leaves the models listed and fails at request time. Measured, not theorised.

---

## Never touch the `X-Initiator` header

GitHub's meter keys premium-request counting on it. Rewriting it misreports your usage against your
seat. `bin/pi-check` rule **PC-15** fails the build if any extension references it.

---

## Verifying

The installer writes these into `~/.pi/agent/provider-notes.md` with your endpoint already
substituted in, and names that file in its closing list of manual steps.

```bash
# the endpoint answers with your token
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $COPILOT_GITHUB_TOKEN" https://api.githubcopilot.com/models

# PI sees the provider as configured
pi --list-models | grep '^github-copilot/'

# one real turn
pi -p 'reply with OK' --model github-copilot/claude-sonnet-5
```

!!! danger "There is no failover, here or anywhere"

    A seat that is out of quota, rate-limited or returning 5xx **aborts** the request, naming the
    provider, the model, the error class and the cause chain. Nothing is silently sent elsewhere.
    See [ADR 0001](../adr/0001-no-provider-failover.md).

## Related

- [`config/models.json`](models.md) — the file this writes into
- [`config/routing.json`](routing.md) — tiers, egress classes, concurrency caps
- [Context windows](../concepts/context-windows.md) — why the overrides above exist
- [Credentials](../extensions/credentials.md) — where the token is stored

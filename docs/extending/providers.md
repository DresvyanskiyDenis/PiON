# Adding a provider

Three provider fragments ship: `github-copilot`, `databricks` and `openai-compatible`. Adding a
fourth is a JSON file, and the installer picks it up with no code change.

!!! tip "Check `openai-compatible` first"

    If your endpoint speaks `/v1/chat/completions` under its own model names — LiteLLM, vLLM,
    OpenRouter, an in-house router — it is already covered by
    [`openai-compatible`](../configuration/openai-compatible.md), answered differently. Writing a
    new fragment buys you a second entry in the provider menu and nothing else.

There are two ways in, and they are not equivalent:

| Route | When |
|---|---|
| **Write a fragment** in `config/providers/` and re-run the installer | you want it prompted for, verified, and reproducible on another machine |
| **Hand-edit `config/models.json`** | you want it now, and you accept that the installer will regenerate the file |

Prefer the fragment. `config/models.json` is generated and git-ignored — **an edit that must survive
belongs in a template**, which is the rule that governs this whole configuration tree.

---

## The fast route: hand-editing

```jsonc
// config/models.json → providers
"my-endpoint": {
  "name": "My endpoint",
  "baseUrl": "https://models.example.com/v1",
  "api": "openai-completions",
  "apiKey": "$MY_ENDPOINT_TOKEN",
  "models": [
    {
      "id": "my-model-v1",
      "name": "My model v1",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "cost": { "input": 0, "output": 0 }
    }
  ]
}
```

Then bind a tier in `config/routing.json` and give the provider an egress class and a concurrency
cap. Only the tier binding is load-bearing — a provider with no `egress` entry dispatches normally
and reads as `unlabelled` everywhere its class is printed, and one with no `concurrency` entry falls
back to `concurrencyDefault`. Write both anyway: the two defaults are silent, and a provider whose
class nobody declared is one nobody had to think about.

Verify:

```bash
config/bin/pi-tier --list          # tiers and what they resolve to
pi                                 # /model should list your models
/doctor                            # D-04: every tier resolves AND has a credential
```

Details on every key: [`config/models.json`](../configuration/models.md).

---

## The durable route: a fragment

One JSON file, `config/providers/<id>.json`, where `<id>` **must equal the filename**. It is
self-describing: it carries the `models.json` block, the questions the installer must ask, the
credentials it needs, its egress class, its concurrency cap, and the reasoning JSON cannot hold.

```jsonc
{
  "schemaVersion": 1,
  "id": "my-endpoint",
  "displayName": "My endpoint",
  "summary": "An OpenAI-compatible endpoint behind our gateway.",
  "builtIn": false,
  "default": false,
  "egress": "internal",
  "concurrency": 4,

  "requires": [
    {
      "kind": "env",
      "name": "MY_ENDPOINT_TOKEN",
      "required": true,
      "secret": true,
      "description": "Bearer token for the gateway.",
      "howTo": "Generate one in the gateway UI; put it in ~/.pi/secrets.env."
    }
  ],

  "prompts": [
    {
      "id": "host",
      "type": "string",
      "label": "Gateway host",
      "example": "models.example.com",
      "required": true
    },
    {
      "id": "contextWindow",
      "type": "number",
      "label": "Context window this endpoint actually serves",
      "default": 128000,
      "required": true
    }
  ],

  "tiers": { "light": "my-endpoint/my-model-v1" },

  "provider": {
    "name": "My endpoint",
    "baseUrl": "https://{{host}}/v1",
    "api": "openai-completions",
    "apiKey": "$MY_ENDPOINT_TOKEN",
    "models": [
      {
        "id": "my-model-v1",
        "name": "My model v1",
        "contextWindow": "{{contextWindow}}",
        "maxTokens": 8192,
        "cost": { "input": 0, "output": 0 }
      }
    ]
  },

  "notes": [
    "MEASURED 2026-08-12: the gateway rejects `max_completion_tokens`; keep maxTokensField at max_tokens."
  ],

  "verify": [
    { "label": "endpoint reachable", "command": "curl -sf https://$HOST/v1/models >/dev/null" }
  ]
}
```

Every top-level key is required except `derived`, `tiers` and `verify`. **An unknown key is an error,
not a warning** — a typo'd key that is silently ignored is how a prompt stops being asked without
anyone noticing.

The full contract, including `requires`, `prompts`, `derived`, `$omitIfBlank` and the merge
algorithm, is in `config/providers/README.md`. It is the authority: if the installer and that file
disagree, the file is right.

---

## The four questions to answer before you ship one

Taken from the fragment contract, because each of them has cost somebody a day.

### 1. Which egress class?

Not a vibe. **Where does the traffic physically go, and who can read it there.** A third-party API is
`public` even if the vendor is trustworthy.

`public` · `internal` · `confidential`. The class is a **label**: it is printed beside this provider
everywhere a model or an agent is offered, and it refuses nothing — no socket is intercepted, and
since 2026-08-13 no dispatch is refused on account of it either
([ADR 0004](../adr/0004-egress-classes-are-declarative.md)). Answer it honestly anyway: it is the
only signal a reader gets about where this provider sends a prompt. See
[Providers and tiers](../concepts/providers-and-tiers.md).

If the honest answer is *"it depends on whose deployment this is"* — the gateway case — a fragment
may defer `egress`, `concurrency` and a `requires[].name` to a prompt, by setting the field to a lone
`"{{promptId}}"`. Those three fields and no others; see `config/providers/README.md` §2.8 for the
rules the loader enforces (an `egress` prompt must be a `choice` whose every option is one of the
three classes, and the resolved value is re-validated before it reaches `routing.json`).
`openai-compatible.json` is the worked example.

### 2. Does PI already ship this provider?

If yes, set `builtIn: true` and keep the `provider` block to the **minimum override**.

!!! danger "Re-declaring a built-in provider's fields is how OAuth blocks get destroyed"
    A provider whose credentials come from an OAuth flow stores state PI manages. A fragment that
    re-declares the whole block overwrites it, and the failure looks like an expired token rather
    than a config bug.

### 3. What does the endpoint *actually* serve as a context window?

```text
contextWindow = min(200000, what the endpoint actually serves)
```

**Never copy the number off a model card.** This is the single most valuable operational rule in the
project and it has its own page: [Context windows](../concepts/context-windows.md).

Declaring more than the endpoint serves produces a hard failure mid-session, after compaction has
already decided it had room.

### 4. Which `compat` flags did you measure?

Start with everything off and `maxTokensField: "max_tokens"`. Get **one successful turn**. Then enable
one flag at a time.

Write what you measured into `notes[]`, with a date. The next person cannot re-derive it from the
config alone, and a wrong guess produces a 400 whose message names the wrong field.

The flag-to-symptom table is in [`config/models.json`](../configuration/models.md#compat).

---

## Two constraints from PI that shape every fragment

### `baseUrl` is not variable-expanded

`$VAR` and `!command` work for `apiKey` and `headers` **only**. A host that varies per installation
has to be substituted literally at install time — which is precisely why fragments and prompts exist.

### `apiKey` must be present *and* resolve

Even for an endpoint that checks nothing. An absent or unresolvable `apiKey` makes the provider's
models disappear from `/model` **entirely**, which reads as a broken harness rather than a missing
credential.

For an endpoint with no auth, point it at a variable you export to any non-empty value.

---

## After adding it

```bash
./scripts/install.sh                # re-running is a supported way to reconfigure
config/bin/pi-tier --list
bin/pi-check --all                  # PC-02: no tier points at an uninstalled provider
pi
/doctor                             # D-04
```

Re-running the installer is **not** a reinstall. It regenerates `models.json`, `routing.json` and
`mcp.json` from the templates plus your answers, and it is the intended way to add a provider,
rebind a tier or change a host.

!!! warning "A tier left pointing at a provider you did not install fails the build"
    `bin/pi-check` rule `PC-02` catches it. If a tier cannot be bound on this machine, it belongs in
    `routing.json`'s [`tiersUnbound`](../configuration/routing.md#tiersunbound) with a one-line
    reason — not left dangling.

## Related

- [`config/models.json`](../configuration/models.md) — every provider key
- [`config/routing.json`](../configuration/routing.md) — tiers, egress, concurrency
- [Context windows](../concepts/context-windows.md) — the rule worth more than the rest of this page
- [Providers and tiers](../concepts/providers-and-tiers.md)

# `config/providers/` — provider fragments, and the contract the installer consumes

One JSON file per provider. Each one is **self-describing**: it carries the block that goes into
`config/models.json`, the questions the installer has to ask before that block is usable, the
credentials it needs, its egress class and concurrency cap, and the reasoning that cannot live in
JSON because JSON has no comments.

`scripts/install.sh` reads this directory. **This file is the contract between the fragments and the
installer.** If the two disagree, this file is right and the installer is wrong.

---

## 1. What is tracked, what is generated

| Path | Tracked in git? | Written by | Purpose |
|---|---|---|---|
| `config/providers/*.json` | **yes** | a human | Template fragments. Never installed anywhere; only read. |
| `config/models.default.json` | **yes** | a human | Generic working default: public GitHub Copilot only, zero configuration. |
| `config/routing.default.json` | **yes** | a human | Generic tier bindings that reference only what `models.default.json` provides. |
| `config/models.json` | **no — gitignored** | `scripts/install.sh` | The active file, symlinked to `~/.pi/agent/models.json`. Carries your endpoints. |
| `config/routing.json` | **no — gitignored** | `scripts/install.sh` | The active tier map, symlinked to `~/.pi/agent/routing.json`. |

The reason for the split is blunt: the install layout symlinks `~/.pi/agent/*` at this repository, so
generated config has to live *inside* the repo. If the active files were tracked, the first person who
runs the installer and then commits would publish their own workspace host or tenant name. They are
gitignored so that cannot happen. **Never `git add -f` them.**

Everything that reads these files at runtime — `extensions/dispatch/config.ts`,
`extensions/path-defaults/`, `extensions/digest/`, `config/bin/pi-tier` — reads
`config/models.json` / `config/routing.json`, i.e. the *generated* names, and fails loud naming
`scripts/install.sh` when they are absent. Do not teach anything to fall back to the `.default.json`
files: a harness quietly running on defaults the operator did not choose is exactly the silent
substitution this project refuses.

---

## 2. Fragment schema, version 1

```jsonc
{
  "schemaVersion": 1,              // int. Bump only on a breaking change; the installer must refuse
                                   //   a fragment whose schemaVersion it does not know.
  "id": "databricks",              // string. The provider key in models.json and routing.json.
                                   //   MUST equal the filename without .json.
  "displayName": "…",              // string. Menu label.
  "summary": "…",                  // string, one line. Shown next to the label.
  "builtIn": false,                // bool. true = PI already ships this provider and the block below
                                   //   only overrides parts of it. false = the block defines it whole.
  "default": false,                // bool. Pre-selected in the installer. Exactly one fragment
                                   //   (github-copilot) sets this true.
  "egress": "confidential",        // "public" | "internal" | "confidential". Copied verbatim into
                                   //   routing.json's `egress` map under `id`. May instead be a
                                   //   lone "{{promptId}}" — see 2.8.
  "concurrency": 4,                // int >= 1. Copied verbatim into routing.json's `concurrency`
                                   //   map. May instead be a lone "{{promptId}}" — see 2.8.

  "requires": [ … ],               // see 2.1
  "prompts":  [ … ],               // see 2.2
  "derived":  [ … ],               // see 2.3
  "tiers":    { … },               // see 2.4
  "provider": { … },               // see 2.5 — the models.json payload
  "notes":    [ "…" ],             // see 2.6
  "verify":   [ { "label": …, "command": … } ]   // see 2.7
}
```

Every key above is **required** except `derived`, `tiers` and `verify`. A fragment with an unknown
top-level key is an error, not a warning — a typo'd key that is silently ignored is how a prompt
stops being asked without anyone noticing.

### 2.1 `requires[]` — credentials and dependencies

```jsonc
{
  "kind": "env" | "command" | "service",
  "name": "DATABRICKS_TOKEN",   // env var name, executable name, or a human name for a service
  "required": true,             // false = the provider still works without it
  "secret": true,               // true = NEVER echo the value, NEVER write it to any file in this repo
  "description": "…",           // what it is, one or two sentences
  "howTo": "…"                  // how to obtain it, concretely
}
```

The installer **checks presence and reports**; it does not collect secret values and must never write
one anywhere. `kind: "env"` + `secret: true` means: tell the user the variable name and that it
belongs in `~/.pi/secrets.env` (chmod 600, git-ignored, outside this repo's tracked tree). A missing
credential is a **warning, never a fatal** — a provider whose credential does not resolve simply makes
its models unavailable, and the harness must still start.

### 2.2 `prompts[]` — what to ask

```jsonc
{
  "id": "workspaceHost",        // referenced as {{workspaceHost}} in `provider`, `tiers`, `derived`
  "type": "string" | "number" | "port" | "boolean" | "choice",
  "label": "…",                 // the question
  "help": "…",                  // optional, longer explanation shown on request
  "example": "…",               // optional, shown as a hint. NOT a default.
  "default": …,                 // optional. Type matches `type`.
  "required": true,             // false = an empty answer is allowed and yields ""
  "when": { "<otherPromptId>": <value> | "*" },   // optional, see below
  "validate": { "pattern": "<ECMAScript regex>", "message": "…" },  // optional
  "choices": [ { "value": "cli", "label": "…" } ]   // required iff type === "choice"
}
```

- Prompts are asked **in array order**. A `when` may only reference a prompt that appears earlier,
  and it carries **exactly one** condition: the installer's `describe` row has room for one, so a
  second would be honoured by the generator and ignored by the interview, and the user would be asked
  a question whose answer is then discarded. Two conditions are refused at load time.
- `when: { "x": "*" }` means "ask this only if the answer to `x` is non-empty".
- `when: { "x": <value> }` means "ask this only if the answer to `x` equals `<value>`".
- A skipped prompt's answer is the declared `default`, or the empty string `""` if there is none.
  Installer and generator apply that rule identically, so a prompt feeding a **typed** field (a `cost`
  rate, a context window) needs a default of that type: `""` where a number belongs is not a zero,
  it is a string PI reads as unset.
- A `required` prompt that IS asked and left blank is refused by name, by the installer when it does
  the asking and by the generator when the answers arrive from a file.
- `type: "number"` and `type: "port"` answers substitute **unquoted**. See rule 2 below.

### 2.3 `derived[]` — values computed from answers, not asked

```jsonc
{
  "id": "apiKeyRef",            // referenced as {{apiKeyRef}}, same as a prompt answer
  "from": "auth",               // a prompt id
  "map": { "cli": "!$HOME/bin/dbx-token-cached", "pat": "$DATABRICKS_TOKEN" }
}
```

The value of `from` is stringified and looked up in `map` (so a boolean prompt maps under the keys
`"true"` / `"false"`). Map values may themselves contain `{{token}}` references to earlier answers,
resolved after the lookup. A map value of `null` is meaningful — see rule 3.

`derived` entries are resolved after all prompts, in array order.

### 2.4 `tiers{}` — suggested bindings

```jsonc
"tiers": { "confidential": "databricks/{{primaryEndpoint}}", "light": "databricks/{{lightEndpoint}}" }
```

A map of semantic tier name → provider-qualified model id this fragment can satisfy. The installer
offers these when asking which provider should back each tier; it is a **suggestion**, never applied
without the user choosing it. A binding whose substitution leaves a blank segment (e.g. the user
skipped `lightEndpoint`) is **dropped**, not written with a hole in it.

The three tier names are fixed vocabulary: `strong`, `light`, `confidential`. They are what every
agent, skill and script in this harness dispatches on. Do not invent a fourth — the resolver refuses
an unknown tier by name rather than substituting one, so a tier nobody declared is a hard failure at
dispatch time, not a soft default. The list is enforced in one place, `TIER_NAMES` in
`scripts/lib/providers.mjs`, and asserted against `routing.default.json` by
`test/dispatch/config.test.ts`.

### 2.5 `provider{}` — the models.json payload

Verbatim what goes under `providers.<id>` in `config/models.json`, after substitution. It follows
PI's own provider schema; this repo adds nothing to it except the substitution tokens and the
`$omitIfBlank` marker.

Two PI facts that constrain what a fragment may do:

- **`baseUrl` is NOT expanded by PI.** `"$VAR"` and `"!cmd"` work for `apiKey` and `headers` only.
  A host therefore has to be substituted literally at install time; it cannot be an env var.
- **`apiKey` must be present and must resolve** for a provider to be considered configured, even for
  an endpoint that checks nothing. An absent or unresolvable `apiKey` makes the provider's models
  disappear from `/model` entirely, which reads as a broken harness rather than a missing credential.

### 2.6 `notes[]` — the comments JSON cannot carry

An array of strings, each a self-contained paragraph. These are **not decoration**: they carry
measured facts about real endpoints (which compat flag causes which 400, why a credential path was
chosen, what a probe does and does not prove). The installer should write the notes of every selected
fragment into the install log, and a human editing `config/models.json` afterwards should read them
first. Keep them; when a fact is superseded, correct it in place rather than deleting it.

Convention: lead each note with a short SHOUTED clause so it can be skimmed.

### 2.7 `verify[]` — one-liners that prove it works

`{ "label": "…", "command": "…" }`. Shell, run by a human. They may reference env vars,
`config/models.json`, and **the fragment's own `{{tokens}}`** — which is why `resolve` emits them and
`describe` does not: before the first question there is no base URL and no credential name to put in
them, and a command printed with `{{placeholders}}` still in it is not a command. The installer
substitutes and writes them verbatim into `~/.pi/agent/provider-notes.md`, and names that file in the
closing list of manual steps. It never runs them: they need a credential collected later and a
reachable endpoint, and a provider whose endpoint is down is a runtime condition, not an install
failure.

### 2.8 Deferred fields — three places a fragment may say "ask the user"

`egress`, `concurrency` and a `requires[].name` may hold a **lone `"{{promptId}}"`** instead of a
literal. Nothing else may: a fragment whose every field is deferred has stopped being a reviewable
template and become a wizard.

These three exist because a **gateway** provider genuinely cannot know them in advance. The same base
URL shape covers a public aggregator, a proxy inside your network and a private deployment, so its
egress class is a fact about *your* deployment; its rate limit is a fact about *your* tenancy; and its
API-key variable is whatever *your* operator named it — no gateway standardises that.

The rules, all enforced by `scripts/lib/providers.mjs`:

- The referenced prompt must exist in the same fragment.
- `egress` may only defer to a `type: "choice"` prompt **whose every choice value is one of the three
  classes**, so an out-of-range class is unreachable rather than caught after generation.
- `concurrency` may only defer to a `type: "number"` prompt.
- **The resolved value is re-validated** at generation time with the same checks as a literal. An
  egress that resolves outside the vocabulary is fatal: `routing.json`'s `egress` map is the one
  place the class is written down, and every surface that tells a human or a model where a prompt is
  going reads it from there. A fourth word would print as a class nobody defined. (Until 2026-08-13
  the map was also consulted to refuse a dispatch; that rule was withdrawn, which lowers the cost of
  a wrong class but not the cost of an unreadable one.)
- A `requires[]` entry with a deferred name is **not** reported by `describe` — that command runs
  before the first question, so there is no answer yet and the raw `{{token}}` would be printed on
  screen as a variable name. `resolve` re-emits it once the answers exist, and the installer collects
  the credential from there. Everything after that point is the ordinary secret path.

---

## 3. Substitution rules

The installer resolves `prompts` → `derived` → then walks `provider` and `tiers` (plus the three
deferred fields of 2.8) applying:

1. **`{{id}}` inside a string is replaced by the answer for `id`.** Multiple tokens per string are
   allowed. An unknown id is an error, not an empty string.
2. **A string that is exactly `"{{id}}"` and whose prompt `type` is `number`, `port` or `boolean`
   substitutes as a JSON number/boolean, unquoted.** `"contextWindow": "{{contextWindow}}"` must
   become `"contextWindow": 200000`, never `"200000"`. PI does not coerce.
3. **A token that resolves to `null` deletes the key that holds it.** Used by `openai`'s derived
   `baseUrl`: no proxy means the `baseUrl` key must be *absent*, which is not the same as `null` or
   `""`.
4. **An object carrying `"$omitIfBlank": "<promptId>"` is deleted whole when that prompt's answer is
   blank.** Works on an object anywhere in `provider`, including an array element (the element is
   removed and the array closed up). The `$omitIfBlank` key itself is always stripped from the
   output. Used by `databricks` for its optional second model.
5. **After substitution, `grep -n '{{' config/models.json config/routing.json` must return nothing.**
   A surviving token is a bug in the installer, not something to paper over.

### Placeholder conventions in tracked files

| Convention | Meaning | Where |
|---|---|---|
| `{{promptId}}` | installer substitutes an answer | `config/providers/*.json` only |
| `<lowercase-words>` | a value **you** type, in prose and examples | anywhere |
| `example.com`, `acme` | illustrative host / tenant names | anywhere |
| `<PLACEHOLDER>`-style all-caps tokens | **forbidden in `config/`** | — |

The last row is a gate, not a style note: `bin/pi-check` rule **PC-10** fails the build on any
`<[A-Z][A-Z0-9_]*>` token anywhere under `config/`, outside shell comments. That is why every
placeholder here is lowercase or `{{mustache}}`.

---

## 4. Merge algorithm

Given the fragments the user selected:

**`config/models.json`** = `config/models.default.json`, then for each selected fragment set
`providers[<id>]` to its substituted `provider` block. A selected fragment **replaces** the default's
block for the same id — it does not deep-merge into it. (`github-copilot` is the only id that can
collide, and a half-merged `modelOverrides` map would be worse than either version.) If the user
deselects `github-copilot`, remove it: an unused provider block is inert, but a tier bound to a
provider nobody configured is not.

**`config/routing.json`** = `config/routing.default.json`, then:

- `egress[<id>]` ← the fragment's `egress`, for every selected fragment.
- `concurrency[<id>]` ← the fragment's `concurrency`, for every selected fragment.
- `tiers[<name>]` ← `{ "model": <chosen id>, "thinkingLevel": <kept from the default>, "purpose":
  <kept from the default> }` for each tier the user bound.
- A tier that ends up bound to **no** installed provider must be **removed from `tiers` and listed in
  `tiersUnbound`** with a one-line reason. Do not leave it pointing at a provider that is not in
  `models.json`: `bin/pi-check` rule PC-02 fails on that, and at runtime the dispatcher would refuse
  it with a less useful message.
- `onProviderError` is **copied through untouched**. `policy: "abort"`, `substituteProvider: false`
  and the reported error classes are not configurable, are not a default to be overridden, and no
  installer prompt may offer to change them. There is no provider failover in this harness, anywhere.

**`config/shell/pi-env.sh`** — the installer may append or uncomment the documented lines
(`DATABRICKS_HOST`, `NODE_EXTRA_CA_CERTS`, proxy). It must not write a secret value there; the
file's own header says it contains none, and `bin/pi-check` rule PC-06 enforces it.

One of those is not optional polish:

- **`DATABRICKS_HOST`** must be exported whenever the `databricks` fragment is selected — the CLI and
  `config/bin/dbx-token-cached` read it, and PI does not expand `$VAR` inside `baseUrl`, so it is set
  twice from one answer and the two have to agree.

A second entry used to sit here: `PI_LOCAL_BASE_URL`, read by a `local` fragment and by an extension
that re-registered a loopback provider at runtime. Both are gone (owner decision, 2026-08-15: the
provider set is exactly `github-copilot`, an OpenAI-compatible gateway and `databricks`), and with
them the only case where an extension's `baseUrl` could win over `models.json`. A loopback endpoint
is now configured like any other — `openai-compatible.json`, answered with a `127.0.0.1` base URL,
written once into `models.json` and read from there.

---

## 5. Adding another provider

Four fragments ship. Before writing a fifth, check whether `openai-compatible.json` already covers
your case: any endpoint speaking `/v1/chat/completions` under its own model names is that fragment,
answered differently, and a new file buys you nothing. That is what retired the `local` and `openai`
fragments — a loopback model server and a first-party OpenAI account are both just that fragment with
different answers.

The one thing that does justify a separate file is knowledge the interview cannot carry. `compat`,
`reasoning` and `thinkingLevelMap` may not be deferred to a prompt (§2.8), so wire behaviour that is
knowable for a **named** product can only be stated as a literal by a fragment that names it. That is
why `litellm.json` exists beside `openai-compatible.json` although both would fit: they differ in no
answer, and in four fields nobody can be asked about.

Copy the closest fragment, change `id` to match the new filename, and answer these before you ship it:

1. **Which egress class?** Not a vibe: *where does the traffic physically go, and who can read it
   there.* A third-party API is `public` even if the vendor is trustworthy.
2. **Does PI already ship the provider?** If yes, `builtIn: true` and keep the `provider` block to the
   minimum override — re-declaring a built-in provider's fields is how OAuth blocks get destroyed.
3. **What does the endpoint actually serve as a context window?** Declare `min(200000, measured)`.
   Never copy the number off a model card.
4. **Which `compat` flags did you measure?** Start with everything off and `maxTokensField:
   "max_tokens"`, get one successful turn, then enable one at a time — and write what you measured
   into `notes`, because the next person cannot re-derive it from the config alone.
5. **What does a call cost, and does your fragment assert it or ask it?** `cost` is optional here
   and required on PI's runtime model type, so the provider composer fills the gap with
   `{input:0,output:0,cacheRead:0,cacheWrite:0}` and every session on your provider shows a flat
   `0.000` spend, silently. Units are **dollars per million tokens** — PI divides each rate by
   1000000 before multiplying by the usage counter, so a per-token figure pasted straight in is
   wrong by six orders of magnitude and still renders.

   Exactly two declarations are accepted, here and by everything downstream: the four rates, or four
   explicit zeros meaning *this endpoint bills nothing, or bills by something other than tokens*.
   There is no third spelling, and leaving `cost` out is not one of the two — `test/providers-cost.test.ts`
   fails the build on it, `bin/pi-check`'s `PC-27` fails the install that composed it, and
   [`cost-gate`](../../docs/extensions/cost-gate.md) ends the first turn that bills on it.

   Which of the two you write is a fact about the deployment, so the fragment decides how to get it.
   A fragment for a **named** product asserts it: `databricks.json` writes the four zeros, because
   Model Serving bills by DBU and no per-token rate exists to state. A **gateway** fragment asks it:
   `litellm.json` and `openai-compatible.json` carry a per-model `metered`/`unmetered` choice and four
   rate prompts gated on it, because the id you call is not the vendor's direct model and its price is
   whatever that deployment's operator configured. Rate prompts are `type: "number"` with a numeric
   `default` — that default is what the unmetered answer writes (see §2.2), and it is the whole
   mechanism by which the opt-out produces zeros rather than blanks.

   What a fragment may not do is leave `cost` out and explain the absence in `notes`. Nothing reads
   notes at runtime; the prose travels and the price does not.

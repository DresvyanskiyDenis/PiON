# Providers and tiers

## PI has no tier concept

`config/settings.json` binds one default model. `--model` and `/model` take a `provider/id`. That
is the whole of what PI offers. Everything below — "give this sub-agent the cheap model", "this
directory's sessions must not reach a public provider", "never run more than one local model at a
time" — is built here, and lives in exactly one file: **`config/routing.json`**.

`routing.json` is not read by PI. It is read by this repository's extensions and by
[`pi-tier`](../operations/cli.md#pi-tier).

## The tier vocabulary

Five names, each a *semantic* claim about the job rather than about the vendor:

| Tier | Purpose | Typical thinking level |
|---|---|---|
| `strong` | Main loop, architecture, hard debugging | `high` |
| `fast` | Reviews, docs, mechanical multi-file edits | `medium` |
| `cheap` | Summaries, digests, classification, grep-and-report | `low` |
| `confidential` | Anything that must not leave the tenant | `medium` |
| `local` | The local lane; marked `optional: true` so its absence is a warning, not a failure | `medium` |

```json title="config/routing.json (shape)"
{
  "version": 2,
  "tiers": {
    "strong": { "model": "<provider>/<id>", "thinkingLevel": "high",
                "purpose": "main loop, architecture, hard debugging" },
    "local":  { "model": "<provider>/<id>", "thinkingLevel": "medium",
                "purpose": "local lane", "optional": true }
  },
  "egress":      { "<provider>": "public" },
  "concurrency": { "<provider>": 4 },
  "onProviderError": { "policy": "abort", "substituteProvider": false }
}
```

### Why tiers, concretely

The predecessor harness this one replaces hard-coded one model id into all fourteen agent
definition files. Trying a different model for a week meant editing and reverting fourteen files.

The acceptance test for this design is the inverse: **repointing `cheap` from one provider to
another is a one-line edit in one file; no agent `.md` is touched, and the next dispatch uses the
new model.**

## The four ways a tier gets selected

1. **Agent frontmatter** — the normal case.

    ```markdown
    ---
    name: code-reviewer
    description: Reviews a diff and returns findings
    model: fast              # a TIER name — or provider/id for a deliberate pin
    egress: internal         # a reported label; nothing is refused on account of it
    tools: [read, grep, glob, bash]
    ---
    ```

2. **Dispatch-time override** — wins over frontmatter. The orchestrating model can spend
   deliberately: a mechanical sweep on a small model, a hard decision on a large one.

    ```js
    subagent({ agent: "code-reviewer", prompt: "…", model: "cheap" })                 // tier
    subagent({ agent: "code-reviewer", prompt: "…", model: "<provider>/<small-id>" }) // pinned id
    ```

3. **Shell, cron, `pi -p`** — `pi-run -p "summarise" --model "$(pi-tier cheap)"`. This is how a
   script stays provider-configurable without hard-coding an id.

4. **Interactive** — `/model` and ++ctrl+p++. Tiers are not exposed in the TUI picker; the main
   session's default already *is* the strong tier.

### The disambiguation rule

`subagent({ model })` accepts either shape, resolved by a single rule:

> **A value containing `/` is a provider-qualified id. Anything else is a tier name.**

A **bare** id (`sonnet`, `gpt-5.4`) stays forbidden everywhere. Providers expose overlapping ids,
and an unqualified one resolves by accident.

### Resolution, and where it fails

```text
resolve(value):
  value in routing.tiers   -> routing.tiers[value].model
  value contains "/"       -> value
  otherwise                -> FAIL AT LOAD, naming the file and the agent

then:  assert the provider exists in models.json
       assert the model id exists under that provider   (the tier's `:<level>` suffix
                                                         is stripped before asking)
       else FAIL AT LOAD, naming the file and the id

finally: move the tier's `thinkingLevel` into the id  ->  provider/id:high
```

A third assertion — that the agent's declared `egress:` was no looser than its provider's class —
sat between those two until 2026-08-13. It is withdrawn; see [Egress classes](#egress-classes)
below.

**Failing at load, not at dispatch, is the point.** A typo in one of a dozen agent files must be a
startup error, not a surprise forty minutes into a long run.

This was measured, not theorised. When `routing.json`'s `fast` tier once named a model id that did
not exist in the provider's catalogue, eight agent definitions refused to dispatch at session start,
each with `model "<id>" (from "fast") is not in the model registry`. That is the design working.

### Discoverability

A model cannot choose an id it does not know exists, so [`dispatch`](../extensions/dispatch.md)
injects a **Sub-agent model selection** block into the system prompt at `before_agent_start`: the
tier list with each tier's resolved target and effective reasoning effort, then every concrete id in
the session's registry, grouped by provider.

The list is **annotated, not filtered** — each provider's egress class is printed beside it, and a
provider `routing.json` does not classify reads as `unlabelled`. It used to be filtered by the
session's class, on the reasoning that a model listed but unusable is a trap; withdrawing the
containment rule on 2026-08-13 removed the "unusable" half, and a menu that hides an id the
dispatcher may legally name teaches the wrong contract. The block is built once at
`session_start` and is byte-identical for the rest of the session, so it does not churn the
prompt-cache prefix. `/agents` prints the same text verbatim; if the human and the model are reading
different lists, the one nobody can see is the one that is wrong.

## Egress classes

Three words — `public`, `internal`, `confidential` — one per provider in `routing.json`. They are
**labels**: resolved, carried onto every resolved model, and displayed on the startup line, in
`/agents`, in the sub-agent model-selection block and in the `dispatch_registry` audit entry. A
provider with no class dispatches normally and reads as `unlabelled`.

!!! warning "Not a network boundary — and, since 2026-08-13, not a dispatch gate either"
    Nothing here intercepts a socket, and nothing refuses a dispatch on account of a class.

    There used to be an ordering over the three (`egressOrder`) and a containment rule on top of it:
    an agent bound to a provider classed looser than its own `egress:` failed at load, and a session
    could not dispatch a child onto a provider classed looser than itself. **Withdrawn.** Nobody had
    asked for it; it was inferred from the presence of the class names. Its effect was not to refuse
    a dangerous dispatch but to make a legitimate one unrepresentable — with most providers classed
    looser than the session, most agents became undispatchable and switching provider mid-session was
    impossible. A control whose failure mode is "the tool refuses the normal thing" buys no safety.

    If you need an actual network boundary, build one at the network layer. See
    [ADR 0004](../adr/0004-egress-classes-are-declarative.md).

[`path-defaults`](../extensions/path-defaults.md) extends the same vocabulary per directory root,
with the same honesty caveat attached to its per-channel `{web, mcp, publicModels}` policy.

## Concurrency

```json
"concurrency": { "<cloud-provider>": 4, "local": 1 }
```

A semaphore keyed on the **resolved** provider id, which **queues rather than errors**. The
`local: 1` entry encodes a physical fact rather than a preference: a machine holds one large local
model at a time and a model-swapping server unloads on switch, so two concurrent local dispatches
thrash instead of parallelising.

Where the semaphore cannot reach is documented honestly in
`extensions/dispatch/concurrency.ts` — there is no extension-visible hook inside PI's own
`Promise.all` phase, so parallelism PI initiates internally is outside its scope.

## Fail loud, no failover

```json
"onProviderError": {
  "policy": "abort",
  "substituteProvider": false,
  "report": ["provider", "model", "errorClass", "message", "causeChain"],
  "errorClasses": ["auth", "quota", "network", "model-not-found", "policy"]
}
```

This is a standing rule, not a default that can be flipped. A provider failover extension was
specified, scheduled, and then **cancelled** — `extensions/failover.ts` does not exist and nothing
in the tree references one.

The reasoning: a harness that silently substitutes a different provider produces work you cannot
attribute, on a model you did not choose, at a price you did not agree to, and it hides the outage
that caused it until something expensive depends on the wrong output. An abort with a full cause
chain costs one turn. A silent substitution costs the trust in every turn after it.

What you get instead is a good error. `extensions/lib/provider-error.ts` classifies the failure and
renders:

```text
[pi-config] provider call failed:
  provider    : <name>
  model       : <id>
  error class : auth | quota | network | model-not-found | policy
  message     : <upstream text>
  caused by   : <cause chain>
```

The [quota meter](../extensions/quota.md) follows the same rule: it *warns* before a turn when the
budget is low and does nothing else. When the budget is actually gone, the provider's own error
surfaces unmodified. The meter never intercepts a provider call.

## Credentials

`config/models.json` contains **references**, never values:

| Form | Resolves to |
|---|---|
| `"$VAR"` / `"${VAR}"` | the environment variable |
| `"!some command"` | the command's stdout, re-executed on **every request** |
| `"$$"` / `"$!"` | a literal `$` / `!` |
| anything else | itself, literally |

`baseUrl` is **not** expanded. A host that varies per installation is a `<PLACEHOLDER>` substituted
at install time, not an environment variable.

!!! danger "`!command` re-executes on every request"
    PI has no TTL of its own for command-sourced credentials. An unwrapped
    `<cloud-cli> auth token` costs one OAuth round trip per LLM call. Wrap it in a small
    TTL cache — `config/bin/dbx-token-cached` is the worked example — and reference the wrapper.
    The same applies to a keychain read: put it in `config/shell/pi-env.sh` where it costs one read
    per shell start, not in `models.json` where it costs one per request.

Secrets themselves live in `~/.pi/secrets.env` (`0600`, git-ignored, not in the repository),
sourced by `config/shell/pi-env.sh`.

!!! tip "Non-interactive shells do not read `~/.zshrc`"
    `pi-env.sh` is wired into `~/.zshrc`, and zsh loads `~/.zshrc` for **interactive** shells only.
    A `cron` or `launchd` job loads `~/.zshenv` and nothing else. If you run this harness
    unattended, add the secrets source to `~/.zshenv` too:

    ```sh
    if [ -r "$HOME/.pi/secrets.env" ]; then set -a; . "$HOME/.pi/secrets.env"; set +a; fi
    ```

    Credentials that happen to already be exported for other tools will mask this problem until the
    one that is not costs you a debugging session.

## Missing credentials do not stop the agent

A provider whose credential is absent must not prevent `pi` from starting. It fails only when that
provider is *selected*. The local lane goes further: no local server running is one warning line
at `session_start`, never a fatal, because the whole point of a portable harness is that a machine
without your local setup still gets a working agent.

## Next

- The one rule that matters most: [Context windows](context-windows.md)
- [Adding a provider](../extending/providers.md)
- [`dispatch`](../extensions/dispatch.md), [`credentials`](../extensions/credentials.md)
- [ADR 0001](../adr/0001-no-provider-failover.md) — why a provider error aborts instead of falling back

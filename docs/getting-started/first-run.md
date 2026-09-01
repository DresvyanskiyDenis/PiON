# First run

Five checks, in increasing cost. Do them in order — each one fails in a way that explains the next.

## 1. The offline rules (no credentials, no network, ~1 s)

```bash
pi-check --all
```

`bin/pi-check` is a standalone Node script that reads the config tree and the agent files without
starting PI. It runs 32 rules (31 without `--live`, which PC-19 needs to reach the npm registry); the ones you
will actually hit on a fresh clone:

| Rule | Fails when |
|---|---|
| `PC-01` | a model id is not provider-qualified (`sonnet` instead of `github-copilot/claude-sonnet-5`) |
| `PC-02` | a tier named in `routing.json` does not resolve to a model in `models.json` |
| `PC-04` | an agent file's `model:` frontmatter names a tier or id that does not resolve |
| `PC-06` | a key-shaped string is committed |
| `PC-10` | a `<PLACEHOLDER>` survived installation |

Zero findings, exit 0. Anything else is a real problem and the message names the file.

For a change in progress there is a second, cheaper question — not whether the tree is consistent,
but whether the branch that produced it looks healthy:

```bash
bin/pi-gate                 # rework, parallel modules, sprawl, bounded runs — warn-only, exit 0
bin/pi-gate --block         # the same four, blocking — exit 1 on any finding
bin/pi-gate --help          # what each gate catches AND what it does not
npm run check               # typecheck, then the gates, then the suite
```

Both are offline and free. `pi-check` reads the config tree as it stands; `pi-gate` reads local git
history and the working diff, so outside a work tree the history gates report nothing rather than
guessing. What each gate can and cannot see — and why a green `SG-04` is a smaller claim than it
looks — is in [structural gates](../operations/structural-gates.md).

## 2. The tier table (needs `jq`, no network)

```bash
pi-tier --list
```

One line per tier: name, the provider-qualified model it resolves to, and the `purpose` string
from `routing.json`. **The output is yours, not this page's** — the model ids depend on which
provider fragment you installed, and `purpose` prints in full rather than abridged. Illustrative
shape only:

```text
strong         <provider>/<model-id>   main loop, the subagent default, architecture, hard debugging
light          <provider>/<model-id>   the opt-in tier for mechanical work, named deliberately …
confidential   UNBOUND                 no provider of the right kind was configured
```

A tier printed as `UNBOUND` is in the vocabulary but has no model: your install configured no
provider of that kind. It is listed rather than omitted so that a caller can see *why* the name
it asked for is missing. Asking for it still exits **2**.

An unknown tier exits **2**. That is deliberate: a typo in a cron job must fail, never fall back to
a default model you did not choose.

## 3. One real turn per provider

```bash
pi -p "reply OK" --model "$(pi-tier strong)"
pi -p "reply OK" --model "$(pi-tier light)"
```

`OK`, exit 0. A provider whose credential is missing produces a block like this — it is the
[fail-loud renderer](../concepts/providers-and-tiers.md#fail-loud-no-failover) working, not a bug:

```text
[pi-config] provider call failed:
  provider    : <name>
  model       : <id>
  error class : auth
  message     : <upstream text>
  caused by   : <cause chain>
```

Nothing is retried onto a different provider. Fix the credential, or select a different tier.

!!! danger "Do not fix a Copilot credential by logging in from inside PI"
    PI's Copilot provider registers **two** auth methods. The `apiKey` method — the one the
    `github-copilot` fragment configures — sends `COPILOT_GITHUB_TOKEN` through and leaves the
    `baseUrl` the fragment wrote intact. The OAuth method's resolver **always** returns its own
    `baseUrl`, derived from a hint inside the token, and at request time that one wins. On the
    public endpoint the substitution is harmless. On a tenant with a data-residency endpoint it
    silently sends your traffic somewhere else, and nothing in the session says so.

    So the fix is a token in `~/.pi/secrets.env`, not a login:

    ```bash
    echo 'COPILOT_GITHUB_TOKEN=gho_...' >> ~/.pi/secrets.env && chmod 600 ~/.pi/secrets.env
    ```

    Reuse the token an editor integration already holds, or — **on a public seat only** — run
    `/login github-copilot` once purely to mint one and copy the value out of
    `~/.pi/agent/auth.json`. `config/providers/github-copilot.json` carries the full finding.

!!! note "Run `/compact` once, in an interactive session, before you trust a provider"
    Some provider integrations resolve their endpoint differently on the compaction and
    branch-summary paths than on the main chat path. A provider that answers a normal turn can
    still fail the moment compaction fires. One `/compact` in a live session, and a working turn
    after it, is the cheap test.

## 4. `/doctor`

Start an interactive session and run `/doctor`. It composes **last** in the extension load order
specifically so its report observes every module above it.

| Check | Asks |
|---|---|
| `D-01` | every tool name your instruction text mentions actually exists (or is declared in `config/tools.declared.json`) |
| `D-02` | every skill name mentioned has a `SKILL.md` PI actually discovered |
| `D-03` | every agent name mentioned has a file in `agents/` |
| `D-04` | every tier in `routing.json` resolves to a model in the registry, **and** that model has a credential |
| `D-05` | every declared extension module loaded — a module that threw, *and* a module that never attempted registration, are both errors |
| `D-06` | the guard loaded **and** its synthetic probe `matchDangerous("rm -rf /")` still resolves to `DB-RM-ROOT` |
| `D-07` | every MCP server name mentioned is declared in `config/mcp.json` |
| `D-08` | every pinned package in `config/packages.lock.json` is installed at that version (warn, not error) |
| `D-09` | the hook layer is carrying rules rather than sitting degraded |
| `D-10` | every tool `promptGuidelines` bullet dropped by `SYSTEM.md` has a recorded disposition (**warn**, not error) |

`D-06` is the only finding that will shut the session down. Everything else reports and continues.

A cheap subset of these also runs automatically at every `session_start` — everything except
`D-04`, which needs the model registry and is therefore network-shaped.

## 5. Prove the guard bites

The point of a permission layer is that you can demonstrate it. In an interactive session, ask the
agent to run something the guard must refuse:

```text
run: sudo rm -rf /
```

You should get a refusal naming the rule id (`DB-RM-ROOT`), not a confirmation prompt and not an
execution. If you get anything else, stop and read [`/doctor`'s `D-06`](../extensions/doctor.md)
before using this harness for real work.

Then the headless half:

```bash
pi-run -p "reply OK" --model "$(pi-tier light)"; echo "exit=$?"
```

`exit=0`. Now point it at a deliberately broken credential and confirm it exits **20** rather than
0 — that is the entire reason [`pi-run`](../operations/cli.md#pi-run) exists.

## What to do next

- Add your own [skills](../extending/skills.md) — none ship.
- Add your own [MCP servers](../extending/mcp-servers.md) — none ship, and the trust gate is
  default-deny, so read that page before you expect one to start.
- Read the [safety model](../concepts/safety-model.md) so you know what the guard does and does
  not cover.
- Read [Known limitations](../limitations.md). It is short and every entry is something that will
  otherwise cost you an afternoon.

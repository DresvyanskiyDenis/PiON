# `config/shell/pi-env.sh` — environment, secrets, proxy, CA

**Tracked in git. Edit in place.** Sourced from your shell profile — this is the line
`scripts/install.sh` appends, and the path it appends is this repository's own:

```sh
[ -f "$HOME/pi-config/config/shell/pi-env.sh" ] && . "$HOME/pi-config/config/shell/pi-env.sh"
```

A non-home `--prefix` substitutes its own stable link for `$HOME/pi-config`; the installer prints
the exact line before it writes it. There is no `~/.pi/agent/shell/` directory — this page and the
file's own header used to name one, which sourced nothing and said nothing about it.

!!! danger "This file contains NO secret values, and must not start to"
    It only points at the places secrets live. `bin/pi-check` rule `PC-06` greps the repository for
    key-shaped strings and fails the build. Every host-specific value in the shipped file is a
    **commented-out example**: uncomment and edit the ones your setup needs, leave the rest alone.
    `scripts/install.sh` may write some of them from your answers.

---

## PI runtime posture

```sh
export PI_TELEMETRY=0             # no telemetry egress
export PI_SKIP_VERSION_CHECK=1    # no version ping at startup
unset PI_EXPERIMENTAL             # MUST never be set
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
# export PI_OFFLINE=1             # opt-in: blocks every non-LLM outbound call
```

| Variable | Ships | Notes |
|---|---|---|
| `PI_TELEMETRY` | `0` | Matches `enableAnalytics: false` in [`settings.json`](settings.md#telemetry). Set in both places because processes that never read the settings file still read the environment |
| `PI_SKIP_VERSION_CHECK` | `1` | No network call at startup. Also makes a machine with no egress start cleanly |
| `PI_EXPERIMENTAL` | **unset** | Explicitly unset rather than merely not exported, so an inherited value from a parent shell cannot turn experimental behaviour on under you |
| `PI_OFFLINE` | commented | Opt-in. Blocks every non-LLM outbound call — useful for a run that must not fetch anything |

### `PI_CODING_AGENT_DIR` — required, not a convenience

The web-access package's own `getWebSearchConfigDir()` falls back to `$HOME/.pi` (no `agent`), while
PI's `getAgentDir()` falls back to `$HOME/.pi/agent`. **Two different directories for the same
config tree.** Exporting this variable pins both to the one symlink target, which is why
`config/web-search.json` is where the package actually looks.

**What breaks if you unset it:** web search silently reads a config file that does not exist, falls
back to package defaults, and your pinned backend quietly stops being pinned.

---

## Secrets

```sh
if [ -r "$HOME/.pi/secrets.env" ]; then
  set -a
  . "$HOME/.pi/secrets.env"
  set +a
fi
```

`~/.pi/secrets.env` is `0600`, git-ignored, and **not part of this repository**. Shape: one
`KEY=value` per line, no `export`, no quotes needed. Supply only the ones whose provider you
installed:

| Variable | For |
|---|---|
| `COPILOT_GITHUB_TOKEN` | the GitHub Copilot provider |
| `DATABRICKS_TOKEN` | a workspace PAT, instead of the OAuth/CLI path |
| *(your own name)* | whatever you answered when you configured [`openai-compatible`](models.md) — the fragment asks for the variable name, so an endpoint that checks no bearer token needs none |
| `PI_COPILOT_QUOTA_TOKEN` | optional classic PAT for the quota meter. Never used for chat |

!!! tip "Non-interactive shells do not read `~/.zshrc`"
    zsh loads `~/.zshrc` for **interactive** shells only. A `cron` or `launchd` job loads
    `~/.zshenv` and nothing else. If you run this harness unattended, add the secrets source there
    too:

    ```sh
    if [ -r "$HOME/.pi/secrets.env" ]; then set -a; . "$HOME/.pi/secrets.env"; set +a; fi
    ```

    Credentials that happen to already be exported for other tools will mask this problem until the
    one that is not costs you a debugging session.

### A key you rotate mid-session

The block above runs once per **shell start**. Rotate a key in `~/.pi/secrets.env` after a terminal
is already open and that terminal never sees it: the old value sits in the shell's environment and
is inherited by every `pi` launched from it. Nothing tells you — a stale key is a well-formed key,
so the provider rejects it and the error talks about authentication, not about your shell being
older than your credentials.

So the shipped file also defines a wrapper that re-reads the secrets file in a subshell immediately
before running the real binary:

```sh
pi() {
  (
    if [ -r "$HOME/.pi/secrets.env" ]; then
      set -a
      . "$HOME/.pi/secrets.env"
      set +a
    fi
    unset -f pi
    exec pi "$@"
  )
}
```

The refresh granularity is one file read per `pi` launch. The subshell keeps the refreshed value out
of your interactive shell; `unset -f pi` before `exec` resolves to the binary on `PATH` rather than
recursing, without hard-coding a path that would go stale if pi moves; `exec` keeps the process tree
flat and the exit status pi's own; and the `[ -r ]` guard means an absent secrets file stays a silent
no-op. `pil` and `pis` expand to `pi --model …`, so they refresh too. `command pi` reaches the bare
binary if you ever want it.

The installer also sources this file from `~/.zshenv` so cron and launchd runs get credentials, which
means the wrapper covers headless callers as well — the case where the shell that started the job is
most likely to be days old.

!!! warning "It cannot rescue a session that is already running"
    A process environment is fixed at spawn. A `pi` started before the rotation keeps the old key
    until you restart it. The wrapper fixes the *next* launch, not the current one.

### Keychain instead of a file

On macOS:

```sh
security add-generic-password -a "$USER" -s pi-<name> -w '<key>'

[ -n "${SOME_API_KEY:-}" ] || \
  export SOME_API_KEY="$(security find-generic-password -a "$USER" -s pi-<name> -w 2>/dev/null)"
```

!!! warning "Put the keychain read here, not in `models.json`"
    Here it costs one keychain read per **shell start**. As a `!command` credential in
    `models.json` it costs one per **LLM request**, because PI re-executes command credentials on
    every call and has no TTL of its own.

---

## `DATABRICKS_HOST`

```sh
# export DATABRICKS_HOST="https://<your-workspace-host>"
# export DATABRICKS_CONFIG_PROFILE=DEFAULT
```

Read by the vendor CLI and by `config/bin/dbx-token-cached`. **Not read by PI** — `baseUrl` in
`models.json` is not variable-expanded, so the hostname is set independently in two places and the
two must agree. The installer writes both from one answer; if you change one by hand, change both.

---

## TLS and proxy

```sh
# export NODE_EXTRA_CA_CERTS="$HOME/.ssl/<your-ca-bundle>.pem"
# export HTTPS_PROXY="http://<your-proxy-host>:<port>"
# export HTTP_PROXY="$HTTPS_PROXY"
export NO_PROXY="127.0.0.1,localhost,::1,.local"
export no_proxy="$NO_PROXY"
```

### `NODE_EXTRA_CA_CERTS`

Behind a TLS-intercepting proxy, Node needs the interceptor's CA bundle or every HTTPS call fails
certificate validation. This is a Node variable — **confirm your `pi` build honours it** before
relying on it.

### The proxy variables, and why they are not enough on their own

!!! note "The standalone `pi` binary does not parse `NODE_OPTIONS` at all"
    Verified: an invalid value is silently ignored, where a real `node` CLI refuses to start. So
    Node's own `--use-env-proxy` / `NODE_OPTIONS` route never reaches it.

    `HTTPS_PROXY` and `HTTP_PROXY` are read **directly by `extensions/web/proxy.ts`**, which builds
    its own `EnvHttpProxyAgent` and installs it as the global fetch dispatcher. That is what
    actually makes `web_search` and `web_fetch` honour the proxy — not this file by itself.

### `NO_PROXY` is set unconditionally, and should stay that way

It is harmless with no proxy configured, and without loopback in it any endpoint you run on
`127.0.0.1` — a model server, an MCP server, SearXNG — is proxied into a black hole. That failure
looks like the endpoint being down.

!!! tip "A per-provider proxy, without a global one"
    An `auth.json` credential can carry its own `env` object, applied for that provider only:

    ```json
    { "<provider-id>": { "type": "api", "key": "$YOUR_API_KEY_VAR",
                         "env": { "HTTPS_PROXY": "http://proxy.example.com:8080" } } }
    ```

    Prefer that over exporting `HTTPS_PROXY` globally, which would also capture anything you run on
    loopback.

---

## Convenience aliases

```sh
alias pil='pi --model "$(pi-tier light)"'
alias pis='pi --model "$(pi-tier strong)"'
```

Two shortcuts, and a demonstration of the intended pattern: a shell command names a **tier**, and
`pi-tier` resolves it. Nothing in your shell history hard-codes a model id, so rebinding a tier in
[`routing.json`](routing.md) changes what these do.

The resolved string carries the tier's `thinkingLevel` as a `:<level>` suffix
(`pi --model github-copilot/claude-opus-5:high`), so these aliases run at the effort the tier
declares rather than at the provider's default. If you compare `pi-tier`'s output against a bare id
somewhere, strip the suffix on your side — `--thinking <tier>` gives you the level separately.

---

## Related

- [`models.json`](models.md#apikey) — why credentials are references
- [`routing.json`](routing.md) — what `pi-tier` reads
- [`pi-tier`](../operations/cli.md#pi-tier)

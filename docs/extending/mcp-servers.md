# Adding MCP servers

`config/mcp.json` ships **empty**, and that is permanent rather than provisional. An MCP server
carries your credentials, your hosts and your tool surface; a server list is as personal as a
password manager, and shipping one as a default would be shipping someone else's.

The machinery around them does ship, and it is worth understanding before you add the first one:
default-deny for project-declared servers, an environment-minimising wrapper for stdio servers, and
host discovery turned off so nothing arrives that you did not write down.

`config/mcp.example.json` is a template that is **never loaded**. It carries three worked entries —
`context7` (HTTP, header credential), `playwright` (stdio, wrapped) and `lightpanda` (stdio, the
text-only browser lane) — chosen because they are public and self-explanatory, not because you need
them. Copy from it.

---

## The installer offers two of the three

The install's MCP step (section 8) reads `config/mcp.example.json` and offers `context7` and
`playwright` by number. `lightpanda` is left out on purpose — it is the one entry that needs a
binary you have to install yourself, and offering it would let the installer write a server that
cannot start. See [Two browser lanes](../configuration/mcp.md#two-browser-lanes-split-by-output)
for why you probably still want it. **The default answer is none**, and blank means none. If you took it, or if
you want to change your mind, re-run just that step:

```bash
./scripts/install.sh --section tools
```

Two things it does whatever you answer: it asserts `settings.hostConfigDiscovery` to `"off"`, and it
declares `playwright` through `mcp-stdio-guard` with `MCP_STDIO_EXTRA_ENV` naming the one variable
that server needs. Both are explained below.

If `config/mcp.json` already exists, the step does nothing at all — your file is not editable by the
installer. From that point on, adding a server is the hand-edit described next.

---

## The 60-second version

An HTTP server:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" },
      "lifecycle": "lazy",
      "directTools": true
    }
  },
  "settings": { "hostConfigDiscovery": "off", "directTools": false }
}
```

A stdio server — note the wrapper:

```json
"playwright": {
  "command": "mcp-stdio-guard",
  "args": ["npx", "-y", "@playwright/mcp", "--headless"],
  "env": {
    "MCP_STDIO_EXTRA_ENV": "PLAYWRIGHT_BROWSERS_PATH",
    "PLAYWRIGHT_BROWSERS_PATH": "${HOME}/.cache/ms-playwright"
  },
  "lifecycle": "lazy"
}
```

Restart `pi`. `/doctor`'s `D-07` confirms every server name your instructions mention is actually
declared.

Full key reference: [`config/mcp.json`](../configuration/mcp.md).

---

## Four decisions per server

### 1. `command` — wrap it or not

!!! danger "A stdio MCP server inherits your entire environment"
    A stdio server is a child process, and a child process gets a copy of the parent's environment.
    That is every API key you have ever exported from your shell profile — your model provider
    tokens, your cloud credentials, whatever else is in `~/.pi/secrets.env` — handed to a program
    published by someone you have never met, on every session, for the price of one line of JSON.

    Nothing about MCP requires that. It is simply what happens if nobody intervenes.

`mcp-stdio-guard` intervenes. It is a small wrapper that re-execs the real server through `env -i`
with an explicit baseline and nothing else:

```text
HOME  LOGNAME  PATH  SHELL  TERM  USER  LANG  LC_ALL  TMPDIR
+ the CA-bundle and proxy variables
```

Written as `"command": "mcp-stdio-guard"` with the real command moved into `args`:

```json
"command": "mcp-stdio-guard",
"args": ["npx", "-y", "@playwright/mcp", "--headless"]
```

**Use it for anything you did not write yourself.**

Widen the allowlist per server with `MCP_STDIO_EXTRA_ENV` — a space-separated list of variable
*names*, set inside that server's own `env` block so the allowlist travels with the definition that
needs it. Naming a variable there is a decision you can see in a diff; inheriting it silently is not.

Three practical notes:

- **The wrapper must be on your `PATH`.** The installer symlinks `config/bin/*` into `~/bin`. If the
  wrapper is missing, a project-sourced server does not fall back to an unwrapped spawn — it throws.
  An untested security control is not one.
- **It `exec`s.** There is no extra process in the tree and signals reach the real server unchanged.
- **It does not sandbox.** The server still runs as you, with your files and your network. This
  removes *ambient credentials*, which is the one thing about a stdio server you cannot otherwise
  see. It is not containment; see [Safety model](../concepts/safety-model.md).

### 2. `lifecycle` — `lazy` unless you have a reason

`lazy` starts the server on first use. The default starts it at session start, which means every
session pays its startup cost and holds its process, whether or not you touch it.

A server with an expensive start (a browser, a container) should always be `lazy`. This is also
what makes it cheap to declare **both** browser lanes — a text-only headless-JS server and a full
browser — instead of picking one: two `lazy` entries are two config blocks and zero processes until
a tool is called. See [Two browser lanes](../configuration/mcp.md#two-browser-lanes-split-by-output).

### 3. `directTools` — per server, never globally

`false` (the shipped global default) puts a server's tools behind one namespaced entry point.
`true` flattens them into the top-level tool list.

Flattening costs context on **every single turn** — the tool schemas are in the system prompt whether
or not the model uses them. Set `directTools: true` only on the one or two servers whose tools you
reach for constantly.

### 4. Where it is declared: yours, or a project's

This is the security-relevant one.

| Source | Treatment |
|---|---|
| `config/mcp.json` (yours) | loaded, and `mcp-stdio-guard` is used only where you asked for it |
| `.mcp.json` / `.pi/mcp.json` inside a repository you opened | **denied by default**, and if approved, its stdio servers are wrapped whether they asked or not |

See [the trust gate](#project-defined-servers) below.

---

## Project-defined servers { #project-defined-servers }

A repository you clone can declare MCP servers. Left unchecked, `git clone <hostile> && cd && pi`
would spawn a process of the repository's choosing, holding every token in your environment, **before
any tool call exists for the guard to see**.

So project sources are default-deny. Approving one is a deliberate, recorded act:

```bash
config/bin/pi-mcp-approve --status .    # what would happen right now
config/bin/pi-mcp-approve .             # shows the config, then records approval
config/bin/pi-mcp-approve --list        # the ledger
```

The approval is keyed on the project path **and** the sha256 digest of its MCP config, recorded in
`~/.config/pi-config/mcp-approvals.jsonl` (`0600`, append-only, last line wins).

!!! warning "Changing the file revokes the approval"
    That is the feature. A dependency update that rewrites `.mcp.json` gets you a refusal, not a
    silently different set of processes. Re-approve after reading the diff — `pi-mcp-approve` prints
    it for you.

There is deliberately **no prompt and no first-sight auto-approval**. An eager server spawns during
initialisation, so by the time a prompt could be answered the process has already started.

Being inside [`trusted-roots.json`](../configuration/paths-and-trust.md) grants **nothing** here.
Path trust asks *may PI run here without asking?*; MCP-config trust asks *may this directory name the
processes this agent spawns with my credentials?* Wiring the first into the second was tried and was
wrong.

---

## `hostConfigDiscovery: "off"`

```json
"settings": { "hostConfigDiscovery": "off", "directTools": false }
```

Other agent tools on this machine keep their own MCP server lists in their own config files. PI can
find those and adopt them. This repository turns that off, in both `config/mcp.default.json` and
`config/mcp.example.json`.

The reason is not that other tools' servers are bad. It is that **your agent's tool surface should
change only when you change it.** With discovery on, installing an unrelated application, or letting
one auto-update, can add tools to a session you are already running — and the first you know about it
is a capability you did not grant appearing in the model's list. Debugging "where did this tool come
from?" is much harder than copying eight lines of JSON.

So: leave it off. If you want a server that another tool declares, copy the entry into
`config/mcp.json`. It takes a minute, and you get to read what you are adding while you do it.

The corollary is worth stating plainly: **everything you get is what is written in
`config/mcp.json`**, plus any project config you explicitly approved. There is no third source.

---

## Credentials

Reference environment variables, never literals:

```json
"headers": { "AUTHORIZATION": "Bearer ${MY_TOKEN}" }
```

Export the value from `~/.pi/secrets.env`, which
[`config/shell/pi-env.sh`](../configuration/environment.md) sources. `config/mcp.json` is
git-ignored, but a secret in a git-ignored file is still a secret in a plain file — and `bin/pi-check`
rule `PC-06` exists because someone will otherwise put one in the tracked shell profile.

---

## Verifying

```bash
pi
/doctor                                  # D-07: declared server names
config/bin/pi-mcp-approve --status .     # is this project's config admitted?
```

If a server does not appear: check that `config/mcp.json` is valid JSON (a trailing comma takes the
whole file down), that the process starts by hand, and — for a stdio server — that it does not depend
on an environment variable `mcp-stdio-guard` stripped. That last one is the most common cause and the
least obvious.

## Related

- [`config/mcp.json`](../configuration/mcp.md) — every key
- [Safety model](../concepts/safety-model.md#mcp) — why default-deny, twice
- [Third-party components](../reference/third-party.md) — the vendored adapter and its patches
- [Exit codes](../reference/exit-codes.md#configbinpi-mcp-approve)

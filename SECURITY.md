# Security policy

This repository is a configuration and extension layer that runs a coding agent on your own machine,
with your own credentials, against your own files. Its safety properties are the point of the project,
so a report that one of them does not hold is genuinely welcome.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository — the **Security** tab →
**Report a vulnerability**. That creates a private advisory only the maintainers can see.

A useful report contains:

- the commit or tag you tested;
- your platform and `node --version`;
- the smallest reproduction you can manage — a config fragment plus the command;
- **what an attacker gains**, stated plainly. "The guard can be bypassed" is a starting point;
  "a `README.md` in a cloned repository causes a program to run before the first tool call" is a
  report.

Please say if you intend to disclose publicly, and when. We will agree a date rather than argue about
one.

## What is in scope

The controls this project claims, and therefore the things worth reporting when they fail:

- **The guard's blocking gates** — a way to make a tool call that `SEC-*`, `DB-*`, `GIT-REWRITE` or
  `GIT-FORCE-PROTECTED` should have refused, in particular anything that reaches a path `SEC-*`
  protects (which has no override at all), or that writes to a protected branch without a written
  justification.
- **The trust boundary** — an untrusted directory whose `.pi/` contents take effect anyway: project
  hooks, project settings, project sub-agents, project MCP servers.
- **MCP default-deny** — a project-declared MCP server that starts without an approval record, or an
  approval that survives the server's definition changing. The approval is keyed on path *and* on a
  sha256 of the definition; a mismatch that still passes is a bug.
- **`mcp-stdio-guard`** — a stdio server that receives environment variables outside the baseline
  allowlist without `MCP_STDIO_EXTRA_ENV` naming them.
- **The deadman** — a way for a guardrail module to fail to load without `bash`, `write`, `edit`,
  `multiedit`, `read` and `grep` being blocked.
- **Hooks failing open** — a `run` rule whose script is missing, crashes or times out, and the tool
  call proceeds anyway. Hooks are specified to fail closed; an exception is a vulnerability.
- **Credential handling** — a credential written to a log, a transcript, a session index, a digest, an
  error report or a sub-agent prompt.
- **The vendored adapter** — a difference between `pi-packages/` on disk and
  `pi-packages/vendor-files.lock.json` that `bin/pi-check`'s `PC-21` does not catch.

## What is out of scope

These are documented limitations, not defects. Reporting them is welcome as a *discussion*, but they
will not be treated as advisories, because the documentation already says they do not hold. See
[Known limitations](docs/limitations.md).

- **Egress classes are not a network boundary.** They are checked at dispatch and at posture
  resolution. Nothing inspects or blocks a socket. A `bash` command that opens a connection is not a
  bypass of a control that does not exist.
- **The guard does not contain a process that already started.** It gates tool calls. A program the
  agent legitimately started can do whatever your user account can do, for as long as it runs.
- **`PRV-*`, `FS-*` and `RTE-*` do not refuse anything.** Since the 2026-08-14 deny-list inversion
  these three gates are documented as audit-only: they record a privileged command, an out-of-tree
  write or a generic-agent dispatch, and permit it regardless. That every program — not just an
  allowlisted one — runs with no per-command decision at all is the shipped design, not a bypass of
  one.
- **A trusted project is trusted.** Once a root is in `trusted-roots.json`, its `.pi/` directory is
  configuration you have accepted. The gate is the trust decision, not what comes after it.
- **The model can be talked into things.** Prompt injection that makes the agent *attempt* a
  disallowed action is expected; the claim is that the guard refuses it. Show the refusal not
  happening.
- **Third-party vulnerabilities.** A flaw in PI itself, in an MCP server you installed, or in a
  provider's API belongs to its own project. If our *use* of it is what makes it exploitable, that is
  in scope here.
- **Anything requiring an attacker who already has your shell.** At that point they have your
  credentials without touching this repository.

## Supported versions

This project is developed on `main` and has no long-lived release branches. Fixes land on `main`; there
is no backport channel. Run a recent checkout.

## Hardening you are expected to do yourself

The defaults assume a single-user workstation. If your threat model is stronger:

- if you need `PRV-*`/`FS-*`/`RTE-*` to actually refuse rather than only record, write your own
  `block` rule in [`config/hooks.yaml`](docs/configuration/tools.md#hooksyaml) — the guard itself
  will not do it for you;
- set `onInternalError` to `closed` if you would rather a broken gate stop work than permit a call —
  see [ADR 0002](docs/adr/0002-fail-open-guard-fail-closed-hooks.md) for why the default is the other
  way;
- keep credentials out of the environment the agent inherits and out of every config file in this
  repository — nothing here is designed to hold a secret;
- put a real network boundary at the network layer if you need one.

## Third-party code

`pi-packages/pi-mcp-adapter/` is a vendored, locally patched copy of a community package. Its
provenance, its licence and each local patch are documented in
[Third-party components](docs/reference/third-party.md), and its integrity is enforced by `PC-21`. A
vulnerability in the upstream package should also be reported upstream; tell us so we can re-vendor.

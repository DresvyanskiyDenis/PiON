# FAQ

## What is this, in one sentence?

PiON — a hardened, portable harness for the [PI coding agent](https://github.com/earendil-works/pi):
one composed extension of 26 modules plus a configuration tree, adding a permission layer, routing by
semantic tier, sub-agent orchestration and a headless wrapper that exits non-zero when a run actually
failed.

## Is it a fork of PI?

No. It neither forks nor redistributes PI. It is an extension plus configuration that PI loads. PI is
installed separately — the installer can do it for you.

## Do I need to know TypeScript?

No, to use it. The interactive installer covers every decision, and everything afterwards is JSON
that the [configuration reference](https://dresvyanskiydenis.github.io/PiON/configuration/) documents key by
key. Yes, if you want to write a new extension module.

## Which operating systems?

Built and measured on **macOS (arm64)**. The extensions are platform-neutral TypeScript; the
installer and the shell helpers assume a POSIX shell and are exercised on macOS. Linux is likely to
work and is not verified. Windows is not supported except through WSL, and that is untested.

## Which PI version?

**0.84.0.** Every measured claim in the documentation was measured against it. PI is
pre-1.0 and its extension API changes; when you update PI, re-run
`bin/api-probe.mjs` and re-apply the vendored patches — see
[Verification](https://dresvyanskiydenis.github.io/PiON/operations/verification/).

## Why are there no skills and no MCP servers?

Deliberately, and permanently — not "none yet". A skill is prose plus scripts, and prose is where
somebody's employer, client or private workflow leaks out; a server list is as personal as a password
manager. Shipping either would mean shipping someone else's.

What ships is the *machinery* — skill discovery across extra roots, the environment shim, the
portability lint, the vendored MCP adapter, the environment-minimising stdio wrapper, the project
trust gate — plus a documented, first-class path for adding your own. The installer creates
`skills-private/` for you and offers two public MCP servers (`context7`, `playwright`), defaulting to
neither. See recipes 17 and 18 in the [[Cookbook]].

## Does it work with my provider?

Three fragments ship (`github-copilot`, `databricks`, `openai-compatible`) and adding another is a
fragment file plus one installer re-run. Anything speaking an OpenAI-compatible Chat Completions
surface — a gateway, a vendor API, a server on your own loopback — is already covered by
`openai-compatible`: you give it the base URL, the model ids and their real context windows. See
[[Provider Cheat Sheet]].

## Why is there no failover to a second provider?

Because silent substitution destroys attribution. When a provider fails, the turn aborts naming the
provider, the model, the error class, the message and the cause chain — and you know what happened.
A failover extension was specified and then cancelled for exactly this reason; `bin/pi-check`'s
`PC-03` fails the repository if a `fallback` / `failover` / `egressOrder` key reappears.

The one exception is a *transient* retry against the **same** provider, which is PI's own
`retry` setting.

## Is this a sandbox?

**No.** It is a permission layer: it refuses tool calls by policy before they run. It does not
contain a process that already started, it does not intercept sockets, and the egress classes are
declarative rather than a network boundary. An OS-level sandbox package was reviewed and deliberately
not relied on. The honest list of what it does not protect you from is in the
[safety model](https://dresvyanskiydenis.github.io/PiON/concepts/safety-model/).

## What does "egress class" actually mean, then?

A label on a provider — `public`, `internal`, `confidential` — that the dispatch ceiling uses to
refuse *a sub-agent dispatch* whose egress class exceeds the parent's. It is enforced at load and
call time inside this harness. Nothing here inspects network traffic.

## Will it send my code anywhere?

Only to the provider you configured, by making the request you asked for. Telemetry and analytics
ship off (`enableInstallTelemetry: false`, `enableAnalytics: false`). If you want a lane where the
endpoint is inside your own boundary, that is what the `confidential` tier is for.

## Can I use it without the installer?

Yes, but you are then responsible for the symlink layout, the generated configuration files and the
verification steps the installer runs for you. `./scripts/install.sh --dry-run` prints exactly what
it would do, which is the fastest way to learn the layout.

## I already have a `~/.pi` configuration. Will this overwrite it?

The installer detects an existing install and offers reconfigure / one section / repair / leave
alone. It backs up what it replaces and records every path it creates in a manifest that
`uninstall.sh` reads back. It **aborts** (`PI-INSTALL-E19`) rather than continue if it finds
`auth.json`, `trust.json`, `sessions/` or `models-store.json` symlinked into the repository —
credentials, trust decisions and transcripts must never live in git.

## How do I change something after installing?

Re-run the installer: `./scripts/install.sh --reconfigure`, or `--section <name>` for one part.
That is a supported operation, not a reinstall. For hand-edits, remember that ten config files are
**generated** — an edit survives a re-run but not a fresh clone, so anything permanent belongs in
the matching `config/<name>.default.json` too. See the [[Cookbook]].

## Where does the configuration actually live?

In your clone. `~/.pi/agent/*` are symlinks into it, so editing a file in the repository changes the
running agent immediately and `git pull` updates it. Nothing is copied.

## Why is `extensions/` not symlinked like everything else?

Because PI discovers `<agentDir>/extensions/*.ts` and would load all 26 modules as separate
extensions in `readdir` order — destroying the fixed load order that puts `guard` first, and failing
every module that has no default export. `config/settings.json` names the single composition root
`extensions/index.ts` explicitly instead.

## What is `bin/pi-run` and why must I use it?

`pi -p --mode json` **exits 0 on a failed turn**, and an extension cannot abort a headless run from
the inside — both measured against 0.84.0. `pi-run` parses the stream and exits `20`/`21`/`22`/`23`/
`24` when the run failed, was truncated, drifted, looped or was aborted. Never use bare `pi -p`
unattended. See [Exit codes](https://dresvyanskiydenis.github.io/PiON/reference/exit-codes/).

## What is `bin/pi-check`?

22 repository invariants, run as one command. It refuses an unqualified model id, a tier bound to an
absent provider, any failover key, a secret-shaped literal in a tracked file, an unreplaced
placeholder, a vendored tree whose bytes no longer match their recorded digests, and more. Exit `1`
means your repository is wrong; exit `2` means the checker could not run.

## Why is third-party source committed into `pi-packages/`?

Because the MCP project-config trust gate has to live inside `getConfigSources()`, and there is no
hook or wrapper position outside that module that sees project sources before they are merged. The
alternatives were a `postinstall` script that rewrites somebody else's package invisibly, or
vendoring. Vendoring makes the patch visible in a diff, re-appliable on every version bump, and
pinned by digest. Full attribution and a description of what the patch changes:
[Third-party components](https://dresvyanskiydenis.github.io/PiON/reference/third-party/).

## Is it fail-open or fail-closed?

Both, deliberately, split on one question: *whose bug is it?* The guard fails **open** on an internal
error, because a bug in the gate must not blanket-block every tool call on your machine. Hooks fail
**closed**, because a declarative rule *you wrote* that silently stops applying **is** the bug. And a
guardrail module that failed to load trips a deadman that blocks the dangerous tools outright.

## Can I run it in CI?

Yes, with `bin/pi-run` and a scheduler script that reads the exit code. The guard needs no CI-specific
configuration: the same small set of catastrophic commands refuses headless as interactively, and
nothing else ever needed a confirmation to begin with. Recipe 22 in the [[Cookbook]].

## How do I contribute?

Open an issue or a pull request. `bin/pi-check --all` and `npm test` must pass, and a documentation
change ships in the same pull request as the behaviour it describes. See `CONTRIBUTING.md`.

## What licence is it under?

MIT — see `LICENSE` at the repository root, which `package.json` mirrors. Third-party components keep
their own licences, which the MIT grant here does not affect; they are catalogued in
[Third-party components](https://dresvyanskiydenis.github.io/PiON/reference/third-party/).

---

See also: [[Cookbook]] · [[Troubleshooting]] · [[Provider Cheat Sheet]]

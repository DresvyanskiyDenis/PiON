# Troubleshooting — first 60 seconds

Fast triage. When the answer here is not enough, the long form is on the site:
[Troubleshooting](https://dresvyanskiydenis.github.io/PiON/operations/troubleshooting/).

## Run these three, in this order

```bash
/doctor                            # inside pi — which modules loaded, which are expected-but-absent
~/pi-config/bin/pi-check --all     # 28 repository invariants
./scripts/postinstall-verify.sh    # the install layout itself
```

`/doctor` answers "is the harness even loaded?" — and most confusing symptoms are that question in
disguise.

## Symptom → first thing to check

| Symptom | Check first |
|---|---|
| Every tool is refused, including `read` and `grep` | A guardrail module failed to load. `/doctor` names it. This is the **deadman**, working as designed — fix the module, do not disable the check |
| No commands, no tools, nothing loaded | `config/settings.json` → `extensions` must name `extensions/index.ts`. A single import error takes the whole tree down before `/doctor` exists to report it |
| A provider is missing from the model list | It is not in `config/models.json` — which is *generated*. Re-run `./scripts/install.sh --section providers` |
| An OAuth provider asks you to log in again | Something re-declared `models` on a built-in provider instead of using `modelOverrides` |
| It aborted on a provider error and tried nothing else | Working as designed. There is no failover — read the provider / model / error class / cause chain it printed |
| A 400 naming a field you did not set | A `compat` flag on the provider fragment does not match what that endpoint accepts |
| Compaction fires far too late, then the request is rejected | The declared `contextWindow` is bigger than what your endpoint serves. `providers.<p>.modelOverrides.<id>.contextWindow` |
| Compaction fires constantly | `reserveTokens` is a **global** scalar; it is probably sized for a much larger model |
| A command is refused unattended | Since 2026-08-15 only three things refuse a bash command at all: `DB-*`, `GIT-REWRITE`, `GIT-FORCE-PROTECTED`. There is no allowlist to add a command to — read the refusal's rule id |
| A credential path was read and nothing stopped it | Working as designed since 2026-08-15. `SEC-*` records the touch and permits the call; no runtime control keeps the file's contents out of the model's context |
| A hook blocks everything | Hooks fail **closed**. A `run` rule whose script is missing, throws or times out blocks every matching call |
| A skill never runs | Its root is not in `config/settings.json` → `skills`. `/doctor` `D-02` lists the roots actually discovered |
| A skill silently fails to load | Unquoted colon in `description` → the YAML parser rejects the file. Quote it |
| `allowed-tools` in a skill is ignored | It **is** ignored. PI parses exactly three front-matter fields: `name`, `description`, `disable-model-invocation` |
| A sub-agent is listed but refuses when dispatched | Its tier is unbound, or the egress ceiling refused it. `pi-tier <tier>` exits `2` when unbound |
| An agent file is not picked up | `name` in the front matter must match the filename, and the directory must be in `config/dispatch.json` → `registryDirs` |
| A project's MCP server is refused | Default-deny. `pi-mcp-approve .` — and approval is keyed on the file's sha256, so any edit invalidates it |
| A stdio MCP server works by hand, not under `pi` | It is spawned through `mcp-stdio-guard` with a minimal environment. Name what it needs in `MCP_STDIO_EXTRA_ENV` |
| A scheduled job "succeeds" but produced nothing | You used bare `pi -p`. It exits `0` on a failed turn — use `bin/pi-run` |
| Exit `23` or `91` from a headless run | The compaction loop guard. The prompt is probably growing without bound |
| Exit `22` | Protocol drift: an assistant message ended with no `stopReason`. PI's stream shape changed |

## Things that look broken and are not

- **The `confidential` tier unbound.** Deliberate. Naming an unbound tier fails loudly rather than
  quietly sending material to a public endpoint.
- **A missing provider credential does not stop `pi` from starting.** It reports which provider is
  unconfigured; tiers bound to configured providers keep working.
- **A missing personal identity overlay is announced, not silent.** "No personal context configured"
  and "personal context failed to load" are different problems and are reported differently.
- **`pi-check` exit `1` versus `2`.** `1` = your repository is wrong. `2` = the checker could not
  run. Do not treat them the same in CI.

## Reset paths, from cheapest to most drastic

```bash
./scripts/install.sh --repair          # re-link and re-verify, ask nothing
./scripts/install.sh --section <name>  # re-answer one section
./scripts/install.sh --reconfigure     # the whole interview again
./scripts/uninstall.sh && ./scripts/install.sh
```

Plain `uninstall.sh` never removes credentials, trust decisions or session transcripts — only
`--purge` and `--purge-state` can, and both ask first.

## Before opening an issue

Include:

1. `/doctor` output.
2. `~/pi-config/bin/pi-check --all --json`.
3. PI version (`pi --version`) and your OS.
4. The exact command and the exact exit code.
5. Whether it reproduces after `./scripts/install.sh --repair`.

Redact model ids, workspace hosts and tenant names if they are not public.

---

See also: [[Cookbook]] · [[FAQ]] · [[Provider Cheat Sheet]]

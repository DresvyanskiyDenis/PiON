# Internal identifiers

Run `bin/pi-check` or read almost any source file here and you will meet identifiers like `EXT-05`,
`REQ-PRV-56` or `VP-10`:

```text
"fallback" key found — provider failover is cancelled (EXT-08); a re-introduced
fallback is a silent-degradation channel
```

They are not dead comments left over from a template. They come from the design record this harness
was built against, and they survive into the shipped code deliberately, because **the reason a rule
exists is more useful than the rule itself**. A message that says only "fallback keys are not
allowed" invites you to delete the check; one that says *which decision* forbids them, and what
failure that decision was avoiding, invites you to argue with the decision instead — which is the
conversation worth having.

They are also exported constants, doctor check ids and test assertions
(`extensions/dispatch/ceiling.ts` exports `CEILING_SOURCE = "pi-config/EXT-05"`), so they are load-
bearing rather than decorative. Renaming one is a code change, not a copy edit.

!!! note "There is no public design document behind them"

    The planning documents these ids were minted in are not part of this repository and are not
    going to be. Everything they decided that still matters is either implemented in the code or
    written up in these docs. So treat an id as **a stable name for a decision**, not as a citation
    you are expected to follow somewhere — this page is the whole lookup table.

## The prefixes

| Prefix | Means |
|---|---|
| `EXT-NN` | one extension, or one coherent feature. The unit of work this harness was built in |
| `REQ-<AREA>-NN` | a single requirement. `REQ-PRV-*` privacy/posture, `REQ-CTX-*` context handling, `REQ-EXT-*` extension behaviour |
| `VP-NN` | a verification point — something that had to be *proved* on a real machine, not argued |
| `PC-NN` | a `bin/pi-check` rule |

`PC-NN` is the only family that is fully self-describing at runtime — `bin/pi-check --all --json`
prints every rule it ran under `rulesRun`, and each rule file in `bin/rules/` exports both a `title`
and a `closes` array naming the requirements it enforces. That `closes` export is the shortest path
from any id in this page back to running code:

```bash
grep -rl 'REQ-PRV-56' bin/rules/
```

## `EXT-NN` → what it actually is

Where a page exists, it is linked; the rest name their entry point in the tree.

| Id | Feature | Where it lives |
|---|---|---|
| `EXT-01` | the extension host: shared helpers, `guardedHandler`, the veto registry | `extensions/lib/` |
| `EXT-02` | session context | [session-context](../extensions/session-context.md) |
| `EXT-03` | the permission layer PI does not have | [guard](../extensions/guard.md) |
| `EXT-04` / `EXT-04a` | the CI and install gate | `bin/pi-check` |
| `EXT-05` | the sub-agent runtime | [dispatch](../extensions/dispatch.md) |
| `EXT-06` | session digest pipeline | [digest](../extensions/digest.md) |
| `EXT-07` | provider-independent `web_search` / `web_fetch` | [web](../extensions/web.md) |
| `EXT-08` | **cancelled** — provider failover. See below | — |
| `EXT-09` | the Copilot quota meter, with a pre-flight | [quota](../extensions/quota.md) |
| `EXT-10` | `/doctor` and the `session_start` warn pass | [doctor](../extensions/doctor.md) |
| `EXT-11` | the compaction suite, including the loop guard | [compaction](../extensions/compaction.md) |
| `EXT-12` / `EXT-12a` | the statusline | `config/pi-statusline.json` |
| `EXT-13` | credentials, providers, provider error surfacing | [credentials](../extensions/credentials.md) |
| `EXT-14` / `EXT-14a` | the MCP bridge and its egress classification | [MCP configuration](../configuration/mcp.md) |
| `EXT-14b` | `mcp-stdio-guard`, the env-minimising exec wrapper | `config/bin/mcp-stdio-guard` |
| `EXT-15` | the declarative hook layer | [hooks](../extensions/hooks.md) |
| `EXT-16` | the skills env shim (`${CLAUDE_SKILL_DIR}` has no PI equivalent) | [skills-env](../extensions/skills-env.md) |
| `EXT-17` | input transforms | [input-transform](../extensions/input-transform.md) |
| `EXT-18` | `bash` hardening — the timeout ceiling | [bash](../extensions/bash.md) |
| `EXT-19t` | the edit trial | — |
| `EXT-20` | automatic session titling | [auto-title](../extensions/auto-title.md) |
| `EXT-21` | context imports (`@path`) and lazy nested `AGENTS.md` | [context-imports](../extensions/context-imports.md) |
| `EXT-22` | task-list glue | [tasks](../extensions/tasks.md) |
| `EXT-23` | worktree detection and isolation | [worktree](../extensions/worktree.md) |
| `EXT-24` | background jobs | [jobs](../extensions/jobs.md) |
| `EXT-25` | teammates — long-lived named child sessions | [teammates](../extensions/teammates.md) |
| `EXT-26` | session index and local observability | [session-index](../extensions/session-index.md) |
| `EXT-27` | path-scoped defaults | [path-defaults](../extensions/path-defaults.md) |
| `EXT-28` | the installer | `scripts/install.sh` |
| `EXT-29` | tool-result externalisation | [big-results](../extensions/big-results.md) |
| `EXT-30` | scoped project trust, plus the vendored-tree deadman | [trust](../extensions/trust.md) |
| `EXT-31` | the upstream API drift probe | `bin/api-probe.mjs` |

Gaps in the numbering are items that were folded into another one or dropped. An id is never reused.

## `EXT-08`, the one that ships as a refusal

`EXT-08` is worth calling out because you will meet it in error text without any feature behind it.
It was provider failover — on a provider error, quietly retry the turn somewhere else — and it was
**cancelled on purpose**. Two `pi-check` rules (`pc-03-no-failover-keys`,
`pc-05-no-fallbackmodels-in-agents`) and a config validator in `extensions/dispatch/config.ts` exist
solely to keep it from coming back through a config key.

So an id can name a decision *not* to build something, and still be load-bearing: the code that
enforces the absence has to be able to say what it is enforcing. The reasoning is written up in
[ADR-0001](../adr/0001-no-provider-failover.md), including what to remove if you want failover in a
fork — worth reading first, so you change it deliberately rather than adding a config key and
finding out later that a check strips it.

## Related

- [Exit codes](exit-codes.md) — the other set of numbers this repo asks you to script against
- [Safety model](../concepts/safety-model.md) — the posture most `REQ-PRV-*` ids serve
- [Decisions](../adr/index.md) — the ids that grew into full architecture decision records

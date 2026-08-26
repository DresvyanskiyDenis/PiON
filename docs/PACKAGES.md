# Package ledger

Every third-party package this repository reviewed, pinned or wired. It is the human-readable
half of `config/packages.lock.json`, which carries the tarball hashes.

!!! info "This file is a gate, not a summary"
    `bin/pi-check` rules **PC-09** and **PC-18** read it. A package wired in
    `config/settings.json` with no row here fails the build, and a version here that
    disagrees with the lock file fails it too. Regenerate rather than hand-edit:

    ```bash
    node bin/pi-check      # PC-09, PC-17, PC-18, PC-19
    ```

For the attribution view — licences, authors and the vendored patches — see
[Third-party components](reference/third-party.md).

## Allowlist

`wired` means the package is named in `config/settings.json`'s `packages` array and loads
every session. The rest are reviewed and pinned but not loaded.

| Package | Version | Licence | Status | Wired | Role |
|---|---|---|---|---|---|
| `pi-subagents` | 0.41.0 | MIT | adopted | yes | sub-agent runtime |
| `pi-sandbox` | 0.6.2 | MIT | adopted-vendored | — | OS-level containment (reviewed, not wired) |
| `pi-mcp-adapter` | 2.20.1 | MIT | adopted-vendored | yes | MCP bridge (vendored and patched) |
| `pi-web-access` | 0.18.0 | MIT | adopted | yes | web search and fetch |
| `pi-web-search` | 1.3.1 | MIT | adopted-conditional | — | web search, alternate backend (not wired) |
| `@99percentpeople/pi-background-tasks` | 2.0.0 | MIT | adopted-hardened | — | background bash tasks (reviewed, not wired) |
| `@mrclrchtr/supi-bash-timeout` | 4.6.0 | MIT | adopted | yes | default timeout for bash |
| `@narumitw/pi-statusline` | 0.49.5 | MIT | adopted | yes | status line |
| `@narumitw/pi-usage` | 0.49.3 | MIT | adopted | — | quota read path (reviewed, not wired) |
| `@juicesharp/rpiv-todo` | 2.4.0 | MIT | adopted | yes | task list |
| `pi-hashline-edit-pro` | 1.1.0 | MIT | adopted-trial | — | hash-line edit, on trial (not wired) |
| `@narumitw/pi-worktree` | 0.49.3 | MIT | adopted | yes | worktrees |
| `@narumitw/pi-lsp` | 0.49.3 | MIT | adopted | yes | language-server diagnostics |
| `@nklisch/pi-plugins` | 0.3.3 | MIT | adopted-hardened | — | package lifecycle (not the install path) |
| `pi-smart-compact` | 7.22.0 | MIT | adopted-optional | — | compaction summary quality |
| `pi-hermes-memory` | 0.9.3 | MIT | adopted-separate | — | session search (FTS5) |
| `pi-lean-ctx` | 3.9.17 | Apache-2.0 | adopted | needs the `lean-ctx` binary at 3.9.13 | tool-output shrinking |
| `pi-opa-net` | 0.6.0 | MIT | adopted-conditional | — | OPA policy engine |

Verification of the hashes themselves:

```text
npm pack --ignore-scripts, then shasum -a 256 on the resulting tarball. The npm_dist_shasum_sha1 field is npm's own SHA-1 and is recorded only as a cross-check.
```

## Transitive pins

Dependencies of the above that are pinned in their own right, because a floating range
would let them change under a package that was reviewed at one version.

| Package | Version | Licence | Required by |
|---|---|---|---|
| `@carderne/sandbox-runtime` | 0.0.69 | Apache-2.0 | pi-sandbox@0.6.2 ("^0.0.69" resolves to exactly 0.0.69) |
| `@napi-rs/keyring-darwin-arm64` | 1.3.0 | MIT | pi-mcp-adapter@2.20.1 -> @napi-rs/keyring@^1.3.0 (optionalDependencies) |

## Per-package detail

One section per pinned package. The heading carries the pinned version, and **PC-18**
checks it against `config/packages.lock.json` on every run.

## `pi-subagents` 0.41.0

| | |
|---|---|
| **Pinned version** | 0.41.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/nicobailon/pi-subagents> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | sub-agent runtime |
| **Tarball sha256** | `f433f7b1dcc252318e9960276e2e2696a1001ec46c7f82b29a5d100fe94252bc` |

## `pi-sandbox` 0.6.2

| | |
|---|---|
| **Pinned version** | 0.6.2 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/carderne/pi-sandbox> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-vendored` — wired, and its source is committed under `pi-packages/` |
| **Role** | OS-level containment (reviewed, not wired) |
| **Tarball sha256** | `f10dd13d37b9444bbaad0b0930d748ec3b24f4165182865b28b05ed4ce7d886d` |

## `pi-mcp-adapter` 2.20.1

| | |
|---|---|
| **Pinned version** | 2.20.1 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/nicobailon/pi-mcp-adapter> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-vendored` — wired, and its source is committed under `pi-packages/` |
| **Role** | MCP bridge (vendored and patched) |
| **Tarball sha256** | `cc35b8d045bb12f8989b8bdfe71dd3b49756c41e0c4a0fe48919ee24c4c16a7f` |

## `pi-web-access` 0.18.0

| | |
|---|---|
| **Pinned version** | 0.18.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/nicobailon/pi-web-access> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | web search and fetch |
| **Tarball sha256** | `6658b8585b2c2bddbed2a8063d75bb2a0e522bb7f182b873c1e54dbee8b42f6d` |

## `pi-web-search` 1.3.1

| | |
|---|---|
| **Pinned version** | 1.3.1 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/ttttmr/pi-web-search> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-conditional` — reviewed and pinned; wired only in some installs |
| **Role** | web search, alternate backend (not wired) |
| **Tarball sha256** | `d7bf017acbe0d0294d8a4a86cf0cc4dcafe366272f346499a28fbd45ef4008ab` |

## `@99percentpeople/pi-background-tasks` 2.0.0

| | |
|---|---|
| **Pinned version** | 2.0.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/99percentpeople/pi-extensions> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-hardened` — wired, with a local restriction on top |
| **Role** | background bash tasks (reviewed, not wired) |
| **Tarball sha256** | `2221dbdb58b53ea812c2fbbaacdfa4dfa8ae420972f275c6ff0704d1585c7907` |

## `@mrclrchtr/supi-bash-timeout` 4.6.0

| | |
|---|---|
| **Pinned version** | 4.6.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/mrclrchtr/supi> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | default timeout for bash |
| **Tarball sha256** | `fc9ca06db74173b6371add9be7fd6c27a054e7d160db1dac804d76690bae635f` |

## `@narumitw/pi-statusline` 0.49.5

| | |
|---|---|
| **Pinned version** | 0.49.5 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/narumiruna/pi-extensions> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | status line |
| **Tarball sha256** | `18b250c08c9adb37634d130e48416923fd4a4251c31292aedb1774fec85cdab7` |

## `@narumitw/pi-usage` 0.49.3

| | |
|---|---|
| **Pinned version** | 0.49.3 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/narumiruna/pi-extensions> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | quota read path (reviewed, not wired) |
| **Tarball sha256** | `47205861fb00495bbbcba795f7218a0c80b13185f43a3e5a21f971537e9adef6` |

## `@juicesharp/rpiv-todo` 2.4.0

| | |
|---|---|
| **Pinned version** | 2.4.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/juicesharp/rpiv-mono> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | task list |
| **Tarball sha256** | `c55f5f6eab93371ae99897590efe558ce556f97a79a63f43ea0a40c09f96a0dd` |

## `pi-hashline-edit-pro` 1.1.0

| | |
|---|---|
| **Pinned version** | 1.1.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/YuGiMob/pi-hashline-edit-pro> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-trial` — reviewed and pinned; kept while it proves itself |
| **Role** | hash-line edit, on trial (not wired) |
| **Tarball sha256** | `37a4e1abc66191300cd7e5c646a6ef5fa87be1fed224bdf00229eb3c3b8fcd68` |

## `@narumitw/pi-worktree` 0.49.3

| | |
|---|---|
| **Pinned version** | 0.49.3 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/narumiruna/pi-extensions> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted` — wired and in use |
| **Role** | worktrees |
| **Tarball sha256** | `ddcc0e3cd1f7881c5e8bafc70c6ff5f86be18bd786002fda87ed42d3a5bbb273` |

## `@narumitw/pi-lsp` 0.49.3

| | |
|---|---|
| **Pinned version** | 0.49.3 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/narumiruna/pi-extensions> |
| **Reviewed** | 2026-08-07 |
| **Status** | `adopted` — wired and in use |
| **Role** | language-server diagnostics |
| **Tarball sha256** | `56f7f49c715f67ff1ea009a77cf5ccf4589f7504d1155cfcfe835c387fa8909c` |

## `@nklisch/pi-plugins` 0.3.3

| | |
|---|---|
| **Pinned version** | 0.3.3 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/nklisch/pi-extensions> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-hardened` — wired, with a local restriction on top |
| **Role** | package lifecycle (not the install path) |
| **Tarball sha256** | `e88f68b217244352237bd81dc368851854136f66b1a0a9de55b906a5bfb781ff` |

## `pi-smart-compact` 7.22.0

| | |
|---|---|
| **Pinned version** | 7.22.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/alpertarhan/pi-smart-compact> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-optional` — reviewed and pinned; not wired by default |
| **Role** | compaction summary quality |
| **Tarball sha256** | `ed0b77491b7207eec0e356bb2bf8890d1278c3a7f61782d2f39d2448be3663ac` |

## `pi-hermes-memory` 0.9.3

| | |
|---|---|
| **Pinned version** | 0.9.3 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/chandra447/pi-hermes-memory> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-separate` — reviewed and pinned; used outside the main loop |
| **Role** | session search (FTS5) |
| **Tarball sha256** | `fc981262fc86246b8277f827abbb25c5a880133e147a146cae8e01c4abc082ff` |

## `pi-lean-ctx` 3.9.17

| | |
|---|---|
| **Pinned version** | 3.9.17 |
| **Licence** | Apache-2.0 |
| **Upstream** | <https://github.com/yvgude/lean-ctx> |
| **Reviewed** | 2026-08-06; measured and wired 2026-08-15 |
| **Status** | `adopted` — wired in `config/settings.default.json`; requires an external binary |
| **Role** | tool-output shrinking |
| **Tarball sha256** | `53dfd362d503679d3d07f85cb8f698057b44f064eab860c19013a8dc5470de1e` |

Two operational caveats, both measured on 2026-08-15 against binary 3.9.13.

**Install the binary at 3.9.13, not latest.** The npm package shells out to a Rust binary of the same
name. Versions 3.9.14 through 3.9.18 fail to compile — they declare `lean-ctx-ocla = "^1.0.0"` and the
only published version of that crate lacks fields the code references, so the build ends in 17 errors
regardless of `--locked`. `cargo install lean-ctx --version 3.9.13` is the last release that builds.
The npm side at 3.9.17 was checked call-by-call against 3.9.13's surface and passes no flag the older
binary rejects.

**Leave `enableMcp` true.** lean-ctx collapses a repeat full read of an unchanged file to a ~13-token
stub, by design and by documentation. With `enableMcp` false, ctx_read is served by a disk-backed cache
that outlives the process, so a later session can receive that stub for content it never saw — reported
as an ordinary `-99%` compression line, with nothing marking it as empty. The MCP bridge's cache is
per-session, which is the scope the design assumes. The full reasoning is recorded in the repository's
`config/lean-ctx-config.json`.

Note that `ctx_read`'s automatic mode returns signatures rather than bodies for code files above 8 KB.
That is disclosed in the tool description and is the package's purpose, but it means an exact-match edit
needs either `mode=full`, an explicit line range, or the native `read` builtin — which stays available,
since the package runs in `additive` mode.

**The `Compressed N → N tokens (0%)` footer is a broken readout, not a decision** (measured
2026-08-26 against the pinned 3.9.17). A `ctx_shell` result carries two footers and only the first
one measures anything:

```
─── 917 → 239 tok (↓~70%) ───

Compressed 333 → 333 tokens (0%)
```

The first comes from the Rust binary (`src/core/savings_footer.rs`) and is accurate — compression is
working. The second comes from the npm extension (`formatFooter`, `extensions/index.ts:233`) and is
arithmetically incapable of reporting anything but `0%` on the shell and search tools.

`ctx_shell` does not run bash and then compress it. `baseBashTool` (`:407`) installs a `spawnHook`
that rewrites every command to `lean-ctx -c '<command>'`, so the extension's only remaining job is to
parse the binary's marker back out. `parseLeanCtxOutput` (`:200-231`) accepts exactly two shapes —
`[lean-ctx: N → M tok, -P%]` at `:208` and `[N tok saved (P%)]` at `:214` — and binary 3.9.13 emits
neither. It emits `[lean-ctx: 17001→1474 tok, verbatim truncated]`, a reason string where the regex
demands a percentage, or the `─── … ───` banner above, which the regex does not model at all. A sweep
of a 141 MB session corpus under `~/.pi/agent/sessions` finds **zero** occurrences of either accepted
shape: never matched, not rarely.

With nothing parsed, the bare `always: true` branch of `withFooter` measures the *already-compressed*
text against itself, so `original === compressed` by construction. Its estimator is `ceil(length / 4)`
over JS UTF-16 units, which is why the number agrees with neither side of the real footer — the body
above is 1329 UTF-16 units, and `ceil(1329 / 4)` is exactly 333.

Affected: `ctx_shell` (`:477`, `:486`) and `ctx_ls` / `ctx_find` / `ctx_grep` (`:691`, `:715`, `:764`),
which pass a bare `always: true`. Eleven of eleven samples in the session corpus are exactly
`N → N (0%)`, with no counter-example. **`ctx_read` is unaffected** (`:594`, `:607`, `:645`, `:658`):
it passes `originalText` with `preferEstimate` and `suppressIfNoSaving`, which is where the genuine
`-47%` / `-99%` / `-100%` footers come from. So a non-zero percentage always means `ctx_read`.

The one case where this matters: `verbatim truncated` means output was *dropped* and teed to
`~/.local/state/lean-ctx/tee/`, and the `0%` footer then sits directly beneath a marker saying content
is missing. Nothing is lost silently — the binary's marker survives in the body precisely because the
parser fails to strip it — but the footer actively contradicts it, and that is the only place the
wrong readout sits next to something consequential.

Upgrading does not fix it: npm 3.9.20 carries the identical two regexes at `:218` and `:224` and still
passes a bare `always: true` on all four tools. It is not patched here either, and deliberately so —
this repository has no patch mechanism, and adding one that every `npm ci` would have to honour
forever is a bad trade for a footer worth roughly ten tokens a call. Recorded as a known cosmetic
defect. Revisit if the `verbatim truncated` case is ever shown to hide real data loss.

## `pi-opa-net` 0.6.0

| | |
|---|---|
| **Pinned version** | 0.6.0 |
| **Licence** | MIT |
| **Upstream** | <https://github.com/buihongduc132/pi-opa-net> |
| **Reviewed** | 2026-08-06 |
| **Status** | `adopted-conditional` — reviewed and pinned; wired only in some installs |
| **Role** | OPA policy engine |
| **Tarball sha256** | `075b000cf64c98b5a8ef43fcc649149ade6aec3f8007e4764f378da5b88b2672` |

## Related

- [Package denylist](DENYLIST.md) — what was reviewed and refused
- [Third-party components](reference/third-party.md) — licences and the vendored patches
- [Generated and locked files](configuration/not-editable.md) — why the lock is not hand-edited

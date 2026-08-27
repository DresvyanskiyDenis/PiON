# Release notes

Human-readable changes. The authoritative record is the git history; this page exists so you can tell
in thirty seconds whether an update affects you.

**How to read an entry.** Anything under **Action required** changes behaviour you already depend on.
Everything else is additive or internal.

**How to write one.** Newest first. Every entry names the files that changed, and any entry that
alters a shipped default gets an **Action required** line — even a one-word one.

---

## Unreleased — initial public release

`package.json` still carries `version: 0.0.0`; the first tag has not been cut.

The first public version of a harness that had been developed privately. Two categories of content
were removed before publication and are not coming back:

- **All skills**, and **all MCP server definitions.** They were one operator's personal setup. The
  loading machinery stayed: skill discovery across extra roots, the `PI_SKILL_DIR_*` environment
  shim, the `allowed-tools` portability lint, the vendored MCP adapter, the `mcp-stdio-guard`
  wrapper and the project trust gate. Adding your own is documented as a first-class path.
- **Everything specific to one machine or one organisation**: identity injection, tenant hostnames,
  private roots, workspace ids.

What the first public release contains:

- **26 extension modules** composed by a single root (`extensions/index.ts`) in a fixed order, with
  per-module error containment and a `/doctor` command that reports loads *and* absences.
- **Routing by semantic tier** — `strong`, `light`, `confidential` — with `confidential` shipped
  deliberately unbound.
- **Three provider fragments**: `github-copilot`, `databricks`, and `openai-compatible` for anything
  serving its own model names over an OpenAI-compatible Chat Completions surface (LiteLLM, vLLM,
  OpenRouter, an in-house router, a first-party vendor API, a server on your own loopback).
- **A six-gate permission layer** over every tool call, plus a deadman that blocks the dangerous
  tools when a guardrail module failed to load.
- **MCP behind a default-deny project trust gate**, digest-keyed approvals, and an
  environment-minimising stdio wrapper.
- **`bin/pi-run`**, the fail-closed headless wrapper, and **`bin/pi-check`** with 22 repository
  invariants.
- **An interactive installer** (`scripts/install.sh`): nine sections, a review screen before
  anything is written, idempotent, re-runnable, and it leaves no orphans.
- **Zero skills and zero MCP servers by design.** The machinery ships; the content is yours. The
  installer offers two public MCP servers and defaults to neither.
- **Documentation**: an MkDocs site covering every configuration key and all 31 modules, and this
  wiki.

**Action required:** none — there is nothing to upgrade from.

**Known at release:** the honest list lives on
[Known limitations](https://dresvyanskiydenis.github.io/PiON/limitations/). The two that bite first are
that `pi -p --mode json` exits `0` on a failed turn (hence `pi-run`) and that egress classes are
declarative, not a network boundary.

---

## Entry template

```markdown
## <version> — <date>

<One paragraph: what changed and why anyone should care.>

**Action required:** <what you must do, or "none">

### Added
### Changed
### Fixed
### Removed

**Files:** `config/…`, `extensions/…`
```

---

## When PI itself updates

A PI release is not a PiON release, and it can still break you. PI is pre-1.0 and its extension
API changes. After updating PI:

```bash
node bin/api-probe.mjs --pi "$(command -v pi)" --check   # has the extension API moved?
~/pi-config/bin/pi-check --all    # includes the vendored-tree digest check
```

Re-apply the vendored patches if `pi-mcp-adapter` moved — the vendor lock file marks re-application
as mandatory, and `PC-21` will fail until the recorded digests match the tree again. See
[Verification](https://dresvyanskiydenis.github.io/PiON/operations/verification/).

---

See also: [[Cookbook]] · [[Troubleshooting]] · [[FAQ]]

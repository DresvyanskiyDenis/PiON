# PiON wiki

Fast, operational material for [PiON](https://github.com/DresvyanskiyDenis/PiON) — a hardened,
portable harness for the [PI coding agent](https://github.com/earendil-works/pi).

**Start here if you want to *do* something.** Start at the
[documentation site](https://dresvyanskiydenis.github.io/PiON/) if you want to *understand* something.

## Pages

| Page | For |
|---|---|
| [[Quickstart]] | Install once, then drive the installer: the four re-run modes and the six sections |
| [[Cookbook]] | "How do I make it do X?" — 20 short recipes, each one file and one command |
| [[FAQ]] | The questions that come up before the first install |
| [[Troubleshooting]] | Symptom → cause → fix, in the order you will hit them |
| [[Provider Cheat Sheet]] | The six shipped providers, what each needs, which tier it suits |
| [[Release Notes]] | What changed, in human terms |
| [[Publishing This Wiki]] | How this wiki is edited and pushed (it lives in the main repository) |

## Why there are two documentation sets

They have different edit costs, and mixing them makes both worse.

| | Documentation site (`docs/`) | This wiki (`wiki/`) |
|---|---|---|
| **Holds** | Structured reference: architecture, every configuration key, all 32 modules, the safety model, exit codes | Recipes, FAQ, troubleshooting, cheat sheets, release notes |
| **Changes** | With the code, in the same pull request | Whenever someone learns something |
| **Reviewed** | Yes — a broken link fails CI | No |
| **Lives in** | The main repository, `docs/` | A *separate* git repository, `PiON.wiki.git` |

The wiki *source* is kept in `wiki/` in the main repository so it is reviewable and diffable, then
pushed to the wiki remote. See [[Publishing This Wiki]].

**Rule of thumb:** if a statement would become wrong when the code changes, it belongs on the site,
next to the code, where CI can catch it. If it would still be true after a refactor, it belongs here.

## The three things worth knowing before you edit anything

1. **Generated versus tracked.** Ten files — `models`, `routing`, `mcp`, `settings`, `guard`,
   `trusted-roots`, `path-defaults`, `web`, `web-search`, `quota` — are *generated* by the installer
   and git-ignored. The tracked templates are `config/<name>.default.json`. Editing a generated file
   works immediately and survives a re-run (the installer patches, it does not reset); what it does
   not survive is a fresh clone, so a permanent edit belongs in the template too.

2. **Re-running the installer is the supported way to change configuration.** It is not a
   reinstall. `./scripts/install.sh --reconfigure`, or `--section providers` for one part of it.

3. **The repository *is* the live configuration.** `~/.pi/agent/*` are symlinks into your clone.
   Editing a file in the clone changes the running agent; there is nothing to copy or deploy.

## Quick links into the site

- [Install](https://dresvyanskiydenis.github.io/PiON/getting-started/install/)
- [Configuration reference](https://dresvyanskiydenis.github.io/PiON/configuration/) — the most useful page
- [Safety model](https://dresvyanskiydenis.github.io/PiON/concepts/safety-model/)
- [Exit codes](https://dresvyanskiydenis.github.io/PiON/reference/exit-codes/)
- [Known limitations](https://dresvyanskiydenis.github.io/PiON/limitations/)

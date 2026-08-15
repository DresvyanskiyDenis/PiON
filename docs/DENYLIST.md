# Package denylist

Packages that were reviewed and **refused**. A refusal is worth recording: without it, the next
person re-does the review, reaches the same conclusion, and pays for it twice.

!!! info "This file is a gate"
    `bin/pi-check` rule **PC-09** fails the build if a package listed here also appears in
    `config/settings.json`'s `packages` array. Adding a row here is how you make a rejection stick.

    Row format matters: the first cell must be a backticked npm id.

## Refused

| Package | Version reviewed | Why not |
|---|---|---|
| `picodesandbox` | 0.6.12 | The same extension as `pi-sandbox`, published under a second name, depending on its runtime at a floating `latest`. A pinned review means nothing if a transitive dependency can change under it. Install `pi-sandbox` instead. |
| `pi-yaml-hooks` | 2026.7.19 | **Fail-open at every layer, and not configurable.** A hook rule that stops applying when its own evaluation throws is worse than no rule, because it reads as enforcement. This repository's [`hooks`](extensions/hooks.md) module exists because of this rejection, and it fails *closed*. |

## Dropped when the lane they served was deleted

Not a refusal, and deliberately not a row above: `pi-llama-cpp` 0.9.1 (MIT) passed review on
2026-08-06 and was pinned for a local-model-server provider lane. Owner decision, 2026-08-15: the
provider set is exactly `github-copilot`, an OpenAI-compatible gateway and `databricks`, and that
lane was deleted from the harness. The package served nothing else — it never registered the
provider id `local` (its own prefix is `llama-server`), and nothing under `extensions/` ever
imported it — so it was uninstalled rather than left pinned and dead. It is recorded in
`config/packages.lock.json`'s `not_installed[]`, which `test/bootstrap.test.ts` enforces, so its
absence is a test rather than a note. A model server on loopback is still perfectly reachable
through [`openai-compatible`](configuration/openai-compatible.md) with a `127.0.0.1` base URL,
which needs no package at all. Re-adopting it would need a fresh review *and* a provider to adopt
it for.

## Refused, and not on npm under a name worth recording

One well-regarded context-optimiser package was reviewed and not adopted, on two independent
grounds:

1. Its licence is **non-commercial**, which makes it unusable in the environment this harness was
   written for.
2. Its design depends on four PI lifecycle events that **do not exist**. The second reason would
   have been sufficient on its own.

Part of its idea survives in [`big-results`](extensions/big-results.md) — but as a *handle* rather
than a *shrink*, because shrinking is lossy and irreversible while a handle is neither.

It carries no row above because it is not wired anywhere and a denylist entry would imply somebody
tried. See [Known limitations](limitations.md#not-ported--capabilities-that-exist-elsewhere-and-not-here).

## What a rejection needs

Before adding a row, write down which of these applies. "It felt wrong" is not a review.

- **Licence** — incompatible with redistribution, or non-commercial.
- **Fail-mode polarity** — a safety-relevant package that fails open, where failing closed was the
  reason to adopt it.
- **Unpinnable dependencies** — a floating range under a package you pinned.
- **Design depends on API that does not exist** — measured against the pinned PI version, not
  inferred from a README.
- **Duplicate of something already adopted**, with no advantage.

## Related

- [Package ledger](PACKAGES.md) — what *was* adopted, and at which version
- [Third-party components](reference/third-party.md) — licences and attribution

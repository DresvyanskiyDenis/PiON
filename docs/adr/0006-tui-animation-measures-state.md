# ADR 0006: TUI animation is scoped to what measures state; interpolation is out

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

PI writes the transcript into terminal scrollback, and that is a different medium from a GUI frame
buffer. Anything animated outside a fixed bottom region corrupts the scroll history the moment the
user scrolls — the repainted frames are gone, only the last one is left behind in a transcript that
is supposed to be a record. Redraw is line-based, so motion over SSH/mosh/tmux tears and flickers
rather than smoothly compositing; the artifacts are worst on the slowest channels, which is exactly
where an operator spends the longest watching a long agent run. The two mediums fail differently on a
dropped frame: a dropped frame in a browser is invisible, absorbed by the next paint; a dropped frame
in a terminal is a visibly mangled line that stays mangled until the next full repaint.

Without a standing rule, each renderer answers "should this animate?" for itself, and a review has no
firmer ground to stand on than taste. Perceived responsiveness in a TUI comes from **stable layout
and progressive disclosure** — content appearing as it becomes true — not from motion standing in for
it. That is the distinction this decision makes precise.

## Decision

**Animate only motion that encodes real state, never motion that interpolates between two states for
its own sake.**

Worth animating:

- A loader tied to real state: elapsed seconds plus the current phase (`thinking`, `tool: read`,
  `streaming`, …) — motion that *encodes information* about what the harness is doing right now.
- Streaming assistant text — it animates for free as tokens arrive; there is no interpolation to add,
  the model's own pace is the frame rate.
- At most a one-frame highlight on a block's collapse or expand. A height change that just snaps
  looks like a glitch; anything more than one frame is decoration on top of a state change that
  already read as instant.

Not worth animating: easing curves, sliding panels, fades, and progress bars — anything that
*interpolates* between two states rather than measuring one. A progress bar in particular implies a
duration estimate this harness does not have, and does not get from the component shipped either (see
Consequences).

## Consequences

**Positive**

- A contributor proposing a sliding panel or a progress bar has a written rule to read rather than a
  fresh argument to relitigate on every PR.
- The distinction is mechanical enough to apply without a design review: does this motion encode a
  value that changed, or does it just get from A to B more smoothly? If the second, it does not ship.

**Negative**

- A loader that only measures elapsed time and phase reads as plainer than an equivalent GUI
  affordance with a real progress bar — this decision accepts that trade rather than building one.
- Some contributors will read "no easing" as "no polish" rather than as "no motion this medium
  cannot render without corrupting its own history."

**Neutral, noted but not built**

- The upstream TUI component library this repository depends on (`@earendil-works/pi-tui`, pinned
  transitively at `0.80.10` in `node_modules`) ships `box`, `loader`, `cancellable-loader`, `text`,
  `truncated-text`, `markdown`, `spacer`, `select-list`, `settings-list`, `image`, `editor`, `input`
  and `autocomplete` — no gauge, progress-bar, table, or sparkline component — and already lags the
  agent package this repository pins directly (`@earendil-works/pi-coding-agent` at `0.84.4`,
  `package.json:21`).
- In a binary-mode install, this repository's own source patches do not apply — a binary install runs
  the upstream package unpatched, regardless of what is checked into this tree. A richer,
  state-driven loader animation beyond what `pi-tui` already ships is therefore either an upstream
  feature request against `pi-tui`, or a prototype confined to npm-mode installs with that gap
  documented the same way any other binary-mode limitation would be. Neither is built by this
  decision; it only sets the bar a future proposal has to clear — state-driven, not interpolated —
  before that work starts.

## Alternatives considered

| Option | Why not |
|---|---|
| Leave it to per-PR review, no written rule | This is the status quo the decision replaces. It relitigates the same argument each time a progress bar or a sliding panel is proposed, and "no, that will tear over SSH" is not obviously true until someone has watched it happen. |
| Allow limited easing on state changes that are visually large (e.g. a panel replacing another) | Easing is exactly the kind of motion that tears on a line-based redraw and leaves an unrecoverable artifact in scrollback the moment a user scrolls mid-animation. The size of the visual change does not change the medium's failure mode. |
| Build a real progress bar once a duration estimate exists | Reasonable, and explicitly not blocked by this decision — the "Reopen this if" section below names the condition. Building the affordance ahead of having anything honest to drive it would ship a bar that lies about progress, which is worse than no bar. |

## Reopen this if

- `pi-tui` ships a gauge, progress-bar, table, or sparkline component upstream — then evaluate
  whether a *state-driven* use of it (not an interpolated one) fits inside this policy, rather than
  treating its arrival as license to add interpolation.
- A durable, honest duration or completion estimate becomes available somewhere in this harness (for
  example, a preflight token estimate maturing into a full-turn estimate) — a progress bar driven by a
  real number is a different proposal from one driven by a guess, and this ADR does not forbid it.
- Binary-mode installs gain a supported way to apply this repository's own patches on top of the
  vendored package — that removes the constraint that currently confines any richer loader work to
  npm-mode prototypes.

## Related

- [Concepts: architecture](../concepts/architecture.md) — where the TUI's rendering constraints are
  documented alongside the rest of the harness

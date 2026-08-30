# `hooks` — the declarative rule layer

A colleague adds a guard by editing YAML, never TypeScript. Configured by
[`config/hooks.yaml`](../configuration/tools.md#hooksyaml).

Deliberately **not expressive enough to become a language**: five fields per rule —
`event`, `match.tool`, `match.pattern`, `action`, `reason` — plus a `run` block for the one action
that shells out. Every request to add a sixth field should be met with "write it as a sub-agent or a
guard gate".

Binds three events: `tool_call`, `input`, `session_start`.

## The inversion that matters

Every other `tool_call` handler in this tree registers with `onInternalError: "open"` — our own bug
must never blanket-block every tool call. **This module is the deliberate exception**:
`onInternalError` is `"closed"`.

!!! abstract "A rule whose absence is itself unsafe"
    A declarative guard that silently stops applying **is** the bug. So all four failure classes
    block rather than permit: evaluation throws, action throws, the script times out, the script is
    missing.

That is why no `run` rule ships enabled — a `run` rule matching `tool: bash` with no script in place
would block every bash call, by design.

## `input` has no platform-level fail-closed option

PI's own `emitInput` catches a throwing `input` handler and continues with the text unchanged.
There is no `"closed"` to ask for; the platform's failure mode for that event is baked in as
fail-open. So this module wraps its own `input` handler in its own `try`/`catch` and swallows the
message on an internal error, rather than letting the exception reach PI's fail-open catch.

## A malformed `hooks.yaml` degrades to "no hooks"

It does **not** contain the session. This was changed deliberately.

The earlier behaviour blocked every subsequent `tool_call`, swallowed every `input` and shut the
session down — on the reasoning that an unparseable rules file means every tool call proceeds
unhooked. That reasoning treated this file as the last line of defence, **which it is not**:
[`guard`](guard.md) owns the hard gates and is a separate module that keeps working when this one has
nothing loaded.

The practical cost of the old polarity was the whole argument against it: one YAML typo bricked the
session. [`doctor`](doctor.md)'s `D-09` reports a hook layer sitting degraded, so the fact stays
visible without being fatal.

The mirror image is the `run` action, whose script lives outside the repository. That one still
fails **closed** — a rule that cannot reach its script blocks the tool it matches, for the whole
session — so it announces itself once per rule and joins `D-09`, and
[`bin/pi-check --doctor`](../extending/hooks.md#when-the-script-is-not-installed) answers the same
question from a shell before a session ever hits the rule.

## Hooks stack on the guard

They may only **add** denial, never remove it. That is why `hooks` loads after `guard`.

Merge order: the global file first, then `<project>/.pi/hooks.yaml` **when the project is trusted**.

## Related
[`hooks.yaml`](../configuration/tools.md#hooksyaml) · [guard](guard.md) ·
[Safety model](../concepts/safety-model.md)

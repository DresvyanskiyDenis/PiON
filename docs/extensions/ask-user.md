# `ask-user` — a question the model can actually put to you

Registers one tool, `ask_user`. The model hands it one to four multiple-choice questions, each one
renders as a dialog in your terminal, and your answers come back as the tool result.

PI 0.84.0 ships no such tool. Its built-ins are `bash`, `edit`, `grep`, `find`, `ls`, `read` and
`write`, all of which act on the repository; none of them can reach the person sitting in front of
it. Without this module, a model facing a prompt with two readings has only two moves: guess, or
stop and hand the work back.

## Shape

A question carries a full sentence, a short `header` (at most twelve characters) that keys the
answer back, two to four options, and an optional `multiSelect`. Every option is a `label` plus a
`description`, and the description is the point: the operator is choosing between consequences, so
a description that restates the label wastes the dialog.

An **Other** row is appended to every question and routes to a free-text input, so no set of
options can trap you into an answer you do not mean. Declaring your own `Other` option is rejected,
because two rows meaning the same thing make the answer ambiguous — as do a repeated label, and two
options that render as the same line.

`consequence` is the fourth field, and the only one that changes what a *non*-answer means. It is
`"reversible"` by default; see [below](#a-dismissed-dialog-is-an-answer-unless-it-was-not-yours-to-decide).

## Four behaviours that are choices

### It fails loudly where there is nobody to ask

The gate is `ctx.hasUI`. When it is false the tool throws, naming the mode, rather than returning
anything at all.

That is not defensive coding, it is the whole reason the module exists in this shape. In print mode
PI installs a no-op UI context whose `select` and `input` resolve to `undefined` instantly and
whose `confirm` resolves to `false`. From inside the dialog call, a question nobody ever saw is
indistinguishable from a question you looked at and dismissed. Without the gate, `ask_user` would
report that you declined to answer something that was never rendered anywhere.

!!! note "`hasUI`, not the mode name"
    The tool is available in **TUI and RPC** modes, and unavailable only in the headless ones
    (`print`, `json`). RPC mode installs a genuine UI context that round-trips the dialog to a
    client, so a real person answers it; gating on `mode === "tui"` instead would abort on an
    operator perfectly able to reply.

A subagent gets a different sentence from the main agent. `pi-subagents` runs each child as its own
headless process, so a child physically cannot render into the parent's terminal — but it may have
`contact_supervisor`, which reaches the agent that spawned it. The message offers that channel when
the run provides it, and tells the main agent to decide and name its assumption instead, because
sending the main agent after a tool it has not got would be its own small fabrication.

### A dismissed dialog is an answer

Closing the box means *I decline to choose*. It comes back as a decline, the model is told in as
many words that no answer was given, and nothing re-asks. The guidelines shipped with the tool say
what to do with that: proceed on your own judgement, and say which assumption you made.

### …unless it was not yours to decide { #a-dismissed-dialog-is-an-answer-unless-it-was-not-yours-to-decide }

"Proceed on your own judgement" is the right reading of a decline on a question about a library or
a naming convention. It is the wrong reading, and an expensive one, on a question that authorises
spending money, an outward send, a deletion, or a write to restricted storage. There, no answer is
a **refusal** — and a model told to use its judgement will helpfully do the thing nobody approved.

A question may therefore declare `consequence: "irreversible"`. Its decline renders as `DENIED`,
leading with the verdict and saying outright that silence is not approval, that the model must not
act, must not choose on your behalf, and must not re-ask in a loop.

Three things about that are deliberate:

**The stakes are declared, never sniffed.** A regex over `$` or `delete` would be wrong in both
directions and cannot be instructed. The obligation lives in the tool's own `promptGuidelines`
instead. A model that fails to declare an irreversible question still gets the ordinary decline —
the strict reading is added, not imposed.

**It is a rendered line, not a thrown error.** One call carries up to four questions. Throwing on
the denied one would discard the answers you *did* give and send the model back to ask everything
again.

**The cause is recorded when it happens.** PI resolves a dismissal, an aborted signal and an
expired dialog all to the same `undefined`
([why](../limitations.md#platform-limits--things-pi-does-not-let-an-extension-do)), so nothing
about the returned value distinguishes them. The decline is stamped `dismissed` or `cancelled` at
the moment the dialog gives up, by reading the caller's signal — and the `DENIED` line names it,
because *you closed it* and *nobody was ever asked* are different refusals.

This module arms no deadline of its own, and should not grow one. A question that authorises
spending must not expire from inattention, and a second signal would make the two causes
indistinguishable again. The only thing that ends a wait here is the session itself.

### `multiSelect` is honoured, not degraded

PI's `select` is single-choice and there is no richer dialog to reach for. Multi-select is
therefore a loop over `select` that renders its own `[x]` / `[ ]` markers, an Other row, and a Done
row carrying a live count. That costs one dialog per toggle and buys a real multi-select answer
everywhere `hasUI` is true. A custom TUI component would have been smoother and would have worked
in TUI mode only, which is strictly fewer places than the tool itself.

The loop is bounded at 200 rounds. A person cannot reach that; a `select` implementation that
resolves without waiting for anyone can, and an unbounded loop over such a `select` holds the turn
open forever with no output. Bounded and loud beats a hang.

## Cost

Nothing at rest. `register()` opens no file, starts no timer and reads no configuration. The module
is inert until the model calls the tool, and the only work it does then is the dialogs themselves.

The tool is registered `executionMode: "sequential"`, so it never runs beside another tool call.
Two dialogs contending for one terminal is not something a person can answer.

## Related

- [`teammates`](teammates.md) — messages between agents, where the reader is another model rather
  than a person.
- [`dispatch`](dispatch.md) — subagent routing, and the reason a child has no terminal of its own.

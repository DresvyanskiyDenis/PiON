# `input-transform` — verification nudges on your own prompts

Fires on PI's `input` event, which can rewrite your message outright. **This module only ever
appends.** The restraint is the design, not a limitation:

> **Design rule: stay silent.** A hook that fires on every prompt is noise and gets tuned out. Each
> signal is a concrete lexical marker, never a guess about intent.

## Signal

One: an explicit **version string** appears in your prompt. Plus two bailouts — a leading `/`, and a
prompt too short to be worth inspecting.

It is a lexical marker you can point at in the text, not an inference about what you meant. An
inference that fires wrongly is worse than no hook, because the model starts discounting the ones
that fire correctly.

!!! note "The dependency-name signal was removed, not narrowed"
    A second signal used to fire whenever a bare token in your prompt equalled a declared dependency
    of the current project. Every short dependency name that is also an ordinary English word was
    therefore a tripwire: in a project whose `pyproject.toml` declares `mcp`, the sentence *"we speak
    only about UI, client side. We do not touch mcp wrapper"* fired the nudge, with no library
    reference in it at all. That is the design rule above being violated by a guess wearing a lexical
    marker's clothes.

    Narrowing it was considered and rejected twice over. Requiring the dependency token to co-occur
    with a version marker adds nothing, because the version marker already fires on its own; and
    requiring an import- or install-shaped context moves the noise rather than removing it, since a
    pasted snippet that merely *contains* an import is usually a request to change code, not a
    question about the library. What the signal was for is already covered statically —
    [`AGENTS.md`](https://github.com/DresvyanskiyDenis/PiON/blob/main/AGENTS.md) tells the model to check current documentation before touching a
    library, and names "a package or tool name" as the trigger. A rule the harness states once does
    not also need a per-prompt hook.

    The manifest reader that fed it — `package.json` / `pyproject.toml` parsing, its mtime cache and
    the TOML dependency — went with it, so the module now reads nothing from disk.

## The ordering fact that is the opposite of the intuition

!!! note "`input` fires BEFORE skill and prompt-template expansion"
    A `/skill:foo bar` prompt reaches this handler as the literal string `/skill:foo bar`. The
    leading-slash bailout exists for exactly that reason, and it does the right thing — but note
    that this handler can **never** see an expanded template, only ever the raw input you typed.

## Deviation, flagged rather than hidden

An earlier research pass listed five portable signals: manifest dependency, version string, recency
words, pricing words, and a pasted stack trace. The narrower porting spec named only the two lexical
markers plus the bailouts, on the grounds that recency and pricing are already covered statically by
the harness's own standing instructions, and a pasted stack trace is a different behaviour (triage,
not verification) with no event mapping given.

Implemented per the narrower list, then narrowed once more to the version marker alone by the
decision above. Whether the other three should be added is left open — recorded here so the shape of
the module is a visible decision rather than something inferred from absence.

## Related
[hooks](hooks.md) · [AGENTS.md](../extending/index.md)

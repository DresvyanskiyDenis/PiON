# `input-transform` — verification nudges on your own prompts

Fires on PI's `input` event, which can rewrite your message outright. **This module only ever
appends.** The restraint is the design, not a limitation:

> **Design rule: stay silent.** A hook that fires on every prompt is noise and gets tuned out. Each
> signal is a concrete lexical marker, never a guess about intent.

## Signals

1. A dependency of **this project's own manifest** is named in your prompt.
2. An explicit **version string** appears in your prompt.

Plus two bailouts: a leading `/`, and a prompt too short to be worth inspecting.

Both signals are lexical markers you can point at in the text. Neither is an inference about what
you meant — an inference that fires wrongly is worse than no hook, because the model starts
discounting the ones that fire correctly.

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

Implemented per the narrower list, and recorded as a deviation so the decision is visible rather
than inferred from absence.

## Related
[hooks](hooks.md) · [AGENTS.md](../extending/index.md)

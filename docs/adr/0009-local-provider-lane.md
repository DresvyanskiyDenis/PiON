# ADR 0009: A session on a local model runs every dispatch and every compaction on that model, with no remote fallback

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

Until now every provider this harness talks to was a remote one, and the rules that keep it honest
were written for that case. [ADR 0001](0001-no-provider-failover.md) says a provider error aborts
the turn, and a dispatch never silently runs on a model other than the one asked for.
[ADR 0007](0007-zero-token-empty-response-gets-one-working-path-hop.md) carves one narrow hop for a
request that never landed.

A model served from the operator's own machine changes what the operator is asking for. Someone who
starts a session on a local model wants the whole session local: the lead, every sub-agent, and the
compaction summary. Three things in the existing design break that wish without anyone choosing it:

1. A sub-agent whose definition names a tier, or pins a remote `provider/model`, dispatches to a
   remote provider, and the prompt leaves the machine.
2. Compaction runs on the configured compaction route, which is remote, and the lead's context goes
   with it.
3. The ADR 0007 hop, taken after an empty reply, moves the session to a remote tier.

A flat auto-compact threshold also misfits a small window: a number tuned for a 200 000-token remote
model never fires on a 131 072-token local one, and PI's own trigger (`contextWindow -
reserveTokens`) leaves too little room to write the summary.

## Decision

**A session is on the local lane when its active model belongs to a provider whose egress class is
`local`. On the lane, every sub-agent dispatch runs on the session's model, compaction runs on it and
on nothing else, and no remote hop is ever taken.**

Mechanism:

- `local` is a fourth egress class, accepted wherever the other three are. It is the one class that
  carries behaviour: the lane is defined by it. A provider joins the lane by declaring it in its
  fragment, not by an answer in the interview.
- Dispatch forces the model. A tier name and an explicit `provider/model` pin are both rewritten to
  the session's model, in single, parallel and chain calls and in a literal `model:` inside an inline
  workflow script. A script whose model is not a literal, or a script file, cannot be rewritten
  safely and is blocked with a message instead. Each rewrite is reported, and the dispatch audit
  entry records it.
- This is a deliberate exception to ADR 0001's "no substitution", and it is stated where the model
  and the operator read it: one line in the `Sub-agent model selection` system-prompt block and one
  in `/agents`.
- Compaction on the lane has exactly one candidate, the session's own model. When it fails, the
  failure is surfaced with provider, model, error class, message and cause chain, and PI's default
  compaction runs on the same local model. The cloud compaction route is never consulted.
- The compaction threshold on the lane is `min(absoluteTokens, 0.75 x contextWindow)`, checked after
  each settled turn because PI has no per-model trigger. Off the lane it is unchanged: a generic cap
  would have moved every 200 000-token remote model to 150 000.
- The ADR 0007 hop is skipped for a local provider. The same-provider bounded retry stays.
- If the local server is down, the turn aborts with provider, model, error class and cause chain.
  Nothing else is tried.

## Consequences

**Positive.** A local session cannot leak a prompt to a remote provider through a sub-agent, a
compaction or a fallback hop. The behaviour is declared in one fragment field rather than inferred.

**Negative.** A sub-agent that was written for a stronger model runs on a weaker one and may do its
job badly, and a small local model may not emit the dispatch call at all. Concurrency 1 serialises
sub-agents. The lane overrides an agent's explicit model pin, which ADR 0001 otherwise treats as a
promise.

**Neutral.** Off the lane nothing changes. Egress classes are still labels, not a network boundary
([ADR 0004](0004-egress-classes-are-declarative.md)); `local` says where the traffic is meant to go,
and the lane enforces it only at the points this ADR lists. An agent file's `fallbackModels` is
refused by the registry and is not a route around the lane.

## Alternatives considered

- **Treat a local model as `openai-compatible` and let the operator pin every agent.** Rejected: one
  forgotten pin sends a prompt out, and the operator cannot audit every agent definition on every
  session.
- **Refuse a dispatch whose model is not the local one.** Rejected: it turns a working session into
  a stream of blocked tool calls the model cannot resolve. Forcing with a visible report keeps the
  session moving and still shows what was changed.
- **Apply the 0.75 cap to every model.** Rejected: it changes the behaviour of every remote model
  for a problem only the local window has.
- **Fall back to a remote model when the local server is down.** Rejected: that is the leak the
  lane exists to prevent, and ADR 0001 already says a failure aborts.

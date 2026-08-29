# `session-context` — date, runtime, scratchpad, identity, git facts

Injects a small, stable block into the system prompt exactly once per turn: today's date, which
model this session is actually running, the per-session scratchpad directory, an operator-identity
file, project state and git facts.

Registers `/ctx-dump`, which prints what was injected.

## The split that makes it cheap

- **All I/O runs in `session_start`**, which fires once per session (plus `reload` / `new` /
  `resume` / `fork`).
- **Injection runs in `before_agent_start`**, which fires on **every** user prompt and therefore
  touches no disk and spawns no process.

Getting that backwards puts a `git` invocation and several file reads on the critical path of every
message you type. It is the single most common performance mistake in an extension of this shape.

The one value read on every prompt is the active model, and that is not an exception to the rule:
PI resolves it through an in-memory getter, so no file is opened and no process is spawned.

## Today's date

Cheap and load-bearing. A model's knowledge has a cutoff; it cannot know what today is unless
something tells it. Every "is this still current?" judgement downstream depends on this line.

## What model this is

A model cannot read its own name plate. Ask an agent which model it is and it answers from training
data — confidently, and often wrongly, because a harness can point it at something that did not
exist when it was trained. Worse, it cannot calibrate: how much to attempt in one turn depends on
the window and the thinking level it is actually running at.

So the block states it:

```text
## Runtime
model github-copilot/claude-opus-5 · thinking high · context window 200000 tokens
Subagent default tier: strong (github-copilot/claude-opus-5 @ high).
Routing questions are answered from config/models.json and config/routing.json, never from memory.
```

Model, thinking level and window come from the **live session**, re-read on every prompt, so
switching model mid-session updates the line instead of leaving a stale claim in the prompt. The
subagent default tier is file-backed — `config/dispatch.json`'s `defaultTier` resolved through
`config/routing.json`'s tier table — and is therefore resolved once, in `session_start`, like every
other read.

!!! warning "The section is never silently omitted"
    If the runtime exposes no model, or `routing.json` has not been generated yet, the section
    still renders and names the reason:

    ```text
    model UNRESOLVED — the session runtime exposed no active model (ctx.model is undefined) · …
    Subagent default tier: strong — UNRESOLVED: routing.json not found … run scripts/install.sh
    ```

    A dropped section would put the agent straight back to guessing, which is the failure this
    exists to close.

## The scratchpad

A per-session directory, created `0700`. It is where temporary files belong — not the system temp
directory, and not the repository.

## The identity file

A generic `OPERATOR.md` ships in `config/operator/`. A personal overlay, if you want one, lives
**outside the repository** at `<configDir>/OPERATOR.local.md` and is gitignored.

!!! danger "The boundary is enforced mechanically, not by convention"
    Any candidate path that resolves to a location **inside the repository** — including one handed
    in through an environment variable — is **refused and announced**, never read. There is no
    remote-fetch fallback and there never will be.

    The point is that personal context cannot end up in a commit by accident. A convention would
    have been followed until the one time it was not.

A missing overlay is **announced**, not silent. You should be able to tell "no personal context
configured" from "personal context failed to load".

## Related
[session-index](session-index.md) · [context-imports](context-imports.md) ·
[Configuration layout](../getting-started/config-layout.md)

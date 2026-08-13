# `session-context` — date, scratchpad, identity, git facts

Injects a small, stable block into the system prompt exactly once per turn: today's date, the
per-session scratchpad directory, an operator-identity file, project state and git facts.

Registers `/ctx-dump`, which prints what was injected.

## The split that makes it cheap

- **All I/O runs in `session_start`**, which fires once per session (plus `reload` / `new` /
  `resume` / `fork`).
- **Injection runs in `before_agent_start`**, which fires on **every** user prompt and therefore
  touches no disk and spawns no process.

Getting that backwards puts a `git` invocation and several file reads on the critical path of every
message you type. It is the single most common performance mistake in an extension of this shape.

## Today's date

Cheap and load-bearing. A model's knowledge has a cutoff; it cannot know what today is unless
something tells it. Every "is this still current?" judgement downstream depends on this line.

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

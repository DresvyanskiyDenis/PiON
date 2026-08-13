# `skills-lint` — warning about frontmatter that does nothing

One job: warn, once per skill, when a skill's frontmatter declares something PI will not honour.

## The fact it is built on

Verified against the pinned 0.84.0 package, not assumed: PI's skill frontmatter reader parses
**exactly three fields**.

| Field | Parsed |
|---|---|
| `name` | yes |
| `description` | yes |
| `disable-model-invocation` | yes |
| **`allowed-tools`** | **no — read by nothing, anywhere** |

`grep -rl "allowed-tools\|allowedTools"` across the packaged `dist/` trees returns no matches. A
skill's `allowed-tools` line is **inert prose** the moment PI loads it.

## Why this is a warning and not enforcement

There is no enforcement half to build. This module cannot make `allowed-tools` work; PI would have
to. What it can do is make the fact loud instead of silently assumed by whoever wrote the
frontmatter — which is exactly the failure mode a portable skill format invites, because the field
is a convention borrowed from a different agent where it *does* do something.

If you need a tool restriction that is real, put it on a [sub-agent](../extending/subagents.md),
whose `tools:` list is honoured, and dispatch the work there.

## Related
[Adding a skill](../extending/skills.md) · [skill-mask](skill-mask.md) · [doctor](doctor.md)

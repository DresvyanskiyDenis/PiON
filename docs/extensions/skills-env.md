# `skills-env` — telling a skill where it lives

PI has no equivalent of a "current skill directory" variable, so a discovered skill's `SKILL.md`
prose, or a script it ships, has no way to name its own directory. This module fills that gap on
`resources_discover`.

## Why `resources_discover` and not `session_start`

Read from the pinned 0.84.0 package, not assumed: `AgentSession.bindExtensions()` runs every
`session_start` handler **first**, then calls `extendResourcesFromExtensions()`, which is what emits
`resources_discover`. By then the resource loader has already resolved the session's real, final
skill set.

So `pi.getCommands()` inside a `resources_discover` handler returns the session's actual skill list.
This module does not re-implement PI's discovery scan and does not race it.

## The correction that matters

An earlier version of this module acted on the assumption that `sourceInfo.baseDir` is populated for
every skill entry. **It is not**, and the answer differs by how the skill was found:

| How the skill was found | `sourceInfo.baseDir` |
|---|---|
| listed in `settings.json`'s `skills` array | **`undefined`** |
| auto-discovered under the standard user skills tree | the tree root, not the skill's own directory |
| shipped by a package | the package install root |

PI's own `createSkillSourceInfo()` does thread `dirname(SKILL.md)` through — and the resource loader
then **discards that object** and rebuilds it. What survives means "the root this resource was
resolved from", which is a different thing and is optional.

The module therefore derives the directory itself rather than trusting the field. This is the kind
of finding that is cheap to write down and expensive to rediscover.

## Related
[Adding a skill](../extending/skills.md) · [skill-mask](skill-mask.md) · [skills-lint](skills-lint.md)

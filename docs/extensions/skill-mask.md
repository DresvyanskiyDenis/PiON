# `skill-mask` — extra skill roots (and why it cannot mask)

Adds extra skill roots to every session via `resources_discover`. That is the whole module.
**Despite the name it masks nothing**, and the name survives only because `config/settings.json` and
the install symlinks refer to it.

## Why it cannot mask — measured, not assumed

In the pinned 0.84.0 package, `extendResourcesFromExtensions()` calls the resource loader's
`extendResources()`, which does `mergePaths(existing, contributed)` — a **union** with whatever the
settings-driven scan already found. No path in that chain removes a root.

> A `resources_discover` handler can only ever **ADD** skills. It can never subtract them.

If you need a skill *not* to load, do not look for a mask. Remove the root from
`config/settings.json`, or remove the skill.

## What contributing a root here does not buy

Additive means **appended**. `extendResources` merges contributed paths onto the **end** of the
already-resolved list, and `loadSkills` keeps the **first** loader of each skill name, reporting
every later one as a collision.

Everything settings-driven is resolved first, and is itself rank-ordered:

| Rank | Root |
|---|---|
| 0 | `<cwd>/.pi/skills` |
| 1 | `<cwd>/.agents/skills` |
| 2 | a root named in `settings.json`'s `skills` array |
| 3 | the standard `~/.agents/skills` tree |
| 4 | package-shipped skills |
| — | anything contributed by `resources_discover`, appended last |

So a root contributed **only** from here sits behind everything and loses every name collision.
Measured, not theorised: two skills contributed only from here were silently shadowed by stale
same-named copies in the standard tree, and never ran.

!!! warning "The fix is not in this module and cannot be"
    **Name your skill roots in `config/settings.json`.** This handler then becomes a harmless
    duplicate — `loadSkills` dedupes by canonical path before the name check — and remains as a
    fallback for an install whose settings file is not this repository's.

A missing directory is a silent no-op rather than an error, so a clone without the optional roots
works unchanged.

## Related
[Adding a skill](../extending/skills.md) · [`settings.json`](../configuration/settings.md#resource-paths) ·
[skills-env](skills-env.md)

# `skill-mask` — a registered no-op (and why it cannot mask)

This module registers nothing. It used to add extra skill roots to every session via
`resources_discover`; both the masking it is named for and the extra roots it contributed turned out
to be the wrong mechanism, and the roots were collapsed into the single one `config/settings.json`
declares. **Despite the name it masks nothing**, and it never did.

The id survives because removing it is a bigger change than keeping it: `extensions/index.ts`, the
extension manifest, the trust deadman list and `/doctor`'s load registry all expect to find it, and
a module that registers no handler is not the same thing as a module that is absent.

## Why it cannot mask — measured, not assumed

In the pinned 0.84.0 package, `extendResourcesFromExtensions()` calls the resource loader's
`extendResources()`, which does `mergePaths(existing, contributed)` — a **union** with whatever the
settings-driven scan already found. No path in that chain removes a root.

> A `resources_discover` handler can only ever **ADD** skills. It can never subtract them.

If you need a skill *not* to load, do not look for a mask. Remove the root from
`config/settings.json`, or remove the skill.

## Why contributing a root here bought nothing either

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

So a root contributed **only** from here sat behind everything and lost every name collision.
Measured, not theorised: two skills contributed only from here were silently shadowed by stale
same-named copies in the standard tree, and never ran.

!!! warning "The fix was never in this module and could not be"
    **Name your skill root in `config/settings.json`.** That is what the shipped array does, with
    one entry, and it is why this module has nothing left to contribute.

## Related
[Adding a skill](../extending/skills.md) · [`settings.json`](../configuration/settings.md#resource-paths) ·
[skills-env](skills-env.md)

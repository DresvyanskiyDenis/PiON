# Skill portability

Skills written for another agent mostly run here unchanged. The differences are narrow and this page
is the list of them, plus a generated table of what is actually on your disk.

## What ports, and what does not

| Convention | Status under PI 0.84.0 |
|---|---|
| `SKILL.md` in a directory, discovered by name | **identical** |
| `name:` frontmatter | read |
| `description:` frontmatter | read — and it is the entire routing signal |
| `disable-model-invocation:` frontmatter | read |
| `allowed-tools:` frontmatter | **inert.** Parsed by nothing, anywhere in the package |
| A skill-directory variable for scripts | provided by [`skills-env`](extensions/skills-env.md) |
| Nested bundles addressed through a router skill | works |
| Custom slash commands | map to prompt templates or `/skill:<name>` — same capability, different syntax |

The one that costs people time is `allowed-tools`. A skill carrying it reads as restricted and is
not. [`skills-lint`](extensions/skills-lint.md) warns once per skill, at session start, for exactly
that reason. For a real tool restriction, use a [sub-agent](extending/subagents.md).

## Generated matrix

The table below is produced from the skills present in `skills/` on this machine. Regenerate it
after changing any skill's frontmatter:

```bash
node scripts/gen-skills-lint-matrix.mjs          # rewrites the block below
node scripts/gen-skills-lint-matrix.mjs --check  # exits non-zero if it is stale
```

A clean clone ships **no skills**, so the block is empty until you
[add your own](extending/skills.md).

<!-- GENERATED:skills-lint:start -->
<!-- GENERATED:skills-lint:end -->

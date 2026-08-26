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

A clean clone loads **no skills**, so the block is empty until you
[add your own](extending/skills.md). The one worked example this repository ships lives outside every
search path and is deliberately not in the matrix.

<!-- GENERATED:skills-lint:start -->
<!-- GENERATED:skills-lint:end -->

## Skills that are deliberately absent

Some skills exist in the private configuration this repository is ported from and are never ported
here. Two reasons account for all of them: a tree of third-party material with no licence file, which
must not be redistributed at all; and workflows built around a specific employer, tax year or
household, which would be noise to everyone else and identifying for one person.

Their names are not on this page, and not anywhere else in the repository either. A list of things
too sensitive to publish, published, is the leak it was meant to prevent — so the names are held as
salted digests in `config/do-not-publish.digests.txt` and enforced by
[`PC-25`](operations/cli.md#binpi-check), which fails the build if one of them turns up as a directory,
as a file name, in git history, or in the text of a tracked file. It fails closed: a missing or
unparsable digest file is a finding, never a quiet pass.

Two limits are worth stating plainly. The salt is a constant in the rule, not a secret — it cannot
be one, since the check has to run in any clone — so it defeats a generic wordlist but not someone
who already guessed a name and wants confirmation. And the content scan skips single-word names,
because one of them is an ordinary English word that appears in this repository's own prose; for
those, only paths and history are checked. Both are deliberate. The rule's job is that reading this
repository does not *tell* you the names.

Regenerate the digest file from a list supplied on standard input, never from anything on disk here:

```bash
printf '%s\n' name-one name-two | node scripts/gen-do-not-publish-digests.mjs > config/do-not-publish.digests.txt
```

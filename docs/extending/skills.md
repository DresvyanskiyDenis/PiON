# Writing a skill

A skill is a directory containing a `SKILL.md`. The model reads its `description` and decides
whether to invoke it; you can also invoke one explicitly as `/skill:<name>`.

!!! info "This repository ships **zero** skills, and always will"
    Not "none yet". Every skill in the private tree this repository came from was one person's
    setup — their vault, their employer's tooling, their habits — and shipping any of it would have
    been shipping someone else's opinions as defaults.

    What ships is the **machinery**: discovery across extra roots, precedence, the
    `PI_SKILL_DIR_<NAME>` environment shim, the portability lint, and the extra-roots handler. So
    **this page is the only route by which you get any skill at all.** It is a headline feature, not
    an appendix.

---

## The five-minute version

A skill is two things: a directory and a Markdown file with three lines of front matter.

```text
~/pi-config/skills/
└── release-notes/
    └── SKILL.md
```

```bash
mkdir -p ~/pi-config/skills/release-notes
cat > ~/pi-config/skills/release-notes/SKILL.md <<'EOF'
---
name: release-notes
description: Use when asked to write release notes from a git range. Groups commits by type, drops noise, writes Markdown. Not for PR descriptions.
---

# Release notes

Read the commit range the user names — ask for it if they did not.

1. `git log --oneline <range>`
2. Group by conventional-commit type: `feat` → Added, `fix` → Fixed, `refactor`/`perf` → Changed.
3. Drop `chore:` and `ci:` unless the commit body says behaviour changed.
4. Write the result to `RELEASE_NOTES.md`. Do not print the whole file into the transcript.

Every entry names the user-visible effect, not the implementation. "Retries no longer double-charge
quota" beats "refactored the retry loop".
EOF
```

Restart `pi`. Two ways to confirm it landed:

```text
/skill:release-notes     # the command exists → PI discovered it
/doctor                  # D-02 reports skills named in your instructions vs skills found
```

`skills/` is git-ignored, so nothing you put there can be committed by accident. That makes it the
right place for anything with a client name, an internal URL or a personal workflow in it — and it
is why the installer offers to create it for you at the tools step, empty, rather than leaving you
to invent a location. The installer also links it to `~/.pi/agent/skills`, so the path you write
into and the path `settings.json` searches are one directory.

---

## A complete worked example

The five-minute version is a prompt in a directory. This one ships a script alongside it, which is
where the environment shim earns its place.

```text
~/pi-config/skills/
└── coverage-report/
    ├── SKILL.md
    └── scripts/
        └── summarise.py
```

```yaml
---
name: coverage-report
description: "Use when asked how test coverage changed, or to summarise a coverage.xml. Reports per-package deltas against the previous run. Not for writing tests."
---
```

````markdown
# Coverage report

The helper script lives next to this file. Its directory is exported for you as
`$PI_SKILL_DIR_COVERAGE_REPORT` — do not guess the path, and do not hardcode a home directory.

```bash
uv run "$PI_SKILL_DIR_COVERAGE_REPORT/scripts/summarise.py" coverage.xml
```

Report the three packages with the largest drop, then the total. If the total moved less than
0.5 %, say "unchanged" rather than quoting a number that is noise.
````

Two rules for skills that ship code:

- **Name the directory through the environment variable, never by path.** PI has no
  `${SKILL_DIR}`; [`skills-env`](../extensions/skills-env.md) supplies one on every
  `resources_discover`. The name is derived from the skill name — `coverage-report` becomes
  `PI_SKILL_DIR_COVERAGE_REPORT` (uppercased, hyphens to underscores). `PI_SKILLS_ROOT` also holds
  the directory that contains the most discovered skills, for a skill that needs its siblings. A
  skill contributed by a `resources_discover` handler rather than `config/settings.json` — see the
  precedence table below — needs a second pass to get its variable at all; `skills-env` covers that
  case too, on `agent_start` (see [`skills-env`](../extensions/skills-env.md)).
- **Keep the script small and boring.** A skill that shells out to four hundred lines of Python is a
  program with a Markdown wrapper; give it a repository and let the skill call its CLI.

!!! note "The exported directory is the *real* path, symlinks resolved"
    `~/.pi/agent/skills` is an install symlink. Left unresolved, every exported directory would
    contain the literal `.pi/agent/`, and the guard's `SEC-PI-STATE` rule matches any path built
    from that — which, before the rule became audit-only on 2026-08-15, refused the read outright
    and meant the skill simply never worked. It now records instead, so the same shape would fill
    the audit log with a finding about ordinary skill files. `skills-env` resolves to the physical
    path before exporting, which is why you can ignore all of this.

---

## Front matter: exactly three fields are read

Verified against the pinned PI 0.84.0 package by reading its front-matter parser.

| Field | Effect |
|---|---|
| `name` | the invocation name. Falls back to the parent directory name if absent |
| `description` | what the model reads to decide whether to invoke it. **This is the entire routing signal** |
| `disable-model-invocation` | `true` makes it `/skill:<name>`-only — the model will not reach for it on its own |

Anything else in the front matter is ignored. Silently.

!!! warning "`allowed-tools` does nothing here"
    It is the Claude Code convention and it arrives with every skill you copy across. PI reads it
    **nowhere** — `grep -rl "allowed-tools\|allowedTools"` across every shipped `dist/` returns no
    matches. A skill carrying it looks restricted and is not.

    [`skills-lint`](../extensions/skills-lint.md) warns once per skill so the fact is loud instead of
    assumed. It cannot enforce, because there is nothing to enforce against.

    If you need a real tool restriction, write a [sub-agent](subagents.md) — its `tools:` list *is*
    honoured.

### Write the `description` for a router, not for a human

It is the only thing the model sees when choosing. State the trigger *and* the boundary:

```yaml
# weak — the model has to guess when this applies
description: Release notes helper.

# strong
description: Use when asked to write release notes from a git range. Not for changelogs of
  unreleased work, and not for PR descriptions.
```

### Quote a description containing a colon

An unquoted `Default output dir: ./out` makes PI's own `parseFrontmatter` throw a `YAMLParseError`
and the skill fails to load — with no error at the place you are looking. This has actually
happened; it is not a hypothetical.

```yaml
description: "Default output dir: ./out"    # quoted — fine
```

---

## Where skills are found, and in what order

Precedence matters more than it should, because **`loadSkills` keeps the first loader of each name
and reports every later one as a collision**. If the name already exists higher up, yours never
runs — and nothing about the session looks broken.

| Rank | Root | Notes |
|---|---|---|
| 0 | `<cwd>/.pi/skills` | project-local, highest — and only after the project is trusted |
| 1 | `<cwd>/.agents/skills` | project-local, conventional |
| 2 | a root named in `config/settings.json` → `skills` | **this is where yours should be** |
| 3 | `~/.agents/skills` | the machine-wide conventional tree |
| 4 | skills shipped inside an installed package | lowest of the resolved set |
| — | roots contributed by a `resources_discover` handler | **appended after all of the above** |

The shipped array is:

```json
"skills": [
  "~/.pi/agent/skills"
]
```

One entry, and the installer points it at the clone's git-ignored `skills/`. Add your own root by
adding a line there — see
[`config/settings.json`](../configuration/settings.md#resource-paths). A root that does not exist is
skipped without complaint, which is why a fresh clone with no `skills/` starts cleanly.

!!! danger "Name your root in `config/settings.json`, not only from an extension"
    A root contributed *only* from a `resources_discover` handler sits behind **every** rank above,
    including `~/.agents/skills`. Measured, not theorised: two skills contributed that way were
    silently shadowed by stale same-named copies in `~/.agents/skills` and never ran once.

    This is also why the three-way `skills/` + `skills-work/` + `skills-private/` split was
    collapsed into the one root above: two of its three directories were contributed from a handler
    and never named in `settings.json`, so they sat behind `~/.agents/skills` the whole time.

!!! info "`skill-mask` masks nothing, despite the name"
    `extendResources` performs a **union** with what the settings-driven scan already found. No path
    in that chain removes a root, so a `resources_discover` handler can only ever *add* skills, never
    subtract them. There is no default-deny skill mask in this harness and one cannot be built at
    that seam. The module is now a registered no-op — it keeps its id only because
    `extensions/index.ts`, the manifest and `/doctor`'s load registry all expect to find it. See
    [Known limitations](../limitations.md).

    The control you *do* have over what a skill may do is the model's own judgement plus the
    [guard](../extensions/guard.md), which sees every tool call a skill causes.

---

## `enableSkillCommands`

```json
"enableSkillCommands": true
```

Ships **on**. Every discovered skill also becomes a slash command, `/skill:<name>`. Two reasons to
keep it that way:

- It is how you test a skill deterministically. Invoking it by name removes "did the router pick it?"
  from the question.
- It is how a skill with `disable-model-invocation: true` is reachable at all.

Set it to `false` and skills still load and can still be invoked by the model; you only lose the
commands. The cost of `true` is autocomplete noise once you have thirty skills.

---

## Skills copied from another agent

Most port directly.

| Elsewhere | Here |
|---|---|
| `SKILL.md` with `name` / `description` | identical |
| `allowed-tools:` | **inert** — see above |
| `${CLAUDE_SKILL_DIR}` | `$PI_SKILL_DIR_<NAME>`, from [`skills-env`](../extensions/skills-env.md) |
| A custom slash command | a prompt template, or `/skill:<name>` |
| Nested skill bundles addressed by path | work, but only through a router skill that dispatches to them |

`node scripts/gen-skills-lint-matrix.mjs` regenerates the portability table in
[Skill portability](../skills-portability.md) from whatever is actually on your disk, so it describes
your tree rather than someone else's.

---

## Verifying, and what each check tells you

```bash
pi                      # restart — skills resolve at session start, not per turn
/skill:<name>           # the command exists → discovery worked
/doctor                 # D-02 → skills your instructions name vs skills PI found
```

`D-02` compares the skill names your instruction text mentions against what PI actually loaded. A
skill shadowed by a collision, or one whose front matter failed to parse, surfaces here — rather than
as a mysteriously ignored request three days later.

If a skill does not appear at all, in order: is its root in `settings.json` → `skills`; is the
front-matter `description` colon-quoted; does a higher-ranked root already own that name.

## Related

- [`skills-env`](../extensions/skills-env.md) · [`skill-mask`](../extensions/skill-mask.md) ·
  [`skills-lint`](../extensions/skills-lint.md)
- [`config/settings.json`](../configuration/settings.md#resource-paths) — the `skills` array
- [Skill portability](../skills-portability.md) · [Known limitations](../limitations.md)

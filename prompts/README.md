# `prompts/` — PI prompt templates

PI reads this directory as `~/.pi/agent/prompts` (`config/settings.json` → `prompts`, symlinked by
`scripts/install.sh` step 6). Each `*.md` file here becomes a slash command whose body is the prompt,
with `{{placeholder}}` substitution for arguments.

It is empty on purpose, and that is a decision rather than an omission. Anything worth invoking by
name is better written as a skill: `config/settings.json` sets `enableSkillCommands: true`, so every
skill is already reachable as `/skill:<name> <args>` without a prompt template existing at all. A
template here earns its place only when you want a *fixed* prompt body with `{{placeholder}}` slots
and no model-facing instructions around it — a form to fill in, not a capability to invoke.

If you are coming from another harness and porting its slash commands, expect most of them to land
as skills in `skills/` instead — the git-ignored directory the installer offers to create
for you. See [Skills](https://dresvyanskiydenis.github.io/PiON/extending/skills/).

The directory itself still has to exist: `scripts/install.sh` treats `prompts` as a **required**
symlink source and aborts with `PI-INSTALL-E18` if it is missing, and PI would otherwise warn about
a dangling `prompts` path on every start.

Add a template by dropping a `*.md` file in. There is no registration step.

# Extending

This repository ships **mechanisms, not content**. There are no skills in it, no MCP servers, no
personal instructions — those were the original operator's and they were removed deliberately. What
remains is the loading, ordering, linting and gating machinery around them, which is the part that
took the work.

So the interesting question is not "what does it come with", it is **"how do I put my own things
in"**. Five answers:

| I want to add… | Go to | Effort |
|---|---|---|
| a reusable procedure the model can invoke by name | [Skills](skills.md) | a directory and a `SKILL.md` |
| a tool server — a database, a browser, an internal API | [MCP servers](mcp-servers.md) | a JSON entry plus one approval |
| a specialist that runs in its own context window | [Sub-agents](subagents.md) | one Markdown file with frontmatter |
| a model endpoint | [Providers](providers.md) | a config fragment, or re-run the installer |
| new behaviour in the agent loop itself | [below](#writing-a-new-extension-module) | TypeScript, and a place in the load order |

Everything on that list except the last is **config**. Reach for the last one only when nothing above
it fits.

---

## The rule that applies to all five

!!! warning "Anything you add is loaded with your credentials in its environment"
    A skill's script, an MCP server, a sub-agent's `bash` calls and a provider's endpoint all run
    inside your session, with whatever your shell exported. The
    [safety model](../concepts/safety-model.md) narrows that where it can — the guard gates tool
    calls, `mcp-stdio-guard` strips the environment of project stdio servers — but nothing here turns
    hostile content into safe content.

    Read what you add. This is the same advice as for a shell alias, and it is ignored for the same
    reasons.

---

## Where your additions live

Two directories exist **specifically** for content you do not want to publish, and both are in
`.gitignore`:

```text
<repo>/skills/             your skills
<repo>/agents-private/     your sub-agents
```

They are discovered at runtime and can never be part of a commit. If you fork this repository and
push it, they stay behind.

That is a deliberate split: the mechanism is public and reviewable, the content is yours. It is also
why a clone with neither directory present starts perfectly happily — every root is guarded by an
existence check, so a missing directory is a silent no-op rather than an error.

---

## Writing a new extension module

Only when the answer really is code. Before you start, check whether a
[hook rule](../configuration/tools.md#hooksyaml) or a
[guard rule](../configuration/guard.md) already covers it — a declarative rule you can read in one
line beats a module you have to maintain.

### The contract

Every module in `extensions/` exports exactly two things:

```ts
export const id = "my-module";
export function register(pi: ExtensionAPI): void { /* … */ }
```

**Not a default export.** PI's own loader would treat a default-exporting file as a standalone
extension; these are not standalone, they are composed.

### Registering it

Add the import and one entry to `ORDER` in `extensions/index.ts`. That file is the composition root
and the **only** file named in `config/settings.json`'s `extensions` array.

!!! danger "Do not symlink the `extensions/` directory into `~/.pi/agent/extensions`"
    PI discovers `extensions/*.ts` and `extensions/<dir>/index.ts` and loads each as a separate
    extension, in `readdir` order. Every module here would then fail, because none has a default
    export — and the load order that the safety model depends on would be alphabetical.

### Where in `ORDER`

The order is not cosmetic. PI iterates `tool_call` handlers across extensions **in load order** and
returns on the first `{block: true}`. The invariants, restated:

- `guard` is **first**. A call that is going to be blocked must not be rewritten by `bash` or `hooks`
  before the guard sees it.
- `trust` is **second**, so its `session_start` deadman reads a registry in which `guard`'s entry is
  already written.
- `hooks` follows the guard, because it may only *add* denial.
- `path-defaults`, `path-rules` and `skills-env` publish configuration that later modules read; `skill-mask` keeps
  its slot beside them although it registers nothing.
- `dispatch` precedes `teammates`, `worktree` and `jobs` — those register into registries it owns.
- `doctor` is **last**, so its session-start pass observes everything above it.

If your module blocks tool calls, it goes after `guard`. If it publishes configuration, it goes
before its consumers. If it only observes, put it near the end.

### Fail closed or fail open — decide explicitly

Use `guardedHandler` and state the posture. The question to answer is
[*whose bug is it?*](../concepts/safety-model.md#2-fail-closed-fail-open--and-which-is-which)

- A bug in code **you** wrote that gates everything → `onInternalError: "open"`, like the guard. A
  crash must not blanket-block the user's machine.
- A rule the **user** wrote that silently stops applying → `onInternalError: "closed"`, like hooks.
  Silence is the failure.

### Then run the checks

```bash
node bin/pi-check          # PC-* rules, including the declared-module manifest
npm test                   # if you added behaviour, add the test that proves it
```

`bin/pi-check` will notice a module that is in `ORDER` but not in the manifest, and vice versa. That
is the point: a guardrail module that quietly stopped loading is the failure mode the whole
[deadman](../concepts/safety-model.md#3-the-deadman) exists for.

---

## What not to extend

| Don't | Because |
|---|---|
| Add a provider failover module | It was specified, scheduled and **cancelled**. See [`onProviderError`](../configuration/routing.md#onprovidererror) |
| Add a sixth field to `hooks.yaml` | The answer to a sixth field is a sub-agent or a guard rule. A hook language is a programming language nobody wanted to write |
| Add a skill-*removal* mechanism | `resources_discover` is additive-only in PI. It is not a policy choice here, it is [not possible](../extensions/skill-mask.md) |
| Edit the vendored adapter for a feature | Vendoring is for security patches that cannot live above the boundary. See [Third-party](../reference/third-party.md) |

## Related

- [Architecture](../concepts/architecture.md) — why the composition root exists
- [Extensions reference](../extensions/index.md) — all 36 modules
- [Configuration reference](../configuration/index.md) — the knobs before the code

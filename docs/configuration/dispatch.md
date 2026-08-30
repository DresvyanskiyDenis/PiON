# `config/dispatch.json` and `agents/` — sub-agents

**Tracked in git. Edit in place.** Read by `extensions/dispatch/config.ts`. Not asked about during
installation — this is a tune-later file.

`dispatch.json` holds the *defaults and limits* for sub-agent dispatch. The agents themselves are
Markdown files with YAML frontmatter, one per agent, in `agents/`.

---

## Shipped file

```json
{
  "maxDepth": 2,
  "defaultTier": "strong",
  "defaultEgress": "internal",
  "defaultTimeoutMs": 1800000,
  "concurrencyDefault": 3,
  "packageDefaultConcurrency": 4,
  "registryDirs": ["<repo>/agents", "<repo>/agents-private",
                   "<agentDir>/agents", "<cwd>/.pi/agents"],
  "dispatchTools": ["subagent", "subagent_run", "dispatch_agent", "task", "agent"],
  "genericAgents": ["general-purpose", "general", "generalist"],
  "specialistMatchMinScore": 2,
  "subagentContract": {
    "doc": "config/subagent-tool-description.md",
    "requiredSections": ["Before you write", "Whether to dispatch at all"],
    "minSectionLines": 6,
    "worthiness": { "leadHandlesChangedLinesUnder": 50,
                    "leadHandlesFilesTouchedAtMost": 3 }
  },
  "onThinkingClamp": "warn",
  "failureOutputMaxLines": 20,
  "failureOutputMaxChars": 2000
}
```

---

## `maxDepth`

Ships **`2`**. How deep sub-agents may nest: the main session dispatches a child (depth 1), that
child may dispatch a grandchild (depth 2), and a great-grandchild is refused.

**Who would change it:** raise it to 3 if you genuinely run a coordinator that spawns coordinators.
Lower it to 1 if you want a flat fan-out and nothing else.

**What breaks if you get it wrong:** the failure of an unbounded depth is not a crash, it is cost.
Each level multiplies token spend by the fan-out, and a model that has decided delegation is the
answer will keep deciding that. A depth limit is a budget, and `2` is deep enough to be useful and
shallow enough to notice.

---

## `defaultTier` and `defaultEgress`

| Key | Ships | Meaning |
|---|---|---|
| `defaultTier` | `"strong"` | The tier an agent gets when its frontmatter declares no `model:` |
| `defaultEgress` | `"internal"` | The egress class reported for a session that declares none |

`defaultTier` ships **`strong`**, not the cheaper tier. A subagent is delegated work the main loop
decided not to do itself, and it runs without the main loop watching — the failure mode of the cheap
default is a plausible-looking wrong answer that nobody reads closely, which costs more than the
tokens saved. So the strong tier is what you get by not choosing, and `light` is what you get by
choosing it: name it on the call, for work whose correctness is obvious on inspection.

That argument has a premise, and the premise is about **your** `routing.json`, not about the words
`strong` and `light`. It holds while `light` is bound to a weaker model — which is what ships here,
Sonnet against Opus. Rebind the tiers and it can invert. Bind `light` to the same model at a lower
effort and the gap is effort, not judgement. Bind it to a cheap model whose gateway has just begun
serving a reasoning level it used to refuse, and `light` becomes the *hardest* thinking you can buy
on that endpoint at a fraction of the price — at which point defaulting to `strong` is paying more
for less. [`thinkingLevel`](routing.md#how-thinkinglevel-reaches-the-child) is where that ceiling is
declared, and [`models.json`](models.md#models) is where a level the endpoint used to refuse becomes
available again.

Which is the useful part: **`defaultTier` is the one line that follows a change in what your tiers
mean.** Not the agent files — an agent file naming a tier is naming a role, and the roles do not
change when the bindings do. Re-read this key whenever a tier's model or `thinkingLevel` changes,
and decide the default from what the tiers point at *now* rather than from which word sounds
stronger.

`defaultEgress` used to be load-bearing: it was the class an undeclared agent was *checked* against,
and setting it to `confidential` would have made every such agent fail against a public provider.
Since the containment rule was withdrawn on 2026-08-13 it decides nothing — it only picks the word
printed on the startup line and in the model menu when neither `PI_ROUTING_EGRESS` nor the session's
own active provider says otherwise. `internal` stays the ship value because "we did not ask" reads
more honestly as the middle class than as either extreme. See
[ADR 0004](../adr/0004-egress-classes-are-declarative.md).

`defaultTier` has a second job: it is the **floor for a `workflowScript` fan-out**. A workflow's
children are built inside the package, past the point where a tier word is turned into a
`provider/model`, so a child that names no model would otherwise fall through to PI's own substring
matcher — which happily resolves a word like `light` onto some provider your `models.json` never
declared, and then fails with a credentials error that is really a silent substitution. When a
`workflowScript` call names no `model`, the resolved `defaultTier` is pinned onto the call, the
package spreads it *underneath* each child's own parameters, and the outcome is: children that name
no model inherit it, children that name one are untouched. The pin is announced as a floor when it
happens, so it is never a routing decision made behind your back — set `model` on the call, or per
child, to choose something else.

**What breaks:** `defaultTier` naming a tier that is unbound in `routing.json` means every
undeclared agent fails at load, and every `workflowScript` that names no model is refused rather
than floored. Since `confidential` ships unbound, do not default to it.

---

## `defaultTimeoutMs`

Ships `1800000` — thirty minutes. The wall-clock budget for one sub-agent run.

Raise it for genuinely long jobs; a research sweep across many sources can exceed it. Lower it if
you would rather find out early that an agent is stuck in a loop. A timed-out sub-agent returns a
failure to its parent, which the parent can see and react to — it does not silently return partial
work.

---

## `concurrencyDefault` and `packageDefaultConcurrency`

| Key | Ships | Meaning |
|---|---|---|
| `concurrencyDefault` | `3` | Parallel sub-agents when the resolved provider has no row in `routing.json`'s `concurrency` |
| `packageDefaultConcurrency` | `4` | The underlying package's own default |

Per-provider caps in [`routing.json`](routing.md#concurrency) win over both. That is where a cap of
`1` would live for an endpoint that can only serve one request at a time — the one kind of entry that
encodes a physical fact rather than a preference.

---

## `registryDirs`

Where agent definitions are discovered, in order:

```json
["<repo>/agents", "<repo>/agents-private", "<agentDir>/agents", "<cwd>/.pi/agents"]
```

| Placeholder | Resolves to |
|---|---|
| `<repo>` | your clone |
| `<agentDir>` | `$PI_CODING_AGENT_DIR`, i.e. `~/.pi/agent` |
| `<cwd>` | the directory `pi` was started in |

`<repo>/agents-private` is gitignored and will not exist on a fresh clone; a missing directory is
skipped, not an error. It is the intended home for agents you do not want to publish.

**Missing is silent; broken is not.** Only "no such directory" counts as a supported absence. A
directory that exists but cannot be read (`EACCES`), or a *file* configured where a directory
belongs, is named as a problem at session start and discovery continues with the other directories.
That distinction is the point: an overlay you believed was installed used to yield zero agents and
zero warnings — indistinguishable from having none — and the first sign of trouble was a dispatch
refused by name much later.

`<cwd>/.pi/agents` makes an agent definition part of a project. It is loaded on the same terms as
everything else in `<cwd>/.pi/` — **only after the project is trusted**.

---

## `dispatchTools`

```json
["subagent", "subagent_run", "dispatch_agent", "task", "agent"]
```

The tool names that count as dispatch. The registered tool is `subagent`; the rest are aliases
other packages and older prose use. The list is wide on purpose — a routing rule that misses
because the tool was called `task` is a rule that does not exist.

The same list appears in [`config/guard.json`](guard.md#dispatchtools) for the `RTE-*` veto. Add a
new dispatch tool to both.

---

## `genericAgents` and `specialistMatchMinScore`

```json
"genericAgents": ["general-purpose", "general", "generalist"],
"specialistMatchMinScore": 2
```

Together these implement one rule: **do not dispatch a generic agent when a specialist matches.**
A request is scored against each specialist's `description`; if the best specialist scores at least
`specialistMatchMinScore` and the model asked for a generic agent by one of the `genericAgents`
names, the specialist is suggested instead.

`genericAgents` is a list of **names**, not a list of definitions — it says which names the veto
watches, and nothing more. `agents/general-purpose.md` is the shipped definition behind the first of
them; the other two are aliases with no file, so dispatching `general` or `generalist` resolves to
nothing unless you add one. If you rename the catch-all, rename it in both places.

Read the scope of this honestly, because the wording invites the wrong reading: the veto fires
**only** on a real match. When no specialist scores `specialistMatchMinScore`, a generic dispatch
goes through unchallenged and with no justification at all. Preferring a specialist is therefore a
discipline the operating rules ask for, not something the harness can enforce — by construction,
when nothing matches there is nothing to match against. When the veto *does* fire it is
[overridable](guard.md) the same way every other overridable gate is: re-issue the identical call
with a `# PI-JUSTIFY(DV-SPECIALIST): <reason>` line prepended to the prompt. There is no
justification parameter.

Raise `specialistMatchMinScore` if you get false matches — the specialist is being suggested for
work it does not do. Lower it to `1` if you have few, sharply-scoped agents and want the nudge to
fire more readily.

**What breaks:** nothing hard. This is a suggestion layer. Setting the score very low turns it into
noise the model learns to ignore, which is the real cost. Setting it very high, or emptying
`genericAgents`, switches the nudge off entirely.

---

## `subagentContract` — the obligations a dispatched child carries { #subagentcontract }

```json
"subagentContract": {
  "doc": "config/subagent-tool-description.md",
  "requiredSections": ["Before you write", "Whether to dispatch at all"],
  "minSectionLines": 6,
  "worthiness": { "leadHandlesChangedLinesUnder": 50, "leadHandlesFilesTouchedAtMost": 3 }
}
```

Everything a dispatched child must do before it writes, and the lead's own test for whether a
dispatch is worth its cost, is prose in
`config/subagent-tool-description.md` — because that file is what the
model actually reads. `pi-subagents` loads it at tool registration and leaves unknown
`{{placeholders}}` alone, so there is no templating and no way to inject a number from here. The two
worthiness numbers therefore exist in two files, and **this block is the authority**.

`bin/rules/pc-29-subagent-contract-obligations.mjs` is what keeps the copy honest. It fails when the
declared document is missing, when a declared section has no heading, when a section is hollowed out
below `minSectionLines` non-blank body lines, or when any `<n> ... lines` / `<n> ... files` claim in
the document disagrees with a declared bound — including the case where the document quietly drops
it. That is the point of holding this as data: an obligation the model has to *remember* per call is
a habit, and a habit is forgotten on the call where it mattered; a section that cannot be deleted or
contradicted without a failing check is state.

| Key | What it declares |
|---|---|
| `doc` | the contract document, repo-relative. Absent from the tree → one finding against `dispatch.json` |
| `requiredSections` | **headings**, never wordings — matched case-insensitively at any level, backticks and trailing punctuation ignored |
| `minSectionLines` | non-blank body lines each declared section must carry, so a heading left standing over nothing fails exactly like a deleted one |
| `worthiness.leadHandlesChangedLinesUnder` | added-plus-deleted lines below which the lead makes the change itself |
| `worthiness.leadHandlesFilesTouchedAtMost` | files opened for writing, the second half of the same bound — **both** have to hold |

Below both bounds the lead does the work; at or above either one a dispatch is permitted. Research,
parallel exploration and independent work streams are dispatch-worthy at any size, and the
orchestrator's own context past half is the operational override. Those shapes are judgement and
live only in the prose; only the two numbers are data, because only a number can go stale silently.

**Drop the whole block and the rule goes quiet** — no `subagentContract`, nothing declared, no
findings, the same posture PC-28 takes toward a missing `routing.json`. That keeps a tree which has
not adopted the contract silent rather than noisy; it also means deleting the block is the one way
to switch the ratchet off, and it is a visible act in a tracked file.

**What breaks if you get it wrong:** raise a worthiness number without editing the document and
`pi-check` fails on the next run, naming both values — which is the intended failure. Rename a
section in the document without renaming it here and the rule reports the heading as missing.
Neither is a silent drift, and that is the whole design.

---

## `onThinkingClamp` — when the effort you asked for is not served { #onthinkingclamp }

```json
"onThinkingClamp": "warn"
```

A reasoning effort travels **inside the model string**: `provider/id:high`, `provider/id:max`. That
suffix is a *request*. Before the wire, PI clamps it against what the model's own registry entry says
it serves (`thinkingLevelMap` in [`models.json`](models.md)), and a model that declares no map at all
is read as serving `off`/`minimal`/`low`/`medium`/`high` and **not** `xhigh` or `max`.

The clamp is not ours and cannot be turned off. What this key controls is whether you are told.

| Value | Behaviour |
|---|---|
| **`"warn"`** (ships) | The dispatch runs at the effective level and says so, naming the requested level, the effective one, everything the model does serve, and which *other* configured providers serve what you asked for — with each candidate's egress class, since moving between classes is your decision and not a routing optimisation |
| `"abort"` | The dispatch is refused by name instead, with the same information |

Neither value ever reroutes. A clamp is never resolved by silently sending the work somewhere else.

`warn` ships because the clamp happens inside PI either way — refusing would not buy you a
harder-thinking run, only no run — and because the failure this key came out of was never the clamp
itself, it was that nobody was **told**. Set `abort` for a session where a quietly downgraded effort
is worse than a missing answer: a benchmark, or a job commissioned at a specific effort.

The model string is also **rewritten to the effective level** before the dispatcher sees it. That is
disclosure, not substitution: the bytes on the wire are identical either way, and the rewrite is what
makes the run's own metadata agree with what was actually sent. The requested level is not lost —
the audit record carries both.

`/agents` lists every tier whose declared effort its resolved model will not serve, as
`reasoning effort CLAMPED: …`, so a whole routing table can be checked without dispatching anything.

!!! warning "A model whose vocabulary is unknown produces no disclosure at all"
    If the registry does not know the model, nothing is reported and nothing is rewritten. "Cannot
    say" must not render as "no clamp will happen" — check `thinkingLevelMap` for a model you added
    by hand.

---

## `failureOutputMaxLines` and `failureOutputMaxChars` — how much of a dead child you pay for { #failureoutput }

```json
"failureOutputMaxLines": 20,
"failureOutputMaxChars": 2000
```

When a dispatched child dies, `pi-subagents` makes its **entire captured output** the run's error
text, and a headless child announces on stderr — so the error text you get back is every startup
notice, every extension announcement and every debug line the child emitted, with the actual cause
somewhere inside it. That text becomes the tool result's `content`, which is the one field of a
result that is serialised to the provider. It is not a one-off cost: the result stays in the
transcript, so the parent re-sends the whole dead child's console on **every later turn of the
session**.

These two keys bound what survives into that context. Ships **20 lines / 2000 characters**,
whichever binds first, always cutting on a line boundary. What is left says how many lines went and
names the file that still holds all of them:

```
--- the run's output, first 20 of 60 line(s), startup notices included ---
…
... (40 more line(s) elided — full output at /runs/<id>/output-0.log)
```

Three things are **never** bounded, and they are the reason this is a bound and not a filter:

| Never bounded | Why |
|---|---|
| The classified provider-failure block | It is the part that says what went wrong. It is already a fixed field set, and shortening a diagnosis to save tokens is the silent substitution this repo refuses everywhere else |
| Anything at all, when the result named no file | With nowhere to read the rest, a cut cannot be undone — that is suppression, not a reference. The tail is forwarded whole, whatever these keys say |
| A successful run's output | This path only runs on a failure that carried a classified block |

The file named in the elision is chosen by **what it actually contains**, most exact first: the
run's metadata artifact, whose `error` field is this very text; then the async run's own
`output-0.log`, which is where the startup notices came from (with several children the run
directory is named instead, because the failing step's index cannot be derived from the result and a
confidently wrong path is worse than a directory); then the child's transcript, labelled as a
transcript because it does *not* carry the stderr tail.

**Who would change it:** raise both if you debug failing children by reading the parent's context
rather than the run directory. Set **either to `0`** to switch that one bound off — a line count
alone does not bound bytes, since one JSON blob is one line of any size, and a character count alone
would cut mid-line. Set **both to `0`** to forward the whole tail again, which is what this repo did
before the bound existed.

**What breaks if you get it wrong:** too small and the useful first lines of a crash go with the
noise — the cause is still in the classified block, but the context around it is a file away. Too
large, or `0`, and one dead subagent quietly raises the price of every remaining turn in the
session.

---

## Agent definitions

One Markdown file per agent, frontmatter plus the system prompt as the body:

```markdown
---
name: code-reviewer
description: Use for thorough code review of a PR or committed branch — correctness,
  security, performance, maintainability, test adequacy. Read-only.
tools:
  - read
  - grep
  - find
  - bash
model: strong          # a TIER name — or provider/id for a deliberate pin
egress: internal       # a reported label; nothing is refused on account of it
returns: object
---

You are a code reviewer. …
```

| Field | Notes |
|---|---|
| `name` | must match the filename |
| `description` | **the field that decides whether the agent is ever used.** It is what the orchestrating model reads and what specialist matching scores against. Write it as *when to use this*, not *what this is* |
| `tools` | the tool allowlist for the child. Narrower is better; a read-only reviewer that cannot write cannot "helpfully" fix things |
| `model` | a tier name, or a provider-qualified id to pin deliberately. **A bare id is rejected everywhere** — `bin/pi-check` `PC-04` and `PC-08` |
| `egress` | a label, reported wherever the agent is shown. It was a ceiling checked at load against the tier's provider class until 2026-08-13; that check is withdrawn ([ADR 0004](../adr/0004-egress-classes-are-declarative.md)) |
| `returns` | `object` for a structured report, matching a schema in `config/schemas/` where one exists |
| `isolation` | `worktree` to run the agent in its own git worktree — see [worktree](../extensions/worktree.md) |

Thirteen agents ship: `ai-engineer`, `app-builder`, `architect-reviewer`, `code-reviewer`,
`data-engineer`, `debugger`, `docs-architect`, `frontend-developer`, `general-purpose`,
`local-llm-engineer`, `prompt-engineer`, `researcher`, `security-reviewer`. Twelve are specialists;
`general-purpose` is the catch-all named in [`genericAgents`](#genericagents-and-specialistmatchminscore).
They are ordinary Markdown — read one before writing your own.

!!! tip "The disambiguation rule for `model`"
    **A value containing `/` is a provider-qualified id. Anything else is a tier name.** A bare id
    such as `sonnet` or `gpt-5.4` is forbidden everywhere, because providers expose overlapping ids
    and an unqualified one resolves by accident.

See [Adding a sub-agent](../extending/subagents.md) for the walkthrough.

---

## Verifying a change

```bash
bin/pi-check --all     # PC-04 agent frontmatter, PC-08 bare ids
```

In a session, `/agents` prints the resolved agent list *and* the sub-agent model-selection block
the model sees — verbatim the same text. `/doctor`'s `D-03` reports any agent name mentioned in
instruction text that has no file.

## Related

- [Adding a sub-agent](../extending/subagents.md)
- [`routing.json`](routing.md) — the tiers the frontmatter names
- [`settings.json`](settings.md#subagentswatchdog) — the watchdog that reviews a child's `agent_end`,
  which lives in PI's settings file rather than in this one
- [dispatch](../extensions/dispatch.md), [teammates](../extensions/teammates.md),
  [jobs](../extensions/jobs.md)

Delegate work to a subagent. One `subagent` call per turn — a second in the same turn is rejected
with "a subagent call is already in progress".

## Roles

These are the roles this configuration installs, from its `agents/` directory. `/agents` is the
live list; any role name that appears in package documentation is one of the package's examples,
not one of these.

- `researcher` — one-shot technical investigation, library comparison, exploring an unfamiliar codebase. Read-only.
- `debugger` — errors, test failures, regressions. Root cause plus the minimal fix and a regression test.
- `code-reviewer` — correctness, security, performance, test adequacy on a PR or committed branch. Read-only.
- `architect-reviewer` — boundaries, decomposition, dependency direction, contract changes. Read-only.
- `security-reviewer` — input validation, auth, secrets, dependency and infra-config audit. Read-only.
- `ai-engineer` — LLM/RAG/agentic features: orchestration, structured output, retrieval, evals.
- `prompt-engineer` — prompts, tool descriptions, eval harnesses, output schemas.
- `data-engineer` — pipelines, SQL, ETL correctness, lineage, experiment interpretation.
- `frontend-developer` — UI implementation and user-visible behaviour.
- `app-builder` — new services, APIs and modules from scratch.
- `docs-architect` — architecture guides, deep-dive references, ADRs, runbooks.
- `local-llm-engineer` — local model serving, quantisation, tool-calling reliability.
- `general-purpose` — the role of last resort, and only when none of the twelve named ones fits.

## Whether to dispatch at all

Settle this before choosing a role, and settle it by measuring rather than by judging. Size the
change you are about to make: changed lines means added plus deleted, files means files opened for
writing.

- **Under 50 changed lines in at most 3 files, do it yourself.** Both bounds have to hold. A child
  costs a cold context, a round trip and a lossy summary; below that size the summary is dearer than
  the edit and less accurate than having made it.
- **At or above either bound a dispatch is permitted.** Size alone never compels one.
- **Three shapes are dispatch-worthy at any size, and only these three:** research, where far more is
  read than written; parallel exploration, where alternatives must not contaminate one another's
  context; and independent work streams, which share no file and impose no ordering on each other.
- **The orchestrator's own context past half** is the one operational override: hand work over to
  keep the thread, whatever the size.

Cannot tell which side of the bounds you are on? Deciding that is the cheap half of the work: open
the files, count, then choose. "It might grow" is not one of the three shapes, and a dispatch issued
to avoid measuring is the expensive way to guess.

The two numbers above are `subagentContract.worthiness` in `config/dispatch.json`, which is their
single authority; `bin/rules/pc-29-subagent-contract-obligations.mjs` fails if this section and that
block ever disagree.

## Before you write

Three obligations. They bind every child and the lead alike, and none of them is discharged by
meaning well: each one has to produce something the caller can check.

1. **Read the structure before the first write.** The module map first — how modules, jobs and
   adapters are laid out, and which naming is already in force. Reading the three files your task
   happens to name is not that: you need to know what exists, not what one author last did.
2. **Name the module you extend.** By path, in your result: `extends <path>`. If the honest answer is
   "none of them", that is obligation 3, not an exemption from this one.
3. **A new top-level module, job or adapter needs the lead's explicit approval.** Ask before writing
   it, and carry one sentence saying why the existing one cannot be parameterised to cover the case.
   No answer is not approval: extend what exists, or return without writing and name what you would
   have created.

**An axis of variation is a parameter, never a file name.** Model, endpoint, prompt variant, stage,
dataset, run size — whatever varies between runs of the same idea belongs in the argument or the
config row that selects it. A file per value looks cheap once and then charges rent twice: every
later change to the shared idea has to be made N times, and every reader has to load N
near-identical files to understand one of them. Copying a file and editing two lines of it is the
tell — those two lines are the parameter.

## Calling it

One child: `{ agent, task }`. Omit `action` for execution.

Independent chunks: **one** call with `workflowScript` and `async: true`, fanning out inside it via
`await runs.all([{key, agent, task}, ...])`. Never issue a second top-level call for the children.
`runs.all` resolves to an **ordered array**, not a key map — read it with indexes, destructuring or
`.map(...)`, never `results.<key>`.

`workflowScript` is an ordinary JavaScript statement body: use an explicit `return`, top-level
`await`, and plain named helper functions. Nested `async` function, arrow and method helpers are
rejected before any child launches.

`action: 'validate'` checks a script without launching children. `action` otherwise is for
management and control only.

## Models

Every child in a `workflowScript` must carry its own fully-qualified `model`, e.g.
`model: "github-copilot/claude-opus-5:high"`, taken from `config/routing.json`. Never a bare tier
word, never omitted: children launched inside a workflow are past the point where a tier resolves,
and an unmatched string is substring-matched across the whole model catalogue into a provider that
may not be configured — which fails as a credentials error rather than as a routing error.

A bare `provider/id` on a `workflowScript` child takes the provider's default effort, not the
tier's `thinkingLevel`. On this path the tier does not resolve — spell out the level.

A plain `{agent, task}` call needs no `model`. It runs on the tier `config/dispatch.json` names as
`defaultTier`.

## Width

Keep concurrent children inside the provider's `concurrency` budget in `config/routing.json` — four
for the provider this configuration ships. That is discipline, not an enforced cap: `runs.all`
fires N independent launches and nothing bounds N. `globalConcurrencyLimit` bounds a different
path, children within one run's parallel batch.

There is one real ceiling and it is cumulative, not concurrent: twenty logical children per run
tree (`maxSubagentSpawnsPerRun` in `config/subagent.json`, deliberately below the package default
of 64), claimed on launch and never refunded. A batch that does not fit is rejected whole, so a
long workflow can exhaust it at width two as easily as at width twenty. Start a new top-level run
rather than widening an exhausted one.

## Boundaries

One writer per working directory unless children run in isolated worktrees.

The external-CLI adapters are refused by the capability ceiling. A child launched through one runs
outside this configuration entirely — no tier routing, no vetoes, no audit trail. Do not route to
them.

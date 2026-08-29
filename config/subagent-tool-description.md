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

Delegate when the work is genuinely wide — a research sweep, a migration across a tree, an audit,
anything where far more is read than written, or anything at all once context is past half. Work
that fits in roughly five files and can be named up front is cheaper done directly: a delegation
costs a round trip, a cold child context and a lossy summary.

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
`model: "github-copilot/claude-opus-5"`, taken from `config/routing.json`. Never a bare tier word,
never omitted: children launched inside a workflow are past the point where a tier resolves, and an
unmatched string is substring-matched across the whole model catalogue into a provider that may not
be configured — which fails as a credentials error rather than as a routing error.

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

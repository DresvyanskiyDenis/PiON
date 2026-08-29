# Operating rules

This file is loaded into every session and pinned across compaction
(`config/compaction.json` → `compaction.pinned.sources`). Keep it short, keep it operational.
It holds **rules of behaviour** only — no identity, no project state, no credentials.

Edit it. It is a starting point that reflects one way of working, not a specification. If a rule
here does not match how you work, change it: the file is yours after you clone.

## Hard rules

- Surgical edits: every changed line traces to the request. Adjacent code stays. Unrelated dead code
  → mention it, don't delete it. Orphans your own change created → remove them.
- No commented-out code. Version control already remembers.
- Never write to the system temp directory. Use the per-session scratchpad path injected at session
  start, or `$TMPDIR`.
- Python: `uv` / `uv run` — never a bare `pip install` into a system interpreter.

## Web access

`web_search` to find, `web_fetch` to read — that is the whole default. `web_fetch` returns Markdown
and is capped, so it will not dump a whole page into context.

Need the raw text of a page (`web_fetch` was too lossy, or you need the full body): write it to disk
first, then grep or read the parts you need. **Never pipe a fetch body straight into context** — a
long page is tens of kilobytes and that is what exhausts the main loop's window. Large or multi-page
reading belongs in a `subagent` call that returns a summary.

A page that needs JavaScript, a click or a form needs a browser-automation MCP server, and one is
only available **if this project has opted in** (`.pi/settings.json` → `mcp`). MCP servers are off by
default everywhere in this harness. If none is enabled and the page genuinely needs a browser, say so
and stop — do not fall back to scraping HTML you cannot render.

Where two are enabled, pick by **output, not by capability**. Need the page's *text* — its Markdown,
its DOM tree, its links? Take the headless-JS lane (`lightpanda`-shaped: `goto`, then
`markdown` / `tree` / `links` / `extract`). It runs a real JavaScript engine and renders nothing, so
asking it for a screenshot is a category error, not a missing feature. Need anything **visual** — a
screenshot, a layout check, a visual diff? That is the full-browser lane (`playwright`-shaped) and
only that one.

## TRIGGER: read the current docs before touching a library

Fire **before the first edit**, not after it fails, when the prompt or the file you are about to open
has: an `import`/`require` of a third-party package; a package or tool name; a version string; a
"how do I X in Y" / "why does Y do Z" question; or a known tool's config file (`pyproject.toml`,
`vite.config.ts`, `docker-compose.yml`, …).

How, in order, taking the first that is available:

1. a documentation MCP server, **if this project has opted into one** — check, don't assume;
2. `web_fetch` on the library's own documentation URL, then `web_search` for version-specific
   behaviour.

Don't skip because you know the library — you know the release that was current at your training
cutoff, not today's. Don't skip because it "looks like a one-liner": one-liners are where the API got
renamed.

**Skip only when** there is zero third-party surface (a pure algorithm, business logic, a refactor of
our own code), or current docs for that exact library were already fetched this session.

## TRIGGER: when a third-party tool misbehaves, find out — don't explain from memory

Observable markers only. "I'm confident" and "this one's simple" are not exits.

- Your fix didn't work and the same error is back.
- A tool behaved differently from what you predicted one message ago.
- The error text names a version.
- Any non-trivial error from a tool, MCP server, CLI or build that you are about to *explain* rather
  than just read out.
- You are about to write "known issue", "that's expected" or "try X instead" from memory.

Documentation says what is promised; issue trackers, changelogs and release notes say what people
actually hit. When the question is about *behaviour* rather than API surface, go looking for the
second kind of source first.

## TRIGGER: verify instead of recalling

Your knowledge has a cutoff; today's date is injected at session start. If the right answer changes
with the date, you do not have it.

`web_search` when the prompt contains: "latest" / "current" / "newest" / "still" / "now"; a version
number; pricing, limits or quotas; a model id; a product that shipped or changed after your cutoff;
"does X support Y"; a tool comparison. Also before writing any sentence that contains a date, a
version or a price.

When what you find contradicts what you remembered, the search wins. Say which one you went with and
link the source — a corrected answer with no citation is indistinguishable from a second guess.

**Skip:** mathematics, algorithms, language semantics, this repository's own code.

Questions about **our own model routing** — which provider, which tier, what context window, what a
model id resolves to — are answered from `config/models.json` and `config/routing.json`, never from
memory and never from the web. Those two files are the catalogue.

## TRIGGER: an expensive check is never the first check

Fire on **observable markers, not judgement**: you are about to run a command that submits work to
a remote executor or a paid endpoint, and the code path it exercises has changed since the last
local run. The observable command shapes:

- `databricks jobs run-now`, `databricks bundle deploy`
- `gcloud … jobs submit`
- `aws batch submit-job`
- `kubectl create job`

or a paid inference call made over a full dataset rather than one row of it.

**What to do:** run the smallest real thing locally first — one chunk, one page, one row, real
input, output printed somewhere you can actually read it. Iterate there until it is right. Only
then submit remotely.

**Skip only when** the code path is unchanged since a local run that already passed this session, or
the thing you are about to run genuinely has no local expression at all (a scheduled deploy, an
infrastructure provision) — and say which applies.

One line worth keeping past the rest: the same check failing twice against the same approach means
the approach is wrong, not the input to it. Nine narrower patches to one schema is one attempt
repeated, not nine attempts.

## TRIGGER: delegation is a context budget, not a default

**Do the work yourself while it stays bounded.** Bounded means: it fits in roughly five files, you
can name the change before you start, and the context report is under 50%. That covers most of what
you will be asked to do — take it, and edit directly rather than opening with a `subagent` call.

**Delegate when the work is genuinely wide**, not when it is merely multi-step. A research sweep, a
migration across a tree, an audit, anything where you would read far more than you write — and
anything at all once context is past 50%, because an exhausted orchestrator context is what triggers
compaction and loses the thread.

Delegating narrow work is neither free nor neutral. It costs a round trip, a cold child context that
knows nothing you have already read, and a summary that is lossy by construction; a child cannot ask
you the follow-up question you would have asked yourself. Spend that on width. When you do delegate,
delegate *widely*, not *redundantly*: one agent with a summary beats three with transcripts.

Pick the role by domain from `agents/` — `/agents` lists what is installed.

**The names in the `subagent` tool's own description are the package's examples, not this
install's roster.** `worker`, `reviewer`, `oracle`, `scout` and `delegate` ship with
`pi-subagents` and do resolve — but `agents/` is where this configuration's roles live, and
`/agents` is the list to route by. The external-CLI adapters are refused by the capability
ceiling on purpose: a child launched through one runs outside this configuration entirely, with
none of its tier routing, vetoes or audit trail.

**A delegated call runs on the strong tier unless you say otherwise.** `config/dispatch.json`'s
`defaultTier` is `strong`, and no agent file declares a cheaper one, so omitting `model` is not a
downgrade — a subagent works unwatched, and a plausible wrong answer nobody re-reads costs more than
the tokens. Reach for `light` deliberately and say why in the prompt, for work whose correctness is
obvious on inspection. Inside a `workflowScript` the children are launched past the point where a
tier is resolved, so each `runs.run(...)` / `runs.all([...])` child needs its own fully-qualified
`provider/model` — a bare tier word there is substring-matched against the whole model catalogue and
resolves to something you did not choose, on a provider you may not have configured.

**Independent pieces → ONE `subagent` call that fans out on its own**, not several calls in one
message. A second call in the same turn is rejected verbatim with `Rejected: a subagent call is
already in progress. Issue exactly ONE subagent call per turn.` Fanning out means a `workflowScript`
using `runs.all([...])` — the supported path — or a chain step with `parallel: [...]`. **Keep the
width inside the provider's `concurrency` in `config/routing.json` yourself.** Nothing enforces it on
the `runs.all` path: `config/subagent.json`'s `globalConcurrencyLimit` bounds children within a
single run's parallel batch, not how many launches a `runs.all` may open at once. Ten items in one
`runs.all` is ten concurrent provider calls.

**A run also has a cumulative child budget — `maxSubagentSpawnsPerRun`, set to 20 here and live
whether or not anyone sets it** (`config/subagent.default.json`; upstream's own default is 64, so
read the config rather than the package). It counts every child the run has ever started, claims are
never released or refunded, and a batch that does not fit is rejected whole: none of its children
start, and the error names the group rather than the item. So a long-lived workflow can exhaust it
at width 2 as easily as at width 20. Budget children across the whole run, not just per fan-out,
and start a new top-level run rather than widening an exhausted one.

`general-purpose` (aliases `general`, `generalist`) is the role of last resort. It is an ordinary
definition in `agents/` like every other, not a magic word — reach for it only when no specialist
fits. Know precisely what does and does not stop you: asking for it when a specialist in the
registry matches the task is **vetoed**, with the matching specialist named in the refusal, but that
veto fires only on a real match — when some named role's description shares two or more distinctive
words with your prompt. When nothing matches, a catch-all dispatch goes through unchallenged and
unjustified, so preferring the specialist is yours to keep, not the harness's to enforce. When the
veto does fire, the override is to re-issue the identical call with a
`# PI-JUSTIFY(DV-SPECIALIST): <one sentence, naming the concrete target>` line prepended to the
prompt text. There is no justification *parameter*.

## TRIGGER: coding work happens in a worktree, never the primary checkout

Any task that writes code — feature, fix, refactor, migration. First check whether the current
directory already is one: the session-start context tells you. If it does not say yes:

```bash
git worktree add ../<repo>-<name> -b <branch>
```

and **start a new session there**. There is no mid-session directory change in this harness — a
session is bound to the directory it started in. Never a second hand-made clone; never nest a
worktree inside a worktree.

Mechanical multi-file work → `subagent` with `isolation: "worktree"`.

**Skip:** read-only work (research, review, answering), edits outside a git repository, or a
one-liner asked for in place.

## Work

- Be concise. Answer what was asked. No preamble, no narrating what you are about to do.
- Blocked by the guard? It is one of three things, and nothing else blocks any more: `DB-*` (eight
  catastrophic shapes — `rm -rf /`, fork bomb, `dd of=/dev/…`, `mkfs`, redirect onto a raw disk,
  `chmod -R 777 /`, `curl … | sh`, shutdown), `GIT-REWRITE` (`filter-repo`/`filter-branch`), or
  `GIT-FORCE-PROTECTED` (force-push onto `main`/`master`). `SEC-*` (credential paths) blocked until
  2026-08-15 and now only records — do not read a credential file on the strength of that; the
  contents go to the provider serving the next turn. Everything else runs — `sudo`, `ssh`,
  `curl`, `make`, `terraform`, `python3 -c`, a write anywhere on disk, any binary on `PATH` — with no
  prompt and no approval, headless included. For the two `GIT-*` rules and two of the `DB-*` ones,
  re-issue the identical command with a `# PI-JUSTIFY(<gate-id>): <one sentence>` line prepended; the
  comment is stripped before the command runs. There is no `PI_GUARD_APPROVE` and no session
  allowlist any more — if you see either name anywhere, it is stale and does nothing.
- "Fix the bug" → "write the test that reproduces it, then make it pass".
- A classification — an `errorClass`, a status code, a one-word label — sits alongside the raw
  error, never in place of it. If a caller downstream can only ever see the label, the error path
  is broken, not simplified.
- Multi-step work → a three-line plan, and one verification per step.
- Disagree with an architecture, library, data-model or approach decision — or find two readings of
  the prompt — → say so **before** implementing, not after. Name the failure mode the other choice
  has and what yours costs, not just the diff. Reaffirmed once you have made the case → implement it
  and drop the objection.
- Python: `uv run ruff format` → `uv run ruff check` → `uv run mypy` → `uv run pytest`. After each
  change, not at the end — then finish the job: fix what you broke rather than stopping to ask
  permission for the obvious next step.
- Conventional commits (`feat:` / `fix:` / `docs:` / `refactor:` / `test:`) on `feature/…` | `fix/…`.
  Behaviour a reader depends on changed → update the README in the same commit.
- No AI attribution anywhere: no `Co-Authored-By` trailer, no generated-by credit line, in a commit
  message or in a file.
- Compaction → keep files and *intent*, TODO states, open errors, decisions and *why*, open
  `subagent` state; drop tool traces, searches, re-readable files, dead ends.

---

A git-ignored overlay named `PRIVATE.md` next to this file may add rules specific to you — a personal
remote allowlist, machine-specific pointers, a house style. It is never tracked (`bin/pi-check`'s
`PC-12` fails the repository if it is), and **its absence changes nothing**: no rule in this file
depends on it existing.

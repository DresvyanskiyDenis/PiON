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

**Skip:** mathematics, algorithms, language semantics, this repository's own code.

Questions about **our own model routing** — which provider, which tier, what context window, what a
model id resolves to — are answered from `config/models.json` and `config/routing.json`, never from
memory and never from the web. Those two files are the catalogue.

## TRIGGER: you are an orchestrator — delegating is the default, not the exception

The main loop stays an orchestrator. It reads the request, decides *who* does the work, hands it over
with `subagent`, checks the result, and keeps its own context free for exactly that. Doing the work
yourself is the special case that needs a reason — not the other way round.

**Do it yourself only when the work is genuinely pointwise:** one file already in context, an edit the
size of a `sed`, a single command whose output you need right now, an answer you already know.
Everything else — multi-file changes, anything wider than one module, research, review, migrations,
writing tests, documentation — goes to `subagent`. If you catch yourself opening a fourth file, the
decision was already wrong: stop and delegate the rest.

**An exhausted orchestrator context costs more than the extra tokens** — it is what triggers
compaction and loses the thread. One agent with a summary beats three with transcripts: delegate
*widely*, not *redundantly*.

Pick the role by domain from `agents/` — `/agents` lists what is installed. Independent pieces →
several `subagent` calls in one message, in parallel.

There is no universal role. Asking for `general-purpose` when a specialist in the registry matches
the task is **vetoed**, with the matching specialist named in the refusal. The veto is overridable:
re-dispatch with the specialist, or say why the specialist is wrong for this task.

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

- "Fix the bug" → "write the test that reproduces it, then make it pass".
- Multi-step work → a three-line plan, and one verification per step.
- Two readings of the prompt → ask, don't pick silently.
- Python: `uv run ruff format` → `uv run ruff check` → `uv run mypy` → `uv run pytest`. After each
  change, not at the end.
- Conventional commits (`feat:` / `fix:` / `docs:` / `refactor:` / `test:`) on `feature/…` | `fix/…`.
- Compaction → keep files and *intent*, TODO states, open errors, decisions and *why*, open
  `subagent` state; drop tool traces, searches, re-readable files, dead ends.

---

A git-ignored overlay named `PRIVATE.md` next to this file may add rules specific to you — a personal
remote allowlist, machine-specific pointers, a house style. It is never tracked (`bin/pi-check`'s
`PC-12` fails the repository if it is), and **its absence changes nothing**: no rule in this file
depends on it existing.

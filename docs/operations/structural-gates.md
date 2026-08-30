# Structural gates (`bin/pi-gate`)

Four cheap checks that run **before** the test suite and answer a question the test suite cannot:
not "is the code correct" but "is the way this change was arrived at healthy".

```bash
bin/pi-gate                     # all four, warn-only — reports, exits 0
bin/pi-gate --block             # any warning becomes an error — exits 1
bin/pi-gate SG-01 SG-04         # named gates only
bin/pi-gate --repo /path/to/x   # gate another tree
bin/pi-gate --help              # what each gate catches, and what it does not
```

Exit codes: `0` clean or warnings only, `1` at least one error-severity finding, `2` the gate
itself could not run.

## Why

From the 2026-08-30 audit of a real seven-hour session, findings H2 and H10. The project had one
gate — format, lint, test — and it was green the entire time the following was true:

- **52 of 72 commits on the branch were `fix:`.** One file was touched in 17 separate commits,
  another in 14, another in 13. On 2026-08-29 a `fix:` commit landed every ~20 minutes for seven
  hours. Nothing ever asked whether the approach, rather than the code, was wrong.
- **15 near-duplicate job files** differed only by a model name in the filename. Understanding one
  thing meant reading fifteen files: ~146 000 tokens of tool results in one lead context, which is
  what eventually pushed the prompt over the model's window.
- **The system could not be validated end to end below full production cost.** The pipeline
  hard-checked `expected_page_count == 701` with no partial-subset mode. All 321 tests passed,
  because every one of them mocked the boundary. The cheapest way to learn anything about the
  system was a full paid run, and that fact was discovered two days late, at the cash register.

Green tests plus a `fix:` commit read as "done", so the loop was *rewarded* for the behaviour that
was burning the budget. These four gates are the missing question.

## Posture: warn by default, block by explicit act

Every gate ships at severity `warn`. It reports, it is counted, and the command exits `0`.

Blocking is one explicit act, in either of two places:

| How | Scope | Use when |
| --- | --- | --- |
| `bin/pi-gate --block` (or `PI_GATE_BLOCK=1`) | promotes every `warn` to `error` for one run | CI, or the moment you want the gate to actually stop something |
| `"severity": "error"` in `config/structural-gates.json` | one gate, permanently | that gate's false-positive rate has been measured and found acceptable here |

`"severity": "off"` in the same file disables a gate entirely.

The reason the shipped default is not blocking: a structural gate is a judgement about process,
and it will be wrong sometimes. A gate that blocks on its own false positives buys one week of
trust and then a permanent `--no-verify`. A gate that is turned off by a config edit leaves a
diff; a gate that is routed around leaves nothing.

## Where it sits in the gate line

```bash
npm run typecheck && npm run gate && npm test      # or: npm run check
```

`npm run gate` is `bin/pi-gate`. It is deliberately **not** wired into `pretest`: the gates read
the branch's history and the working diff, so their answer changes between two runs of the same
test suite, and a check that can fail for a reason unrelated to the tests does not belong inside
the command people run fifty times an hour. `npm run check` runs the three in order for the times
you want the whole line.

## Relationship to `bin/pi-check`

Two tools, on purpose.

[`pi-check`](cli.md#binpi-check) asks **"is this configuration tree internally consistent"** — a property of the files as
they are, where every finding is equally fatal (any finding, exit 1). `pi-gate` asks **"is the way
this change was arrived at healthy"** — a property of the history and the diff, where the honest
default is a warning. Folding the four gates into `pi-check` would have meant either making
`pi-check`'s findings non-fatal or making these four fatal on day one. Neither tool has to lie
about the other's confidence level; the cost is one more command in the gate line.

Both share the same contract: standalone Node, zero npm dependencies, no import from `lib/`, no
network, no credential read, no paid call of any kind. `pi-gate` invokes exactly one binary —
local, read-only `git` (`log`, `diff`, `ls-files`, `rev-parse`) — the same way `bin/rules/pc-12`
and `pc-24` already do. Outside a git work tree it reports nothing rather than guessing.

## The four gates

Each entry says what it catches **and what it does not**. The second half is not a disclaimer; it
is the part that keeps the first half from being quoted as more than it is.

### SG-01 — fix-streak

**Catches.** Two or more consecutive `fix:` commits landing on the same file. "Consecutive" is
measured over *the commits that touch that file*, newest first — an unrelated `chore:` elsewhere on
the branch does not reset a file's streak, but a `feat:` or `refactor:` on the same file does,
because that is a change of intent on the same code. Default threshold 2, so the finding appears
before the third fix, which is the one the audit says to stop.

**The escape hatch is the thing it asks for.** A commit whose message carries both a
`Root-cause:` and an `Alternative:` line resets the streak at that commit:

```
fix: bound the page count to the requested scope

Root-cause: the count was asserted against production (701), not against what the
  caller asked for, so no subset run could ever pass.
Alternative: drop the assertion entirely and let the aggregation fail late — rejected,
  it turns a config error into a paid failure.
```

No flag, no env var: the answer lives in the history, where the next person reading `git log` finds
it. Both trailers are required — a root cause with no alternative is still a streak.

**Does not catch.** Fixes not spelled `fix:` (a `chore:` that is really a fix is invisible). Work
that is never committed. One enormous fix commit that patches ten symptoms at once — this counts
commits, not thrash. Rebased or squashed history, where the streak has been rewritten away.

**Tuning.** `streak`, `ignore` (globs; lockfiles and append-only ledgers — `**/*.lock`,
`package-lock.json`, `**/ledger.tsv` — are ignored by default, because they churn by design).

### SG-02 — parallel-module

**Catches.** A new file whose name differs from an existing file's name by exactly one token, on
either of two independent triggers:

- **Derived axis.** The tree already contains two or more files that differ only at that token
  position (`chunk_sonnet_job.py`, `chunk_gemma_job.py`), so the position is an established variant
  axis and the new file is the next near-duplicate. Needs no vocabulary at all: the tree names its
  own axis.
- **Vocabulary.** The differing token is a variant token. The vocabulary is **derived, never
  hardcoded**: every quoted identifier in the repo's own model configuration
  (`config/models.default.json`, `config/routing.default.json` and their installed
  `config/models.json` / `config/routing.json` counterparts — `deriveTokensFrom`) is split into
  words, the structural ones are dropped, and the rest join a small set of generic naming
  conventions (`v2`, `a1`, `copy`, `old`, `legacy`, …). On this repo that derivation yields
  `sonnet`, `haiku`, `opus`, `fable`, `gpt`, `gemini`, `grok`, `kimi`, `luna`, `terra`, `sol`,
  `claude`, `copilot` and about fifty more, without one of them appearing in the gate's source.
  `variantTokens` in config adds more by hand.

**Does not catch.** Duplication that renames more than one token at a time. Duplication *inside*
one file (a class per model in a single module) — this reads filenames, not contents. A copy that
lands under a different extension.

**Two deliberate blind spots**, both there to keep it quiet on normal trees:

- A numbered series never fires on its digit. `bin/rules/pc-29-…` beside twenty-eight `pc-NN-…`
  siblings is a rule set, not a variant axis (`numericSeriesMin`, default 3).
- A family that shares only one token is a prefix convention. `bin/pi-gate` beside `bin/pi-check`
  is two programs, not a duplicate (`minSharedTokens`, default 2). This was the gate's own first
  false positive, on the commit that introduced it.

**Tuning.** `variantTokens`, `deriveTokensFrom`, `numericSeriesMin`, `minSharedTokens`, `ignore`
(tests and fixtures are ignored by default).

### SG-03 — file-count budget per wave

**Catches.** Four or more new top-level source modules in one diff with no recorded sign-off.
"Top-level" is depth, not a directory allowlist: a path of `maxDepth` segments or fewer
(`src/pipeline.py` counts, `src/chunking/util/text.py` does not) whose extension is a source
extension (a new `README.md` is not sprawl). New paths include what is uncommitted and untracked —
the useful moment is before the decision is committed, not after.

**The sign-off is explicit or it does not exist.** Silence never clears this gate. A reason must be
given, in one of three places:

```bash
bin/pi-gate --signoff "one module per source format, agreed with the lead"
PI_GATE_SIGNOFF="one module per source format" bin/pi-gate
git commit -m "feat: four readers

Sprawl-signoff: one module per source format, agreed with the lead"
```

An empty or whitespace-only reason is not a sign-off. With a reason, the gate **still reports**, at
severity `ok`, quoting the reason back: an approval nobody can find later is the same as no
approval at all.

**Does not catch.** Sprawl added one module per commit across ten commits — this measures a diff,
not a trend. Growth inside modules that already exist: it counts files, not complexity. A rename
that git records as an add.

**Tuning.** `signoffThreshold`, `maxDepth`, `sourceExts`, `ignore`.

### SG-04 — bounded-run (weak by construction)

**This is the weak one, and it must not be quoted as more.**

**Catches.** For each file matching `jobGlobs` (`*_job.py`, `*_pipeline.py`, `jobs/**`,
`pipelines/**`, `resources/**/*.job.yml` — narrow on purpose), either of:

1. **No subset parameter anywhere.** None of `limit`, `max_pages`, `sample`, `subset`,
   `page_range`, `scope`, … appears as a parameter or a key. There is no documented way to ask
   this job for less than everything.
2. **A hard equality against a full-scale constant.** `expected_page_count == 701` — the shape that
   makes a bounded run impossible *even when a limit parameter exists*, which is exactly the defect
   that cost four paid runs to discover. Only literals ≥ `fullScaleLiteralMin` (default 500) count,
   and only under a name that is not in `identifierIgnore` (`status`, `status_code`, `code`,
   `port`, `errno`).

**Does not catch — read this before quoting a green SG-04.**

- **Whether a declared limit is actually honoured.** It never runs anything. A `limit` parameter
  that is accepted and then ignored, overwritten, or dropped three frames down satisfies this gate
  completely.
- **A `limit` in a comment or a docstring** satisfies it. This is a name check over text, not a
  semantic one.
- **A job it cannot see**: one whose entry point does not match `jobGlobs`, whose scope is set by
  an external orchestrator (a Databricks bundle, an Airflow DAG defined elsewhere), or whose
  parameters arrive through `**kwargs`.
- **A full-scale constant below 500.** A 300-page corpus is missed. That threshold is the price of
  keeping HTTP status compares — the identical syntactic shape, far more common — out of the
  output. Lower `fullScaleLiteralMin` if your magnitudes are smaller and you can live with the
  noise.

**So a green SG-04 means exactly one thing: no job in this tree *advertises* full-scale-only
operation.** It never means "every job has been shown to run on a subset". The only strong form of
this check is an actual bounded run; this gate exists to make the *absence* of one visible, not to
substitute for it. Where the two disagree, the run wins.

**Tuning.** `jobGlobs`, `subsetParams`, `fullScaleLiteralMin`, `identifierIgnore`, `ignore`.

## Configuration

`config/structural-gates.json`, repo-side only — it is not installed into `~/.pi/agent`, the same
way `config/slop-lint.json` is not. The shipped file sets nothing but the four severities; every
threshold defaults in `bin/lib/structural-gates.mjs` and can be overridden by name:

```json
{
  "gates": {
    "SG-01": { "severity": "error", "streak": 3 },
    "SG-02": { "variantTokens": ["kudu"] },
    "SG-04": { "severity": "off" }
  }
}
```

An unknown gate id, an unknown key, an unknown severity or a wrong type is a **hard error**
(exit 2), never a silent no-op. A gate that quietly did not run would report "0 findings", which is
the one failure mode a gate must not have.

## Base ref

The history and the diff are measured against a base: `--base REF`, or by default the merge-base
with `origin/main` (then `main`, `origin/master`, `master`), then `HEAD~20`. On `main` itself the
range is empty and the history gates are silent, which is correct — there is no branch to judge.

## Implementation

| File | Role |
| --- | --- |
| `bin/pi-gate` | CLI, and the only place that gathers facts from a real tree (git, filesystem) |
| `bin/lib/structural-gates.mjs` | the four detectors, as pure functions over plain data |
| `config/structural-gates.json` | severities and threshold overrides |
| `test/bin/structural-gates.test.ts` | each detector, in both directions |
| `test/pi-gate.suite.mjs` | the CLI end to end against two synthetic repositories |

The split exists so that every detector has a test for the case where it must stay **silent**. A
detector that can only be exercised through a live repository is one nobody writes that test for,
and on a structural gate the negative test is the half that decides whether anyone still reads the
output a week later.

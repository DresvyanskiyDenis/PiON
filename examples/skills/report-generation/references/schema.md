# `report.md` schema

The renderer parses `report.md` with a strict, line-oriented parser and aborts with a line number on any violation. This file is the contract.

## Contents

- [Why the schema exists](#why-the-schema-exists)
- [Skeleton](#skeleton)
- [Slot reference](#slot-reference)
  - [Title](#title)
  - [Verdict](#verdict)
  - [Meta bullets](#meta-bullets)
  - [`## Key numbers`](#-key-numbers)
  - [`## Finding N — headline`](#-finding-n--headline)
  - [`## Caveats`](#-caveats)
  - [`## Actions`](#-actions)
  - [`## Appendix …`](#-appendix-)
- [What reaches the HTML](#what-reaches-the-html)
- [Anchors](#anchors)
- [Validation errors](#validation-errors)

## Why the schema exists

The HTML tier is **not a summary the model writes**. It is a projection of named slots out of `report.md`. The model can write an unlimited amount of detail prose and the HTML cannot grow, because detail prose is not a slot that the HTML reads.

This is the whole brevity mechanism. It is structural, not a matter of the model exercising restraint — models violate stated word budgets more than half the time, so nothing here relies on a stated word budget.

## Skeleton

```markdown
# LSD chatbot evaluation: old LangGraph stack vs new Databricks app

> **Verdict.** The new app wins on groundedness and precision; the other two criteria are ties.

- **Date:** 2026-08-25
- **Scope:** 30 curated questions, 4 MLflow runs, pairwise + absolute scoring
- **Evidence:** `lsd_scripts/runs/`, MLflow experiment `lsd-eval-2026-08`

## Key numbers

| Metric | Value | Baseline | Delta |
|---|---|---|---|
| Groundedness | 4.3 | 3.3 | +1.00 |
| Precision | 3.9 | 3.2 | +0.70 |
| Judge noise floor | 0.24 | — | — |

## Finding 1 — Groundedness and precision clear the judge noise floor

Figure: threshold | scale-max: 1.1 | threshold: 0.24 | threshold-label: judge noise floor

| Criterion | Gap |
|---|---|
| Groundedness | 1.00 |
| Precision | 0.70 |
| Correctness | 0.10 |
| Relevance | 0.07 |

Caption: Two of four gaps sit below the measured noise floor and are ties.

The old system returned byte-identical answers across two runs, so any score
movement between them is pure judge variance. That gives a free calibration
constant of 0.24 points, and it is the line drawn on the chart. Correctness
(+0.10) and relevance (+0.07) fall under it …

<!-- ...unlimited further detail, tables, caveats. None of this reaches the HTML. -->

## Finding 2 — One retrieval path cannot succeed and wastes a third of calls

Figure: ba | scale-max: 100

| Outcome | Calls |
|---|---|
| Used | 68 |
| Wasted | 32 |

Caption: 32 of 100 retrieval calls query a field that is never populated.

...

## Caveats

- The judge is the same model family as the system under test.
- 30 questions is too few to separate criteria closer than ~0.3 points.

## Actions

1. Fix the unpopulated retrieval field before any further evaluation.
2. Re-run correctness and relevance with 120 questions.

## Appendix A — full per-question scores

| # | Question | Old | New |
|---|---|---|---|
...
```

## Slot reference

### Title

The single `#` H1. Required, must be first non-blank line. Becomes the HTML `<title>` and hero heading.

### Verdict

A blockquote starting `> **Verdict.**`, immediately after the title. Required.

**≤ 125 characters** — the cap is Science's one-sentence-finding limit, and the gate enforces it. State the conclusion, not the topic. No hedging: hedges belong in `## Caveats`.

### Meta bullets

Bold-key bullets between the verdict and the first `##`. `**Date:**` is required; `**Scope:**` and `**Evidence:**` are recommended. Any other key is allowed and renders in the footer.

### `## Key numbers`

Optional, at most one. A table whose first column is the label. Recognised column names, case-insensitive:

| Column | Role |
|---|---|
| first column | tile label |
| `Value` | the headline number (required) |
| `Baseline` or `Target` | comparison, rendered small |
| `Delta` | rendered as a first-class coloured element, not grey afterthought text |
| `Unit` | appended to the value |

3–6 rows. The gate warns below 3 and errors above 6 — a KPI strip with ten tiles has no headline.

### `## Finding N — headline`

The core repeating unit. `N` must be sequential from 1. The separator is an em dash surrounded by spaces.

**Headline: 8–14 words, an assertion, not a topic.** "Groundedness improves" is a topic. "Groundedness and precision clear the judge noise floor" is an assertion. The gate counts the words; whether it is an assertion is on you.

One assertion per finding. Two independent claims means two findings.

Inside the section, in order:

1. **`Figure:` line** — required. Syntax and vocabulary in [`figures.md`](figures.md).
2. **Data table** — the first table after the `Figure:` line, if the figure type needs one. Its header row supplies series names.
3. **`Caption:` line** — required. **≤ 25 words.** One line, states what the reader should take from the figure. Not a restatement of the headline.
4. **Everything else** — detail. Unlimited. **Never reaches the HTML.**

Subsequent tables in the section are detail, not chart data. Only the first one is read.

### `## Caveats`

Bullet list. The HTML renders **at most 5**; the rest stay Markdown-only, and the gate warns if you are hiding more than 5 so you know the HTML is not showing everything.

Always present. A report with no caveats is a report that has not been checked.

### `## Actions`

Numbered list, short imperatives. All of them reach the HTML — if there are more than 5 actions, the report has no recommendation.

### `## Appendix …`

Any `##` heading starting `Appendix`. Markdown-only, never in the HTML, unlimited length. This is where per-question tables, raw output, and full configuration go.

## What reaches the HTML

| Slot | In HTML | In Markdown |
|---|---|---|
| Title, verdict, meta | yes | yes |
| Key numbers table | yes, as KPI tiles | yes |
| Finding headline | yes | yes |
| Finding figure | yes, as a chart | yes, as the source table |
| Finding caption | yes | yes |
| **Finding detail prose** | **no** | yes |
| Caveats | first 5 | all |
| Actions | yes | yes |
| Appendices | no | yes |

Every HTML section links to its Markdown counterpart by anchor. Nothing is omitted from the reader — it is relocated one click away.

## Anchors

The renderer derives GitHub-style slugs from the Markdown headings and emits `report.md#slug` links. **Renaming a heading breaks its anchor**, which is why the gate re-checks every emitted anchor against the headings actually present in the file. If you rename a heading, re-run the renderer; do not hand-edit the HTML.

## Validation errors

The parser aborts on the first structural error with the offending line number. It never guesses, never falls back to a partial render, and never writes a half-built HTML file. Common aborts:

- `Finding 3 has no Figure: line` — every finding needs a visual, or an explicit `Figure: none` with a reason.
- `Finding 2 figure 'bars' needs scale-max` — scaled figures must state their axis maximum. An auto-fitted axis exaggerates small differences, which is how honest data becomes a misleading chart.
- `Verdict is 141 characters (max 125)`.
- `Finding 4 headline is 19 words (max 14)`.
- `Caption for finding 1 is 34 words (max 25)`.
- `Finding numbering jumps from 2 to 4`.

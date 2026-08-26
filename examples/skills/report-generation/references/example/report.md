# Chatbot evaluation: existing retrieval stack vs new answering app

> **Verdict.** The new app wins on groundedness and precision; the other two criteria are statistical ties.

- **Date:** 2026-08-25
- **Scope:** 30 curated questions, 4 evaluation runs, pairwise and absolute scoring
- **Evidence:** `runs/`, experiment `eval-2026-08`
- **Commit:** `a3f19c2`

## Key numbers

| Metric | Value | Baseline | Delta | Unit |
|---|---|---|---|---|
| Groundedness | 4.3 | 3.3 | +1.00 | pts |
| Precision | 3.9 | 3.2 | +0.70 | pts |
| Judge noise floor | 0.24 | | | pts |
| Wasted retrieval | 32 | | | % |

## Finding 1 — Only groundedness and precision clear the measured judge noise floor

Figure: threshold | scale-max: 1.1 | threshold: 0.24 | threshold-label: noise floor | unit: pts

| Criterion | Gap |
|---|---|
| Groundedness | 1.00 |
| Precision | 0.70 |
| Correctness | 0.10 |
| Relevance | 0.07 |

Caption: Two of four gaps fall below the noise floor and are ties, not improvements.

The old system returned byte-identical answers across two consecutive runs, so any score movement between those runs is pure judge variance. That yields a free calibration constant of 0.24 points, drawn here as the dashed line.

Correctness (+0.10) and relevance (+0.07) both sit under it. Reporting either as an improvement would be reporting judge noise. The two that clear it do so by a wide margin: groundedness at +1.00 is more than four times the noise floor.

This is why the verdict names two criteria rather than four, and it is the single most important qualification in this report.

## Finding 2 — One retrieval path queries a field that is never populated

Figure: ba | scale-max: 100 | unit: calls

| Outcome | Calls |
|---|---|
| Used | 68 |
| Wasted | 32 |

Caption: 32 of 100 retrieval calls target an always-empty field and cannot succeed.

The `doc_summary` field is read by the second retrieval branch but never written by the ingestion job. Every call down that branch returns an empty result set, and the agent then falls back to the primary index.

The cost is latency and tokens, not correctness — the fallback masks the defect entirely, which is why it survived to production. Fix this before running any further evaluation, because the wasted calls distort the searches-per-question distribution in Finding 3.

## Finding 3 — Most questions resolve in two searches but a tail runs to six

Figure: histogram | scale-max: 14 | x-label: searches per question | unit: questions

| Bin | Questions |
|---|---|
| 1 | 4 |
| 2 | 13 |
| 3 | 7 |
| 4 | 3 |
| 5 | 2 |
| 6 | 1 |

Caption: The distribution is right-skewed; six questions needed four or more searches.

## Finding 4 — The new app leads on three of five criteria and ties the rest

Figure: bars | scale-max: 5 | unit: pts

| Criterion | Existing | New |
|---|---|---|
| Groundedness | 3.3 | 4.3 |
| Precision | 3.2 | 3.9 |
| Correctness | 4.1 | 4.2 |
| Relevance | 4.4 | 4.4 |
| Latency score | 3.8 | 3.1 |

Caption: Latency is the one criterion where the existing stack still wins.

## Finding 5 — Pairwise judging favours the new app in three of five comparisons

Figure: stack

| Outcome | Questions |
|---|---|
| New wins | 18 |
| Tie | 7 |
| Existing wins | 5 |

Caption: Swap-order disagreement was 22%, below the 30% unusable threshold.

## Finding 6 — The two stacks share a retrieval shape but no code

Figure: matrix

| Capability | Existing | New | Reference |
|---|---|---|---|
| Streaming responses | x | x | x |
| Tool loop | x | x | x |
| Reranking | - | x | x |
| Citation spans | o | x | x |
| Query rewriting | - | o | x |

Caption: Reranking and citation spans are the two capabilities the new app adds.

## Caveats

- The judge is from the same model family as one system under test, which may bias pairwise verdicts.
- 30 questions cannot separate criteria closer than roughly 0.3 points.
- Latency was measured on a warm cache and understates cold-start cost.
- Only English questions were tested.
- The wasted-retrieval defect in Finding 2 was present during all four runs.

## Actions

1. Populate `doc_summary` in the ingestion job, then re-run the evaluation.
2. Re-test correctness and relevance with 120 questions before claiming either.
3. Profile cold-start latency before committing to the new app.

## Appendix A — per-question scores

| # | Question | Existing | New | Winner |
|---|---|---|---|---|
| 1 | How do I reset my access token? | 4 | 5 | New |
| 2 | Which regions support the connector? | 3 | 5 | New |
| 3 | What is the retention policy? | 4 | 4 | Tie |

## Appendix B — judge prompt

The full judge prompt, scoring rubric, and swap-order protocol used for every
comparison in this report.

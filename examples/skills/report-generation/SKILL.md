---
name: report-generation
description: Use when the user asks for a report, write-up, summary, or findings document from research, completed work, an evaluation, a benchmark, or an audit. Produces a paired report.md (full detail) and report.html (short, graphical, interactive) where the HTML is rendered mechanically from the Markdown, so it cannot grow into pages of prose.
---

# Report generation

Two files, one source of truth.

| File | Reader | Register |
|---|---|---|
| `report.md` | needs the detail behind one section | the dissertation — as long as the evidence requires |
| `report.html` | needs the result in two minutes | the defence talk — findings, figures, links back |

**The HTML is a projection of named slots out of `report.md`, not a summary you write.** You write one Markdown file. `scripts/render.py` parses it and emits the HTML from a fixed template. Detail prose is not one of the slots, so the page cannot grow no matter how long the Markdown gets.

This is why the skill works. Stated word budgets do not survive contact with a model — mechanical slots do. Do not hand-write HTML, and do not add a summary section to the Markdown for the page to lift.

## Hard rules

1. **Graphics over prose.** Every finding carries a figure. Nobody reads long passages; a chart is read at a glance. `Figure: none | reason: ...` exists, and using it more than once in a report is a failure.
2. **Be concise where it counts.** The verdict is one sentence. A headline is 8–14 words. A caption is ≤25 words. These are enforced, not encouraged.
3. **The two tiers have different registers.** The Markdown may be long; the HTML is a projection and cannot be. Writing HTML-register prose into the Markdown loses the evidence — writing Markdown-register prose expecting it on the page wastes it.
4. **No orphan facts.** Every number on the page came out of the Markdown. The renderer checks this and fails on a number it cannot find.
5. **You run everything.** The user asked for a report, not for instructions. Never print a command for them to run, never ask which directory or which figure kind, never hand back a Markdown file with "now render it". You gather, you write, you render, you fix what the gate rejects, you look at the result, and you deliver two finished files. The only acceptable output of this skill is `report.md` and `report.html` on disk.

## Workflow

Run all of this yourself, start to finish, without stopping to ask.

1. **Gather first, write second.** You cannot write three MECE findings out of material you have not read. Collect the runs, diffs, measurements, logs.
2. **Read `references/schema.md`.** It is the contract the renderer parses — headings, slots, budgets. Writing to it from memory means a failed render.
3. **Pick figures from `references/figures.md`** before writing the prose. The figure decides what the finding says; a finding whose data has no figure is usually two findings.
4. **Write `report.md`.** One file. Put it where the project's `AGENTS.md` says reports go; absent that, the current working directory. Decide this yourself.
5. **Render it yourself:**

   ```bash
   uv run $PI_SKILL_DIR_REPORT_GENERATION/scripts/render.py report.md
   ```

   Writes `report.html` next to the Markdown. Needs only `uv` — dependencies are declared inline (PEP 723) and ECharts is vendored, so the output is a single self-contained file that works offline. The script lives next to this file at `scripts/render.py`; use that path if the one above does not resolve.
6. **Fix what the gate rejects, then render again.** It exits non-zero and writes nothing on failure. Every message names the line and what to change. Loop until it exits clean — that loop is your job, not the user's. Do not work around a gate by deleting the content it objected to; that is how a report becomes short and empty.
7. **Look at the rendered page before you report done.** A green render is not a good report. Open the HTML and check that each figure says what its headline claims. If you can read images, screenshot it and look; a chart can render perfectly and still state the opposite of the data.
8. **Report both paths and the verdict.** The artefact on disk is the result, not your message about it. Two paths, one line on what the report concludes, nothing else.

## What the gate enforces

Reasons a render fails, so you can write to them the first time rather than iterating:

- verdict over 125 characters; headline outside 8–14 words; caption over 25 words
- a caption that restates its headline instead of adding the reading
- hedges (`may`, `might`, `appears to`, `seems`) in a headline or verdict — a finding either holds or is a caveat
- more than 7 findings, fewer than 3 or more than 6 KPI tiles, missing `## Caveats` or `## Actions`
- a figure without a data table, or a scaled figure without `scale-max` — an auto-fitted axis exaggerates small differences
- a number on the page that is not in the Markdown; a `report.md#anchor` link with no matching heading
- an `http(s)` reference where the evidence should be a local path
- banned filler (`leverage`, `robust`, `seamless`, `delve`, …) and em-dash density above one per 500 words

Warnings print but do not block. Read them; they are usually right.

## Publishing

The deliverable is a local file. Publishing to a shareable URL is **opt-in** — do it only when the user asks. The rendered HTML is self-contained and passes through unchanged.

## References

- `references/schema.md` — the `report.md` contract, slot by slot, and what reaches the HTML
- `references/figures.md` — the closed figure vocabulary, with a chooser table and the SVG escape hatch
- `references/register.md` — how to write each tier; banned constructions; the self-review checklist
- `references/example/report.md` — a complete six-finding report that renders clean

## Extending

`assets/report.css`, `assets/charts.js` and `assets/template.html.jinja` are the visual system. Adding a figure kind means a builder in `scripts/render.py`, a CSS or ECharts branch, and an entry in `references/figures.md` — all three, or the vocabulary lies about itself.

Anything the vocabulary genuinely cannot express goes through the escape hatch: hand-authored inline SVG referenced as `Figure: svg: figures/name.svg`. Use `currentColor` and `var(--token)` so it themes with the page.

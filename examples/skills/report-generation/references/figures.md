# Figure vocabulary

A closed set. If your data does not fit one of these, use `svg:` and draw it — do not stretch a primitive into the wrong shape.

## Contents

- [Directive syntax](#directive-syntax)
- [Choosing a figure](#choosing-a-figure)
- [Interactive figures (ECharts)](#interactive-figures-echarts)
- [Structural figures (CSS/SVG)](#structural-figures-csssvg)
- [Escape hatch](#escape-hatch)
- [Rules that apply to every figure](#rules-that-apply-to-every-figure)

## Directive syntax

```
Figure: <kind> | <key>: <value> | <key>: <value>
```

`kind` first, then any number of `key: value` options separated by `|`. Unknown keys abort the render — a silently ignored option is a chart that does not say what you think it says.

## Choosing a figure

| You want to show | Use |
|---|---|
| A vs B across several criteria | `bars` |
| Whether a difference is big enough to be real | `threshold` |
| How one thing changed over time or steps | `line` |
| The shape of a distribution | `histogram` |
| A many-criteria profile of two systems | `radar` |
| Proportions of one whole (win/tie/lose) | `stack` |
| Useful vs wasted portion of a total | `ba` |
| Which items have which attributes | `matrix` |
| Stages data passes through | `pipeline` |
| Which defects affect which subjects | `ledger` |
| A mechanism, architecture, or flow | `svg:` |
| Nothing — this section is prose | `none` (needs a reason; the gate warns) |

**A chart forces you to commit to a claim.** Prose lets you write "somewhat better, though with caveats"; a bar has one length. If a paragraph could be a figure, it must be a figure.

## Interactive figures (ECharts)

Rendered by vendored ECharts 5.6.1. Animated on first scroll into view, hover tooltips, clickable legend to toggle series, and they re-layout on resize. All of that is free — do not hand-roll it.

### `bars`

Grouped bars. Table header supplies series names.

```
Figure: bars | scale-max: 5 | unit: points

| Criterion | Old | New |
|---|---|---|
| Groundedness | 3.3 | 4.3 |
| Precision | 3.2 | 3.9 |
```

Options: `scale-max` (**required**), `unit`, `horizontal: true`.

### `threshold`

Measured values against a reference line. **The honesty primitive** — use it whenever some differences are real and some are noise. The reader concludes "these two are ties" in about a second and cannot skim past it the way they skim a hedge clause.

```
Figure: threshold | scale-max: 1.1 | threshold: 0.24 | threshold-label: judge noise floor

| Criterion | Gap |
|---|---|
| Groundedness | 1.00 |
| Correctness | 0.10 |
```

Options: `scale-max` (**required**), `threshold` (**required**), `threshold-label`, `unit`.

Bars that clear the line render in the "good" token, bars that do not render muted. That mapping is the point: do not override it.

### `line`

Trend across ordered steps. First column is the x axis.

Options: `scale-max` (**required**), `unit`, `area: true` (single series only — two overlapping fills read as a third, meaningless band).

### `histogram`

Distribution. Table is `| Bin | Count |`.

Options: `scale-max` (**required**), `unit`, `x-label`.

### `radar`

Multi-criteria profile, two or three series maximum. Above three it becomes unreadable.

Options: `scale-max` (**required**).

## Structural figures (CSS/SVG)

Rendered as CSS/inline SVG, no JavaScript needed to be correct. They animate in and show hover detail, but they read fine with scripting dead.

### `stack`

One 100 %-width ribbon of proportions. Table is `| Outcome | Count |`. Percentages are computed; do not pre-compute them.

```
Figure: stack

| Outcome | Count |
|---|---|
| New wins | 18 |
| Tie | 7 |
| Old wins | 5 |
```

Segments are coloured by row order from the categorical palette, which deliberately holds no red and no green — a proportion is not a verdict. A row whose label *is* a draw word (`tie`, `draw`, `equal`, `even`, `neither`, `none`, `other`, `unchanged`) renders in the neutral token instead. Order the rows the way you want them read.

### `ba`

Used-vs-wasted split of a total. Table is `| Outcome | Value |` with exactly two rows.

**Row order is load-bearing.** The first row is the useful portion and renders in the good token; the second is the remainder and renders in the bad token, because a wasted portion is a verdict, not a neutral fact. Put them the other way round and the figure says the opposite of what you mean.

Options: `scale-max` (**required**), `unit`.

### `matrix`

Items × attributes presence grid. Pure data, zero prose — the densest thing in the vocabulary and often the best figure in a report.

```
Figure: matrix

| Feature | repo-a | repo-b | repo-c |
|---|---|---|---|
| Streaming | x | x | o |
| Tool loop | x | x | x |
| Auth | - | o | x |
```

Cells: `x` filled, `o` ring (partial), `-` faint (absent). Any other cell value aborts the render.

### `pipeline`

Ordered stages. Table is `| Stage | What |`. Renders as connected flex stages, colour-graded along the sequence.

Keep to 3–6 stages. Beyond 6 it wraps, and a wrapped pipeline strands its arrows — the gate checks for this at render width.

### `ledger`

Defects × subjects pips. Table's first column is the defect, remaining columns are subjects, cells `x` (present) or `-` (absent). Reads left-to-right as a count.

This is the one primitive whose colour states a verdict: a present pip is red, because a present defect is bad by definition. For a presence grid that is *not* a defect list — capabilities, coverage, features — use `matrix`, which colours neutrally.

## Escape hatch

```
Figure: svg: figures/architecture.svg
```

The file is inlined verbatim into the HTML, so it must be a self-contained `<svg>` element — no external references, no `<image href>` to a file on disk. Put it in a `figures/` directory next to `report.md`.

Use this for mechanism: an architecture with numbered pins showing where each recommendation lands, a graph skeleton, a dormancy timeline. A charting library is the wrong tool for these and will make them worse.

**Draw the real mechanism.** A box-and-arrow diagram that just restates the section headings is decoration, and decoration is what the gate cannot catch — you have to catch it.

Every `<svg>` you author must:

- use `currentColor` or the CSS custom properties for every stroke and fill, never a hardcoded hex, or it will be invisible in one of the two themes;
- carry a `viewBox` and no fixed `width`/`height`, so it scales;
- keep text at 12 px equivalent or larger at render size.

## Rules that apply to every figure

1. **State the scale maximum.** Every scaled figure requires `scale-max`. An auto-fitted axis exaggerates small differences; an unlabelled axis is where misleading charts come from.
2. **One figure, one message.** If you are explaining two things, that is two findings.
3. **The figure and its caption must agree.** The gate checks bar widths arithmetically against their labels, because *rendering correctly is not the same as being correct* — a broken-looking chart gets reported by a reader, a wrong-but-pretty one does not.
4. **Colour means the same thing everywhere.** A named series keeps one token across every chart figure, so the reader learns the encoding once. This holds for the ECharts kinds, which key colour to the series name across the whole report. It does not hold for `stack`, which colours by row position within its own table: two `stack` figures that list the same label in a different row order will give it a different colour. If you use two, order their rows the same way.
5. **Annotations anchor to what they annotate**, never to the page layout. A threshold line lives inside its own track, not positioned against a grid column — otherwise any label-width change silently drifts it.
6. **Motion is diagrammatic, not decorative.** A loop may march because it is a loop. A uniform entrance animation on every section is the reflex that makes a page read as generated; it is banned.

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["jinja2>=3.1"]
# ///
"""Render report.md into a self-contained report.html.

The HTML is a projection of named slots out of report.md, not a summary the
model writes. Detail prose is not a slot, so the HTML cannot grow no matter
how long the Markdown gets. See references/schema.md for the contract.

Aborts on the first structural error with a line number. Never writes a
partial file: gates run against the fully rendered HTML in memory, and the
file is only written once every gate passes.

Usage:
    uv run render.py report.md
    uv run render.py report.md -o out/report.html
    uv run render.py report.md --check       # gates only, write nothing
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import NoReturn

from jinja2 import Environment, StrictUndefined
from markupsafe import Markup

FigureSpec = dict[str, object]

ASSETS = Path(__file__).resolve().parent.parent / "assets"

# ---------------------------------------------------------------- budgets

VERDICT_MAX_CHARS = 125
HEADLINE_MIN_WORDS = 8
HEADLINE_MAX_WORDS = 14
CAPTION_MAX_WORDS = 25
FINDINGS_MAX = 7
KPI_MIN, KPI_MAX = 3, 6
CAVEATS_SHOWN = 5
ACTIONS_MAX = 5
PROSE_WORDS_TOTAL = 600
EM_DASH_PER_WORDS = 500

ECHARTS_KINDS = {"bars", "threshold", "line", "histogram", "radar"}
CSS_KINDS = {"stack", "ba", "matrix", "pipeline", "ledger"}
SCALED_KINDS = {"bars", "threshold", "line", "histogram", "radar", "ba"}

OPTION_KEYS = {
    "scale-max",
    "unit",
    "horizontal",
    "threshold",
    "threshold-label",
    "area",
    "x-label",
    "reason",
}

BANNED_WORDS = [
    "leverage",
    "leveraging",
    "harness",
    "harnessing",
    "utilize",
    "utilise",
    "delve",
    "robust",
    "seamless",
    "seamlessly",
    "cutting-edge",
    "game-changer",
    "game changer",
    "unlock",
    "unlocks",
    "supercharge",
    "realm",
    "testament to",
    "it's worth noting",
    "it is worth noting",
    "it's important to note",
    "it is important to note",
    "in conclusion",
    "in summary",
]
HEDGE_WORDS = [
    "may ",
    "might ",
    "could potentially",
    "arguably",
    "in some cases",
    "somewhat",
    "relatively",
    "fairly ",
    "perhaps",
]


class ReportError(Exception):
    """Structural problem in report.md. Aborts the render."""


def die(line_no: int | None, msg: str) -> NoReturn:
    where = f"report.md:{line_no}: " if line_no else ""
    raise ReportError(f"{where}{msg}")


# ---------------------------------------------------------------- model


@dataclass
class Table:
    header: list[str]
    rows: list[list[str]]
    line: int


@dataclass
class Figure:
    kind: str
    options: dict[str, str]
    table: Table | None
    line: int
    series: list[str] = field(default_factory=list)


@dataclass
class Finding:
    n: int
    headline: str
    caption: str
    anchor: str
    figure: Figure | None
    line: int
    figure_html: str = ""


@dataclass
class Kpi:
    label: str
    value: str
    unit: str = ""
    baseline: str = ""
    delta: str = ""
    delta_dir: str = "flat"


@dataclass
class Report:
    title: str
    verdict: str
    meta: dict[str, str]
    kpis: list[Kpi]
    findings: list[Finding]
    caveats: list[str]
    actions: list[str]
    md_only_sections: list[str] = field(default_factory=list)

    @property
    def caveats_shown(self) -> list[str]:
        return self.caveats[:CAVEATS_SHOWN]

    @property
    def caveats_hidden(self) -> list[str]:
        return self.caveats[CAVEATS_SHOWN:]


# ---------------------------------------------------------------- helpers


def slugify(text: str) -> str:
    """GitHub-style heading slug."""
    s = unicodedata.normalize("NFKD", text)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s+", "-", s.strip())
    return s


def words(text: str) -> int:
    return len(re.findall(r"[^\s]+", text))


def as_float(raw: str, line: int, what: str) -> float:
    try:
        return float(str(raw).replace(",", ".").strip())
    except ValueError:
        die(line, f"{what} is not a number: {raw!r}")


def strip_md(text: str) -> str:
    """Reduce inline Markdown to plain text for slot values."""
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*\*([^*]*)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]*)\*", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return text.strip()


# ---------------------------------------------------------------- parsing


def parse_table(
    lines: list[str], start: int, offset: int = 0
) -> tuple[Table | None, int]:
    """Read a pipe table starting at `start`. Returns (table, next_index).

    `offset` is added to reported line numbers so that a table found inside a
    section slice still reports its real line in report.md.
    """
    i = start
    block: list[tuple[int, str]] = []
    while i < len(lines) and lines[i].strip().startswith("|"):
        block.append((i, lines[i].strip()))
        i += 1
    if len(block) < 2:
        return None, start

    def cells(row: str) -> list[str]:
        parts = row.split("|")
        if parts and not parts[0].strip():
            parts = parts[1:]
        if parts and not parts[-1].strip():
            parts = parts[:-1]
        return [strip_md(p) for p in parts]

    header = cells(block[0][1])
    sep = block[1][1]
    if not re.fullmatch(r"\|[\s:|-]+\|?", sep):
        die(block[1][0] + 1 + offset, "table is missing its |---| separator row")
    rows = [cells(r) for _, r in block[2:]]
    rows = [r for r in rows if any(c for c in r)]
    for idx, r in enumerate(rows):
        if len(r) != len(header):
            die(
                block[2 + idx][0] + 1 + offset,
                f"table row has {len(r)} cells but the header has {len(header)}",
            )
    return Table(header=header, rows=rows, line=block[0][0] + 1 + offset), i


def parse_figure_directive(raw: str, line: int) -> Figure:
    body = raw.split(":", 1)[1].strip()
    if body.startswith("svg:"):
        return Figure(
            kind="svg", options={"path": body[4:].strip()}, table=None, line=line
        )

    parts = [p.strip() for p in body.split("|")]
    kind = parts[0].strip()
    options: dict[str, str] = {}
    for part in parts[1:]:
        if not part:
            continue
        if ":" not in part:
            die(line, f"figure option {part!r} is not 'key: value'")
        key, val = part.split(":", 1)
        key, val = key.strip(), val.strip()
        if key not in OPTION_KEYS:
            die(
                line,
                f"unknown figure option {key!r} "
                f"(known: {', '.join(sorted(OPTION_KEYS))})",
            )
        options[key] = val

    known = ECHARTS_KINDS | CSS_KINDS | {"none"}
    if kind not in known:
        die(line, f"unknown figure kind {kind!r} (known: {', '.join(sorted(known))})")
    return Figure(kind=kind, options=options, table=None, line=line)


def parse(text: str) -> Report:
    lines = text.splitlines()

    # --- title
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines) or not lines[i].startswith("# "):
        die(i + 1, "report must start with a '# Title' H1")
    title = strip_md(lines[i][2:])
    i += 1

    # --- verdict
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines) or not lines[i].lstrip().startswith(">"):
        die(i + 1, "the line after the title must be a '> **Verdict.** ...' blockquote")
    vparts: list[str] = []
    while i < len(lines) and lines[i].lstrip().startswith(">"):
        vparts.append(lines[i].lstrip()[1:].strip())
        i += 1
    verdict = strip_md(" ".join(vparts))
    verdict = re.sub(r"^Verdict\.\s*", "", verdict, flags=re.IGNORECASE).strip()
    if not verdict:
        die(i, "verdict blockquote is empty")

    # --- meta bullets, up to the first '##'
    meta: dict[str, str] = {}
    while i < len(lines) and not lines[i].startswith("## "):
        m = re.match(r"^\s*[-*]\s+\*\*(.+?):\*\*\s*(.+)$", lines[i])
        if m:
            meta[m.group(1).strip()] = strip_md(m.group(2))
        i += 1
    if "Date" not in meta:
        die(None, "a '- **Date:** YYYY-MM-DD' meta bullet is required")

    # --- sections
    heads = [n for n in range(i, len(lines)) if lines[n].startswith("## ")]
    bounds = [
        (heads[k], heads[k + 1] if k + 1 < len(heads) else len(lines))
        for k in range(len(heads))
    ]

    kpis: list[Kpi] = []
    findings: list[Finding] = []
    caveats: list[str] = []
    actions: list[str] = []
    md_only: list[str] = []
    seen_kpi = False

    for start, end in bounds:
        heading = strip_md(lines[start][3:])
        body = lines[start + 1 : end]
        low = heading.lower()

        if low.startswith("appendix"):
            md_only.append(heading)
            continue

        if low == "key numbers":
            if seen_kpi:
                die(start + 1, "only one '## Key numbers' section is allowed")
            seen_kpi = True
            kpis = parse_kpis(body, start + 1)
            continue

        fm = re.match(r"^Finding\s+(\d+)\s*[—–-]\s*(.+)$", heading)
        if fm:
            findings.append(
                parse_finding(
                    int(fm.group(1)), strip_md(fm.group(2)), heading, body, start + 1
                )
            )
            continue

        if low == "caveats":
            caveats = parse_list(body)
            continue

        if low in ("actions", "what to do"):
            actions = parse_list(body)
            continue

        md_only.append(heading)

    if not findings:
        die(None, "report has no '## Finding N — headline' sections")

    return Report(
        title=title,
        verdict=verdict,
        meta=meta,
        kpis=kpis,
        findings=findings,
        caveats=caveats,
        actions=actions,
        md_only_sections=md_only,
    )


def parse_list(body: list[str]) -> list[str]:
    out: list[str] = []
    for ln in body:
        m = re.match(r"^\s*(?:[-*]|\d+[.)])\s+(.+)$", ln)
        if m:
            out.append(strip_md(m.group(1)))
    return out


def parse_kpis(body: list[str], line: int) -> list[Kpi]:
    idx = next((k for k, ln in enumerate(body) if ln.strip().startswith("|")), None)
    if idx is None:
        die(line, "'## Key numbers' needs a table")
    table, _ = parse_table(body, idx, offset=line)
    if table is None:
        die(line, "'## Key numbers' table could not be parsed")

    cols = {name.lower(): pos for pos, name in enumerate(table.header)}
    if "value" not in cols:
        die(table.line, "'## Key numbers' table needs a 'Value' column")

    def cell(r: list[str], key: str) -> str:
        pos = cols.get(key)
        return r[pos] if pos is not None and pos < len(r) else ""

    out: list[Kpi] = []
    for row in table.rows:
        delta = cell(row, "delta")
        direction = "flat"
        if delta.startswith("+"):
            direction = "up"
        elif delta.startswith("-") and delta not in ("-", "--"):
            direction = "down"
        out.append(
            Kpi(
                label=row[0],
                value=cell(row, "value"),
                unit=cell(row, "unit"),
                baseline=cell(row, "baseline") or cell(row, "target"),
                delta="" if delta in ("", "-", "--", "—") else delta,
                delta_dir=direction,
            )
        )
    return out


def parse_finding(
    n: int, headline: str, heading: str, body: list[str], line: int
) -> Finding:
    figure: Figure | None = None
    caption = ""

    for k, ln in enumerate(body):
        stripped = ln.strip()
        if figure is None and re.match(r"^Figure:\s*", stripped, re.IGNORECASE):
            figure = parse_figure_directive(stripped, line + 1 + k)
            if figure.kind in (ECHARTS_KINDS | CSS_KINDS):
                j = k + 1
                while j < len(body) and not body[j].strip():
                    j += 1
                if j < len(body) and body[j].strip().startswith("|"):
                    figure.table, _ = parse_table(body, j, offset=line)
            continue
        if not caption and re.match(r"^Caption:\s*", stripped, re.IGNORECASE):
            caption = strip_md(stripped.split(":", 1)[1])

    if figure is None:
        die(
            line,
            f"Finding {n} has no 'Figure:' line "
            f"(use 'Figure: none | reason: ...' if a visual truly does not apply)",
        )
    if not caption:
        die(line, f"Finding {n} has no 'Caption:' line")
    if figure.kind in (ECHARTS_KINDS | CSS_KINDS) and figure.table is None:
        die(
            figure.line,
            f"figure '{figure.kind}' needs a data table right after the Figure: line",
        )
    if figure.kind in SCALED_KINDS and "scale-max" not in figure.options:
        die(
            figure.line,
            f"figure '{figure.kind}' needs 'scale-max' — an auto-fitted "
            f"axis exaggerates small differences",
        )
    if figure.kind == "threshold" and "threshold" not in figure.options:
        die(figure.line, "figure 'threshold' needs a 'threshold' value")
    if (
        figure.kind == "line"
        and figure.options.get("area") == "true"
        and figure.table is not None
        and len(figure.table.header) > 2
    ):
        die(
            figure.line,
            "'area: true' needs a single series — two overlapping "
            "fills read as a third band that is not in the data",
        )
    if figure.kind == "none" and "reason" not in figure.options:
        die(figure.line, "'Figure: none' needs 'reason: ...'")
    if figure.table is not None:
        figure.series = figure.table.header[1:]

    return Finding(
        n=n,
        headline=headline,
        caption=caption,
        anchor=slugify(heading),
        figure=figure,
        line=line,
    )


# ---------------------------------------------------------------- figures


def esc(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# Colour never comes from guessing at label text. Substring matching put
# "New wins" and "Existing wins" both in the good token, which read as a
# verdict that the data did not support. Position decides, and only a label
# that IS one of these words (not one that contains it) gets the neutral
# token, because a draw genuinely has no direction.
NEUTRAL_LABELS = frozenset(
    {
        "tie",
        "ties",
        "draw",
        "draws",
        "equal",
        "even",
        "neither",
        "same",
        "none",
        "other",
        "unchanged",
        "n/a",
    }
)


def cat_class(label: str, index: int) -> str:
    """Categorical class for one stack segment: position, not word-matching."""
    if label.strip().lower() in NEUTRAL_LABELS:
        return "tie"
    return f"c{(index % 6) + 1}"


def pct(value: float, scale: float, label: str) -> float:
    if scale <= 0:
        raise ReportError(f"scale for {label!r} must be greater than zero")
    return round(value / scale * 100.0, 3)


def fig_stack(f: Figure) -> str:
    assert f.table is not None  # parser guarantees this
    total = sum(
        as_float(r[1], f.table.line, f"stack value for {r[0]!r}") for r in f.table.rows
    )
    if total <= 0:
        die(f.table.line, "stack values sum to zero")
    segs, legend = [], []
    for i, row in enumerate(f.table.rows):
        val = as_float(row[1], f.table.line, row[0])
        cls = cat_class(row[0], i)
        p = pct(val, total, f"stack:{row[0]}")
        segs.append(
            f'<span class="stack-seg {cls}" style="width:{p}%" '
            f'title="{esc(row[0])}: {esc(row[1])} of {total:g}">{esc(row[1])}</span>'
        )
        legend.append(f'<span><i class="swatch {cls}"></i>{esc(row[0])}</span>')
    return (
        f'<div class="stack">{"".join(segs)}</div>'
        f'<div class="scaleline"><span data-computed="1">0</span>'
        f'<span data-computed="1">total {total:g}</span></div>'
        f'<div class="stack-legend">{"".join(legend)}</div>'
    )


def fig_ba(f: Figure) -> str:
    assert f.table is not None  # parser guarantees this
    if len(f.table.rows) != 2:
        die(f.table.line, "figure 'ba' needs exactly two rows")
    scale = as_float(f.options["scale-max"], f.line, "scale-max")
    # Row order is the contract: first row is the useful portion, second is
    # the remainder. Stated in references/figures.md and enforced here.
    parts = []
    for i, row in enumerate(f.table.rows):
        val = as_float(row[1], f.table.line, row[0])
        cls = "used" if i == 0 else "wasted"
        p = pct(val, scale, f"ba:{row[0]}")
        parts.append(
            f'<span class="{cls}" style="width:{p}%" '
            f'title="{esc(row[0])}: {esc(row[1])}"></span>'
        )
    labels = " &middot; ".join(f"{esc(r[0])} {esc(r[1])}" for r in f.table.rows)
    unit = f" {esc(f.options['unit'])}" if f.options.get("unit") else ""
    return (
        f'<div class="ba">{"".join(parts)}</div>'
        f'<div class="scaleline"><span>{labels}</span>'
        f"<span>max {esc(f.options['scale-max'])}{unit}</span></div>"
    )


def fig_matrix(f: Figure) -> str:
    assert f.table is not None  # parser guarantees this
    head = "".join(f"<th>{esc(h)}</th>" for h in f.table.header)
    body = []
    for row in f.table.rows:
        cells = [f"<td>{esc(row[0])}</td>"]
        for cell in row[1:]:
            token = cell.strip().lower()
            if token in ("x", "✓", "yes"):
                dot = "full"
            elif token in ("o", "~", "partial"):
                dot = "ring"
            elif token in ("-", "", "no"):
                dot = "faint"
            else:
                die(f.table.line, f"matrix cell {cell!r} is not one of x / o / -")
            cells.append(f'<td><i class="dot {dot}" title="{esc(cell)}"></i></td>')
        body.append(f"<tr>{''.join(cells)}</tr>")
    return (
        f'<table class="matrix"><thead><tr>{head}</tr></thead>'
        f"<tbody>{''.join(body)}</tbody></table>"
    )


def fig_pipeline(f: Figure) -> str:
    assert f.table is not None  # parser guarantees this
    stages = []
    for k, row in enumerate(f.table.rows, start=1):
        what = row[1] if len(row) > 1 else ""
        stages.append(
            f'<div class="stage"><div class="stage-n" data-computed="1">{k:02d}</div>'
            f'<div class="stage-name">{esc(row[0])}</div>'
            f'<div class="stage-what">{esc(what)}</div></div>'
        )
    return f'<div class="pipeline">{"".join(stages)}</div>'


def fig_ledger(f: Figure) -> str:
    assert f.table is not None  # parser guarantees this
    subjects = f.table.header[1:]
    rows = []
    for row in f.table.rows:
        pips = []
        for pos, subject in enumerate(subjects):
            cell = (row[pos + 1] if pos + 1 < len(row) else "-").strip().lower()
            if cell not in ("x", "-", "", "o"):
                die(f.table.line, f"ledger cell {cell!r} is not 'x' or '-'")
            on = " on" if cell == "x" else ""
            pips.append(f'<i class="pip{on}" title="{esc(subject)}"></i>')
        rows.append(
            f'<div class="ledger-row"><div class="ledger-label">{esc(row[0])}</div>'
            f'<div class="pips">{"".join(pips)}</div></div>'
        )
    legend = ", ".join(esc(s) for s in subjects)
    return (
        f'<div class="ledger">{"".join(rows)}</div>'
        f'<div class="scaleline"><span>{legend}</span></div>'
    )


def fig_svg(f: Figure, md_dir: Path) -> str:
    path = (md_dir / f.options["path"]).resolve()
    if not path.is_file():
        die(f.line, f"svg file not found: {f.options['path']}")
    svg = path.read_text(encoding="utf-8")
    if "<svg" not in svg:
        die(f.line, f"{f.options['path']} contains no <svg> element")
    if re.search(r'(?:href|src)\s*=\s*["\']https?://', svg):
        die(
            f.line,
            f"{f.options['path']} references an external URL; "
            f"the report must be self-contained",
        )
    # A deliberate fixed accent (black text on the yellow badge) is fine. What
    # is not fine is an svg with no theme-aware colour at all: it goes invisible
    # in one of the two themes.
    if (
        re.search(r"#[0-9a-fA-F]{3,6}\b", svg)
        and "currentColor" not in svg
        and "var(--" not in svg
    ):
        print(
            f"  warn: {f.options['path']} uses only hardcoded colours; it will "
            f"be invisible in one theme. Use currentColor or var(--token).",
            file=sys.stderr,
        )
    return svg


def build_figures(report: Report, md_dir: Path) -> list[FigureSpec]:
    """Fill in figure_html and collect ECharts specs."""
    specs: list[FigureSpec] = []
    for f in report.findings:
        fig = f.figure
        assert fig is not None
        if fig.kind in ECHARTS_KINDS:
            host_id = f"fig{f.n}"
            tall = "true" if fig.kind == "radar" else "false"
            f.figure_html = (
                f'<div class="echart" id="{host_id}" data-tall="{tall}"></div>'
            )
            specs.append(
                {
                    "id": host_id,
                    "kind": fig.kind,
                    "options": fig.options,
                    "series": fig.series,
                    "rows": fig.table.rows if fig.table else [],
                }
            )
        elif fig.kind == "stack":
            f.figure_html = fig_stack(fig)
        elif fig.kind == "ba":
            f.figure_html = fig_ba(fig)
        elif fig.kind == "matrix":
            f.figure_html = fig_matrix(fig)
        elif fig.kind == "pipeline":
            f.figure_html = fig_pipeline(fig)
        elif fig.kind == "ledger":
            f.figure_html = fig_ledger(fig)
        elif fig.kind == "svg":
            f.figure_html = fig_svg(fig, md_dir)
        elif fig.kind == "none":
            f.figure_html = ""
    return specs


# ---------------------------------------------------------------- gates


@dataclass
class Gates:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def visible_text(html: str) -> str:
    """Strip scripts, styles, computed-number elements, and tags."""
    html = re.sub(r"<script\b.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<style\b.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<svg\b.*?</svg>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(
        r'<[^>]*\bdata-computed="1"[^>]*>.*?</[a-zA-Z]+>', " ", html, flags=re.DOTALL
    )
    html = re.sub(r"<[^>]+>", " ", html)
    html = html.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    html = re.sub(r"&[a-z]+;", " ", html)
    return re.sub(r"\s+", " ", html)


def numbers_in(text: str) -> set[str]:
    return {m.group(0).rstrip(".") for m in re.finditer(r"\d+(?:[.,]\d+)?", text)}


def run_gates(report: Report, html: str, md_text: str, md_name: str) -> Gates:
    g = Gates()

    # --- budgets on the slots that project into the HTML
    if len(report.verdict) > VERDICT_MAX_CHARS:
        g.err(f"verdict is {len(report.verdict)} characters (max {VERDICT_MAX_CHARS})")

    if len(report.findings) > FINDINGS_MAX:
        g.err(
            f"{len(report.findings)} findings (max {FINDINGS_MAX}) — "
            f"regroup them; more than {FINDINGS_MAX} has no headline"
        )

    for pos, f in enumerate(report.findings, start=1):
        if f.n != pos:
            g.err(f"finding numbering jumps to {f.n} at position {pos}")
        hw = words(f.headline)
        if not HEADLINE_MIN_WORDS <= hw <= HEADLINE_MAX_WORDS:
            g.err(
                f"finding {f.n} headline is {hw} words "
                f"(want {HEADLINE_MIN_WORDS}-{HEADLINE_MAX_WORDS}): {f.headline!r}"
            )
        cw = words(f.caption)
        if cw > CAPTION_MAX_WORDS:
            g.err(f"finding {f.n} caption is {cw} words (max {CAPTION_MAX_WORDS})")
        if f.caption.lower().strip(".") == f.headline.lower().strip("."):
            g.err(f"finding {f.n} caption restates the headline")
        low = f.headline.lower()
        for hedge in HEDGE_WORDS:
            if hedge in low:
                g.err(
                    f"finding {f.n} headline hedges ({hedge.strip()!r}); "
                    f"move it to Caveats"
                )

    total_prose = (
        words(report.verdict)
        + sum(words(f.headline) + words(f.caption) for f in report.findings)
        + sum(words(c) for c in report.caveats_shown)
        + sum(words(a) for a in report.actions)
    )
    if total_prose > PROSE_WORDS_TOTAL:
        g.err(f"HTML prose is {total_prose} words (max {PROSE_WORDS_TOTAL})")

    vlow = report.verdict.lower()
    for hedge in HEDGE_WORDS:
        if hedge in vlow:
            g.err(f"verdict hedges ({hedge.strip()!r}); state the conclusion")

    # --- structure
    if report.kpis:
        if len(report.kpis) > KPI_MAX:
            g.err(f"{len(report.kpis)} KPI tiles (max {KPI_MAX})")
        elif len(report.kpis) < KPI_MIN:
            g.warn(f"only {len(report.kpis)} KPI tiles (want at least {KPI_MIN})")
    else:
        g.warn("no '## Key numbers' section — the HTML has no KPI strip")

    if not report.caveats:
        g.err("no '## Caveats' section — a report with no caveats has not been checked")
    if report.caveats_hidden:
        g.warn(
            f"{len(report.caveats_hidden)} caveats are Markdown-only; "
            f"the HTML shows {CAVEATS_SHOWN}"
        )
    if not report.actions:
        g.err(
            "no '## Actions' section — a report with no actions is not a decision instrument"
        )
    elif len(report.actions) > ACTIONS_MAX:
        g.warn(
            f"{len(report.actions)} actions (want at most {ACTIONS_MAX}) — "
            f"a list this long is not a recommendation"
        )

    none_figs = [f.n for f in report.findings if f.figure and f.figure.kind == "none"]
    if none_figs:
        g.warn(
            f"findings {none_figs} have no figure; a chart forces you to "
            f"commit to a claim, prose lets you hedge"
        )
    if len(none_figs) > 1:
        g.err(f"{len(none_figs)} findings have 'Figure: none' (max 1)")

    for f in report.findings:
        if f.figure and f.figure.kind == "pipeline" and f.figure.table:
            n = len(f.figure.table.rows)
            if n > 6:
                g.warn(
                    f"finding {f.n} pipeline has {n} stages; beyond 6 it wraps "
                    f"and strands its arrows"
                )

    # --- self-contained
    for m in re.finditer(r'(?:src|href)\s*=\s*["\'](https?://[^"\']+)', html):
        g.err(f"external reference {m.group(1)} — the report must be self-contained")

    # --- anchors resolve to real headings in the Markdown
    md_slugs = {
        slugify(strip_md(m.group(1)))
        for m in re.finditer(r"^#{1,6}\s+(.+)$", md_text, re.MULTILINE)
    }
    for m in re.finditer(rf'href="{re.escape(md_name)}#([^"]+)"', html):
        if m.group(1) not in md_slugs:
            g.err(
                f"anchor {md_name}#{m.group(1)} does not match any heading; "
                f"a renamed heading breaks it silently"
            )

    # --- no orphan numbers: the HTML must carry no fact absent from the Markdown
    md_numbers = numbers_in(md_text)
    for token in numbers_in(visible_text(html)):
        if token not in md_numbers:
            g.err(f"number {token} appears in the HTML but not in {md_name}")

    # --- register
    text = visible_text(html).lower()
    for bad in BANNED_WORDS:
        if bad in text:
            g.err(f"banned phrase {bad!r} in the rendered report")
    dashes = text.count("—")
    allowed = max(1, total_prose // EM_DASH_PER_WORDS)
    if dashes > allowed:
        g.warn(
            f"{dashes} em dashes for {total_prose} prose words (want at most {allowed})"
        )

    return g


# ---------------------------------------------------------------- render


def render(report: Report, specs: list[FigureSpec], md_name: str) -> str:
    css = (ASSETS / "report.css").read_text(encoding="utf-8")
    charts_js = (ASSETS / "charts.js").read_text(encoding="utf-8")
    echarts_js = ""
    if specs:
        vendor = ASSETS / "vendor" / "echarts.min.js"
        if not vendor.is_file():
            raise ReportError(
                f"{vendor} is missing but the report uses interactive figures "
                f"({', '.join(sorted({str(s['kind']) for s in specs}))}). "
                f"Re-fetch it, or switch those figures to CSS kinds."
            )
        echarts_js = vendor.read_text(encoding="utf-8")

    figures_json = json.dumps(specs, ensure_ascii=False).replace("<", "\\u003c")

    env = Environment(
        autoescape=True,
        undefined=StrictUndefined,
        trim_blocks=False,
        lstrip_blocks=False,
    )
    tpl = env.from_string((ASSETS / "template.html.jinja").read_text(encoding="utf-8"))

    # Figure HTML is generated by this script, not user input, so it is marked
    # safe. Every value that came out of report.md is still autoescaped.
    for f in report.findings:
        f.figure_html = Markup(f.figure_html)

    return str(
        tpl.render(
            report=report,
            md_name=md_name,
            css=Markup(css),
            charts_js=Markup(charts_js),
            echarts_js=Markup(echarts_js),
            figures_json=Markup(figures_json),
        )
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("source", type=Path, help="path to report.md")
    ap.add_argument(
        "-o",
        "--out",
        type=Path,
        default=None,
        help="output HTML path (default: alongside the source)",
    )
    ap.add_argument(
        "--check", action="store_true", help="run the gates and write nothing"
    )
    args = ap.parse_args()

    if not args.source.is_file():
        print(f"error: {args.source} not found", file=sys.stderr)
        return 2

    md_text = args.source.read_text(encoding="utf-8")
    try:
        report = parse(md_text)
        specs = build_figures(report, args.source.parent)
        html = render(report, specs, args.source.name)
    except ReportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    gates = run_gates(report, html, md_text, args.source.name)

    for w in gates.warnings:
        print(f"  warn: {w}", file=sys.stderr)
    for e in gates.errors:
        print(f"  FAIL: {e}", file=sys.stderr)

    if gates.errors:
        print(
            f"\n{len(gates.errors)} gate failure(s); nothing written.", file=sys.stderr
        )
        return 1

    kb = len(html.encode("utf-8")) / 1024
    interactive = len(specs)
    print(
        f"ok: {len(report.findings)} findings, {interactive} interactive "
        f"figure(s), {len(report.findings) - interactive} static, "
        f"{kb:.0f} KB"
    )
    if gates.warnings:
        print(f"    {len(gates.warnings)} warning(s) above — read them.")

    if args.check:
        print("    --check: nothing written.")
        return 0

    out = args.out or args.source.with_suffix(".html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"    wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

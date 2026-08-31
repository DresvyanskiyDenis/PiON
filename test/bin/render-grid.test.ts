/**
 * `config/bin/render-grid` — the affordance behind AGENTS.md's "character-grid output is computed,
 * never composed" TRIGGER, exercised as a real OS process the way `test/bin/pi-tier.test.ts`
 * exercises its subject.
 *
 * The property under test is the one the freehand path cannot hold, so every case asserts it the
 * same way a reader would: **the printed lines are all the same length, and the vertical rules land
 * in identical columns on every row**. A test that only compared a golden string would still pass
 * if the arithmetic drifted in two places at once; comparing columns is what the script exists for.
 *
 * The refusals matter as much as the renders: a spec this script cannot render exactly must exit 2
 * and name the field, never print a grid that is quietly misaligned.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const RENDER_GRID = fileURLToPath(new URL("../../config/bin/render-grid", import.meta.url));

interface Run {
  readonly status: number;
  readonly lines: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

function run(spec: unknown, args: readonly string[] = []): Run {
  const result = spawnSync(process.execPath, [RENDER_GRID, ...args], {
    input: typeof spec === "string" ? spec : JSON.stringify(spec),
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  return {
    status: result.status ?? -1,
    lines: stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n"),
    stdout,
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Every column index at which the given rule character appears, per line. */
function columnsOf(line: string, mark: string): number[] {
  return [...line].flatMap((ch, i) => (ch === mark ? [i] : []));
}

describe("render-grid — table", () => {
  it("pads every column to one width, so the cells of a row start in the same column on every line", () => {
    const out = run({
      type: "table",
      rows: [
        ["run", "cost", "verdict"],
        ["a", "0.19", "misaligned"],
        ["bbbb", "0.192676", "misaligned"],
      ],
      header: true,
      align: ["left", "right", "left"],
    });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.lines, [
      "run       cost  verdict",
      "----  --------  ----------",
      "a         0.19  misaligned",
      "bbbb  0.192676  misaligned",
    ]);
    // The property, stated independently of the golden text above: the right-aligned column ends
    // in the same place on every row, whatever the cell widths were.
    for (const line of out.lines) assert.equal(line.slice(6, 14).length, 8, line);
    assert.equal(out.lines[0].indexOf("cost"), 10);
    assert.equal(out.lines[2].indexOf("0.19"), 10);
  });

  it("a bordered table puts every vertical rule in the same column on every line", () => {
    const out = run({
      type: "table",
      rows: [
        ["run", "cost"],
        ["a", "0.19"],
        ["longer", "0.192676"],
      ],
      header: true,
      border: "unicode",
    });
    assert.equal(out.status, 0, out.stderr);
    const body = out.lines.filter((l) => l.includes("│"));
    const first = columnsOf(body[0], "│");
    assert.equal(first.length, 3, body[0]);
    for (const line of body) assert.deepEqual(columnsOf(line, "│"), first, line);
    const lengths = new Set(out.lines.map((l) => [...l].length));
    assert.equal(lengths.size, 1, `every line is one width: ${[...lengths].join(", ")}`);
  });

  it("the ascii border draws with + and | only, for terminals that mangle box drawing", () => {
    const out = run({ type: "table", rows: [["a", "b"]], border: "ascii" });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.lines, ["+---+---+", "| a | b |", "+---+---+"]);
  });

  it("a short row is padded, not misaligned, when rows differ in length", () => {
    const out = run({ type: "table", rows: [["a", "b", "c"], ["x"]], border: "ascii" });
    assert.equal(out.status, 0, out.stderr);
    const body = out.lines.filter((l) => l.includes("|"));
    assert.equal(body.length, 2, out.stdout);
    for (const line of body) assert.deepEqual(columnsOf(line, "|"), columnsOf(body[0], "|"), line);
    assert.equal(body[1], "| x |   |   |", "the missing cells are padded, not dropped");
  });
});

describe("render-grid — spans", () => {
  it("renders a two-track boundary diagram: every cell boundary lands on a multiple of cellWidth", () => {
    const out = run({
      type: "spans",
      cells: 15,
      cellWidth: 5,
      labelWidth: 12,
      ruler: true,
      rows: [
        { label: "gold", spans: [{ text: "d1", from: 1, to: 6 }, { text: "d2", from: 7, to: 15 }] },
        { label: "predicted", spans: [{ text: "d1", from: 1, to: 4 }, { text: "d2", from: 5, to: 15 }] },
      ],
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.lines.length, 3, out.stdout);
    const closing = 12 + 15 * 5 - 1; // the one bar that closes the track instead of opening a cell
    for (const line of out.lines.slice(0, 2)) {
      for (const column of columnsOf(line, "|")) {
        if (column === closing) continue;
        assert.equal((column - 12) % 5, 0, `bar at column ${column} is not on a cell boundary: ${line}`);
      }
      assert.equal(line.length, closing + 1, line);
    }
    assert.equal(out.lines[0].startsWith("gold        |"), true, out.lines[0]);
    assert.equal(out.lines[2].trim().startsWith("1"), true, out.lines[2]);
  });

  it("a span's text is centred inside its own range and never leaks into the neighbour", () => {
    const out = run({
      type: "spans",
      cells: 4,
      cellWidth: 4,
      labelWidth: 0,
      rows: [{ label: "", spans: [{ text: "ab", from: 1, to: 2 }, { text: "cd", from: 3, to: 4 }] }],
    });
    assert.equal(out.status, 0, out.stderr);
    // Each span opens with its own bar and the track closes with one, so every cell stays exactly
    // cellWidth wide: bars at 0, 8 and 15 for two two-cell spans of width 4.
    assert.deepEqual(out.lines, ["|  ab   |  cd  |"]);
    assert.deepEqual(columnsOf(out.lines[0], "|"), [0, 8, 15]);
  });

  it("refuses a text wider than the span rather than printing a span that swallows its bar", () => {
    const out = run({ type: "spans", cells: 2, cellWidth: 3, rows: [{ label: "x", spans: [{ text: "abcdef", from: 1, to: 1 }] }] });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /rows\[0\]\.spans\[0\]\.text: .*needs 6 columns, the span holds 2/);
    assert.equal(out.stdout, "", "nothing is printed when the grid cannot be exact");
  });

  it("refuses overlapping spans, naming both, because the later one would silently win", () => {
    const out = run({ type: "spans", cells: 4, rows: [{ label: "x", spans: [{ text: "a", from: 1, to: 2 }, { text: "b", from: 2, to: 3 }] }] });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /rows\[0\]\.spans\[1\]: overlaps rows\[0\]\.spans\[0\] at cell 2/);
  });

  it("refuses a span past the last cell", () => {
    const out = run({ type: "spans", cells: 3, rows: [{ label: "x", spans: [{ text: "a", from: 2, to: 4 }] }] });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /to \(4\) is past cells \(3\)/);
  });
});

describe("render-grid — refusals", () => {
  it("refuses a double-width character, which would align by code point and print misaligned", () => {
    const out = run({ type: "table", rows: [["日本", "x"], ["a", "b"]] });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /rows\[0\]\[0\]: contains a double-width character/);
    assert.equal(out.stdout, "");
  });

  it("refuses an unknown type by name, instead of guessing a renderer", () => {
    const out = run({ type: "chart", rows: [] });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /type: must be "table" or "spans", got "chart"/);
  });

  it("refuses input that is not JSON, and says so as input rather than as a crash", () => {
    const out = run("not json at all");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /input is not JSON/);
  });

  it("--help prints both input shapes and exits 0, so the shape need not be guessed from a failure", () => {
    const out = run("", ["--help"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /"type":"table"/);
    assert.match(out.stdout, /"type":"spans"/);
  });
});

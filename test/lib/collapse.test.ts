/**
 * `collapseCompleted`: a worked todo-panel example, generalised.
 * ```
 * ▾ Todos  3 done ▸
 *   ○ Derive scoring ranges from authoritative annotations
 * ```
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseCompleted } from "../../extensions/lib/collapse.ts";

interface Item {
  readonly text: string;
  readonly done: boolean;
}

const isDone = (item: Item): boolean => item.done;
const render = (item: Item): string => item.text;

describe("collapseCompleted", () => {
  it("matches the worked example exactly", () => {
    const items: Item[] = [
      { text: "a", done: true },
      { text: "b", done: true },
      { text: "c", done: true },
      { text: "○ Derive scoring ranges from authoritative annotations", done: false },
    ];
    const lines = collapseCompleted(items, isDone, render, "Todos");
    assert.deepEqual(lines, [
      "▾ Todos  3 done ▸",
      "  ○ Derive scoring ranges from authoritative annotations",
    ]);
  });

  it("open items keep their own order, unaffected by where the done ones sat", () => {
    const items: Item[] = [
      { text: "open-1", done: false },
      { text: "done-1", done: true },
      { text: "open-2", done: false },
    ];
    const lines = collapseCompleted(items, isDone, render, "L");
    assert.deepEqual(lines, ["▾ L  1 done ▸", "  open-1", "  open-2"]);
  });

  it("nothing done: header carries no count and no expand marker — there is nothing to expand", () => {
    const items: Item[] = [{ text: "open-1", done: false }];
    const lines = collapseCompleted(items, isDone, render, "L");
    assert.deepEqual(lines, ["▾ L", "  open-1"]);
  });

  it("everything done: header alone, no open rows", () => {
    const items: Item[] = [
      { text: "a", done: true },
      { text: "b", done: true },
    ];
    assert.deepEqual(collapseCompleted(items, isDone, render, "L"), ["▾ L  2 done ▸"]);
  });

  it("empty list: header alone, no count", () => {
    assert.deepEqual(collapseCompleted([], isDone, render, "L"), ["▾ L"]);
  });
});

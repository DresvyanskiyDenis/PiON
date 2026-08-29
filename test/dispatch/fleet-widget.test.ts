/**
 * EXT-05 — the async fleet as a live panel.
 *
 * Two properties carry the weight here and neither is checkable by reading the module: that the
 * panel never appears outside the TUI, and that the poll it needs to stay live leaves no timer
 * behind. Both are measured, not asserted in prose.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAsyncFleet, noteAsyncSpawn, type AsyncFleet } from "../../extensions/dispatch/async-fleet.ts";
import {
  createFleetWidget,
  displayWidth,
  fitLine,
  MAX_PANEL_LINES,
  panelWidth,
  renderFleetPanel,
  WIDGET_KEY,
} from "../../extensions/dispatch/fleet-widget.ts";
import { scratch } from "./helpers.ts";

const RUN = "66971211-3f09-48ca-bdea-c2be3950a845";
const OTHER = "9c1d77aa-1111-4222-8333-b44444444444";
const GHOST = "aaaaaaaa-0000-4000-8000-000000000000";
const ESC = "\u001b";

let root: string;

beforeEach(() => {
  root = scratch("ext05-fleet-widget-");
});

function runDir(runId: string, status?: Record<string, unknown>): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  if (status !== undefined) writeFileSync(join(dir, "status.json"), JSON.stringify(status), "utf8");
  return dir;
}

function spawnResult(runId: string, asyncDir: string, agent: string): unknown {
  return {
    content: [{ type: "text", text: `Async: ${agent} [${runId}]` }],
    details: { mode: "single", runId, results: [], asyncId: runId, asyncDir, context: "fresh" },
  };
}

function fleetWith(...runs: ReadonlyArray<readonly [string, string, string]>): AsyncFleet {
  const fleet = createAsyncFleet();
  for (const [runId, dir, agent] of runs) noteAsyncSpawn(fleet, spawnResult(runId, dir, agent), 0);
  return fleet;
}

type Painted = { key: string; content: string[] | undefined };

function ctxFor(mode: ExtensionContext["mode"], painted: Painted[]): ExtensionContext {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      setWidget: (key: string, content: string[] | undefined) => {
        painted.push({ key, content });
      },
    },
  } as unknown as ExtensionContext;
}

/** Counts intervals created and still open, by wrapping the globals for the duration of `body`. */
function withTimerAudit(body: () => void): { created: number; live: number } {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const open = new Set<unknown>();
  let created = 0;
  (globalThis as { setInterval: unknown }).setInterval = (...args: unknown[]) => {
    created += 1;
    const handle = (realSet as (...a: unknown[]) => unknown)(...args);
    open.add(handle);
    return handle;
  };
  (globalThis as { clearInterval: unknown }).clearInterval = (handle: unknown) => {
    open.delete(handle);
    return (realClear as (h: unknown) => unknown)(handle);
  };
  try {
    body();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    for (const handle of open) realClear(handle as ReturnType<typeof setInterval>);
  }
  return { created, live: open.size };
}

describe("renderFleetPanel", () => {
  it("shows nothing at all when no run has been dispatched", () => {
    assert.equal(renderFleetPanel(createAsyncFleet()), undefined);
  });

  it("reads each run's own status file rather than remembering a state", () => {
    const dir = runDir(RUN, { runId: RUN, state: "running", mode: "single" });
    const fleet = fleetWith([RUN, dir, "data-engineer"]);
    assert.match(renderFleetPanel(fleet)!.join("\n"), /▸ data-engineer \[66971211\] running/);

    writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: RUN, state: "complete", mode: "single" }));
    const after = renderFleetPanel(fleet)!.join("\n");
    assert.match(after, /✓ data-engineer \[66971211\] complete/);
    assert.doesNotMatch(after, /running/);
  });

  it("separates a failure and a run that never started from a clean finish", () => {
    const okDir = runDir(RUN, { runId: RUN, state: "complete", mode: "single" });
    const badDir = runDir(OTHER, { runId: OTHER, state: "failed", mode: "single", error: "boom" });
    const ghostDir = runDir(GHOST);
    const fleet = fleetWith([RUN, okDir, "reviewer"], [OTHER, badDir, "debugger"], [GHOST, ghostDir, "researcher"]);
    const lines = renderFleetPanel(fleet)!;
    assert.match(lines[0]!, /2 needs attention/);
    assert.match(lines[0]!, /1 done/);
    assert.match(lines.join("\n"), /✗ debugger \[9c1d77aa\] failed/);
    assert.match(lines.join("\n"), /\? researcher \[aaaaaaaa\] NEVER STARTED/);
  });

  it("distinguishes the outcomes without colour, so a screenshot still reads", () => {
    const lines = renderFleetPanel(
      fleetWith(
        [RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"],
        [OTHER, runDir(OTHER, { runId: OTHER, state: "failed", mode: "single" }), "b"],
        [GHOST, runDir(GHOST), "c"],
      ),
    )!;
    const rows = lines.slice(1);
    assert.ok(!lines.join("").includes(ESC), "the panel emits ANSI, which is a colour-only channel");
    assert.equal(new Set(rows.map((l) => l.trim()[0])).size, 3, "two states share a glyph");
  });
});

describe("createFleetWidget", () => {
  it("paints above the editor under one key, so a repaint replaces rather than stacks", () => {
    const painted: Painted[] = [];
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"]);
    const widget = createFleetWidget(fleet, 50);
    const ctx = ctxFor("tui", painted);
    widget.refresh(ctx);
    widget.refresh(ctx);
    widget.dispose(ctx);
    assert.deepEqual(new Set(painted.map((p) => p.key)), new Set([WIDGET_KEY]));
  });

  it("does nothing outside the TUI — not even in rpc mode, where hasUI is true", () => {
    // `hasUI` is true in RPC mode (`core/extensions/types.d.ts:215`) but there is no editor there
    // for a widget to sit above, so `hasUI` is the wrong guard and `mode` is the right one.
    for (const mode of ["rpc", "print", "json"] as const) {
      const painted: Painted[] = [];
      const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"]);
      const audit = withTimerAudit(() => {
        const widget = createFleetWidget(fleet, 50);
        const ctx = ctxFor(mode, painted);
        widget.refresh(ctx);
        widget.dispose(ctx);
      });
      assert.deepEqual(painted, [], `${mode} mode painted a widget`);
      assert.equal(audit.created, 0, `${mode} mode started a poll`);
    }
  });

  it("clears the panel when there is nothing to show, and again on dispose", () => {
    const painted: Painted[] = [];
    const widget = createFleetWidget(createAsyncFleet(), 50);
    const ctx = ctxFor("tui", painted);
    widget.refresh(ctx);
    assert.deepEqual(painted, [{ key: WIDGET_KEY, content: undefined }]);
    widget.dispose(ctx);
    assert.equal(painted.at(-1)!.content, undefined);
  });

  it("starts no poll while the fleet is empty", () => {
    const painted: Painted[] = [];
    const audit = withTimerAudit(() => {
      const widget = createFleetWidget(createAsyncFleet(), 50);
      const ctx = ctxFor("tui", painted);
      widget.refresh(ctx);
      widget.dispose(ctx);
    });
    assert.equal(audit.created, 0, "an idle session is carrying a timer");
  });

  it("polls once, not once per refresh, and leaves no timer behind", () => {
    const painted: Painted[] = [];
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"]);
    const audit = withTimerAudit(() => {
      const widget = createFleetWidget(fleet, 20);
      const ctx = ctxFor("tui", painted);
      widget.refresh(ctx);
      widget.refresh(ctx);
      widget.refresh(ctx);
      widget.dispose(ctx);
      widget.dispose(ctx);
    });
    assert.equal(audit.created, 1, "each refresh started its own poll");
    assert.equal(audit.live, 0, "dispose left a timer running");
  });

  it("stops its own poll when the last run is gone, without waiting for dispose", async () => {
    const painted: Painted[] = [];
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"]);
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const open = new Set<unknown>();
    (globalThis as { setInterval: unknown }).setInterval = (...args: unknown[]) => {
      const handle = (realSet as (...a: unknown[]) => unknown)(...args);
      open.add(handle);
      return handle;
    };
    (globalThis as { clearInterval: unknown }).clearInterval = (handle: unknown) => {
      open.delete(handle);
      return (realClear as (h: unknown) => unknown)(handle);
    };
    try {
      const widget = createFleetWidget(fleet, 10);
      widget.refresh(ctxFor("tui", painted));
      assert.equal(open.size, 1);
      fleet.tracked.clear();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(open.size, 0, "the poll outlived the fleet it was polling");
      assert.equal(painted.at(-1)!.content, undefined, "the panel outlived the fleet");
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      for (const handle of open) realClear(handle as ReturnType<typeof setInterval>);
    }
  });
});

/**
 * Two things make a widget block move on screen, and neither is about what it says.
 *
 * One is height: a line more or fewer, or a line long enough to wrap, and everything below it
 * walks. The other is ORDER — `setWidget` re-inserts this widget's key on every call, which
 * re-orders it against any other widget at the same placement, so a repaint that changes nothing
 * is still a visible event. These measure both.
 */
describe("the panel as a fixed block on the screen", () => {
  function fleetOf(count: number): AsyncFleet {
    const fleet = createAsyncFleet();
    for (let i = 0; i < count; i += 1) {
      const id = `${String(i).repeat(8)}-0000-4000-8000-000000000000`;
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      if (i % 2 === 0) {
        writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: id, state: "running", mode: "single" }));
      }
      noteAsyncSpawn(fleet, spawnResult(id, dir, `a${i}`), 0);
    }
    return fleet;
  }

  it("never asks the host to draw more lines than the host will draw", () => {
    for (let count = 1; count <= 14; count += 1) {
      const lines = renderFleetPanel(fleetOf(count))!;
      assert.ok(
        lines.length <= MAX_PANEL_LINES,
        `${count} runs produced ${lines.length} lines, past the host ceiling of ${MAX_PANEL_LINES}`,
      );
    }
  });

  it("says how many runs it is not showing rather than dropping them in silence", () => {
    assert.equal(renderFleetPanel(fleetOf(9))!.length, MAX_PANEL_LINES);
    const twelve = renderFleetPanel(fleetOf(12))!;
    assert.equal(twelve.length, MAX_PANEL_LINES);
    assert.match(twelve.at(-1)!, /… and 4 more/);
  });

  it("never emits a line that would wrap into a second row", () => {
    const id = "77777777-0000-4000-8000-000000000000";
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: id, state: "x".repeat(400), mode: "single" }));
    const fleet = createAsyncFleet();
    noteAsyncSpawn(fleet, spawnResult(id, dir, "agent-with-a-very-long-name".repeat(10)), 0);
    for (const width of [20, 40, 80, 200]) {
      for (const line of renderFleetPanel(fleet, width)!) {
        assert.ok(displayWidth(line) <= width, `a ${displayWidth(line)}-column line at width ${width}`);
      }
    }
  });

  it("measures a line in terminal columns, not in UTF-16 code units", () => {
    assert.equal(displayWidth("日本語"), 6, "three CJK ideographs are six columns, not three");
    assert.equal(displayWidth("🚀"), 2);
    assert.equal("🚀".length, 2, "the ruler String.length would have used");
    // e + U+0301: one column, two code units. And a ZWJ family: many code points, one grapheme.
    assert.equal(displayWidth("e\u0301"), 1);
    assert.equal(displayWidth("👩‍👩‍👧"), 2);
    for (const text of ["日本語".repeat(40), "🚀".repeat(40), "e\u0301".repeat(40)]) {
      for (const width of [20, 41, 80]) assert.ok(displayWidth(fitLine(text, width)) <= width);
    }
    assert.equal(fitLine("日本語", 6), "日本語", "a line that already fits is left alone");
    assert.equal(fitLine("abcdef", 4), "abc…");
    assert.equal(panelWidth(120), 118);
    assert.equal(panelWidth(undefined), 78);
  });

  it("does not repaint — and so does not re-order itself — when nothing changed", () => {
    const id = "88888888-0000-4000-8000-000000000000";
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: id, state: "running", mode: "single" }));
    const fleet = createAsyncFleet();
    noteAsyncSpawn(fleet, spawnResult(id, dir, "reviewer"), 0);

    const painted: Painted[] = [];
    const widget = createFleetWidget(fleet, 50);
    const ctx = ctxFor("tui", painted);
    widget.refresh(ctx);
    assert.equal(painted.length, 1);
    widget.refresh(ctx);
    widget.refresh(ctx);
    assert.equal(painted.length, 1, "an unchanged panel was written to the host again");

    writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: id, state: "complete", mode: "single" }));
    widget.refresh(ctx);
    assert.equal(painted.length, 2, "a changed panel was not repainted");
    widget.dispose(ctx);
    assert.equal(painted.at(-1)!.content, undefined);
  });
});

/**
 * The consequence of the fleet never cleaning up, measured on the widget rather than argued about.
 *
 * `renderFleetPanel` returns `undefined` only at `tracked.size === 0`, and that `undefined` is the
 * one signal `refresh` stops its poll on. While terminal runs accumulated forever, a session that
 * had dispatched a single async run kept a 1 Hz timer — and a status-file read per tracked run on
 * every one of its ticks — until it exited. The sweep in `paint` is what ends that.
 */
describe("retiring settled runs from the panel", () => {
  /** Marks `runId` announced and settled long enough ago that the TTL has already elapsed. */
  function settledLongAgo(fleet: AsyncFleet, runId: string): void {
    fleet.announced.add(runId);
    fleet.settledAt.set(runId, 0);
  }

  it("clears the panel and starts no poll once the last settled run is retired", () => {
    const painted: Painted[] = [];
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "complete", mode: "single" }), "a"]);
    settledLongAgo(fleet, RUN);
    const audit = withTimerAudit(() => {
      const widget = createFleetWidget(fleet, 50);
      const ctx = ctxFor("tui", painted);
      widget.refresh(ctx);
      widget.dispose(ctx);
    });
    assert.equal(fleet.tracked.size, 0, "the settled run was not retired");
    assert.deepEqual(painted[0], { key: WIDGET_KEY, content: undefined }, "the panel did not go away");
    assert.equal(audit.created, 0, "a session with nothing left to watch is carrying a timer");
  });

  it("keeps painting the running child after the finished one is retired", () => {
    const painted: Painted[] = [];
    const fleet = fleetWith(
      [RUN, runDir(RUN, { runId: RUN, state: "complete", mode: "single" }), "done"],
      [OTHER, runDir(OTHER, { runId: OTHER, state: "running", mode: "single" }), "busy"],
    );
    settledLongAgo(fleet, RUN);
    const widget = createFleetWidget(fleet, 50);
    const ctx = ctxFor("tui", painted);
    widget.refresh(ctx);
    widget.dispose(ctx);

    assert.deepEqual([...fleet.tracked.keys()], [OTHER]);
    const lines = painted[0]!.content!;
    assert.ok(lines.some((line) => line.includes("busy")), "the running child is not on the panel");
    assert.ok(!lines.some((line) => line.includes("done")), "the retired run is still on the panel");
    assert.match(lines[0]!, /1 running/, "the header still counts the retired run");
    assert.doesNotMatch(lines[0]!, /done/, "the header still counts the retired run");
  });

  it("leaves a run that finished but was never reported on the panel", () => {
    const painted: Painted[] = [];
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "failed", mode: "single" }), "a"]);
    const widget = createFleetWidget(fleet, 50);
    const ctx = ctxFor("tui", painted);
    widget.refresh(ctx);
    widget.refresh(ctx);
    widget.dispose(ctx);
    assert.equal(fleet.tracked.size, 1, "a failure nobody has been told about was swept away");
  });
});

/**
 * The panel is a display, not a control.
 *
 * Reported as "after `/compact` the panel is still displayed but the down arrow no longer selects
 * the async runs", with a prescribed fix of repainting this widget from a `session_compact`
 * handler. The panel was never selectable: the host wraps a `string[]` widget in a `Container` of
 * `Text` components, which has no `handleInput`, and no repaint can change that. These two lock the
 * properties the module header argues from, so a later move to a component factory — the only
 * widget shape that can take a keypress — has to come past this test rather than quietly making
 * that paragraph false.
 */
describe("the panel is a display, not a control", () => {
  /** A context that records everything the widget asks of `ui`, not only what it paints. */
  function spyCtx(): { ctx: ExtensionContext; widgets: Array<{ content: unknown; options: unknown }>; asked: string[] } {
    const widgets: Array<{ content: unknown; options: unknown }> = [];
    const asked: string[] = [];
    const ui = new Proxy(
      {
        setWidget: (_key: string, content: unknown, options: unknown) => {
          widgets.push({ content, options });
        },
      } as Record<string, unknown>,
      {
        get(target, property: string) {
          asked.push(property);
          return target[property];
        },
      },
    );
    return { ctx: { mode: "tui", hasUI: true, ui } as unknown as ExtensionContext, widgets, asked };
  }

  it("publishes a line array, never a component factory", () => {
    const { ctx, widgets } = spyCtx();
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"]);
    const widget = createFleetWidget(fleet, 50);
    widget.refresh(ctx);
    widget.dispose(ctx);

    const shown = widgets.filter((call) => call.content !== undefined);
    assert.equal(shown.length, 1, "the panel was painted more than once for one refresh");
    assert.ok(Array.isArray(shown[0]!.content), "the panel published something other than a line array");
    assert.ok(
      (shown[0]!.content as unknown[]).every((line) => typeof line === "string"),
      "the panel published a non-string among its lines",
    );
    assert.deepEqual(shown[0]!.options, { placement: "aboveEditor" });
  });

  it("never subscribes to the keyboard or asks for focus", () => {
    // Selection lives in `pi-subagents`' fleet view, which is left enabled —
    // `config/subagent.default.json` turns off `asyncWidget`, not `fleetView`. This panel takes
    // neither of the two shapes that could consume a keypress, and a `/compact` handler here would
    // not have given it either.
    const { ctx, asked } = spyCtx();
    const fleet = fleetWith([RUN, runDir(RUN, { runId: RUN, state: "running", mode: "single" }), "a"]);
    const widget = createFleetWidget(fleet, 50);
    widget.refresh(ctx);
    widget.refresh(ctx);
    widget.dispose(ctx);
    assert.deepEqual([...new Set(asked)], ["setWidget"], `the panel reached for more than setWidget: ${asked}`);
  });
});

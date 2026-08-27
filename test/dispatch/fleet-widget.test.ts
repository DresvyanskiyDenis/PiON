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
import { createFleetWidget, renderFleetPanel, WIDGET_KEY } from "../../extensions/dispatch/fleet-widget.ts";
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

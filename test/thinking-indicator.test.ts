import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  framesForLevel,
  indicatorFor,
  INTERVAL_MS,
  LEVELS,
  normaliseLevel,
  painterFor,
  RAMP,
  register,
} from "../extensions/thinking-indicator.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const globals = globalThis as unknown as Record<symbol, unknown>;

/** Stands in for the live `Theme`, painting each level with a tag we can read back out. */
function installFakeTheme(): void {
  globals[THEME_KEY] = {
    getThinkingBorderColor: (level: string) => (str: string) => `<${level}>${str}</${level}>`,
  };
}

type Recorded = { frames?: string[]; intervalMs?: number } | undefined;

/** A fake `pi` + `ctx` pair that records every `setWorkingIndicator` call, in order. */
function harness(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const calls: Recorded[] = [];
  const pi = {
    on: (event: string, handler: (e: unknown, c: ExtensionContext) => void) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      setWorkingIndicator: (options?: Recorded) => {
        calls.push(options);
      },
    },
  } as unknown as ExtensionContext & { thinkingLevel?: string };

  const fire = (event: string, payload: unknown = {}) => {
    const handler = handlers.get(event);
    assert.ok(handler, `no handler registered for ${event}`);
    handler(payload, ctx);
  };
  return { pi, ctx, calls, fire, handlers };
}

afterEach(() => {
  delete globals[THEME_KEY];
});

describe("thinking-indicator: the ramp", () => {
  it("gives every level a distinct pair of frames", () => {
    installFakeTheme();
    const seen = LEVELS.map((l) => framesForLevel(l, painterFor(l)).join("|"));
    assert.equal(new Set(seen).size, LEVELS.length, "two levels render the same indicator");
  });

  it("rises monotonically: the ramp index is the level's rank", () => {
    const heights = LEVELS.map((l) => RAMP.indexOf(framesForLevel(l, (s) => s)[0]!));
    assert.deepEqual(heights, [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(RAMP.length > LEVELS.length, "the top level has no second frame to pulse to");
  });

  it("gives every level a distinct colour, taken from the live theme", () => {
    installFakeTheme();
    const painted = LEVELS.map((l) => framesForLevel(l, painterFor(l))[0]!);
    assert.equal(new Set(painted).size, LEVELS.length);
    // The colour is the theme's own thinking-border colour for that level, not a second palette:
    // whatever the editor border shows, the spinner shows.
    assert.match(painted[LEVELS.indexOf("max")]!, /^<max>/);
  });

  it("renders unstyled rather than throwing when no theme is installed", () => {
    assert.equal(globals[THEME_KEY], undefined);
    const frames = framesForLevel("high", painterFor("high"));
    assert.deepEqual(frames, [RAMP[4], RAMP[5]]);
  });

  it("normalises an unknown level onto the floor instead of indexing off the ramp", () => {
    for (const bogus of [undefined, null, "", "ultra", 3]) {
      assert.equal(normaliseLevel(bogus), "off");
    }
    assert.deepEqual(framesForLevel(normaliseLevel("ultra"), (s) => s), [RAMP[0], RAMP[1]]);
  });

  it("animates inside the 150–300 ms band, with exactly two frames", () => {
    for (const level of LEVELS) {
      const options = indicatorFor(level);
      assert.equal(options.frames.length, 2, `${level} is not a two-frame pulse`);
      assert.ok(
        options.intervalMs >= 150 && options.intervalMs <= 300,
        `${level} animates at ${options.intervalMs}ms`,
      );
    }
    assert.equal(INTERVAL_MS, 280);
  });
});

describe("thinking-indicator: register", () => {
  it("applies the level at session_start and again on every thinking_level_select", () => {
    installFakeTheme();
    const { pi, ctx, calls, fire } = harness();
    register(pi);
    (ctx as { thinkingLevel?: string }).thinkingLevel = "medium";

    fire("session_start", { type: "session_start", reason: "startup" });
    assert.match(calls[0]!.frames![0]!, /<medium>/);

    fire("thinking_level_select", { type: "thinking_level_select", level: "max", previousLevel: "medium" });
    assert.match(calls[1]!.frames![0]!, /<max>/);
    assert.equal(calls.length, 2);
  });

  it("re-applies at session_start, because a session replacement resets the indicator", () => {
    // `interactive-mode.js:1695` calls `setWorkingIndicator()` with no argument on every reset, so
    // a module that only applied once at registration would render the default from then on.
    installFakeTheme();
    const { pi, ctx, calls, fire } = harness();
    register(pi);
    (ctx as { thinkingLevel?: string }).thinkingLevel = "low";
    fire("session_start", { type: "session_start", reason: "startup" });
    fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.frames![0]!, /<low>/);
  });

  it("is a no-op outside the TUI, where there is no loader to configure", () => {
    installFakeTheme();
    for (const mode of ["rpc", "print", "json"] as const) {
      const { pi, ctx, calls, fire } = harness(mode);
      register(pi);
      (ctx as { thinkingLevel?: string }).thinkingLevel = "high";
      fire("session_start", { type: "session_start", reason: "startup" });
      fire("thinking_level_select", { type: "thinking_level_select", level: "max", previousLevel: "high" });
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      assert.deepEqual(calls, [], `${mode} mode touched the working indicator`);
    }
  });

  it("hands the spinner back at session_shutdown", () => {
    installFakeTheme();
    const { pi, ctx, calls, fire } = harness();
    register(pi);
    (ctx as { thinkingLevel?: string }).thinkingLevel = "xhigh";
    fire("session_start", { type: "session_start", reason: "startup" });
    fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    assert.equal(calls.at(-1), undefined, "custom frames outlived the module that set them");
  });

  it("leaks no timer of its own across a full lifecycle", () => {
    // The animation belongs to `pi-tui`'s `Loader`, which owns the interval and clears it in
    // `dispose()`. This module must therefore create none — the assertion is what makes that a
    // fact rather than a comment in the docstring.
    installFakeTheme();
    const realSetInterval = globalThis.setInterval;
    const realSetTimeout = globalThis.setTimeout;
    let created = 0;
    (globalThis as { setInterval: unknown }).setInterval = (...args: unknown[]) => {
      created += 1;
      return (realSetInterval as (...a: unknown[]) => unknown)(...args);
    };
    (globalThis as { setTimeout: unknown }).setTimeout = (...args: unknown[]) => {
      created += 1;
      return (realSetTimeout as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const { pi, ctx, fire } = harness();
      register(pi);
      (ctx as { thinkingLevel?: string }).thinkingLevel = "off";
      fire("session_start", { type: "session_start", reason: "startup" });
      for (const level of LEVELS) {
        fire("thinking_level_select", { type: "thinking_level_select", level, previousLevel: "off" });
      }
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(created, 0, "this module scheduled work of its own, and nothing disposes it");
  });

  it("survives a ui that throws, leaving the default spinner rather than the session", () => {
    installFakeTheme();
    const { pi, ctx, fire } = harness();
    (ctx.ui as { setWorkingIndicator: unknown }).setWorkingIndicator = () => {
      throw new Error("no loader");
    };
    register(pi);
    assert.doesNotThrow(() => fire("session_start", { type: "session_start", reason: "startup" }));
    assert.doesNotThrow(() => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }));
  });
});

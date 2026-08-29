// The three commands, the statusline, and the two ways a mask has to survive: `/compact` (replayed
// from the session entry) and a fork or switch (replayed the same way, in a runtime that never saw
// the command). The fake `pi` here is the one from `test/path-rules/index.test.ts`, extended with
// the tool-list members this module actually calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  __resetForTests,
  __state,
  activeMask,
  id,
  register,
  renderStatus,
  requestTurnMask,
  STATE_ENTRY,
  STATUS_KEY,
} from "../../extensions/tool-masks/index.ts";

const FULL = ["read", "bash", "edit", "write", "grep", "find", "ls", "expand_result", "web_search"];

interface Harness {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  active: string[];
  entries: Array<{ type: string; customType: string; data: unknown }>;
  status: Array<string | undefined>;
  commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>;
  run(command: string): Promise<void>;
  fire(event: string, payload?: unknown): void;
}

function harness(initial: readonly string[] = FULL): Harness {
  const h = {
    active: [...initial],
    entries: [] as Array<{ type: string; customType: string; data: unknown }>,
    status: [] as Array<string | undefined>,
    commands: new Map(),
    handlers: new Map(),
  } as unknown as Harness;

  h.pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      h.commands.set(name, options.handler);
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      const list = h.handlers.get(event) ?? [];
      list.push(handler);
      h.handlers.set(event, list);
    },
    getActiveTools: () => [...h.active],
    setActiveTools: (names: string[]) => {
      h.active = [...names];
    },
    appendEntry: (customType: string, data: unknown) => {
      h.entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  h.ctx = {
    cwd: "/repo",
    hasUI: false,
    ui: {
      setStatus(key: string, text: string | undefined) {
        assert.equal(key, STATUS_KEY);
        h.status.push(text);
      },
      notify() {},
    },
    sessionManager: { getEntries: () => h.entries },
  } as unknown as ExtensionContext;

  h.run = async (command: string) => {
    const handler = h.commands.get(command);
    assert.ok(handler, `no such command: /${command}`);
    await handler("", h.ctx);
  };
  h.fire = (event: string, payload: unknown = {}) => {
    for (const handler of h.handlers.get(event) ?? []) handler(payload, h.ctx);
  };
  return h;
}

const sessionStart = (): SessionStartEvent => ({ type: "session_start", reason: "startup" }) as SessionStartEvent;

beforeEach(() => {
  __resetForTests();
});

describe("tool-masks: the three commands", () => {
  it("registers under its declared id and offers exactly /review, /explore and /ship", () => {
    const h = harness();
    register(h.pi);
    assert.equal(id, "tool-masks");
    assert.deepEqual([...h.commands.keys()].sort(), ["explore", "review", "ship"]);
  });

  it("/review leaves no `write` and no `edit` in the tool list", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    assert.ok(!h.active.includes("write"));
    assert.ok(!h.active.includes("edit"));
    assert.ok(!h.active.includes("bash"));
    assert.ok(h.active.includes("read"));
    assert.ok(h.active.includes("grep"));
  });

  it("/explore is read-only plus web", async () => {
    const h = harness();
    register(h.pi);
    await h.run("explore");
    assert.ok(h.active.includes("web_search"));
    for (const tool of ["write", "edit", "bash"]) assert.ok(!h.active.includes(tool));
  });

  it("/ship restores the exact list that was active before the mask", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    await h.run("ship");
    assert.deepEqual(h.active, FULL);
    assert.equal(activeMask(), null);
  });

  it("/ship restores what the session HAD, not everything PI could offer", async () => {
    // A session that starts without `bash` must not be handed `bash` by shipping.
    const narrowed = ["read", "grep", "write"];
    const h = harness(narrowed);
    register(h.pi);
    await h.run("review");
    await h.run("ship");
    assert.deepEqual(h.active, narrowed);
  });

  it("/ship also hands back a tool registered while the mask was on", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    h.active.push("mcp_jira_search"); // an MCP server connected mid-mask
    await h.run("ship");
    assert.deepEqual(h.active, [...FULL, "mcp_jira_search"]);
  });

  it("switching masks widens from the baseline, not from the narrower mask", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    await h.run("explore");
    assert.ok(h.active.includes("web_search"), "web never came back");
    await h.run("ship");
    assert.deepEqual(h.active, FULL);
  });

  it("/ship on an unmasked session changes nothing", async () => {
    const h = harness();
    register(h.pi);
    await h.run("ship");
    assert.deepEqual(h.active, FULL);
    assert.equal(activeMask(), null);
  });
});

describe("tool-masks: the statusline", () => {
  it("shows `full` when no mask is on, and the mask name when one is", async () => {
    const h = harness();
    register(h.pi);
    assert.equal(renderStatus(), "tools full");
    await h.run("review");
    assert.equal(renderStatus(), "tools review");
    assert.equal(h.status.at(-1), "tools review");
    await h.run("explore");
    assert.equal(h.status.at(-1), "tools explore");
    await h.run("ship");
    assert.equal(h.status.at(-1), "tools full");
  });

  it("has an icon under the same key it publishes status on", () => {
    // The join between two files that do not import each other: `config/pi-statusline.json`'s
    // `extensionStatusIcons` is keyed by the `ctx.ui.setStatus` key this module publishes, and
    // nothing at runtime complains if the two drift — the icon simply stops appearing. Same
    // reasoning as `test/ext-12b-quota-status-icon.test.ts`, for this module's key.
    const doc = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../config/pi-statusline.json", import.meta.url)), "utf8"),
    );
    assert.ok(Object.hasOwn(doc.extensionStatusIcons, STATUS_KEY));
    assert.equal(typeof doc.extensionStatusIcons[STATUS_KEY], "string");
    assert.ok((doc.extensionStatusIcons[STATUS_KEY] as string).length > 0);
  });

  it("marks an automatic mask as such, so the footer never lies about who asked for it", () => {
    const h = harness();
    register(h.pi);
    requestTurnMask(h.ctx, "review");
    assert.equal(h.status.at(-1), "tools review (auto)");
  });
});

describe("tool-masks: surviving /compact, fork and resume", () => {
  it("replays the mask into a runtime that never saw the command", async () => {
    const first = harness();
    register(first.pi);
    await first.run("review");

    // A fork or a session switch: new runtime, new module state, same session entries.
    __resetForTests();
    const forked = harness();
    forked.entries.push(...first.entries);
    register(forked.pi);
    forked.fire("session_start", sessionStart());

    assert.equal(activeMask(), "review");
    assert.ok(!forked.active.includes("write"));
    assert.equal(forked.status.at(-1), "tools review");
  });

  it("replays it again after a compaction", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    h.active = [...FULL]; // whatever the rebuild left active
    h.fire("session_compact", { type: "session_compact" });
    assert.ok(!h.active.includes("write"));
    assert.equal(activeMask(), "review");
  });

  it("replays a /ship as a /ship, not as a mask", async () => {
    const first = harness();
    register(first.pi);
    await first.run("review");
    await first.run("ship");

    __resetForTests();
    const resumed = harness(["read"]);
    resumed.entries.push(...first.entries);
    register(resumed.pi);
    resumed.fire("session_start", sessionStart());

    assert.equal(activeMask(), null);
    assert.deepEqual(resumed.active, FULL);
  });

  it("records only the operator transitions in the session, never a turn mask", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    requestTurnMask(h.ctx, "review");
    assert.deepEqual(
      h.entries.map((e) => e.customType),
      [STATE_ENTRY],
    );
  });
});

describe("tool-masks: turn masks (the path-rules seam)", () => {
  it("narrows for the rest of the turn and releases at turn_end", () => {
    const h = harness();
    register(h.pi);
    assert.equal(requestTurnMask(h.ctx, "review"), "review");
    assert.ok(!h.active.includes("write"));

    h.fire("turn_end", { type: "turn_end" });
    assert.deepEqual(h.active, FULL);
    assert.equal(activeMask(), null);
    assert.equal(h.status.at(-1), "tools full");
  });

  it("tightens an operator's /explore, then falls back to it rather than to the full set", async () => {
    const h = harness();
    register(h.pi);
    await h.run("explore");
    assert.equal(requestTurnMask(h.ctx, "review"), "review");
    assert.ok(!h.active.includes("web_search"));

    h.fire("turn_end", { type: "turn_end" });
    assert.equal(activeMask(), "explore");
    assert.ok(h.active.includes("web_search"));
    assert.ok(!h.active.includes("write"));
  });

  it("never loosens what is already in force", async () => {
    const h = harness();
    register(h.pi);
    await h.run("review");
    assert.equal(requestTurnMask(h.ctx, "explore"), null);
    assert.equal(__state()?.source, "command");
    assert.ok(!h.active.includes("web_search"));
  });

  it("does nothing before register(), rather than throwing at a rule that fired early", () => {
    const h = harness();
    assert.equal(requestTurnMask(h.ctx, "review"), null);
  });
});

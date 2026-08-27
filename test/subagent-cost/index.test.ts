// extensions/subagent-cost/index.ts — which events refresh the footer, what gets published under
// the status key, and that a bug in the summariser can never take the session down with it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { id, register } from "../../extensions/subagent-cost/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function fakeCtx(opts: {
  entries?: SessionEntry[];
  oauthProviders?: string[];
  statuses: Map<string, string | undefined>;
}): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => opts.entries ?? [],
    },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        modelId.includes("/") ? undefined : { provider, id: modelId },
      isUsingOAuth: (model: { provider: string }) =>
        (opts.oauthProviders ?? []).includes(model.provider),
    },
    ui: {
      setStatus(key: string, text: string | undefined) {
        opts.statuses.set(key, text);
      },
    },
  } as unknown as ExtensionContext;
}

function subagentResult(details: unknown): SessionEntry {
  return {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: 1,
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "subagent",
      content: [{ type: "text", text: "ok" }],
      details,
      isError: false,
      timestamp: 1,
    },
  } as unknown as SessionEntry;
}

const FINISHED_RUN = {
  mode: "sync",
  runId: "r1",
  totalCost: { inputTokens: 8572, outputTokens: 82, costUsd: 1.94 },
  totalChildUsage: { input: 8572, output: 82 },
  results: [{ exitCode: 0, model: "github-copilot/gpt-5.6" }],
};

describe("subagent-cost extension", () => {
  it("declares the module id the manifest and ORDER expect", () => {
    assert.equal(id, "subagent-cost");
  });

  it("subscribes to the four events that can change the number", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    assert.deepEqual(
      [...handlers.keys()].sort(),
      ["session_start", "tool_execution_start", "tool_result", "turn_end"],
    );
  });

  it("publishes the rendered pair under its own status key", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    const statuses = new Map<string, string | undefined>();
    const ctx = fakeCtx({ entries: [subagentResult(FINISHED_RUN)], statuses });
    handlers.get("session_start")![0]({}, ctx);
    assert.equal(statuses.get("subagent-cost"), "+$1.94");
  });

  it("clears the status when the session has spawned nothing", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    const statuses = new Map<string, string | undefined>([["subagent-cost", "+$1.94"]]);
    handlers.get("turn_end")![0]({}, fakeCtx({ statuses }));
    assert.equal(statuses.get("subagent-cost"), undefined);
  });

  it("marks a child whose provider the registry reports as OAuth-backed", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    const statuses = new Map<string, string | undefined>();
    const ctx = fakeCtx({
      entries: [subagentResult(FINISHED_RUN)],
      oauthProviders: ["github-copilot"],
      statuses,
    });
    handlers.get("session_start")![0]({}, ctx);
    assert.equal(statuses.get("subagent-cost"), "+$1.94 (sub 1)");
  });

  it("resolves a child reference that carries a thinking level", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    const statuses = new Map<string, string | undefined>();
    const ctx = fakeCtx({
      entries: [
        subagentResult({
          ...FINISHED_RUN,
          results: [{ exitCode: 0, model: "github-copilot/gpt-5.6:high" }],
        }),
      ],
      oauthProviders: ["github-copilot"],
      statuses,
    });
    handlers.get("session_start")![0]({}, ctx);
    assert.equal(statuses.get("subagent-cost"), "+$1.94 (sub 1)");
  });

  it("re-sums only for the tools that can change the number", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    let reads = 0;
    const statuses = new Map<string, string | undefined>();
    const ctx = {
      ...fakeCtx({ statuses }),
      sessionManager: {
        getEntries: () => {
          reads += 1;
          return [];
        },
      },
    } as unknown as ExtensionContext;
    const onResult = handlers.get("tool_result")![0];
    onResult({ toolName: "read" }, ctx);
    onResult({ toolName: "bash" }, ctx);
    assert.equal(reads, 0, "a footer must not walk the session on every read");
    onResult({ toolName: "subagent" }, ctx);
    onResult({ toolName: "subagent_wait" }, ctx);
    assert.equal(reads, 2);
  });


  it("publishes the status key the statusline icon map is keyed on", () => {
    // The join between two files that do not import each other: rename one side and the icon
    // silently stops appearing. Nothing complains at runtime, so complain here.
    const src = readFileSync(
      fileURLToPath(new URL("../../extensions/subagent-cost/index.ts", import.meta.url)),
      "utf8",
    );
    const match = src.match(/const STATUS_KEY = "([^"]+)"/);
    assert.ok(match, 'extensions/subagent-cost/index.ts must define `const STATUS_KEY = "..."`');
    const icons = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../config/pi-statusline.json", import.meta.url)), "utf8"),
    );
    assert.ok(Object.hasOwn(icons.extensionStatusIcons, match![1]));
  });

  it("swallows a failure inside a lifecycle handler instead of failing the turn", () => {
    const { pi, handlers } = fakePi();
    register(pi);
    const ctx = {
      sessionManager: {
        getEntries() {
          throw new Error("session read exploded");
        },
      },
    } as unknown as ExtensionContext;
    assert.doesNotThrow(() => handlers.get("turn_end")![0]({}, ctx));
  });
});

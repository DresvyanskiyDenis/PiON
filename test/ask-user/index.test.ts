// EXT-56 — extensions/ask-user/index.ts: the tool registration and fail-loud gate.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { askQuestions, id, register } from "../../extensions/ask-user/index.ts";
import type { AskQuestion } from "../../extensions/ask-user/dialog.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function fakePi(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

/**
 * `noUi` reproduces the trap this tool exists to avoid. PI installs `noOpUIContext` in print
 * mode, whose `select` and `input` resolve to `undefined` instantly — so headless mode looks
 * exactly like someone who dismissed the box. This tool rejects that trap.
 */
function fakeCtx(opts: {
  hasUI: boolean;
  mode?: string;
  select?: (options: string[]) => string | undefined;
  input?: () => string | undefined;
  onSignal?: (signal?: AbortSignal) => void;
}): ExtensionContext {
  return {
    hasUI: opts.hasUI,
    mode: opts.mode ?? (opts.hasUI ? "tui" : "print"),
    ui: {
      async select(_title: string, options: string[], o?: { signal?: AbortSignal }) {
        opts.onSignal?.(o?.signal);
        return opts.select ? opts.select(options) : undefined;
      },
      async input(_title: string, _placeholder?: string, o?: { signal?: AbortSignal }) {
        opts.onSignal?.(o?.signal);
        return opts.input ? opts.input() : undefined;
      },
      async confirm() {
        return false;
      },
    },
  } as unknown as ExtensionContext;
}

const QUESTIONS: AskQuestion[] = [
  {
    question: "Which auth method?",
    header: "Auth",
    options: [
      { label: "OIDC", description: "delegate to the identity provider" },
      { label: "API key", description: "one shared secret" },
    ],
  },
];

function askUserTool(): RegisteredTool {
  const { pi, tools } = fakePi();
  register(pi);
  assert.equal(tools.length, 1, "the extension registers exactly one tool");
  return tools[0];
}

describe("ask-user — registration", () => {
  it("registers ask_user and runs it alone, since two dialogs cannot share one terminal", () => {
    const tool = askUserTool();
    assert.equal(tool.name, "ask_user");
    assert.equal(tool.executionMode, "sequential");
    assert.equal(id, "ask-user");
  });

  it("ships the prompt surface, without which the model never calls it at all", () => {
    const tool = askUserTool();
    assert.ok((tool.promptSnippet ?? "").length > 0, "a tool with no snippet is one the model does not reach for");
    assert.ok((tool.promptGuidelines ?? []).length >= 3);
    const guidelines = (tool.promptGuidelines ?? []).join(" ");
    assert.match(guidelines, /materially different/);
    assert.match(guidelines, /conventional default/);
  });
});

describe("ask-user — nobody to ask", () => {
  it("throws instead of reporting a decline the operator never made", async () => {
    const tool = askUserTool();
    await assert.rejects(
      () => tool.execute("call-1", { questions: QUESTIONS }, undefined, () => {}, fakeCtx({ hasUI: false })),
      (err: Error) => {
        assert.match(err.message, /print/, "the message must name the mode");
        assert.match(err.message, /no answer is being invented/);
        return true;
      },
    );
  });

  it("points a subagent at the channel that can still reach someone", async () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      await assert.rejects(
        () => askQuestions(fakeCtx({ hasUI: false }), QUESTIONS),
        (err: Error) => {
          assert.match(err.message, /subagent/);
          assert.match(err.message, /contact_supervisor/);
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });

  it("does not send the main agent after a tool only a subagent has", async () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    try {
      await assert.rejects(
        () => askQuestions(fakeCtx({ hasUI: false, mode: "json" }), QUESTIONS),
        (err: Error) => {
          assert.doesNotMatch(err.message, /subagent|contact_supervisor/);
          assert.match(err.message, /json/);
          return true;
        },
      );
    } finally {
      if (previous !== undefined) process.env.PI_SUBAGENT_CHILD = previous;
    }
  });

  it("gates on hasUI, not mode name: rpc has a real person behind the dialog", async () => {
    const answers = await askQuestions(
      fakeCtx({ hasUI: true, mode: "rpc", select: (options) => options[0] }),
      QUESTIONS,
    );
    assert.deepEqual(answers, [{ kind: "answered", labels: ["OIDC"] }]);
  });
});

describe("ask-user — answering", () => {
  it("returns the answer as text for the model and structured detail beside it", async () => {
    const tool = askUserTool();
    const result = await tool.execute(
      "call-2",
      { questions: QUESTIONS },
      undefined,
      () => {},
      fakeCtx({ hasUI: true, select: (options) => options[1] }),
    );
    assert.deepEqual(result.content, [{ type: "text", text: "Auth: API key" }]);
    assert.deepEqual(result.details, {
      answers: [{ header: "Auth", multiSelect: false, answer: { kind: "answered", labels: ["API key"] } }],
    });
  });

  it("asks every question in the order given", async () => {
    const asked: string[] = [];
    const ctx = fakeCtx({ hasUI: true, select: (options) => options[0] });
    const spy = ctx.ui.select.bind(ctx.ui);
    (ctx.ui as { select: unknown }).select = async (title: string, options: string[], o?: unknown) => {
      asked.push(title);
      return spy(title, options, o as never);
    };
    const second: AskQuestion = { ...QUESTIONS[0], question: "Which store?", header: "Store" };
    const answers = await askQuestions(ctx, [QUESTIONS[0], second]);
    assert.deepEqual(asked, ["Which auth method?", "Which store?"]);
    assert.equal(answers.length, 2);
  });

  it("carries the caller's abort signal into the dialog", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await askQuestions(
      fakeCtx({ hasUI: true, select: (options) => options[0], onSignal: (s) => seen.push(s) }),
      QUESTIONS,
      controller.signal,
    );
    assert.deepEqual(seen, [controller.signal]);
  });
});

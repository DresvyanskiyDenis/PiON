// EXT-07 — extensions/web/answer.ts's `web_answer` tool.
//
// Isolation follows test/web/config-guard.test.ts: PI_CODING_AGENT_DIR points configDir() at a
// throwaway directory holding the web.json / web-search.json pair, so nothing here reads the real
// install's configuration or leaves the machine. The endpoint under test is a local http server,
// so the happy path exercises the real fetch/parse/format chain rather than a stubbed client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  answerEndpoint,
  answerRequested,
  formatAnswer,
  registerAnswerTool,
} from "../../extensions/web/answer.ts";

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

interface Configs {
  /** `web.json` body; `undefined` writes no file at all. */
  readonly web?: unknown;
  /** `web-search.json` body; `undefined` writes no file at all. */
  readonly search?: unknown;
}

/** A throwaway PI_CODING_AGENT_DIR holding the given config pair. */
function withConfig(configs: Configs, run: () => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-ext07-answer-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const put = (name: string, body: unknown): void => {
    if (body === undefined) return;
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  };
  put("web.json", configs.web);
  put("web-search.json", configs.search);
  const restore = (): void => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const out = run();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return undefined;
  } catch (err) {
    restore();
    throw err;
  }
}

/** The pair a machine that has turned `web_answer` on carries, pointed at `base`. */
function enabled(base: string): Configs {
  return {
    web: { version: 1, search: { backend: "searxng", answerPath: "/answer" } },
    search: { provider: "searxng", searxngBaseUrl: base },
  };
}

function serve(handler: (body: string) => { status: number; body: string }): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const out = handler(raw);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function baseUrlOf(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// -- the opt-in gate --------------------------------------------------------

test("answerRequested is false on the shipped defaults, and says so without throwing", () => {
  withConfig(
    { web: { version: 1, search: { backend: "none", answerPath: null } }, search: { provider: "none" } },
    () => {
      assert.equal(answerRequested(), false);
    },
  );
});

test("answerRequested is false when web.json is absent entirely", () => {
  withConfig({}, () => {
    assert.equal(answerRequested(), false);
  });
});

test("answerRequested is false when web.json is unreadable garbage", () => {
  withConfig({ web: "{not json" }, () => {
    assert.equal(answerRequested(), false);
  });
});

test("answerRequested is true once a path is named", () => {
  withConfig(enabled("http://127.0.0.1:8080"), () => {
    assert.equal(answerRequested(), true);
  });
});

test("register creates no tool while the path is unset", () => {
  withConfig({ web: { version: 1, search: { backend: "none", answerPath: null } } }, () => {
    const { pi, tools } = fakePi();
    registerAnswerTool(pi);
    assert.deepEqual(tools, [], "an unconfigured web_answer must not be offered to the model");
  });
});

// -- endpoint derivation ----------------------------------------------------

test("answerEndpoint joins the configured path to the base web_search uses", () => {
  withConfig(enabled("http://127.0.0.1:8080"), () => {
    assert.equal(answerEndpoint(), "http://127.0.0.1:8080/answer");
  });
});

test("answerEndpoint tolerates slashes on either side of the join", () => {
  withConfig(
    {
      web: { version: 1, search: { backend: "searxng", answerPath: "answer" } },
      search: { provider: "searxng", searxngBaseUrl: "http://127.0.0.1:8080///" },
    },
    () => {
      assert.equal(answerEndpoint(), "http://127.0.0.1:8080/answer");
    },
  );
});

test("answerEndpoint fails loud when no path is configured", () => {
  withConfig({ web: { version: 1, search: { backend: "none" } } }, () => {
    assert.throws(() => answerEndpoint(), /no "search\.answerPath"/);
  });
});

test("answerEndpoint fails loud when searxngBaseUrl is absent", () => {
  withConfig(
    {
      web: { version: 1, search: { backend: "searxng", answerPath: "/answer" } },
      search: { provider: "searxng" },
    },
    () => {
      assert.throws(() => answerEndpoint(), /no "searxngBaseUrl"/);
    },
  );
});

test("answerEndpoint fails loud when web-search.json is missing", () => {
  withConfig({ web: { version: 1, search: { backend: "searxng", answerPath: "/answer" } } }, () => {
    assert.throws(() => answerEndpoint(), /web-search\.json not found/);
  });
});

test("answerEndpoint fails loud on malformed web-search.json", () => {
  withConfig(
    {
      web: { version: 1, search: { backend: "searxng", answerPath: "/answer" } },
      search: "{not json",
    },
    () => {
      assert.throws(() => answerEndpoint(), /not valid JSON/);
    },
  );
});

// -- rendering --------------------------------------------------------------

test("formatAnswer puts the answer first and the cited sources under it", () => {
  const text = formatAnswer({
    answer: "Qdrant listens on 6333 [1] and 6334 for gRPC [2].",
    sources: [
      { n: 1, title: "Quickstart", url: "https://qdrant.tech/documentation/quickstart/" },
      { n: 2, title: "Configuration", url: "https://qdrant.tech/documentation/config/" },
    ],
  });
  assert.match(text, /^Qdrant listens on 6333/);
  assert.match(text, /Sources \(cited as \[n\] above\):/);
  assert.match(text, /\[1\] Quickstart — https:\/\/qdrant\.tech\/documentation\/quickstart\//);
  assert.match(text, /\[2\] Configuration —/);
  assert.doesNotMatch(text, /NOTE: upstream result screening/);
});

test("formatAnswer surfaces a degraded upstream rather than hiding it", () => {
  const text = formatAnswer({ answer: "a", sources: [], vet_error: "ConnectError: refused" });
  assert.match(text, /NOTE: upstream result screening was unavailable \(ConnectError: refused\)/);
});

// -- the tool ---------------------------------------------------------------

test("web_answer posts the question and returns the formatted answer", async () => {
  const seen: string[] = [];
  const server = await serve((body) => {
    seen.push(body);
    return {
      status: 200,
      body: JSON.stringify({
        answer: "The default port is 6333 [1].",
        sources: [{ n: 1, title: "Docs", url: "https://qdrant.tech/" }],
        read: 4,
        found: 120,
      }),
    };
  });
  try {
    await withConfig(enabled(baseUrlOf(server)), async () => {
      const { pi, tools } = fakePi();
      registerAnswerTool(pi);
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "web_answer");

      const result = await tools[0].execute(
        "call-1",
        { q: "qdrant default port", k: 4 },
        undefined,
        undefined,
        {} as never,
      );
      assert.deepEqual(JSON.parse(seen[0]), { q: "qdrant default port", k: 4 });
      assert.equal(result.content[0].type, "text");
      assert.match((result.content[0] as { text: string }).text, /default port is 6333 \[1\]/);
      assert.match(
        (result.content[0] as { text: string }).text,
        /\[1\] Docs — https:\/\/qdrant\.tech\//,
      );
      assert.equal((result.details as { read: number }).read, 4);
    });
  } finally {
    server.close();
  }
});

test("web_answer throws — not falls back — when the engine returns an error status", async () => {
  const server = await serve(() => ({
    status: 502,
    body: JSON.stringify({ error: "answer-engine unavailable" }),
  }));
  try {
    await withConfig(enabled(baseUrlOf(server)), async () => {
      const { pi, tools } = fakePi();
      registerAnswerTool(pi);
      await assert.rejects(
        () => tools[0].execute("c", { q: "x" }, undefined, undefined, {} as never),
        /HTTP 502.*web_search is still available/s,
      );
    });
  } finally {
    server.close();
  }
});

test("web_answer throws when the engine answers with an empty answer", async () => {
  const server = await serve(() => ({
    status: 200,
    body: JSON.stringify({ answer: "   ", sources: [] }),
  }));
  try {
    await withConfig(enabled(baseUrlOf(server)), async () => {
      const { pi, tools } = fakePi();
      registerAnswerTool(pi);
      await assert.rejects(
        () => tools[0].execute("c", { q: "x" }, undefined, undefined, {} as never),
        /returned no answer/,
      );
    });
  } finally {
    server.close();
  }
});

test("web_answer reports an unreachable engine as unreachable, not as a cancellation", async () => {
  // Port 1 on loopback: nothing listens, and connecting is refused immediately.
  await withConfig(enabled("http://127.0.0.1:1"), async () => {
    const { pi, tools } = fakePi();
    registerAnswerTool(pi);
    await assert.rejects(
      () => tools[0].execute("c", { q: "x" }, undefined, undefined, {} as never),
      /could not reach the answer engine/,
    );
  });
});

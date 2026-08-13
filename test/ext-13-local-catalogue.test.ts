// EXT-13 (a) — the local lane: llama-swap discovery, the 3 s budget, and the catalogue merge.
//
// The merge tests are the important ones. An earlier draft's `refreshModels` synthesises a
// fresh entry per live model id; PI's composer replaces the provider's whole model list with what
// an extension returns, so that version silently discards every tuned field in
// `config/models.json` (`samplingParams`, `compat.thinkingFormat`, the tuned context windows, and
// the provider-level `supportsDeveloperRole: false` that stops PI sending a role llama.cpp
// rejects). These tests pin the non-destructive behaviour that replaced it.
import { readShippedConfig } from "./lib/repo-config.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  DISCOVERY_TIMEOUT_MS,
  fetchLiveModelIds,
  localBaseUrl,
  mergeCompat,
  mergeLocalCatalogue,
  pingLocal,
  readConfiguredLocalProvider,
  type ConfiguredLocalProvider,
} from "../extensions/lib/local-catalogue.ts";

/**
 * The `local` provider block scripts/install.sh writes into `config/models.json` when a user selects
 * that provider — three example models carrying every field the merge must preserve. This repository
 * ships no `config/models.json` (generated, git-ignored) and no model fleet of its own, so this
 * template is what "the real configured catalogue" now means.
 */
const LOCAL_PROVIDER_TEMPLATE = fileURLToPath(new URL("../config/providers/local.json", import.meta.url));

/** Stands in for the context window the installer asks the user for. */
const CONTEXT_WINDOW = 80_000;

interface LocalProviderBlock {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  compat?: Record<string, unknown>;
  models: Array<Record<string, unknown>>;
}

function localTemplate(): LocalProviderBlock {
  const spec = JSON.parse(readFileSync(LOCAL_PROVIDER_TEMPLATE, "utf8")) as { provider: LocalProviderBlock };
  return spec.provider;
}

/**
 * Renders that template the way the installer does — placeholders filled in — into a scratch
 * `models.json` and returns its path. Collecting the answers is the installer's job; what matters
 * here is that the file it produces is one `readConfiguredLocalProvider` can read.
 */
async function installedLocalModelsJson(): Promise<string> {
  const rendered = JSON.stringify(localTemplate())
    .replaceAll('"{{contextWindow}}"', String(CONTEXT_WINDOW))
    .replaceAll("{{port}}", "8888")
    .replaceAll("{{apiKey}}", "not-required");
  const dir = await mkdtemp(join(tmpdir(), "pi-ext13-local-"));
  const path = join(dir, "models.json");
  await writeFile(path, JSON.stringify({ providers: { local: JSON.parse(rendered) } }), "utf8");
  return path;
}

const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/v1`;
}

/* ------------------------------------------------------------------------------------------- */

describe("localBaseUrl", () => {
  it("defaults to llama-swap on 127.0.0.1:8888", () => {
    const previous = process.env.PI_LOCAL_BASE_URL;
    delete process.env.PI_LOCAL_BASE_URL;
    try {
      assert.equal(localBaseUrl(), "http://127.0.0.1:8888/v1");
    } finally {
      if (previous !== undefined) process.env.PI_LOCAL_BASE_URL = previous;
    }
  });

  it("is read per call, so PI_LOCAL_BASE_URL is not frozen at import time", () => {
    const previous = process.env.PI_LOCAL_BASE_URL;
    process.env.PI_LOCAL_BASE_URL = "http://127.0.0.1:9999/v1";
    try {
      assert.equal(localBaseUrl(), "http://127.0.0.1:9999/v1");
    } finally {
      if (previous === undefined) delete process.env.PI_LOCAL_BASE_URL;
      else process.env.PI_LOCAL_BASE_URL = previous;
    }
  });
});

describe("fetchLiveModelIds", () => {
  it("returns the served ids", async () => {
    const base = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
    });
    assert.deepEqual(await fetchLiveModelIds(base), ["a", "b"]);
  });

  it("returns undefined — not [] — on a connection refusal", async () => {
    // Port 1 on loopback: nothing listens, and the refusal is immediate.
    const result = await fetchLiveModelIds("http://127.0.0.1:1/v1");
    assert.equal(result, undefined);
  });

  it("returns undefined on a non-2xx", async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 503;
      res.end("nope");
    });
    assert.equal(await fetchLiveModelIds(base), undefined);
  });

  it("returns undefined on a body that is not a model list", async () => {
    const base = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list" }));
    });
    assert.equal(await fetchLiveModelIds(base), undefined);
  });

  it(
    "gives up after the 3 s discovery budget rather than hanging on the startup path",
    { timeout: 20_000 },
    async () => {
      // A server that accepts the connection and never answers — the shape that made
      // `pi --list-models` hang for the full stream timeout before the budgets were split.
      const base = await listen(() => {});
      const started = Date.now();
      const result = await fetchLiveModelIds(base);
      const elapsed = Date.now() - started;
      assert.equal(result, undefined);
      assert.ok(
        elapsed >= DISCOVERY_TIMEOUT_MS - 250 && elapsed < DISCOVERY_TIMEOUT_MS + 2_000,
        `expected ~${DISCOVERY_TIMEOUT_MS} ms, got ${elapsed} ms`,
      );
    },
  );

  it("honours an outer signal that has already fired", async () => {
    const base = await listen(() => {});
    assert.equal(await fetchLiveModelIds(base, AbortSignal.abort()), undefined);
  });
});

describe("pingLocal", () => {
  it("reports ok for a live server", async () => {
    const base = await listen((_req, res) => res.end(JSON.stringify({ data: [{ id: "a" }] })));
    assert.deepEqual(await pingLocal(base), { ok: true });
  });

  it("reports a detail string, never throws, for a dead one", async () => {
    const result = await pingLocal("http://127.0.0.1:1/v1");
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.detail.length > 0);
  });

  it("reports the status for a server that answers badly", async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    const result = await pingLocal(base);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.detail : "", /HTTP 500/);
  });
});

/* ------------------------------------------------------------------------------------------- */

describe("mergeCompat replicates PI's own layering", () => {
  it("model-level keys win over provider-level ones", () => {
    assert.deepEqual(mergeCompat({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 });
  });

  it("merges the four nested objects one level deeper instead of replacing them", () => {
    assert.deepEqual(
      mergeCompat(
        { chatTemplateKwargs: { thinking: true, other: 1 } },
        { chatTemplateKwargs: { thinking: false } },
      ),
      { chatTemplateKwargs: { thinking: false, other: 1 } },
    );
  });

  it("returns the base untouched when there is no override", () => {
    const base = { supportsDeveloperRole: false };
    assert.equal(mergeCompat(base, undefined), base);
  });
});

describe("mergeLocalCatalogue", () => {
  const configured: ConfiguredLocalProvider = {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8888/v1",
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: [
      {
        id: "tuned",
        name: "[qwen] tuned",
        reasoning: true,
        input: ["text"],
        contextWindow: 80_000,
        maxTokens: 32_768,
        compat: { thinkingFormat: "qwen-chat-template" },
        samplingParams: { temperature: 0.6, top_p: 0.95, top_k: 20 },
      },
      { id: "absent-from-server", name: "gone", contextWindow: 60_000 },
    ],
  };

  it("keeps every tuned field of a model models.json already describes", () => {
    const { models } = mergeLocalCatalogue(configured, ["tuned"]);
    const model = models[0] as unknown as Record<string, unknown>;
    assert.equal(model["id"], "tuned");
    assert.equal(model["name"], "[qwen] tuned");
    assert.equal(model["contextWindow"], 80_000);
    assert.equal(model["maxTokens"], 32_768);
    assert.equal(model["reasoning"], true);
    assert.deepEqual(model["samplingParams"], { temperature: 0.6, top_p: 0.95, top_k: 20 });
  });

  it("merges provider-level compat under model-level compat", () => {
    const { models } = mergeLocalCatalogue(configured, ["tuned"]);
    assert.deepEqual((models[0] as unknown as Record<string, unknown>)["compat"], {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen-chat-template",
    });
  });

  it("fills the fields PI's applyExtension does NOT default for extension models", () => {
    // `modelFromJson` defaults cost/contextWindow/maxTokens for models.json entries;
    // `applyExtension` does not do the same for extension-returned ones, so the merge must.
    const { models } = mergeLocalCatalogue({ ...configured, models: [{ id: "bare" }] }, ["bare"]);
    const model = models[0] as unknown as Record<string, unknown>;
    assert.deepEqual(model["cost"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model["contextWindow"], 128_000);
    assert.equal(model["maxTokens"], 16_384);
    assert.equal(model["name"], "bare");
    assert.equal(model["reasoning"], false);
    assert.deepEqual(model["input"], ["text"]);
  });

  it("synthesises a conservative entry for a live id models.json does not know", () => {
    const { models, synthesised } = mergeLocalCatalogue(configured, ["tuned", "brand-new"]);
    assert.deepEqual(synthesised, ["brand-new"]);
    const model = models[1] as unknown as Record<string, unknown>;
    assert.equal(model["reasoning"], false, "never claim reasoning we cannot verify");
    assert.deepEqual(model["input"], ["text"]);
    assert.deepEqual(model["compat"], { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
  });

  it("reports models.json ids the server is not serving instead of dropping them quietly", () => {
    const { dropped } = mergeLocalCatalogue(configured, ["tuned"]);
    assert.deepEqual(dropped, ["absent-from-server"]);
  });

  it("de-duplicates a server that lists the same id twice", () => {
    const { models } = mergeLocalCatalogue(configured, ["tuned", "tuned"]);
    assert.equal(models.length, 1);
  });

  it("preserves the server's ordering", () => {
    const { models } = mergeLocalCatalogue(configured, ["z", "tuned", "a"]);
    assert.deepEqual(
      models.map((m) => (m as unknown as Record<string, unknown>)["id"]),
      ["z", "tuned", "a"],
    );
  });
});

/* ------------------------------------------------------------------------------------------- */

describe("readConfiguredLocalProvider", () => {
  it("reads a models.json written from the shipped local-provider template and finds every example model", async () => {
    const models = await installedLocalModelsJson();
    const configured = await readConfiguredLocalProvider(models);
    assert.ok(configured, "an installed models.json must declare a `local` provider");
    assert.equal(configured.models.length, localTemplate().models.length);
    // Provider-level compat: the four capability denials plus the field name llama.cpp expects.
    // A local server that is told PI supports a developer role rejects the very first turn.
    assert.deepEqual(configured.compat, {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsFinishReason: false,
      maxTokensField: "max_tokens",
    });
  });

  it("round-trips that catalogue without losing a single tuned field", async () => {
    const configured = await readConfiguredLocalProvider(await installedLocalModelsJson());
    assert.ok(configured);
    const liveIds = configured.models.map((m) => String(m.id));
    const { models, dropped, synthesised } = mergeLocalCatalogue(configured, liveIds);
    assert.deepEqual(dropped, []);
    assert.deepEqual(synthesised, []);

    const thinking = models.find(
      (m) => (m as unknown as Record<string, unknown>)["id"] === "example-thinking-model",
    ) as unknown as Record<string, unknown> | undefined;
    assert.ok(thinking, "every configured model must survive the merge");
    assert.deepEqual(thinking["samplingParams"], {
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
    });
    assert.equal(thinking["contextWindow"], CONTEXT_WINDOW, "must not fall back to the generic 128k");
    assert.deepEqual(thinking["compat"], {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsFinishReason: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen-chat-template",
    });

    // The nested `$var` reference is the one field a naive merge flattens into a literal.
    const toggleable = models.find(
      (m) => (m as unknown as Record<string, unknown>)["id"] === "example-toggleable-thinking-model",
    ) as unknown as Record<string, unknown> | undefined;
    assert.ok(toggleable);
    assert.deepEqual((toggleable["compat"] as Record<string, unknown>)["chatTemplateKwargs"], {
      thinking: { $var: "thinking.enabled" },
    });
  });

  it("every model in the shipped template is well-formed — an entry PI cannot read prints the conservative-defaults warning instead", () => {
    for (const entry of localTemplate().models as Array<Record<string, unknown>>) {
      const label = typeof entry.id === "string" ? entry.id : JSON.stringify(entry);
      assert.ok(
        typeof entry.id === "string" && entry.id.length > 0,
        `${label}: id must be a non-empty string`,
      );
      assert.ok(
        typeof entry.name === "string" && (entry.name as string).length > 0,
        `${label}: name must be a non-empty string`,
      );
      // In the template this is the `{{contextWindow}}` placeholder the installer replaces with the
      // number the user was asked for; what must never happen is the field being absent, because the
      // synthesised fallback assumes 128k and a server started with less then truncates mid-answer.
      assert.ok(
        "contextWindow" in entry,
        `${label}: contextWindow must be declared, not left to the synthesised 128k default`,
      );
      assert.ok(
        typeof entry.maxTokens === "number" && Number.isFinite(entry.maxTokens) && (entry.maxTokens as number) > 0,
        `${label}: maxTokens must be a positive number`,
      );
      if (entry.reasoning !== undefined) {
        assert.equal(typeof entry.reasoning, "boolean", `${label}: reasoning must be a boolean`);
      }
      if (entry.input !== undefined) {
        assert.ok(
          Array.isArray(entry.input) && (entry.input as unknown[]).every((v) => v === "text" || v === "image"),
          `${label}: input must be an array of "text"/"image"`,
        );
      }
    }
  });

  it("returns undefined for a missing, unparseable, or local-less models.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext13-"));
    assert.equal(await readConfiguredLocalProvider(join(dir, "nope.json")), undefined);

    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ not json", "utf8");
    assert.equal(await readConfiguredLocalProvider(broken), undefined);

    const noLocal = join(dir, "no-local.json");
    await writeFile(noLocal, JSON.stringify({ providers: { openai: {} } }), "utf8");
    assert.equal(await readConfiguredLocalProvider(noLocal), undefined);
  });
});

/* ------------------------------------------------------------------------------------------- */

describe("the shipped settings template — the cold-start budget this lane depends on", () => {
  it("keeps httpIdleTimeoutMs at or above 300 000 ms", () => {
    // Cold-starting a 30 B GGUF through llama-swap routinely exceeds PI's
    // default HTTP timeout. The 300 s budget is transport-level and provider-wide; this lane
    // only asserts it is not lowered.
    const settings = readShippedConfig<{ httpIdleTimeoutMs?: number }>("settings");
    assert.ok(
      (settings.httpIdleTimeoutMs ?? 0) >= 300_000,
      `httpIdleTimeoutMs must stay >= 300000, found ${String(settings.httpIdleTimeoutMs)}`,
    );
  });
});

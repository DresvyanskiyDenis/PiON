// EXT-13 — `config/models.json` decides prompt-cache retention; the environment does not.
//
// `PI_CACHE_RETENTION=long` is a fallback pi-ai reads in every API module whenever the caller
// passes no explicit `cacheRetention` (`openai-completions.js:93-97`, `anthropic-messages.js:18-23`
// in the pinned `@earendil-works/pi-ai`). Nothing in this repo ever passes one, so that env var is
// the only thing deciding the tier — for every provider, on every call — and `supportsLongCacheRetention`
// defaults to *true* when a provider's `compat` block says nothing (`anthropic-messages.js:115`,
// `openai-completions.js:1235`). A route nobody has probed therefore gets a paid retention product
// the moment the variable is set, unless something in this repo takes the decision away from the
// environment. This file pins the rule and the wire-level default it is closing against, and the
// last suite drift-guards the exact lines the module's own docstring cites.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  CACHE_RETENTION_ENV,
  decideEnvCacheRetention,
  type ModelsFile,
  pinCacheRetentionEnv,
  readModelsFile,
} from "../extensions/lib/cache-retention.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-cache-retention-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function modelsFile(providers: Record<string, unknown>): string {
  const path = join(dir, `models-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ providers }), "utf8");
  return path;
}

describe("readModelsFile", () => {
  it("reads a real file and returns its parsed providers", () => {
    const path = modelsFile({ acme: { compat: { supportsLongCacheRetention: false } } });
    const result = readModelsFile(path);
    assert.deepEqual((result.raw as any).providers, { acme: { compat: { supportsLongCacheRetention: false } } });
    assert.equal(result.source, path);
    assert.equal(result.problem, undefined);
  });

  it("an explicit override that does not exist is a typo, not a hint to fall through", () => {
    const result = readModelsFile(join(dir, "does-not-exist.json"));
    assert.equal(result.raw, undefined);
    assert.match(result.problem ?? "", /does not exist/);
  });

  it("a missing file (the normal state on a fresh clone) reports absence, not an error thrown", () => {
    const result = readModelsFile(join(dir, "sub", "nope.json"));
    assert.equal(result.raw, undefined);
    assert.equal(result.source, join(dir, "sub", "nope.json"));
  });

  it("malformed JSON is reported as a problem, not thrown", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json", "utf8");
    const result = readModelsFile(path);
    assert.equal(result.raw, undefined);
    assert.match(result.problem ?? "", /not valid JSON/);
  });

  it("a JSON array or scalar is rejected — models.json must be an object", () => {
    const path = join(dir, "array.json");
    writeFileSync(path, "[]", "utf8");
    const result = readModelsFile(path);
    assert.equal(result.raw, undefined);
    assert.match(result.problem ?? "", /must be a JSON object/);
  });
});

describe("decideEnvCacheRetention — the rule: every provider must have an opinion, and one must opt in", () => {
  it("a provider declaring no compat.supportsLongCacheRetention silences the env switch for everyone", () => {
    const path = modelsFile({
      alpha: { compat: { supportsLongCacheRetention: true } },
      beta: { baseUrl: "https://example.invalid" }, // no compat block at all
    });
    const decision = decideEnvCacheRetention(readModelsFile(path));
    assert.equal(decision.honourEnv, false);
    assert.deepEqual(decision.silent, ["beta"]);
    assert.match(decision.reason, /beta.*no compat\.supportsLongCacheRetention/);
  });

  it("every provider pinning false silences the env switch — there is nothing to opt in with", () => {
    const path = modelsFile({
      alpha: { compat: { supportsLongCacheRetention: false } },
      beta: { compat: { supportsLongCacheRetention: false } },
    });
    const decision = decideEnvCacheRetention(readModelsFile(path));
    assert.equal(decision.honourEnv, false);
    assert.deepEqual(decision.pinnedOff, ["alpha", "beta"]);
    assert.match(decision.reason, /pins compat\.supportsLongCacheRetention false/);
  });

  it("every provider deciding, and at least one opting in, honours the env switch", () => {
    const path = modelsFile({
      alpha: { compat: { supportsLongCacheRetention: false } },
      beta: { compat: { supportsLongCacheRetention: true } },
    });
    const decision = decideEnvCacheRetention(readModelsFile(path));
    assert.equal(decision.honourEnv, true);
    assert.deepEqual(decision.optedIn, ["beta"]);
    assert.match(decision.reason, /beta.*opt in/);
  });

  it("a non-boolean compat.supportsLongCacheRetention counts as silent, not as a decision", () => {
    const path = modelsFile({ alpha: { compat: { supportsLongCacheRetention: "yes" } } });
    const decision = decideEnvCacheRetention(readModelsFile(path));
    assert.equal(decision.honourEnv, false);
    assert.deepEqual(decision.silent, ["alpha"]);
  });

  it("a per-model override does not count as a route-wide decision", () => {
    const path = modelsFile({
      alpha: { modelOverrides: { "some-model": { compat: { supportsLongCacheRetention: true } } } },
    });
    const decision = decideEnvCacheRetention(readModelsFile(path));
    assert.equal(decision.honourEnv, false);
    assert.deepEqual(decision.silent, ["alpha"]);
  });

  it("an unreadable models.json refuses rather than defaulting to true", () => {
    const decision = decideEnvCacheRetention({ raw: undefined, source: "<absent>", problem: "not found" } as ModelsFile);
    assert.equal(decision.honourEnv, false);
    assert.equal(decision.reason, "not found");
  });

  it("a providers block that is not an object refuses rather than guessing", () => {
    const decision = decideEnvCacheRetention({ raw: { providers: "nope" }, source: "x" });
    assert.equal(decision.honourEnv, false);
    assert.match(decision.reason, /declares no "providers" object/);
  });
});

describe("pinCacheRetentionEnv — the rewrite, and when it stays silent", () => {
  it("rewrites long to short when the config refuses to honour it, and says why", () => {
    const env = { [CACHE_RETENTION_ENV]: "long" };
    const notice = pinCacheRetentionEnv(env, {
      honourEnv: false,
      optedIn: [],
      pinnedOff: ["alpha"],
      silent: [],
      reason: "every provider in models.json pins compat.supportsLongCacheRetention false",
    });
    assert.equal(env[CACHE_RETENTION_ENV], "short");
    assert.match(notice ?? "", /PI_CACHE_RETENTION=long is ignored and pinned to "short"/);
    assert.match(notice ?? "", /every provider in models\.json pins/);
  });

  it("says nothing when the env var was never set to long", () => {
    const env: Record<string, string> = {};
    const notice = pinCacheRetentionEnv(env, { honourEnv: false, optedIn: [], pinnedOff: [], silent: [], reason: "n/a" });
    assert.equal(notice, undefined);
    assert.equal(env[CACHE_RETENTION_ENV], undefined);
  });

  it("says nothing, and rewrites nothing, when the config already agrees", () => {
    const env = { [CACHE_RETENTION_ENV]: "long" };
    const notice = pinCacheRetentionEnv(env, {
      honourEnv: true,
      optedIn: ["alpha"],
      pinnedOff: [],
      silent: [],
      reason: "alpha opts in",
    });
    assert.equal(notice, undefined);
    assert.equal(env[CACHE_RETENTION_ENV], "long", "an honoured env var must not be touched");
  });

  it("a value other than the literal string \"long\" is left alone — only the fallback path reads it", () => {
    const env = { [CACHE_RETENTION_ENV]: "short" };
    const notice = pinCacheRetentionEnv(env, { honourEnv: false, optedIn: [], pinnedOff: [], silent: [], reason: "n/a" });
    assert.equal(notice, undefined);
    assert.equal(env[CACHE_RETENTION_ENV], "short");
  });
});

/* ---------------------------------------------------------------------------------------------
 * Drift guard — the pinned `pi-ai` still has the exact defect this module closes.
 *
 * If either default flips (the flag stops defaulting to true, or the env fallback is removed),
 * this module is solving a problem the installed runtime no longer has, and that is worth reading
 * as news rather than as a silent pass.
 * ------------------------------------------------------------------------------------------- */
describe("drift guard: the pinned pi-ai still defaults supportsLongCacheRetention to true", () => {
  const openaiPath = new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js", import.meta.url);
  const anthropicPath = new URL("../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js", import.meta.url);

  it("openai-completions.js still reads PI_CACHE_RETENTION as the fallback tier", () => {
    const text = readFileSync(openaiPath, "utf8");
    assert.match(text, /getProviderEnvValue\("PI_CACHE_RETENTION", env\)\s*===\s*"long"/);
  });

  it("openai-completions.js still gates prompt_cache_retention on supportsLongCacheRetention alone", () => {
    const text = readFileSync(openaiPath, "utf8");
    assert.match(text, /cacheRetention === "long" && compat\.supportsLongCacheRetention \? "24h" : undefined/);
  });

  it("detectCompat still defaults supportsLongCacheRetention to true outside its exclusion list", () => {
    const text = readFileSync(openaiPath, "utf8");
    const idx = text.indexOf("function detectCompat(");
    assert.ok(idx >= 0, "detectCompat() not found — the compat-detection mechanism moved");
    assert.match(text.slice(idx, idx + 4000), /supportsLongCacheRetention:\s*!\(isTogether/);
  });

  it("anthropic-messages.js still defaults supportsLongCacheRetention to true when compat says nothing", () => {
    const text = readFileSync(anthropicPath, "utf8");
    assert.match(text, /supportsLongCacheRetention:\s*model\.compat\?\.supportsLongCacheRetention\s*\?\?\s*true/);
  });
});

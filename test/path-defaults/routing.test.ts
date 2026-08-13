import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  UnknownProviderEgressError,
  UnknownTierError,
  loadRoutingTierTarget,
  resolveRoutingTier,
} from "../../extensions/path-defaults/routing.ts";

function grab(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

// `litellm` is deleted from the real harness — the `some-internal-provider` name below is a
// self-contained synthetic fixture, not a reference to any real provider, purely to exercise the
// `internal` egress class and the trailing-slash edge case.
const ROUTING_JSON = JSON.stringify({
  tiers: {
    strong: { model: "github-copilot/claude-opus-5" },
    cheap: { model: "some-internal-provider/gpt-5.4" },
    confidential: { model: "databricks/databricks-claude-sonnet-4-5" },
    broken: { model: "not-a-provider-slash-id-that-has-no-slash" },
    "trailing-slash": { model: "some-internal-provider/" },
  },
  egress: {
    "github-copilot": "public",
    "some-internal-provider": "internal",
    databricks: "confidential",
  },
});

describe("resolveRoutingTier — pure resolution", () => {
  it("resolves a known tier to provider/model/egress", () => {
    const t = resolveRoutingTier(ROUTING_JSON, "confidential", "routing.json");
    assert.equal(t.tier, "confidential");
    assert.equal(t.model, "databricks/databricks-claude-sonnet-4-5");
    assert.equal(t.provider, "databricks");
    assert.equal(t.modelId, "databricks-claude-sonnet-4-5");
    assert.equal(t.egress, "confidential");
  });

  it("throws on malformed JSON", () => {
    const err = grab(() => resolveRoutingTier("{ not json", "confidential", "routing.json"));
    assert.match(err.message, /is not valid JSON/);
  });

  it("throws UnknownTierError for a tier not in the file", () => {
    const err = grab(() => resolveRoutingTier(ROUTING_JSON, "nonexistent", "routing.json"));
    assert.ok(err instanceof UnknownTierError);
    assert.equal((err as UnknownTierError).tier, "nonexistent");
    assert.match(err.message, /unknown tier "nonexistent"/);
  });

  it("throws when the tier's model has no provider/id slash", () => {
    const err = grab(() => resolveRoutingTier(ROUTING_JSON, "broken", "routing.json"));
    assert.match(err.message, /not "provider\/id"-shaped/);
  });

  it("throws when the model string ends in a trailing slash (empty modelId)", () => {
    const err = grab(() => resolveRoutingTier(ROUTING_JSON, "trailing-slash", "routing.json"));
    assert.match(err.message, /not "provider\/id"-shaped/);
  });

  it("throws UnknownProviderEgressError when the resolved provider has no egress entry", () => {
    const routing = JSON.stringify({
      tiers: { local: { model: "local/some-model" } },
      egress: { "github-copilot": "public" },
    });
    const err = grab(() => resolveRoutingTier(routing, "local", "routing.json"));
    assert.ok(err instanceof UnknownProviderEgressError);
    assert.equal((err as UnknownProviderEgressError).provider, "local");
  });
});

describe("loadRoutingTierTarget — file I/O", () => {
  let sandbox: string;
  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-path-defaults-routing-"));
  });
  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("reads and resolves a real file", async () => {
    const file = join(sandbox, "routing.json");
    await writeFile(file, ROUTING_JSON);
    const t = loadRoutingTierTarget("cheap", file);
    assert.equal(t.model, "some-internal-provider/gpt-5.4");
    assert.equal(t.egress, "internal");
  });

  it("throws a plain Error naming the tier for a missing file", () => {
    const err = grab(() => loadRoutingTierTarget("strong", join(sandbox, "missing.json")));
    assert.match(err.message, /could not read .* to resolve tier "strong"/);
  });
});

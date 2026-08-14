import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { UnknownTierError, resolveTier } from "../../extensions/digest/tier.ts";

let sandbox: string;
before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-digest-tier-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("tier — resolveTier", () => {
  it("resolves a known tier to its provider-qualified model id", async () => {
    const path = join(sandbox, "routing.json");
    await writeFile(
      path,
      JSON.stringify({ tiers: { cheap: { model: "databricks/databricks-claude-haiku-4-5" }, strong: { model: "github-copilot/claude-opus-5" } } }),
    );
    assert.equal(await resolveTier("cheap", path), "databricks/databricks-claude-haiku-4-5");
    assert.equal(await resolveTier("strong", path), "github-copilot/claude-opus-5");
  });

  /**
   * The resolved string goes straight to `pi -p --model`, and the model string is the only channel
   * PI reads reasoning effort from. Returning `model` alone summarised at the provider's default
   * while `routing.json` declared a level. The tempting alternative — writing `provider/id:low`
   * into the tier's `model` field — is worse: that field is contractually a bare `provider/id`, and
   * a suffix in it reads as part of the id to every consumer that does not strip one.
   */
  it("appends the tier's thinkingLevel, since the model string is where PI reads effort", async () => {
    const path = join(sandbox, "routing-thinking.json");
    await writeFile(
      path,
      JSON.stringify({
        tiers: {
          cheap: { model: "databricks/databricks-claude-haiku-4-5", thinkingLevel: "low" },
          pinned: { model: "databricks/databricks-claude-haiku-4-5:max", thinkingLevel: "low" },
          plain: { model: "databricks/databricks-claude-haiku-4-5" },
        },
      }),
    );
    assert.equal(await resolveTier("cheap", path), "databricks/databricks-claude-haiku-4-5:low");
    assert.equal(
      await resolveTier("pinned", path),
      "databricks/databricks-claude-haiku-4-5:max",
      "a pinned suffix is the more specific statement",
    );
    assert.equal(
      await resolveTier("plain", path),
      "databricks/databricks-claude-haiku-4-5",
      "no level declared, no suffix invented",
    );
  });

  it("refuses a thinkingLevel PI does not know rather than sending it to the provider", async () => {
    const path = join(sandbox, "routing-bad-level.json");
    await writeFile(
      path,
      JSON.stringify({ tiers: { cheap: { model: "databricks/databricks-claude-haiku-4-5", thinkingLevel: "supreme" } } }),
    );
    await assert.rejects(() => resolveTier("cheap", path), /thinkingLevel "supreme"/);
  });

  it("REQ-PRV-32: an unknown tier throws UnknownTierError rather than guessing or falling back", async () => {
    const path = join(sandbox, "routing2.json");
    await writeFile(path, JSON.stringify({ tiers: { cheap: { model: "databricks/databricks-claude-haiku-4-5" } } }));
    await assert.rejects(
      () => resolveTier("nonexistent", path),
      (err: unknown) => {
        assert.ok(err instanceof UnknownTierError);
        assert.equal(err.tier, "nonexistent");
        assert.equal(err.routingPath, path);
        assert.match(err.message, /unknown tier "nonexistent"/);
        return true;
      },
    );
  });

  it("a tier whose model field is missing or not a string is treated as unknown", async () => {
    const path = join(sandbox, "routing3.json");
    await writeFile(path, JSON.stringify({ tiers: { empty: {}, wrongtype: { model: 42 } } }));
    await assert.rejects(() => resolveTier("empty", path), UnknownTierError);
    await assert.rejects(() => resolveTier("wrongtype", path), UnknownTierError);
  });

  it("a missing routing.json throws a plain Error naming the path and the tier being resolved", async () => {
    const path = join(sandbox, "does-not-exist.json");
    await assert.rejects(
      () => resolveTier("cheap", path),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /cheap/);
        assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  });

  it("malformed JSON throws a plain Error, not a silent empty-tiers fallback", async () => {
    const path = join(sandbox, "bad.json");
    await writeFile(path, "{ not json");
    await assert.rejects(() => resolveTier("cheap", path), /not valid JSON/);
  });

  it("uses PI_ROUTING_JSON as the default path when no explicit path is given", async () => {
    const path = join(sandbox, "env-routing.json");
    await writeFile(path, JSON.stringify({ tiers: { cheap: { model: "databricks/databricks-claude-haiku-4-5" } } }));
    const before = process.env.PI_ROUTING_JSON;
    process.env.PI_ROUTING_JSON = path;
    try {
      assert.equal(await resolveTier("cheap"), "databricks/databricks-claude-haiku-4-5");
    } finally {
      if (before === undefined) delete process.env.PI_ROUTING_JSON;
      else process.env.PI_ROUTING_JSON = before;
    }
  });
});

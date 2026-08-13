import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MENU_CLOSE,
  MENU_OPEN,
  describeAlternatives,
  injectMenuOnce,
  makeCatalogue,
  renderModelMenu,
  selectMenuModels,
  splitModelId,
  stripMenu,
  suggestModels,
} from "../../extensions/dispatch/catalogue.ts";
import { CATALOGUE, CONFIG, ROUTING } from "./helpers.ts";

describe("splitModelId", () => {
  it("splits on the FIRST slash, so a local model id keeps its own", () => {
    assert.deepEqual(splitModelId("local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF"), {
      provider: "local",
      id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
    });
    assert.deepEqual(splitModelId("databricks/databricks-claude-haiku-4-5"), {
      provider: "databricks",
      id: "databricks-claude-haiku-4-5",
    });
  });

  it("reports no provider for a bare id rather than inventing one", () => {
    assert.deepEqual(splitModelId("gpt-5.4"), { provider: "", id: "gpt-5.4" });
    assert.deepEqual(splitModelId("/gpt-5.4"), { provider: "", id: "/gpt-5.4" });
  });
});

describe("suggestModels", () => {
  it("puts the same id under a different provider first — the most common miss in this config", () => {
    const near = suggestModels("anthropic/claude-sonnet-5", CATALOGUE);
    assert.equal(near[0], "github-copilot/claude-sonnet-5");
  });

  it("prefers the provider that was actually asked for when the id is the mistake", () => {
    const near = suggestModels("github-copilot/gpt-5.1", CATALOGUE);
    assert.deepEqual(near.slice(0, 2), ["github-copilot/gpt-5.4", "github-copilot/gpt-5.4-mini"]);
  });

  it("does not let a repeated digit outrank the right lane (gpt-5.5 over gpt-5.4 for gpt-5.1)", () => {
    // Needs two providers that both plausibly serve a "gpt-5.x" id so the digit-similarity scorer
    // has a real cross-provider collision to resolve. The shared CATALOGUE no longer has one now
    // that litellm (the other "gpt-5.x" lane) is deleted, so this test builds its own local
    // catalogue instead of reaching for CATALOGUE.
    const collision = makeCatalogue(["github-copilot/gpt-5.4", "openai/gpt-5.5"]);
    const near = suggestModels("github-copilot/gpt-5.1", collision);
    assert.ok(
      near.indexOf("github-copilot/gpt-5.4") < near.indexOf("openai/gpt-5.5") ||
        !near.includes("openai/gpt-5.5"),
    );
  });

  it("tolerates separator and case differences, because the registry mixes both", () => {
    assert.equal(suggestModels("github-copilot/GPT_5_4", CATALOGUE)[0], "github-copilot/gpt-5.4");
  });

  it("returns nothing rather than four arbitrary guesses for an unrecognisable string", () => {
    assert.deepEqual(suggestModels("databricks/zzzzzzzz", CATALOGUE), []);
  });

  it("never returns more than the limit", () => {
    assert.ok(suggestModels("github-copilot/gpt", CATALOGUE, 2).length <= 2);
  });
});

describe("describeAlternatives", () => {
  it("names real ids when there are any", () => {
    assert.match(describeAlternatives("github-copilot/gpt-5.1", CATALOGUE), /^Closest available: github-copilot\/gpt-5\.4/);
  });

  it("says how many models exist and where the list is when nothing resembles it", () => {
    const text = describeAlternatives("databricks/zzzzzzzz", CATALOGUE);
    assert.match(text, /9 model\(s\) in the registry/);
    assert.match(text, /Sub-agent model selection/);
  });
});

describe("selectMenuModels", () => {
  const input = (sessionEgress: "public" | "internal" | "confidential") => ({
    routing: ROUTING,
    catalogue: CATALOGUE,
    sessionEgress,
    defaultTier: CONFIG.defaultTier,
  });

  const ALL_PROVIDERS = ["github-copilot", "databricks", "deepseek"];

  it("groups by provider and keeps providers routing.json does not classify", () => {
    const sel = selectMenuModels(input("public"));
    assert.deepEqual([...sel.byProvider.keys()], ALL_PROVIDERS);
    assert.deepEqual(sel.unclassed, ["deepseek/deepseek-v4-flash"], "reported, but not withheld");
    assert.deepEqual(sel.byProvider.get("deepseek"), ["deepseek-v4-flash"]);
  });

  /**
   * WITHDRAWN 2026-08-13. Three tests here used to assert that the menu was FILTERED by the
   * session's egress class: a confidential session saw only databricks, a public one lost nothing,
   * and a provider with no class at all was withheld entirely. Hiding models from the session is
   * exactly what made "switch provider mid-session" impossible, and a menu that omits a model the
   * dispatcher can legally name is a menu that teaches the wrong contract. The new rule is that the
   * class annotates and never subtracts, so one test replaces the three: the menu is identical for
   * every session class.
   */
  it("shows every model to every session class — the class does not filter", () => {
    for (const cls of ["public", "internal", "confidential"] as const) {
      const sel = selectMenuModels(input(cls));
      assert.deepEqual([...sel.byProvider.keys()], ALL_PROVIDERS, cls);
      const total = [...sel.byProvider.values()].reduce((n, ids) => n + ids.length, 0);
      assert.equal(total, CATALOGUE.ids.length, `${cls}: every id in the registry is selectable`);
    }
  });
});

describe("renderModelMenu", () => {
  const menu = (sessionEgress: "public" | "internal" | "confidential" = "public", withCatalogue = true) =>
    renderModelMenu({
      routing: ROUTING,
      catalogue: withCatalogue ? CATALOGUE : undefined,
      sessionEgress,
      defaultTier: CONFIG.defaultTier,
    });

  it("states the contract the dispatching model has to satisfy", () => {
    const text = menu();
    assert.match(text, /EITHER a tier name/);
    assert.match(text, /OR a concrete `provider\/id`/);
    assert.match(text, /A value containing "\/" is read as a provider-qualified id/);
  });

  it("states that an explicit model wins over the agent file, and names the default tier", () => {
    assert.match(menu(), /wins over the agent file's own `model:`/);
    assert.match(menu(), /default tier: `fast`/);
  });

  it("states the consequence of getting it wrong, in this project's terms", () => {
    assert.match(menu(), /ABORTS that dispatch/);
    assert.match(menu(), /Nothing is substituted/);
  });

  /**
   * WITHDRAWN 2026-08-13: a tier whose provider was classed looser than the session used to be
   * printed with `[NOT available to this <class> session]` after it. No tier is out of reach any
   * more, so the annotation has nothing to mark and the assertion is inverted — the marker must
   * never appear.
   *
   * Also new here: each tier line carries `, effort <level>`. `renderModelMenu` reads `def.model`
   * from the RAW (unresolved) tier definition, so the id itself stays bare on this line and only
   * the separate `effort` field reports the level.
   */
  it("lists every tier with its resolved model and that model's egress class, flagging none", () => {
    const text = menu("confidential");
    assert.match(text, /tier `strong` -> github-copilot\/claude-opus-5 \(egress public, effort high\)/);
    assert.match(text, /tier `confidential` -> databricks\/databricks-claude-sonnet-4-5 \(egress confidential, effort medium\)/);
    assert.doesNotMatch(text, /NOT available/);
  });

  it("lists the selectable ids grouped by provider, with the provider's egress class", () => {
    const text = menu();
    assert.match(text, /- github-copilot \(egress public\): claude-opus-5, claude-sonnet-5/);
    assert.match(
      text,
      /- databricks \(egress confidential\): databricks-claude-haiku-4-5, databricks-gpt-oss-120b, databricks-claude-sonnet-4-5/,
    );
  });

  it("keeps the session's own class on the page, as a label that restricts nothing", () => {
    assert.match(menu("confidential"), /This session is classed `confidential`; the class is a label and restricts nothing/);
    assert.match(menu("confidential"), /All 9 concrete id\(s\) below are selectable/);
  });

  it("labels an unclassed provider rather than withholding it", () => {
    const text = menu();
    assert.match(text, /- deepseek \(egress unlabelled\): deepseek-v4-flash/);
    assert.match(text, /1 of them come from provider\(s\) with no egress class in routing\.json \(deepseek\)/);
    assert.match(text, /they are selectable and reported as unlabelled/);
  });

  it("says so plainly when the registry could not be read, rather than printing an empty list", () => {
    const text = menu("public", false);
    assert.match(text, /model registry was unavailable/);
    assert.doesNotMatch(text, /concrete id\(s\) below are selectable/);
  });

  /**
   * The `:<level>` suffix syntax is documented in its own paragraph so the dispatching model can
   * find it without reading every tier line, and each tier line shows what it actually resolves to
   * — `effort high` for a declared level, `effort provider default` for a tier with none.
   */
  it("documents the :<level> suffix and shows each tier's effective effort", () => {
    const text = menu();
    assert.match(text, /Append `:<level>` to a concrete id to set that child's REASONING EFFORT/);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.match(text, new RegExp("`" + level + "`"), `level ${level} named in the suffix paragraph`);
    }
    assert.match(text, /tier `strong` -> github-copilot\/claude-opus-5 \(egress public, effort high\)/);

    const routing = { ...ROUTING, tiers: { ...ROUTING.tiers, strong: { model: "github-copilot/claude-opus-5" } } };
    const noLevelText = renderModelMenu({
      routing,
      catalogue: CATALOGUE,
      sessionEgress: "public",
      defaultTier: CONFIG.defaultTier,
    });
    assert.match(noLevelText, /tier `strong` -> github-copilot\/claude-opus-5 \(egress public, effort provider default\)/);
  });

  it("stays well inside the byte budget with the real machine's model count", () => {
    // 38 available models is what `ctx.modelRegistry.getAvailable()` returns on the target Mac.
    const many = makeCatalogue([
      ...CATALOGUE.ids,
      ...Array.from({ length: 30 }, (_, i) => `github-copilot/synthetic-model-${i}`),
    ]);
    const text = renderModelMenu({ routing: ROUTING, catalogue: many, sessionEgress: "public", defaultTier: "fast" });
    assert.ok(Buffer.byteLength(text, "utf8") < 4096, `menu was ${Buffer.byteLength(text, "utf8")} bytes`);
  });
});

describe("injectMenuOnce", () => {
  it("appends exactly one block", () => {
    const out = injectMenuOnce("BASE PROMPT", "MENU");
    assert.match(out, /BASE PROMPT/);
    assert.equal(out.split(MENU_OPEN).length - 1, 1);
    assert.equal(out.split(MENU_CLOSE).length - 1, 1);
  });

  it("is idempotent: a prompt that already carries a block gets the new one, not both", () => {
    const once = injectMenuOnce("BASE", "OLD MENU");
    const twice = injectMenuOnce(once, "NEW MENU");
    assert.equal(twice.split(MENU_OPEN).length - 1, 1);
    assert.match(twice, /NEW MENU/);
    assert.doesNotMatch(twice, /OLD MENU/);
    assert.match(twice, /^BASE/);
  });

  it("heals a prompt that somehow stacked two blocks", () => {
    const stacked = `BASE\n${MENU_OPEN}\nA\n${MENU_CLOSE}\n${MENU_OPEN}\nB\n${MENU_CLOSE}\n`;
    assert.equal(stripMenu(stacked).includes(MENU_OPEN), false);
    assert.equal(injectMenuOnce(stacked, "C").split(MENU_OPEN).length - 1, 1);
  });

  it("truncates with a notice rather than blowing the budget", () => {
    const out = injectMenuOnce("BASE", "x".repeat(10_000));
    assert.ok(Buffer.byteLength(out, "utf8") < 10_000);
    assert.match(out, /\[dispatch model menu truncated to 4096 bytes\]/);
  });
});

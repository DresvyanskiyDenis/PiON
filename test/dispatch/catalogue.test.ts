import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MENU_CLOSE,
  MENU_OPEN,
  describeAlternatives,
  describeServing,
  injectMenuOnce,
  makeCatalogue,
  providersServing,
  renderModelMenu,
  selectMenuModels,
  splitModelId,
  stripMenu,
  suggestModels,
} from "../../extensions/dispatch/catalogue.ts";
import { CATALOGUE, CONFIG, CONFIGURED_PROVIDERS, ROUTING, THINKING_CAPS } from "./helpers.ts";

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

describe("providersServing", () => {
  it("groups the models that serve a level, and carries each provider's egress class", () => {
    assert.deepEqual(providersServing(CATALOGUE, ROUTING, "max"), [
      { provider: "databricks", egress: "confidential", models: ["databricks/databricks-claude-sonnet-4-5"] },
    ]);
  });

  it("returns every provider that serves a level they all serve", () => {
    const providers = providersServing(CATALOGUE, ROUTING, "medium").map((s) => s.provider);
    assert.deepEqual(providers, ["github-copilot", "databricks"], "registry order, not alphabetical");
  });

  /** A model the registry does not describe is skipped: "cannot say" must never render as "yes". */
  it("never guesses for a model with no declared vocabulary", () => {
    const all = providersServing(CATALOGUE, ROUTING, "high").flatMap((s) => s.models);
    assert.ok(!all.includes("github-copilot/claude-opus-5"), "no capability entry means no claim");
    assert.ok(!all.includes("github-copilot/gpt-5.4-mini"), "reasoning: false serves nothing but off");
  });

  it("says nothing at all when the registry was unavailable", () => {
    assert.deepEqual(providersServing(undefined, ROUTING, "max"), []);
  });

  /**
   * The registry carries providers PI knows natively whether or not this install configured them.
   * A hint exists to say where the requested level would REALLY run, so an endpoint that appears in
   * neither `config/models.json` nor `routing.json`'s egress map is not a candidate — it could not
   * even be assigned a class, and `egress unlabelled` was the map admitting it could not classify a
   * route it was nonetheless recommending.
   */
  describe("only configured, classified providers are candidates", () => {
    /** Registry order matters, so the unconfigured one sits first: it must be dropped, not shadowed. */
    const WITH_DEEPSEEK = makeCatalogue(
      ["deepseek/deepseek-v4-flash", "databricks/databricks-claude-sonnet-4-5"],
      [
        [
          "deepseek/deepseek-v4-flash",
          { reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" } },
        ],
        ...THINKING_CAPS.filter(([id]) => id === "databricks/databricks-claude-sonnet-4-5"),
      ],
    );

    it("drops a provider routing.json does not classify, even without a models.json list", () => {
      assert.deepEqual(providersServing(WITH_DEEPSEEK, ROUTING, "max"), [
        { provider: "databricks", egress: "confidential", models: ["databricks/databricks-claude-sonnet-4-5"] },
      ]);
    });

    it("drops a classified provider that config/models.json does not declare", () => {
      const routing = { ...ROUTING, egress: { ...ROUTING.egress, deepseek: "public" as const } };
      const providers = providersServing(WITH_DEEPSEEK, routing, "max", CONFIGURED_PROVIDERS).map((s) => s.provider);
      assert.deepEqual(providers, ["databricks"], "classified is not enough; it must also be configured");
    });

    it("keeps the classified half working when models.json could not be read", () => {
      const routing = { ...ROUTING, egress: { ...ROUTING.egress, deepseek: "public" as const } };
      const providers = providersServing(WITH_DEEPSEEK, routing, "max", undefined).map((s) => s.provider);
      assert.deepEqual(providers, ["deepseek", "databricks"], "an unreadable file must not empty the hint");
    });

    it("still names a provider that is both configured and classified", () => {
      assert.deepEqual(providersServing(CATALOGUE, ROUTING, "max", CONFIGURED_PROVIDERS), [
        { provider: "databricks", egress: "confidential", models: ["databricks/databricks-claude-sonnet-4-5"] },
      ]);
    });
  });
});

describe("describeServing", () => {
  it("reads as a hint and explicitly not as a reroute", () => {
    const text = describeServing(providersServing(CATALOGUE, ROUTING, "max"), "max");
    assert.match(text, /Models that DO serve `max`: databricks \(egress confidential\)/);
    assert.match(text, /hint, not a reroute/);
  });

  it("calls an empty list the configuration's ceiling, not silence", () => {
    assert.match(describeServing([], "xhigh"), /No configured model serves `xhigh` at all/);
    assert.match(describeServing([], "xhigh"), /ceiling rather than a routing choice/);
  });

  it("caps a long list rather than reprinting the model menu", () => {
    const many = [{ provider: "openai-compatible", egress: "internal" as const, models: ["a", "b", "c", "d", "e"] }];
    assert.match(describeServing(many, "max"), /openai-compatible \(egress internal\): a, b, c \+2 more/);
  });
});

describe("selectMenuModels", () => {
  const input = (sessionEgress: "public" | "internal" | "confidential") => ({
    routing: ROUTING,
    catalogue: CATALOGUE,
    sessionEgress,
    defaultTier: CONFIG.defaultTier,
    configuredProviders: CONFIGURED_PROVIDERS,
  });

  /** What this install has. `deepseek` is in the registry fixture and in neither config. */
  const DISPATCHABLE = ["github-copilot", "databricks"];

  /**
   * REVISED 2026-08-14. This used to assert `unclassed: ["deepseek/deepseek-v4-flash"]` — "reported,
   * but not withheld". The owner's rule replaced it: a provider that is not configured does not
   * exist, so it is withheld, and the menu and the dispatch gate now give the same answer.
   */
  it("groups by provider and drops any provider this install has not configured", () => {
    const sel = selectMenuModels(input("public"));
    assert.deepEqual([...sel.byProvider.keys()], DISPATCHABLE);
    assert.equal(sel.byProvider.get("deepseek"), undefined);
    assert.deepEqual(sel.excluded, ["deepseek/deepseek-v4-flash"]);
  });

  it("drops a classified provider that models.json does not declare, and vice versa", () => {
    // Both halves, independently: the rule is a conjunction, so either one alone must exclude.
    const onlyClassified = selectMenuModels({
      ...input("public"),
      configuredProviders: new Set(["github-copilot"]),
    });
    assert.deepEqual([...onlyClassified.byProvider.keys()], ["github-copilot"]);
    const onlyConfigured = selectMenuModels({
      ...input("public"),
      routing: { ...ROUTING, egress: { "github-copilot": "public" as const } },
    });
    assert.deepEqual([...onlyConfigured.byProvider.keys()], ["github-copilot"]);
  });

  it("falls back to the classified half when models.json could not be read", () => {
    // Degradation, not silence: an unreadable file must not empty the menu. `deepseek` is still
    // absent, because it is unclassified too — which is why the fallback is safe here.
    const sel = selectMenuModels({ ...input("public"), configuredProviders: undefined });
    assert.deepEqual([...sel.byProvider.keys()], DISPATCHABLE);
    assert.deepEqual(sel.excluded, ["deepseek/deepseek-v4-flash"]);
  });

  /**
   * WITHDRAWN 2026-08-13. Three tests here used to assert that the menu was FILTERED by the
   * session's egress class: a confidential session saw only databricks, a public one lost nothing,
   * and a provider with no class at all was withheld entirely. Hiding models from the session is
   * exactly what made "switch provider mid-session" impossible, and a menu that omits a model the
   * dispatcher can legally name is a menu that teaches the wrong contract. The new rule is that the
   * class annotates and never subtracts, so one test replaces the three: the menu is identical for
   * every session class. Still true — the 2026-08-14 filter asks a different question ("does this
   * install have it") and is the same for every session class.
   */
  it("shows every dispatchable model to every session class — the class does not filter", () => {
    for (const cls of ["public", "internal", "confidential"] as const) {
      const sel = selectMenuModels(input(cls));
      assert.deepEqual([...sel.byProvider.keys()], DISPATCHABLE, cls);
      const total = [...sel.byProvider.values()].reduce((n, ids) => n + ids.length, 0);
      assert.equal(total, CATALOGUE.ids.length - 1, `${cls}: every dispatchable id is selectable`);
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
      configuredProviders: CONFIGURED_PROVIDERS,
    });

  it("states the contract the dispatching model has to satisfy", () => {
    const text = menu();
    assert.match(text, /EITHER a tier name/);
    assert.match(text, /OR a concrete `provider\/id`/);
    assert.match(text, /A value containing "\/" is read as a provider-qualified id/);
  });

  it("states that an explicit model wins over the agent file, and names the default tier", () => {
    assert.match(menu(), /wins over the agent file's own `model:`/);
    assert.match(menu(), /default tier: `strong`/);
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
    // 9 in the registry fixture, 8 dispatchable: `deepseek` is in neither config file.
    assert.match(menu("confidential"), /All 8 concrete id\(s\) below are selectable/);
  });

  /**
   * REPLACES "labels an unclassed provider rather than withholding it" (2026-08-13 - 2026-08-14).
   * That test asserted `- deepseek (egress unlabelled): deepseek-v4-flash` was rendered. Under the
   * owner's rule — a provider that is not configured does not exist — `unlabelled` stopped being a
   * renderable state and became a filter, so the assertion is inverted.
   */
  it("never names a provider this install has not configured, anywhere on the page", () => {
    const text = menu();
    assert.doesNotMatch(text, /deepseek/);
    assert.doesNotMatch(text, /unlabelled/);
    // ...and says the list is complete, so the model does not go looking for what is missing.
    assert.match(text, /This is the complete set/);
    assert.match(text, /a provider this install has not configured is not on it and cannot be dispatched to/);
  });

  it("flags a tier pointing at an unconfigured provider instead of labelling it unlabelled", () => {
    // A broken tier must be visible: `tiers.ts` aborts the dispatch, and the menu saying so is what
    // stops the model discovering it by calling it. This is a config error surfaced, not a leak.
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, strong: { model: "deepseek/deepseek-v4-flash" } },
    };
    const text = renderModelMenu({
      routing,
      catalogue: CATALOGUE,
      sessionEgress: "public",
      defaultTier: CONFIG.defaultTier,
      configuredProviders: CONFIGURED_PROVIDERS,
    });
    assert.match(text, /tier `strong` -> deepseek\/deepseek-v4-flash — NOT DISPATCHABLE:/);
    assert.match(text, /it is not configured in config\/models\.json/);
    assert.match(text, /it has no egress class in config\/routing\.json/);
    assert.doesNotMatch(text, /egress unlabelled/);
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
      configuredProviders: CONFIGURED_PROVIDERS,
    });
    assert.match(noLevelText, /tier `strong` -> github-copilot\/claude-opus-5 \(egress public, effort provider default\)/);
  });

  /**
   * The status-line half of the `:max` defect. The menu is the text both the operator and the
   * dispatching model read to decide what a tier costs; while it printed the REQUESTED level, a
   * tier could advertise `effort max` for months of runs that shipped `high`. Both levels are now
   * on the line, and so is the vocabulary that explains the difference.
   */
  it("shows the effort a tier will really run at, not the one it asked for", () => {
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4", thinkingLevel: "max" } },
    };
    const text = renderModelMenu({
      routing,
      catalogue: CATALOGUE,
      sessionEgress: "public",
      defaultTier: CONFIG.defaultTier,
      configuredProviders: CONFIGURED_PROVIDERS,
    });
    assert.match(text, /tier `cheap` -> github-copilot\/gpt-5\.4 \(egress public, effort high \(asked max; github-copilot does not serve it — serves low\|medium\|high\)\)/);
  });

  it("reports a level the model does serve without any annotation", () => {
    const routing = {
      ...ROUTING,
      tiers: { ...ROUTING.tiers, cheap: { model: "github-copilot/gpt-5.4", thinkingLevel: "medium" } },
    };
    const text = renderModelMenu({
      routing,
      catalogue: CATALOGUE,
      sessionEgress: "public",
      defaultTier: CONFIG.defaultTier,
      configuredProviders: CONFIGURED_PROVIDERS,
    });
    assert.match(text, /tier `cheap` -> github-copilot\/gpt-5\.4 \(egress public, effort medium\)/);
  });

  it("stays well inside the byte budget with the real machine's model count", () => {
    // 38 available models is what `ctx.modelRegistry.getAvailable()` returns on the target Mac.
    const many = makeCatalogue([
      ...CATALOGUE.ids,
      ...Array.from({ length: 30 }, (_, i) => `github-copilot/synthetic-model-${i}`),
    ]);
    const text = renderModelMenu({
      routing: ROUTING,
      catalogue: many,
      sessionEgress: "public",
      defaultTier: "fast",
      configuredProviders: CONFIGURED_PROVIDERS,
    });
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

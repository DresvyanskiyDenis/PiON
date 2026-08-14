import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCatalogue, type ModelCatalogue } from "../../extensions/dispatch/catalogue.ts";
import type { ThinkingCapability } from "../../extensions/dispatch/thinking.ts";
import { DEFAULT_DISPATCH_CONFIG, type DispatchConfig, type RoutingConfig } from "../../extensions/dispatch/config.ts";

/** Never `/tmp`: $TMPDIR via os.tmpdir(). */
export function scratch(prefix = "ext05-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * `assert.throws` returns `undefined`, so it cannot be used to inspect the thrown value.
 * These refusals carry a `kind` and a message that a human has to read, so the tests assert on
 * the object itself.
 */
export function grab(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

/**
 * Every id here is a REAL id from PI 0.84.0's catalogue, verified against
 * `@earendil-works/pi-ai/dist/models.generated.js` and against `ctx.modelRegistry.getAvailable()`
 * on this machine. The fixture used to carry `github-copilot/gpt-5.1`, an id that never existed;
 * the same invention shipped in `config/routing.json` and refused 8 agents at session start.
 * A fixture that models the registry must not be the last place
 * the fiction survives.
 */
// The `litellm` provider that used to own the `cheap` tier and the `internal` egress class was
// deleted from the harness entirely (config/models.json, config/routing.json). `cheap` now points
// at `databricks/databricks-claude-haiku-4-5`, sharing the `databricks` provider's cap of 4 and its
// `confidential` egress class — there is no `internal`-class provider left in the shipped config at
// all. Tests that specifically exercise the `internal` egress class declare their own synthetic
// ROUTING fixture rather than relying on this shared one (see catalogue.test.ts, registry.test.ts).
export const ROUTING: RoutingConfig = {
  tiers: {
    strong: { model: "github-copilot/claude-opus-5", thinkingLevel: "high" },
    fast: { model: "github-copilot/claude-sonnet-5", thinkingLevel: "medium" },
    cheap: { model: "databricks/databricks-claude-haiku-4-5", thinkingLevel: "low" },
    confidential: { model: "databricks/databricks-claude-sonnet-4-5", thinkingLevel: "medium" },
    local: { model: "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF", thinkingLevel: "medium", optional: true },
  },
  egress: {
    "github-copilot": "public",
    openai: "public",
    databricks: "confidential",
    local: "confidential",
  },
  concurrency: { "github-copilot": 4, openai: 4, databricks: 4, local: 1 },
};

export const CONFIG: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG };

/**
 * What `loadConfiguredProviders()` reads out of `config/models.json` — the real four, and nothing
 * else. `deepseek` is deliberately absent, exactly as a real install would have it: it reaches
 * `ctx.modelRegistry.getAvailable()` through PI's own native catalogue and through no config of
 * ours, which is why it must never be offered as somewhere a dispatch could run.
 */
export const CONFIGURED_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot", "openai", "databricks", "local"]);

/**
 * The stand-in for `ctx.modelRegistry.getAvailable()`. Deliberately a strict subset of the real
 * machine's 38: it holds every tier target except the `local` one (whose absence is the point —
 * an `optional` tier is allowed to be missing), plus a few extra ids so the "closest available"
 * suggestions have something honest to rank.
 */
export const ALL_MODELS = new Set([
  "github-copilot/claude-opus-5",
  "github-copilot/claude-sonnet-5",
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/gpt-5.4",
  "github-copilot/gpt-5.4-mini",
  "databricks/databricks-claude-haiku-4-5",
  "databricks/databricks-gpt-oss-120b",
  "databricks/databricks-claude-sonnet-4-5",
  // Available in PI's registry, and configured NOWHERE — no `deepseek` block in models.json, no
  // egress entry in ROUTING, no key on any real machine. From the 2026-08-14 deny-list inversion's
  // admission rule this makes it undispatchable and invisible: not on the menu, not in a
  // suggestion, refused by the gate with a named reason. It stays in this fixture precisely so the
  // filter has something real to remove — a registry that only holds configured providers cannot
  // prove anything.
  "deepseek/deepseek-v4-flash",
]);

/**
 * The reasoning vocabulary the registry reports for those ids, so the disclosure path is exercised
 * by the whole rule suite rather than by one dedicated test.
 *
 * `github-copilot/gpt-5.4` carries the enum shape an OpenAI-family reasoning model reports: `off`,
 * `minimal`, `xhigh` and `max` are all null, so a request for any of them clamps — `max` down to
 * `high`, `off` UP to `low`. `github-copilot/claude-opus-5` is deliberately given NO entry: a model
 * the registry does not describe must produce no disclosure at all, and half the fixture asserting
 * that is cheaper than a mock.
 */
export const THINKING_CAPS: readonly (readonly [string, ThinkingCapability])[] = [
  [
    "github-copilot/gpt-5.4",
    {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    },
  ],
  // Anthropic-shaped: a token budget rather than an enum, so PI declares the full ladder and
  // nothing clamps. The contrast with the enum shape above is the point.
  [
    "databricks/databricks-claude-sonnet-4-5",
    {
      reasoning: true,
      thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    },
  ],
  // Serves no reasoning at all: every level collapses to `off`.
  ["github-copilot/gpt-5.4-mini", { reasoning: false }],
];

export const CATALOGUE: ModelCatalogue = makeCatalogue(ALL_MODELS, THINKING_CAPS);

export interface AgentFile {
  readonly name: string;
  readonly frontmatter: string;
  readonly body?: string;
}

export function writeAgents(dir: string, files: readonly AgentFile[]): string {
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const body = file.body ?? "You are a test agent. Answer only from files you actually read.";
    writeFileSync(join(dir, `${file.name}.md`), `---\n${file.frontmatter}\n---\n${body}\n`, "utf8");
  }
  return dir;
}

export const GOOD_SCOUT: AgentFile = {
  name: "scout",
  frontmatter: [
    "name: scout",
    "description: Read-only repository reconnaissance - greps, reads and summarises. Never edits.",
    "model: cheap",
    // Block sequence, not `[read, grep]` — see test/agents/frontmatter.test.ts. This fixture never
    // reaches pi-subagents' comma splitter, so the flow form would be valid here; it is written in
    // the safe shape anyway, because fixtures get copied into real agent files and that is exactly
    // how 14 of them ended up with a shape only one of the two parsers could read.
    "tools:",
    "  - read",
    "  - grep",
    "isolation: none",
  ].join("\n"),
};

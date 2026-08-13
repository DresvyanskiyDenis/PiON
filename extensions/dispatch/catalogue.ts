/**
 * The model catalogue — what a dispatch may name, and what to say when it names something else.
 *
 * `tiers.ts` answers "what does this string resolve to". This module answers the two questions
 * that only make sense once a **caller** — the orchestrating model, mid-turn — is allowed to pick
 * a concrete `provider/id` instead of one of the five tier names:
 *
 *   1. **Does it exist?** `ctx.modelRegistry.getAvailable()` is the only authority. Without this
 *      check a typo reaches `pi-subagents`, whose `resolveModelCandidate()`
 *      (`src/runs/shared/model-fallback.ts`) returns the *unresolved string unchanged* when it
 *      cannot match it, and the child is spawned with `--model <garbage>` — a failure 40 minutes
 *      downstream, in a different process, attributed to the wrong thing. Exactly the failure
 *      `github-copilot/gpt-5.1` produced against the tier map in `config/routing.json`.
 *   2. **What should it have written?** A refusal that only says "no" is a refusal the model will
 *      retry verbatim. `suggestModels()` names the closest real ids, and `renderModelMenu()` puts
 *      the whole selectable set in the system prompt so the question is usually not asked at all.
 *
 * Neither function ever substitutes. Suggestions are text inside an error message; nothing here
 * rewrites a call. "Fail loud, no provider failover" is the project rule and this is the module
 * with the most temptation to break it.
 *
 * ## Why the menu is annotated, not filtered
 *
 * The menu lists **every** model in the session's registry, grouped by provider and annotated with
 * that provider's `routing.json` egress class (or `unlabelled`, when it has none). It used to hide
 * anything outside the session's own class; that filter was withdrawn on 2026-08-13 along with the
 * containment rule it served, because hiding a model the session is perfectly entitled to use is
 * exactly what stopped a provider switch mid-session. Existence is still the only gate: a model
 * that is not in the registry is still refused by name.
 */
import type { EgressClass } from "../lib/dispatch-veto.ts";
import type { RoutingConfig } from "./config.ts";
import { THINKING_LEVELS, effectiveLevel } from "./thinking.ts";

/**
 * The registry as this extension consumes it: `provider/id` strings, in the registry's own order.
 *
 * `undefined` is a distinct, meaningful state — `ctx.modelRegistry` threw at `session_start`, so
 * existence cannot be asserted at all. Every consumer treats it as "skip the check and say so",
 * never as "the catalogue is empty".
 */
export interface ModelCatalogue {
  readonly ids: readonly string[];
  readonly set: ReadonlySet<string>;
}

export function makeCatalogue(ids: Iterable<string>): ModelCatalogue {
  const list = [...ids];
  return { ids: list, set: new Set(list) };
}

/** Splits on the FIRST slash: `local/vendor/Model-30B-A3B-GGUF` is one provider, one id. */
export function splitModelId(full: string): { provider: string; id: string } {
  const slash = full.indexOf("/");
  if (slash <= 0) return { provider: "", id: full };
  return { provider: full.slice(0, slash), id: full.slice(slash + 1) };
}

/**
 * Case/separator folding, matching what `pi-subagents`' own fuzzy matcher does
 * (`normalizeModelSegment`): `gpt-5.4` and `gpt_5_4` are the same string to a human typing fast.
 * Used for *ranking suggestions only* — never to accept a spelling we would otherwise refuse.
 */
export function normalizeSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function tokens(segment: string): string[] {
  return normalizeSegment(segment).split(/[-/]/).filter((t) => t.length > 0);
}

/**
 * Shared leading characters, but only once there are enough of them to mean something. Without the
 * floor, "galaxy" and "gpt-5.4" share a `g` and every gpt model becomes a "closest match" for an
 * unrelated word — a suggestion list that is confidently wrong is worse than an empty one.
 */
const MIN_MEANINGFUL_PREFIX = 3;

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i >= MIN_MEANINGFUL_PREFIX ? i : 0;
}

/**
 * The closest real `provider/id`s to something that does not exist, best first.
 *
 * Deliberately simple and deterministic — no dependency, no edit distance table. The three signals
 * that actually explain the mistakes this catalogue produces, in priority order:
 *
 *   - **the same model id under a different provider** (`anthropic/claude-sonnet-5` when the id
 *     only exists as `github-copilot/claude-sonnet-5`) — by far the most common miss in a config
 *     where one model family is reachable through three providers;
 *   - **shared id tokens** (`gpt-5.1` → `gpt-5.4`, `gpt-5.2`, `gpt-5-mini`);
 *   - **the same provider**, as a tiebreak, so a wrong id stays inside the lane that was meant.
 *
 * Returns at most `limit` entries and never returns a zero-signal guess: an unrecognisable string
 * gets no suggestions rather than four arbitrary ones.
 */
export function suggestModels(spec: string, catalogue: ModelCatalogue, limit = 4): string[] {
  const wanted = splitModelId(spec.trim());
  const wantedProvider = normalizeSegment(wanted.provider);
  const wantedId = normalizeSegment(wanted.id);
  const wantedTokens = new Set(tokens(wanted.id));
  if (wantedId.length === 0) return [];

  const scored: { full: string; score: number }[] = [];
  for (const full of catalogue.ids) {
    const entry = splitModelId(full);
    const entryId = normalizeSegment(entry.id);
    const sameProvider = normalizeSegment(entry.provider) === wantedProvider;

    // The id has to carry SOME signal on its own. A shared provider is a tiebreak, never a reason:
    // "you wrote databricks/zzzzzzzz, did you mean databricks/databricks-claude-sonnet-4-5" is a
    // guess dressed up as help, and a model that follows it dispatches the wrong thing.
    let idSignal = 0;
    if (entryId === wantedId) idSignal += 1000;
    // Distinct tokens only. Counting them with multiplicity makes `gpt-5.5` outrank `gpt-5.4` as a
    // suggestion for `gpt-5.1` purely because it repeats the digit 5 — a ranking artefact, not a
    // similarity.
    for (const token of new Set(tokens(entry.id))) if (wantedTokens.has(token)) idSignal += 20;
    idSignal += commonPrefixLength(entryId, wantedId);
    if (idSignal === 0) continue;

    scored.push({ full, score: idSignal + (sameProvider ? 5 : 0) });
  }

  scored.sort((a, b) => (b.score - a.score) || (a.full.length - b.full.length) || a.full.localeCompare(b.full));
  return scored.slice(0, limit).map((s) => s.full);
}

/** Rendered into every refusal that names a bad model, so the retry has somewhere to go. */
export function describeAlternatives(spec: string, catalogue: ModelCatalogue): string {
  const near = suggestModels(spec, catalogue);
  if (near.length === 0) {
    return `No available model resembles it (${catalogue.ids.length} model(s) in the registry); see the "Sub-agent model selection" block in the system prompt for the full list.`;
  }
  return `Closest available: ${near.join(", ")}.`;
}

// --------------------------------------------------------------------------------------------
// The menu
// --------------------------------------------------------------------------------------------

export const MENU_OPEN = "<!-- pi-config:dispatch-models v1 -->";
export const MENU_CLOSE = "<!-- /pi-config:dispatch-models v1 -->";

/** Hard cap on the injected block. 38 models render in ~1.3 KB; this is the backstop, not the plan. */
export const MAX_MENU_BYTES = 4 * 1024;

export interface MenuInput {
  readonly routing: RoutingConfig;
  readonly catalogue: ModelCatalogue | undefined;
  readonly sessionEgress: EgressClass;
  readonly defaultTier: string;
}

export interface MenuSelection {
  /** Provider -> every id under it in the registry, registry order preserved. */
  readonly byProvider: ReadonlyMap<string, readonly string[]>;
  /**
   * Selectable like everything else, but the provider has no egress class in `routing.json`, so the
   * menu can only label it `unlabelled`. Reported so a missing class reads as a configuration fact.
   */
  readonly unclassed: readonly string[];
}

/** Pure, so the grouping is assertable without a live session or a system prompt. */
export function selectMenuModels(input: MenuInput): MenuSelection {
  const byProvider = new Map<string, string[]>();
  const unclassed: string[] = [];
  for (const full of input.catalogue?.ids ?? []) {
    const { provider, id } = splitModelId(full);
    if (!provider) continue;
    if (input.routing.egress[provider] === undefined) unclassed.push(full);
    const bucket = byProvider.get(provider);
    if (bucket) bucket.push(id);
    else byProvider.set(provider, [id]);
  }
  return { byProvider, unclassed };
}

/**
 * The block injected into the system prompt once per turn.
 *
 * Written for a model that is about to call `subagent`, not for a human reading documentation:
 * the contract first, the consequence of getting it wrong second (because "it will abort" is what
 * makes the list worth reading), then the list itself. Tiers stay listed first — they remain the
 * normal way to pick, and a concrete id is the deliberate exception for cost control.
 */
export function renderModelMenu(input: MenuInput): string {
  const tierNames = Object.keys(input.routing.tiers);
  const selection = selectMenuModels(input);
  const lines: string[] = [];
  lines.push(`## Sub-agent model selection`);
  lines.push(
    `The dispatch tools take an optional \`model\`. It accepts EITHER a tier name from ` +
      `config/routing.json — ${tierNames.map((t) => `\`${t}\``).join(", ")} — OR a concrete ` +
      `\`provider/id\` from the list below. A value containing "/" is read as a provider-qualified ` +
      `id; anything else is read as a tier name.`,
  );
  lines.push(
    `An explicit \`model\` on the call wins over the agent file's own \`model:\`. Omit it to use ` +
      `the agent's own (default tier: \`${input.defaultTier}\`). Prefer a tier unless you are ` +
      `deliberately trading capability for cost on this one call.`,
  );
  lines.push(
    `Append \`:<level>\` to a concrete id to set that child's REASONING EFFORT for this dispatch — ` +
      `${THINKING_LEVELS.map((l) => `\`${l}\``).join(", ")} — e.g. \`${firstExample(selection)}:max\`. ` +
      `It overrides the agent file's own thinking setting. A misspelled level is not read as an ` +
      `effort and aborts the dispatch as an unknown model; there is no default-on-typo.`,
  );
  lines.push(
    `An unknown tier, or an id that is not in the list below, ABORTS that dispatch. Nothing is ` +
      `substituted and no cheaper model is silently used in its place.`,
  );

  for (const [tier, def] of Object.entries(input.routing.tiers)) {
    const { provider } = splitModelId(def.model);
    const level = effectiveLevel(def.model) ?? def.thinkingLevel;
    lines.push(
      `  - tier \`${tier}\` -> ${def.model} (egress ${describeClass(input.routing.egress[provider])}, ` +
        `effort ${level ?? "provider default"})` +
        (def.purpose ? ` — ${def.purpose}` : ""),
    );
  }

  if (input.catalogue === undefined) {
    lines.push(
      `The model registry was unavailable at session start, so concrete \`provider/id\` values ` +
        `cannot be checked for existence here. Name a tier instead.`,
    );
    return lines.join("\n");
  }

  const total = [...selection.byProvider.values()].reduce((n, ids) => n + ids.length, 0);
  lines.push(
    `This session is classed \`${input.sessionEgress}\`; the class is a label and restricts nothing. ` +
      `All ${total} concrete id(s) below are selectable, grouped by provider:`,
  );
  for (const [provider, ids] of selection.byProvider) {
    lines.push(`  - ${provider} (egress ${describeClass(input.routing.egress[provider])}): ${ids.join(", ")}`);
  }
  lines.push(`  Write them qualified, e.g. \`${firstExample(selection)}\`.`);

  if (selection.unclassed.length > 0) {
    const providers = [...new Set(selection.unclassed.map((m) => splitModelId(m).provider))];
    lines.push(
      `  ${selection.unclassed.length} of them come from provider(s) with no egress class in ` +
        `routing.json (${providers.join(", ")}); they are selectable and reported as unlabelled.`,
    );
  }

  return lines.join("\n");
}

/** One spelling for "routing.json says nothing about this provider", used everywhere it is shown. */
function describeClass(cls: EgressClass | undefined): string {
  return cls ?? "unlabelled";
}

function firstExample(selection: MenuSelection): string {
  for (const [provider, ids] of selection.byProvider) {
    if (ids.length > 0) return `${provider}/${ids[0]}`;
  }
  return "provider/id";
}

/**
 * Removes any previously injected menu, then appends exactly one — idempotent by construction, so
 * it survives compaction, `/reload` and a second extension editing the same prompt, exactly as
 * `session-context.ts` does for its own block.
 */
export function injectMenuOnce(systemPrompt: string, block: string): string {
  const stripped = stripMenu(systemPrompt);
  const note = `[dispatch model menu truncated to ${MAX_MENU_BYTES} bytes]`;
  const overhead =
    Buffer.byteLength(MENU_OPEN, "utf8") + Buffer.byteLength(MENU_CLOSE, "utf8") +
    Buffer.byteLength(note, "utf8") + 4;
  const capped = capMenuBytes(block, MAX_MENU_BYTES - overhead, note);
  return `${stripped.trimEnd()}\n\n${MENU_OPEN}\n${capped}\n${MENU_CLOSE}\n`;
}

export function stripMenu(s: string): string {
  let out = s;
  for (;;) {
    const start = out.indexOf(MENU_OPEN);
    if (start === -1) return out;
    const end = out.indexOf(MENU_CLOSE, start);
    out = end === -1 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + MENU_CLOSE.length);
  }
}

function capMenuBytes(s: string, maxBytes: number, note: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  return `${head}\n${note}`;
}

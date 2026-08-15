/**
 * The model catalogue — what a dispatch may name, and what to say when it names something else.
 *
 * `tiers.ts` answers "what does this string resolve to". This module answers the two questions
 * that only make sense once a **caller** — the orchestrating model, mid-turn — is allowed to pick
 * a concrete `provider/id` instead of one of the three tier names:
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
 * ## A provider that is not configured does not exist
 *
 * `ctx.modelRegistry.getAvailable()` is PI's own registry, and it carries providers PI knows
 * natively whether or not this install ever set them up. Before the 2026-08-14 deny-list inversion
 * that whole registry was the menu, the suggestion pool and the existence gate, so a provider
 * present in neither `config/models.json` nor `config/routing.json`'s `egress` map, and with no key
 * on this machine, could still be offered as a routing target, listed as selectable, reachable by
 * typo correction, and accepted by the gate. It would then fail in the child process, minutes
 * later, on a missing credential, attributed to the wrong thing.
 *
 * The rule, as an owner decision dated 2026-08-14: *a provider that is not configured does not
 * exist*. A provider is dispatchable only when it is BOTH
 *
 *   - **configured** — declared in `config/models.json`'s `providers` object, i.e. this install has
 *     an endpoint and a credential for it; and
 *   - **classified** — carrying an entry in `config/routing.json`'s `egress` map, i.e. somebody has
 *     said out loud what class of data may leave for it.
 *
 * That is a structural rule about the two config files, not a list of banned provider names —
 * nothing here hardcodes a provider identity. `admissibleProviders` computes the set,
 * `describeProviderRefusal` explains an exclusion in the operator's terms, and `restrictCatalogue`
 * applies it once so that the menu, the suggestions and `tiers.ts`'s existence gate cannot disagree
 * about what exists.
 *
 * Consequently `unlabelled` is no longer a class this module can render. It was the egress map
 * saying out loud that it could not classify a route it was nonetheless offering; it is now a
 * filter.
 *
 * The earlier session-class filter — hiding models outside the session's own egress class — stays
 * withdrawn (2026-08-13). Hiding a model the session is entitled to use is what stopped a provider
 * switch mid-session. This is a different question: not "may this session use it" but "does this
 * install have it at all".
 */
import type { EgressClass } from "../lib/dispatch-veto.ts";
import type { RoutingConfig } from "./config.ts";
import {
  THINKING_LEVELS,
  discloseThinking,
  requestedLevel,
  splitThinkingSuffix,
  supportedThinkingLevels,
  type ThinkingCapability,
  type ThinkingDisclosure,
  type ThinkingLevel,
} from "./thinking.ts";

/**
 * The registry as this extension consumes it: `provider/id` strings, in the registry's own order.
 *
 * `undefined` is a distinct, meaningful state — `ctx.modelRegistry` threw at `session_start`, so
 * existence cannot be asserted at all. Every consumer treats it as "skip the check and say so",
 * never as "the catalogue is empty".
 *
 * `thinking` carries each model's reasoning vocabulary, so a dispatch can say what effort it will
 * ACTUALLY run at rather than what it asked for. It is keyed by bare `provider/id`, never by a
 * suffixed string, and a model missing from it simply gets no disclosure — an unknown vocabulary
 * must read as "cannot say", never as "no clamp will happen".
 */
export interface ModelCatalogue {
  readonly ids: readonly string[];
  readonly set: ReadonlySet<string>;
  readonly thinking: ReadonlyMap<string, ThinkingCapability>;
}

export function makeCatalogue(
  ids: Iterable<string>,
  thinking?: Iterable<readonly [string, ThinkingCapability]>,
): ModelCatalogue {
  const list = [...ids];
  return { ids: list, set: new Set(list), thinking: new Map(thinking ?? []) };
}

// --------------------------------------------------------------------------------------------
// Admission: which providers this install actually has
// --------------------------------------------------------------------------------------------

/** The provider names dispatch will accept, and whether that answer had to be degraded. */
export interface ProviderAdmission {
  /** Configured AND classified. Anything outside it is refused by name, never silently dropped. */
  readonly dispatchable: ReadonlySet<string>;
  /** The two inputs, kept so a refusal can name WHICH half failed. See `describeProviderRefusal`. */
  readonly routing: RoutingConfig;
  readonly configuredProviders: ReadonlySet<string> | undefined;
  /**
   * `config/models.json` could not be read, so only the classified half was applied.
   *
   * The alternative — refusing every dispatch until the file parses — turns one unreadable config
   * into a total outage, and the file is not the only evidence: `routing.json`'s `egress` map is an
   * independent statement about the same providers, written by hand, and on its own it already
   * excludes anything PI merely knows about natively. So the conjunct is dropped rather than the
   * world emptied, and the degradation is announced through `problems` at `session_start` and shown
   * in `/agents`.
   */
  readonly degraded: boolean;
}

/**
 * The dispatchable set: `routing.json`'s classified providers, narrowed to those `models.json`
 * declares.
 *
 * Built from the egress map rather than from the registry, because the question is what this
 * install configured, not what PI happens to ship a client for.
 */
export function admissibleProviders(
  routing: RoutingConfig,
  configuredProviders: ReadonlySet<string> | undefined,
): ProviderAdmission {
  const classified = Object.keys(routing.egress);
  const dispatchable =
    configuredProviders === undefined
      ? new Set(classified)
      : new Set(classified.filter((p) => configuredProviders.has(p)));
  return { dispatchable, routing, configuredProviders, degraded: configuredProviders === undefined };
}

/**
 * Why `provider` is not dispatchable, in the operator's terms and naming the file at fault, or
 * `undefined` when it is dispatchable.
 *
 * Both halves are reported when both fail, because "it is not configured" and "it has no egress
 * class" are two different pieces of work and a message that names one sends the reader to fix half
 * the problem.
 */
export function describeProviderRefusal(provider: string, admission: ProviderAdmission): string | undefined {
  const classified = admission.routing.egress[provider] !== undefined;
  // An unreadable `models.json` cannot convict anyone; see `ProviderAdmission.degraded`.
  const configured = admission.configuredProviders === undefined || admission.configuredProviders.has(provider);
  if (classified && configured) return undefined;
  const reasons: string[] = [];
  if (!configured) reasons.push(`it is not configured in config/models.json`);
  if (!classified) reasons.push(`it has no egress class in config/routing.json`);
  return reasons.join(", and ");
}

/** A catalogue narrowed to the dispatchable providers, plus what that removed. */
export interface RestrictedCatalogue {
  readonly catalogue: ModelCatalogue;
  /**
   * Registry ids dropped because their provider is not dispatchable, registry order preserved.
   *
   * Reported to the OPERATOR — `problems` and `/agents` — and to nobody else. It is deliberately
   * not rendered into the system prompt: telling the orchestrating model which models it may not
   * have is an invitation to try one, and "must not appear on any surface" is the rule. A human
   * still needs to know their registry holds providers this install never configured.
   */
  readonly dropped: readonly string[];
}

/**
 * Applies the admission rule to a whole catalogue, once, at `session_start`.
 *
 * Doing it here rather than at each call site is the point: the menu, `suggestModels` and the
 * existence gate in `tiers.ts` all read the same `ModelCatalogue`, so filtering it once is what
 * makes them agree. A menu that offers what the gate refuses costs a dispatch; a gate that accepts
 * what the menu never showed costs a credential error in a child process much later.
 */
export function restrictCatalogue(catalogue: ModelCatalogue, admission: ProviderAdmission): RestrictedCatalogue {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const full of catalogue.ids) {
    const { provider } = splitModelId(full);
    (provider && admission.dispatchable.has(provider) ? kept : dropped).push(full);
  }
  if (dropped.length === 0) return { catalogue, dropped };
  const thinking = [...catalogue.thinking].filter(([full]) => {
    const { provider } = splitModelId(full);
    return provider !== "" && admission.dispatchable.has(provider);
  });
  return { catalogue: makeCatalogue(kept, thinking), dropped };
}

/**
 * What effort a resolved model string will really run at. Takes the full string (suffix and all)
 * and strips it internally, so callers never have to remember whether the catalogue is keyed with
 * or without the level.
 */
export function catalogueDisclosure(
  catalogue: ModelCatalogue | undefined,
  model: string,
): ThinkingDisclosure | undefined {
  if (catalogue === undefined) return undefined;
  const { baseModel } = splitThinkingSuffix(model);
  return discloseThinking(model, catalogue.thinking.get(baseModel));
}

/** One provider's models that can serve a given reasoning level, with the class of leaving for it. */
export interface ServingProvider {
  readonly provider: string;
  /**
   * Always a real class. A provider `routing.json` does not classify never becomes a candidate at
   * all (see `providersServing`), so `unlabelled` is not a state this type can hold.
   */
  readonly egress: EgressClass;
  readonly models: readonly string[];
}

/**
 * Which configured models actually serve `level`, grouped by provider, registry order preserved.
 *
 * This is the routing HINT half of a clamp disclosure: when a dispatch asks for an effort its model
 * will not run at, the reader's next question is always "then what would?", and answering it from
 * the registry is cheaper and more honest than letting them guess. It is emphatically not failover
 * — nothing here reroutes anything, and the egress class travels with every entry precisely because
 * moving a job from `internal` to `confidential` or `public` is a decision only the operator makes.
 *
 * A model with no entry in `catalogue.thinking` is skipped rather than assumed capable: an unknown
 * vocabulary must read as "cannot say", never as "yes".
 *
 * The candidates are the dispatchable providers and only those (`admissibleProviders`), applied
 * here as well as at the catalogue, because a HINT is the surface where an unconfigured endpoint
 * used to do the most damage: an unconfigured provider labelled `egress unlabelled` could be
 * offered as a place to run `max` on a machine with no block for it in `config/models.json` and no
 * key for one. `egress unlabelled` was the egress map saying out loud that it could not classify a
 * route it was nonetheless recommending, and the map exists precisely to stop work reaching an
 * unintended destination.
 *
 * Nothing about the consequence changes: still a hint, still never a reroute, and the egress class
 * is still shown per provider and still never altered for anyone.
 */
export function providersServing(
  catalogue: ModelCatalogue | undefined,
  routing: RoutingConfig,
  level: ThinkingLevel,
  configuredProviders?: ReadonlySet<string>,
): ServingProvider[] {
  if (catalogue === undefined) return [];
  const admission = admissibleProviders(routing, configuredProviders);
  const byProvider = new Map<string, { egress: EgressClass; models: string[] }>();
  for (const full of catalogue.ids) {
    const cap = catalogue.thinking.get(full);
    if (cap === undefined) continue;
    if (!supportedThinkingLevels(cap).includes(level)) continue;
    const { provider } = splitModelId(full);
    if (!provider) continue;
    if (!admission.dispatchable.has(provider)) continue;
    // Dispatchable implies classified, so this is a real class and never `unlabelled`.
    const egress = routing.egress[provider] as EgressClass;
    const bucket = byProvider.get(provider);
    if (bucket) bucket.models.push(full);
    else byProvider.set(provider, { egress, models: [full] });
  }
  return [...byProvider].map(([provider, { egress, models }]) => ({ provider, egress, models }));
}

/** Hard cap per provider, so a clamp warning stays a sentence and not a second model menu. */
const MAX_SERVING_MODELS_PER_PROVIDER = 3;

/** The routing hint as one sentence, for the clamp warning and for an abort reason. */
export function describeServing(serving: readonly ServingProvider[], level: string): string {
  // "Configured" rather than "in this session's registry": since `providersServing` started
  // filtering, an empty list no longer means the registry holds nothing that serves the level — it
  // means nothing CONFIGURED does. Naming the unconfigured ones instead is exactly the inversion
  // this rule exists to stop, so this stays the answer for that case and only the noun moved.
  if (serving.length === 0) {
    return (
      `No configured model serves \`${level}\` at all, so this is the configuration's ceiling ` +
      `rather than a routing choice — see config/models.json's thinkingLevelMap notes for who ` +
      `could raise it.`
    );
  }
  const parts = serving.map((s) => {
    const shown = s.models.slice(0, MAX_SERVING_MODELS_PER_PROVIDER);
    const more = s.models.length - shown.length;
    return `${s.provider} (egress ${s.egress}): ${shown.join(", ")}` + (more > 0 ? ` +${more} more` : "");
  });
  return (
    `Models that DO serve \`${level}\`: ${parts.join("; ")}. Naming one is yours to decide — this is a ` +
    `hint, not a reroute, and changing egress class is never done for you.`
  );
}

/**
 * Splits on the FIRST slash, because a model id may itself contain slashes — `<provider>/org/Model`
 * is one provider and one id, not three segments. Aggregator gateways serve exactly such ids. The
 * rule is about the id format, not about who happens to be configured.
 */
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
 *  *   - **the same model id under a different provider** (`databricks/claude-sonnet-5` when the id
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
  /**
   * `config/models.json`'s provider names. `undefined` means the file could not be read — see
   * `ProviderAdmission.degraded`.
   *
   * The menu applies the admission rule itself rather than trusting its caller to have passed a
   * catalogue that was already restricted. The menu is the model's only picture of what exists, and
   * a surface that leaks an unconfigured provider is one the model will call.
   */
  readonly configuredProviders: ReadonlySet<string> | undefined;
}

export interface MenuSelection {
  /** Provider -> every id under it that is dispatchable, registry order preserved. */
  readonly byProvider: ReadonlyMap<string, readonly string[]>;
  /**
   * Registry ids the menu will not offer, because their provider is not dispatchable. Operator-
   * facing only — see `RestrictedCatalogue.dropped`, which is the same fact from the same rule.
   */
  readonly excluded: readonly string[];
}

/** Pure, so the grouping is assertable without a live session or a system prompt. */
export function selectMenuModels(input: MenuInput): MenuSelection {
  const admission = admissibleProviders(input.routing, input.configuredProviders);
  const byProvider = new Map<string, string[]>();
  const excluded: string[] = [];
  for (const full of input.catalogue?.ids ?? []) {
    const { provider, id } = splitModelId(full);
    if (!provider) continue;
    if (!admission.dispatchable.has(provider)) {
      excluded.push(full);
      continue;
    }
    const bucket = byProvider.get(provider);
    if (bucket) bucket.push(id);
    else byProvider.set(provider, [id]);
  }
  return { byProvider, excluded };
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
    // A tier declares its level in either of two places; the suffix on the id wins, exactly as
    // `applyTierThinkingLevel` decides it (tiers.ts).
    const asked = requestedLevel(def.model) ?? def.thinkingLevel;
    // ...and then the model's own vocabulary has the last word. Showing only `asked` here is what
    // hid an afternoon of runs that were commissioned at `max` and shipped `high`.
    const disclosure =
      asked === undefined
        ? undefined
        : catalogueDisclosure(input.catalogue, `${splitThinkingSuffix(def.model).baseModel}:${asked}`);
    const effort =
      disclosure === undefined
        ? (asked ?? "provider default")
        : disclosure.clamped
          ? `${disclosure.effective} (asked ${disclosure.requested}; ${provider} does not serve it — serves ${disclosure.supported.join("|")})`
          : disclosure.effective;
    // A tier is only as good as its provider. If `routing.json` points a tier at something this
    // install has not configured, the dispatch aborts (`tiers.ts` refuses it by name) — so the menu
    // says that here rather than labelling the tier `egress unlabelled` and letting the model find
    // out by calling it.
    const refusal = describeProviderRefusal(provider, admissibleProviders(input.routing, input.configuredProviders));
    lines.push(
      refusal !== undefined
        ? `  - tier \`${tier}\` -> ${def.model} — NOT DISPATCHABLE: ${refusal}. Calling it aborts; ` +
            `this is a config/routing.json error to fix, not a model to work around.`
        : `  - tier \`${tier}\` -> ${def.model} (egress ${input.routing.egress[provider]}, ` +
            `effort ${effort})` +
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
      `All ${total} concrete id(s) below are selectable, grouped by provider. This is the complete ` +
      `set — a provider this install has not configured is not on it and cannot be dispatched to:`,
  );
  for (const [provider, ids] of selection.byProvider) {
    lines.push(`  - ${provider} (egress ${input.routing.egress[provider]}): ${ids.join(", ")}`);
  }
  lines.push(`  Write them qualified, e.g. \`${firstExample(selection)}\`.`);

  return lines.join("\n");
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

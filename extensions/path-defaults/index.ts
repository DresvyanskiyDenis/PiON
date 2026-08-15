/**
 * `EXT-27` — default tier and egress policy (`REQ-PRV-90`).
 *
 * A single configured default for provider/tier and a declarative per-channel egress policy for
 * every session, inside the single config tree (Decision D1: one install, one config tree —
 * `oh-my-pi` proves the *shape* of `path:`-prefixed model scoping; only the idea is ported, not
 * the fork, which is a core-engine feature that cannot be cherry-picked).
 *
 * This module used to resolve a *different* default per `cwd`, matching a `roots` array by
 * longest prefix. That per-directory split is gone: `config/path-defaults.json` now names exactly
 * one tier and one egress policy, applied at every `session_start` regardless of where it runs.
 * `rootFor`, `expandHome`, the `RootDef`/`RootEgress` types, the wildcard-last rule and duplicate-
 * path detection are all deleted along with the array they existed to search — see `config.ts`'s
 * and `resolve.ts`'s own header comments for what each one used to do.
 *
 * ## Two DIFFERENT things both called "egress" here, on purpose
 *
 * 1. **Session egress class** (`public`/`internal`/`confidential`, `extensions/lib/dispatch-veto.ts`'s
 *    vocabulary) — one scalar per session, derived from the configured tier's provider via
 *    `config/routing.json`'s `egress` map (`./routing.ts`). Declared into `PI_ROUTING_EGRESS` so
 *    `EXT-05`'s dispatch containment (`extensions/dispatch/tiers.ts` `resolveSessionEgress`,
 *    `extensions/guard/gates/agent-routing.ts`) enforces "a confidential session may not
 *    dispatch a child onto a public provider" — this is the ACTUAL, ALREADY-SHIPPED enforcement
 *    mechanism this item hooks into. An earlier draft named the contract
 *    `PI_EGRESS_CLASS`; both of `EXT-05`'s real readers (`dispatch/index.ts`,
 *    `guard/gates/agent-routing.ts`) read `PI_ROUTING_EGRESS` instead — the fact wins, and this
 *    module sets `PI_ROUTING_EGRESS`.
 *
 * 2. **Per-channel egress policy** (`{web, mcp, publicModels}`, each `"allow"|"deny"`) — a
 *    DIFFERENT, DECLARATIVE fact, now install-wide rather than per-root: whether this install's
 *    sessions should be allowed to reach the open web, use MCP tools, or fall back to a public
 *    model at all. This module does not intercept a web call, an MCP call, or a model choice to
 *    enforce it — it only computes and exports it for `EXT-07` (web tools) and `EXT-14` (MCP
 *    adapter) to read and enforce at their own call sites, and neither one currently does: this
 *    item's earlier per-`cwd` accessor (`egressClassFor`) had zero real consumers (re-checked at
 *    the same time this module lost its per-directory shape — `grep -rn egressClassFor
 *    extensions/web* extensions/mcp*` still returns nothing, and both extensions shipped complete
 *    without wiring it), and a `cwd`-keyed accessor had nothing left to compute once resolution
 *    stopped depending on `cwd` at all. It was deleted rather than reshaped around a parameter it
 *    no longer needs. A consumer that wants this signal reads
 *    `resolvePathDefaults().file.egress` directly — there is only one policy to read now. **It is
 *    declarative, not a network boundary.** An install with no `EXT-07`/`EXT-14` wiring in place
 *    enforces nothing from this channel — the notice this module prints says so, and nobody should
 *    read the presence of a `"deny"` entry here as proof that traffic is actually blocked.
 *
 * ## Why `pi.setModel()` at `session_start` and not a `tool_call` handler
 *
 * There is no tool call to gate: this is "which model does this session start on", which is
 * exactly `pi.setModel()`'s job (the relevant surface is `session_start`,
 * `pi.setModel()`, `ctx.scopedModels`, `ctx.ui.notify`). `guardedHandler` is typed for
 * `ToolCallEvent`/`ToolCallEventResult` and does not apply here (that inversion
 * is specific to `tool_call`); PI's own generic `emit()` already catches a throwing
 * `session_start` handler per-extension without taking the process down (verified against
 * `dist/core/extensions/runner.js`), so the try/catch below is for a FRIENDLIER, on-brand message
 * (`once.ts`'s `surfaceOnce`/`describeError` idiom), not a crash backstop PI does not already have.
 *
 * ## Register()-time declaration, and why
 *
 * `PI_ROUTING_EGRESS` is read by `EXT-05`'s `dispatch/index.ts` `session_start` handler and
 * captured ONCE into session-lifetime state. `extensions/<dir>/index.ts` discovery order across
 * sibling directories is plain `fs.readdirSync` order (`dist/core/extensions/loader.js`
 * `discoverExtensionsInDir`) — unspecified, filesystem-dependent, and not something either module
 * controls. If this module's OWN declaration only happened inside its `session_start` handler, and
 * `dispatch`'s directory happened to be listed (and therefore its `session_start` handler run)
 * first, the containment veto would capture the OLD (or default) egress class instead of this
 * install's configured one. `loadExtensions()` runs every extension's `register()` to completion
 * BEFORE any `session_start` event is ever emitted (`dist/core/extensions/loader.js`
 * `discoverAndLoadExtensions` → `loadExtensions`, called from session construction, ahead of the
 * `ExtensionRunner.emit("session_start")` pass) — so declaring in `register()` removes the race
 * outright, no `ctx.cwd` needed since the resolved tier no longer depends on it. Both writes go
 * through the same "never clobber an existing declaration" guard (`declareSessionEgress`), so
 * whichever runs first wins and they would normally agree anyway.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type NoticeTarget, emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { type PathDefaultsFile, loadPathDefaults } from "./config.ts";
import { explicitModelRequested, statusFlag } from "./resolve.ts";
import { loadRoutingTierTarget, type RoutingTierTarget } from "./routing.ts";

export const id = "path-defaults";

export type Resolution =
  | { readonly kind: "disabled" } // no config/path-defaults.json — a normal, unconfigured install
  | { readonly kind: "config-error"; readonly message: string }
  | { readonly kind: "configured"; readonly file: PathDefaultsFile; readonly target: RoutingTierTarget };

/**
 * Everything this item can determine WITHOUT touching `pi`/`ctx` — synchronous, and the seam
 * every unit test drives. Never throws: every failure mode becomes a `"config-error"`
 * `Resolution` instead, per `REQ-PRV-32` (announce, never silently substitute). Takes no `cwd`
 * argument any more — the same configured tier applies regardless of where the session starts.
 */
export function resolvePathDefaults(pathDefaultsPath?: string): Resolution {
  let file: PathDefaultsFile;
  try {
    file = pathDefaultsPath ? loadPathDefaults(pathDefaultsPath) : loadPathDefaults();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause as NodeJS.ErrnoException | undefined;
    if (cause?.code === "ENOENT") return { kind: "disabled" };
    return { kind: "config-error", message: describeError(err) };
  }
  try {
    const target = loadRoutingTierTarget(file.tier);
    return { kind: "configured", file, target };
  } catch (err) {
    return { kind: "config-error", message: `tier "${file.tier}": ${describeError(err)}` };
  }
}

/** Sets `PI_ROUTING_EGRESS` from a configured resolution — but never overwrites an existing value.
 *  `dispatch/tiers.ts`'s own doc comment: "An explicit declaration always wins" — a value the
 *  user (or a wrapper script) set manually must not be clobbered by this module's opinion. */
export function declareSessionEgress(res: Resolution): void {
  if (res.kind !== "configured") return;
  if (process.env.PI_ROUTING_EGRESS === undefined) {
    process.env.PI_ROUTING_EGRESS = res.target.egress;
  }
}

export function register(pi: ExtensionAPI): void {
  try {
    declareSessionEgress(resolvePathDefaults());
  } catch (err) {
    // Must never break a session-less invocation (`pi --list-models`). No ctx exists yet, so
    // stderr is the only channel; session_start repeats this properly with full UI.
    process.stderr.write(
      `[pi-config] path-defaults: register()-time egress probe failed (non-fatal, retried at session_start): ${describeError(err)}\n`,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    const announce = report(ctx);
    try {
      const res = resolvePathDefaults();
      declareSessionEgress(res);
      await applyResolution(pi, ctx, res, announce);
    } catch (err) {
      surfaceOnce(ctx, `path-defaults:session_start:${describeError(err).slice(0, 80)}`, () => {
        announce(`session_start failed internally; path defaults were not applied: ${describeError(err)}`, "error");
      });
    }
  });

  pi.registerCommand("path-defaults-status", {
    description: "Show the configured default tier and egress policy (debugging)",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      report(ctx)(describeResolution(resolvePathDefaults()), "info");
    },
  });
}

// ---------------------------------------------------------------------------------------------

async function applyResolution(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  res: Resolution,
  announce: Announce,
): Promise<void> {
  if (res.kind === "disabled") return;
  if (res.kind === "config-error") {
    ctx.ui.setStatus("scope", undefined);
    announce(`path defaults not applied: ${res.message}`, "error");
    return;
  }

  const { file, target } = res;
  ctx.ui.setStatus("scope", statusFlag(target.egress));
  const egressLine =
    `session egress ${target.egress}; web ${file.egress.web}, mcp ${file.egress.mcp}, ` +
    `public models ${file.egress.publicModels} (declarative — enforced only where EXT-07/EXT-14 consult it)`;

  if (ctx.scopedModels.length > 0 || explicitModelRequested()) {
    announce(
      `configured default tier "${file.tier}" (${target.model}), but an explicit model ` +
        `selection is already in effect for this session — leaving it alone. ${egressLine}`,
      "info",
    );
    return;
  }

  const resolved = ctx.modelRegistry.find(target.provider, target.modelId);
  if (!resolved) {
    announce(
      `configured default tier "${file.tier}" -> ${target.model}, but no such model is ` +
        `configured (check config/models.json, and for github-copilot that its catalogue has ` +
        `refreshed). Run: pi --list-models`,
      "error",
    );
    return;
  }

  const ok = await pi.setModel(resolved);
  if (!ok) {
    const staying = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
    announce(
      `configured default tier "${file.tier}" wants ${target.model} but no credential is available ` +
        `for provider "${target.provider}"; staying on ${staying}. Run: pi --list-models to see ` +
        `which providers have a usable credential.`,
      "error",
    );
    return;
  }
  // `pi.setThinkingLevel` is the seam that makes a tier's declared effort real. `dispatch/tiers.ts`
  // has no such API for a child it is about to spawn and must smuggle the level inside the model
  // id; this module runs inside `session_start` holding the `ExtensionAPI`, so it can just ask.
  // Deliberately here and nowhere else: an explicit-model override, an unresolved model and a
  // missing credential all return above, and none of them should move this session's effort.
  if (target.thinkingLevel !== undefined) {
    pi.setThinkingLevel(target.thinkingLevel);
  }
  announce(`configured default tier "${file.tier}" -> ${target.model}. ${egressLine}`, "info");
}

/** No leading "path-defaults: " here — the only caller (`report()`, above) already prefixes
 *  every message with "[pi-config] path-defaults: "; repeating it here just doubled the prefix. */
function describeResolution(res: Resolution): string {
  switch (res.kind) {
    case "disabled":
      return "no config/path-defaults.json — the feature is not configured";
    case "config-error":
      return `config error: ${res.message}`;
    case "configured":
      return (
        `configured default tier "${res.file.tier}" -> ${res.target.model}, session egress ` +
        `${res.target.egress}; web ${res.file.egress.web}, mcp ${res.file.egress.mcp}, ` +
        `public models ${res.file.egress.publicModels}`
      );
  }
}

// ---------------------------------------------------------------------------------------------

type Announce = (message: string, level: "info" | "warning" | "error") => void;

/** One channel, whichever this run mode has — `ctx.ui.notify` in the TUI, stderr in
 *  `-p`/`--mode json` where notify is a no-op. Writing both, as this
 *  helper used to, printed every startup line twice in the TUI; `lib/announce.ts` carries the
 *  full argument and is now the single implementation for the whole tree. */
function report(ctx: NoticeTarget): Announce {
  return (message, level) => emitNotice(ctx, `[pi-config] path-defaults: ${message}`, level);
}

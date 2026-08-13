/**
 * `EXT-27` — path-scoped defaults (`REQ-PRV-90`).
 *
 * Per-`cwd` defaults for provider/tier and a declarative per-channel egress policy, inside the
 * single config tree (Decision D1: one install, one config tree — `oh-my-pi` proves the *shape*
 * of `path:`-prefixed model scoping; only the idea is ported, not the fork, which is a core-engine
 * feature that cannot be cherry-picked).
 *
 * ## Two DIFFERENT things both called "egress" here, on purpose
 *
 * 1. **Session egress class** (`public`/`internal`/`confidential`, `extensions/lib/dispatch-veto.ts`'s
 *    vocabulary) — one scalar per matched root, derived from the root's **tier**'s provider via
 *    `config/routing.json`'s `egress` map (`./routing.ts`). Declared into `PI_ROUTING_EGRESS` so
 *    `EXT-05`'s dispatch containment (`extensions/dispatch/tiers.ts` `resolveSessionEgress`,
 *    `extensions/guard/gates/agent-routing.ts`) enforces "a confidential root's session may not
 *    dispatch a child onto a public provider" — this is the ACTUAL, ALREADY-SHIPPED enforcement
 *    mechanism this item hooks into. An earlier draft named the contract
 *    `PI_EGRESS_CLASS`; both of `EXT-05`'s real readers (`dispatch/index.ts`,
 *    `guard/gates/agent-routing.ts`) read `PI_ROUTING_EGRESS` instead — the fact wins, and this
 *    module sets `PI_ROUTING_EGRESS`.
 *
 * 2. **Per-channel egress policy** (`{web, mcp, publicModels}`, each `"allow"|"deny"`) — a
 *    DIFFERENT, per-root, purely DECLARATIVE fact: whether this directory's session should be
 *    allowed to reach the open web, use MCP tools, or fall back to a public model at all. This
 *    module does not intercept a web call, an MCP call, or a model choice to enforce it — it only
 *    computes and exports it (`egressClassFor`, below) for `EXT-07` (web tools) and `EXT-14` (MCP
 *    adapter) to read and enforce at their own call sites. **It is declarative, not a network
 *    boundary.** A directory tree with no `EXT-07`/`EXT-14` wiring in place enforces nothing from
 *    this channel — the notice this module prints says so, and nobody should read the presence of
 *    a `"deny"` entry here as proof that traffic is actually blocked.
 *
 * ## Why `pi.setModel()` at `session_start` and not a `tool_call` handler
 *
 * There is no tool call to gate: this is "which model does this session start on", which is
 * exactly `pi.setModel()`'s job (the relevant surface is `session_start`,
 * `pi.setModel()`, `ctx.cwd`, `ctx.scopedModels`, `ctx.ui.notify`). `guardedHandler` is typed for
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
 * root's. `loadExtensions()` runs every extension's `register()` to completion BEFORE any
 * `session_start` event is ever emitted (`dist/core/extensions/loader.js`
 * `discoverAndLoadExtensions` → `loadExtensions`, called from session construction, ahead of the
 * `ExtensionRunner.emit("session_start")` pass) — so declaring in `register()`, using
 * `process.cwd()` in place of the not-yet-available `ctx.cwd`, removes the race outright. Both
 * writes go through the same "never clobber an existing declaration" guard
 * (`declareSessionEgress`), so whichever runs first wins and they would normally agree anyway.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type NoticeTarget, emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { type Channel, type PathDefaultsFile, type RootDef, loadPathDefaults } from "./config.ts";
import { explicitModelRequested, rootFor, statusFlag } from "./resolve.ts";
import { loadRoutingTierTarget, type RoutingTierTarget, type SessionEgressClass } from "./routing.ts";

export const id = "path-defaults";

export type Resolution =
  | { readonly kind: "disabled" } // no config/path-defaults.json — a normal, unconfigured install
  | { readonly kind: "config-error"; readonly message: string }
  | { readonly kind: "unmatched" } // valid file, but no root (and no "*") covers this cwd
  | { readonly kind: "matched"; readonly root: RootDef; readonly target: RoutingTierTarget };

/**
 * Everything this item can determine WITHOUT touching `pi`/`ctx` beyond `cwd` — synchronous, and
 * the seam every unit test drives. Never throws: every failure mode becomes a `"config-error"`
 * `Resolution` instead, per `REQ-PRV-32` (announce, never silently substitute).
 */
export function resolveForCwd(cwd: string, pathDefaultsPath?: string): Resolution {
  let file: PathDefaultsFile;
  try {
    file = pathDefaultsPath ? loadPathDefaults(pathDefaultsPath) : loadPathDefaults();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause as NodeJS.ErrnoException | undefined;
    if (cause?.code === "ENOENT") return { kind: "disabled" };
    return { kind: "config-error", message: describeError(err) };
  }
  const root = rootFor(cwd, file.roots);
  if (!root) return { kind: "unmatched" };
  try {
    const target = loadRoutingTierTarget(root.tier);
    return { kind: "matched", root, target };
  } catch (err) {
    return {
      kind: "config-error",
      message: `root "${root.path}" names tier "${root.tier}": ${describeError(err)}`,
    };
  }
}

/** Sets `PI_ROUTING_EGRESS` from a matched resolution — but never overwrites an existing value.
 *  `dispatch/tiers.ts`'s own doc comment: "An explicit declaration always wins" — a value the
 *  user (or a wrapper script) set manually must not be clobbered by this module's opinion. */
export function declareSessionEgress(res: Resolution): void {
  if (res.kind !== "matched") return;
  if (process.env.PI_ROUTING_EGRESS === undefined) {
    process.env.PI_ROUTING_EGRESS = res.target.egress;
  }
}

/** The per-channel, per-directory policy that is this
 *  item's contract with `EXT-07` (web tools) and `EXT-14` (MCP adapter): "consume `egressClassFor`".
 *  Neither of those items actually imports this (verified: `grep -rn egressClassFor extensions/web*
 *  extensions/mcp*` — zero hits; both shipped complete without path-scoped egress wiring, per their
 *  own manifests). Exported anyway because it is the documented contract this item owns and it costs
 *  nothing to provide — but its absence from EXT-07/EXT-14a is a real gap, not a hypothetical
 *  one. Never throws — `disabled`/`unmatched`/`config-error` all fail
 *  OPEN (fully allowed, `sessionEgress: "public"`), matching `applyResolution`'s own no-op on those
 *  same kinds: an unconfigured or broken `path-defaults.json` must not become a surprise network
 *  lockout on top of `REQ-PRV-32`'s already-loud failure notice. DECLARATIVE ONLY — see the module
 *  header comment; this function computes a policy, it does not enforce one. */
export interface EgressPolicy {
  readonly sessionEgress: SessionEgressClass;
  readonly web: Channel;
  readonly mcp: Channel;
  readonly publicModels: Channel;
}

const OPEN_EGRESS: EgressPolicy = { sessionEgress: "public", web: "allow", mcp: "allow", publicModels: "allow" };

export function egressClassFor(cwd: string, pathDefaultsPath?: string): EgressPolicy {
  const res = resolveForCwd(cwd, pathDefaultsPath);
  if (res.kind !== "matched") return OPEN_EGRESS;
  return {
    sessionEgress: res.target.egress,
    web: res.root.egress.web,
    mcp: res.root.egress.mcp,
    publicModels: res.root.egress.publicModels,
  };
}

export function register(pi: ExtensionAPI): void {
  try {
    declareSessionEgress(resolveForCwd(process.cwd()));
  } catch (err) {
    // Must never break a session-less invocation (`pi --list-models`). No ctx exists yet, so
    // stderr is the only channel; session_start repeats this properly with ctx.cwd and full UI.
    process.stderr.write(
      `[pi-config] path-defaults: register()-time egress probe failed (non-fatal, retried at session_start): ${describeError(err)}\n`,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    const announce = report(ctx);
    try {
      const res = resolveForCwd(ctx.cwd);
      declareSessionEgress(res);
      await applyResolution(pi, ctx, res, announce);
    } catch (err) {
      surfaceOnce(ctx, `path-defaults:session_start:${describeError(err).slice(0, 80)}`, () => {
        announce(`session_start failed internally; path defaults were not applied: ${describeError(err)}`, "error");
      });
    }
  });

  pi.registerCommand("path-defaults-status", {
    description: "Show the path-scoped default resolved for the current directory (debugging)",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      report(ctx)(describeResolution(ctx.cwd, resolveForCwd(ctx.cwd)), "info");
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
  if (res.kind === "disabled" || res.kind === "unmatched") return;
  if (res.kind === "config-error") {
    ctx.ui.setStatus("scope", undefined);
    announce(`path defaults not applied: ${res.message}`, "error");
    return;
  }

  const { root, target } = res;
  ctx.ui.setStatus("scope", statusFlag(target.egress));
  const reasonSuffix = root.reason ? ` — ${root.reason}` : "";
  const egressLine =
    `session egress ${target.egress}; web ${root.egress.web}, mcp ${root.egress.mcp}, ` +
    `public models ${root.egress.publicModels} (declarative — enforced only where EXT-07/EXT-14 consult it)`;

  if (ctx.scopedModels.length > 0 || explicitModelRequested()) {
    announce(
      `root ${root.path} names tier "${root.tier}" (${target.model}), but an explicit model ` +
        `selection is already in effect for this session — leaving it alone. ${egressLine}${reasonSuffix}`,
      "info",
    );
    return;
  }

  const resolved = ctx.modelRegistry.find(target.provider, target.modelId);
  if (!resolved) {
    announce(
      `root ${root.path} names tier "${root.tier}" -> ${target.model}, but no such model is ` +
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
      `root ${root.path} wants ${target.model} but no credential is available for provider ` +
        `"${target.provider}"; staying on ${staying}. Run: pi --list-models to see which ` +
        `providers have a usable credential.`,
      "error",
    );
    return;
  }
  announce(`root ${root.path} -> ${target.model} (tier "${root.tier}"). ${egressLine}${reasonSuffix}`, "info");
}

/** No leading "path-defaults: " here — the only caller (`report()`, above) already prefixes
 *  every message with "[pi-config] path-defaults: "; repeating it here just doubled the prefix. */
function describeResolution(cwd: string, res: Resolution): string {
  switch (res.kind) {
    case "disabled":
      return `no config/path-defaults.json — the feature is not configured (cwd ${cwd})`;
    case "config-error":
      return `config error for cwd ${cwd}: ${res.message}`;
    case "unmatched":
      return `no root covers cwd ${cwd} (and no "*" fallback is configured)`;
    case "matched":
      return (
        `cwd ${cwd} matches root "${res.root.path}" -> tier "${res.root.tier}" ` +
        `(${res.target.model}, session egress ${res.target.egress}; web ${res.root.egress.web}, ` +
        `mcp ${res.root.egress.mcp}, public models ${res.root.egress.publicModels})`
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

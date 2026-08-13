/**
 * EXT-23 — worktree detection and isolation.
 *
 * This is a composed module, not a discovered extension — it exports
 * `id` + `register(pi)` for `extensions/index.ts` to import in the fixed load `ORDER`, plus a
 * `default` export mirroring `extensions/dispatch/index.ts`'s own shape for standalone loadability.
 *
 * Three jobs, and only three. `@narumitw/pi-worktree` 0.49.3 already ships `/worktree` (add,
 * switch, remove, prune, its own interactive menu) — this module does not compete with it or
 * re-implement it. What no package covers:
 *
 *   1. **Detection** at `session_start` — `git rev-parse --git-common-dir`; not `.git` means the
 *      session is already inside a linked worktree (REQ-CTX-60). Published three ways: the
 *      statusline (`ctx.ui.setStatus`), the shared extension bus (`pi.events`), and a
 *      module-level getter (`getWorktreeInfo()`) that `EXT-02`'s rules context and `EXT-26`'s
 *      session index import directly — the same integration shape `../dispatch/isolation.ts`
 *      already uses for `EXT-05`.
 *   2. **A `WorktreeProvider`** for `EXT-05`'s `isolation: worktree`
 *      (`extensions/dispatch/isolation.ts`, which documents "EXT-23 calls this at session_start"
 *      and expects the id `"ext-23"` — both honoured here verbatim). Reuses the session's own
 *      worktree when it is already inside one (REQ-CTX-60's "never nest" half — see the
 *      acceptance test, C2); creates a fresh one, recorded in
 *      `registry.ts` before it exists on disk, when the session is in the primary checkout.
 *   3. **Crash-safe cleanup**: a full registry sweep at every `session_start` (four rows, enumerated below),
 *      plus an eager release the moment the isolated tool call that used a worktree settles —
 *      so a long session doing many isolated dispatches does not accumulate one worktree per
 *      dispatch until it finally exits.
 *
 * Never `rm -rf` a dirty tree. That is the one rule this module cannot get wrong.
 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { registerWorktreeProvider, type WorktreeGrant, type WorktreeRequest } from "../dispatch/isolation.ts";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { stateRoot } from "../lib/paths.ts";
import {
  addWorktree,
  deleteBranchIfMerged,
  detect,
  isDirty,
  isPidAlive,
  pruneWorktrees,
  removeWorktree,
  resolveCommonDir,
  type WorktreeInfo,
} from "./git.ts";
import {
  all as allRegistryEntries,
  drop as dropRegistryEntry,
  record as recordRegistryEntry,
  registryPath,
  type RegistryEntry,
} from "./registry.ts";

export const id = "worktree";
export type { WorktreeInfo } from "./git.ts";

/** The id `dispatch/isolation.ts` documents as the one EXT-23 supplies. Named in its audit entries. */
const PROVIDER_ID = "ext-23";

let current: WorktreeInfo | undefined;

/** `EXT-02`'s rules context and `EXT-26`'s session index read this directly. */
export function getWorktreeInfo(): WorktreeInfo | undefined {
  return current;
}

/** Test-only. */
export function resetWorktreeState(): void {
  current = undefined;
}

interface LiveGrant {
  readonly id: string;
  readonly path: string;
  readonly repo: string;
  readonly branch: string;
}

export function register(pi: ExtensionAPI): void {
  // toolCallId -> the grant it produced, for the eager tool_result release below. In-memory
  // only: a crash loses this map, but the registry entry (written to disk before the worktree
  // exists) is the actual crash-safety mechanism, swept at the next session_start regardless.
  const liveGrants = new Map<string, LiveGrant>();

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    try {
      current = await detect(pi, ctx.cwd);
      publishStatus(ctx, current);
      try {
        pi.events.emit("worktree:info", current);
      } catch (err) {
        report(ctx, `[pi-config] worktree: bus emit failed (non-fatal): ${describeError(err)}`, "warning");
      }

      registerWorktreeProvider({
        id: PROVIDER_ID,
        create: (request) => createGrant(pi, ctx, request, liveGrants),
      });

      if (current.isRepo) {
        await sweep(pi, ctx, current);
      }
    } catch (err) {
      report(ctx, `[pi-config] worktree: session_start failed: ${describeError(err)}`, "error");
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const grant = liveGrants.get(event.toolCallId);
    if (!grant) return;
    liveGrants.delete(event.toolCallId);
    try {
      await releaseIfClean(pi, ctx, grant);
    } catch (err) {
      report(
        ctx,
        `[pi-config] worktree: release of ${grant.path} after tool call ${event.toolCallId} failed: ${describeError(err)}`,
        "warning",
      );
    }
  });
}

function publishStatus(ctx: ExtensionContext, info: WorktreeInfo): void {
  try {
    if (!info.isRepo) {
      ctx.ui.setStatus("worktree", undefined);
      return;
    }
    const dirtySuffix = info.dirty > 0 ? `*${info.dirty}` : "";
    ctx.ui.setStatus("worktree", `${info.isWorktree ? "⑂ " : ""}${info.branch}${dirtySuffix}`);
  } catch {
    // ctx.ui.* is a no-op in -p and --mode json; a throw here must not
    // take session_start down for every other module.
  }
}

async function createGrant(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: WorktreeRequest,
  liveGrants: Map<string, LiveGrant>,
): Promise<WorktreeGrant> {
  const info = current;
  if (!info || !info.isRepo) {
    throw new Error(`${request.cwd} is not inside a git repository`);
  }

  // REQ-CTX-60's other half: never nest. The session is already isolated on its own worktree,
  // so a child dispatched from it needs nothing further — creating a second, nested worktree
  // would just be another copy of the same isolation with none of the benefit.
  if (info.isWorktree) {
    return { cwd: info.root, detail: `reused: session is already isolated on ${info.branch}` };
  }

  const shortCall = request.toolCallId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || randomBytes(4).toString("hex");
  const wtId = `wt-${sanitize(request.agent)}-${shortCall}`;
  const path = join(stateRoot(), "wt", wtId);
  const branch = `agent/${wtId}`;
  const regPath = registryPath(resolveCommonDir(info));

  const entry: RegistryEntry = {
    id: wtId,
    path,
    repo: info.root,
    branch,
    ownerPid: process.pid,
    toolCallId: request.toolCallId,
    createdAt: new Date().toISOString(),
  };
  // Recorded BEFORE the worktree exists: a crash between this write and `addWorktree` leaves a
  // registry entry whose path never came into being — the sweep's "path missing" rule
  // drops it cleanly on the next session_start instead of leaking it forever.
  await recordRegistryEntry(regPath, entry);
  await addWorktree(pi, info.root, path, branch);

  liveGrants.set(request.toolCallId, { id: wtId, path, repo: info.root, branch });
  return { cwd: path, detail: `created ${branch}` };
}

async function releaseIfClean(pi: ExtensionAPI, ctx: ExtensionContext, grant: LiveGrant): Promise<void> {
  const info = current;
  if (!info) return;
  const regPath = registryPath(resolveCommonDir(info));
  if (await isDirty(pi, grant.path)) {
    report(
      ctx,
      `[pi-config] worktree: not reclaiming ${grant.path} — the child left uncommitted changes there`,
      "warning",
    );
    return;
  }
  await removeWorktree(pi, grant.repo, grant.path);
  await deleteBranchIfMerged(pi, grant.repo, grant.branch);
  await dropRegistryEntry(regPath, grant.id);
}

/** All four rows below, run once at every `session_start`. Never `rm -rf` a dirty tree. */
async function sweep(pi: ExtensionAPI, ctx: ExtensionContext, info: WorktreeInfo): Promise<void> {
  const regPath = registryPath(resolveCommonDir(info));
  const entries = await allRegistryEntries(regPath);

  for (const entry of entries) {
    if (isPidAlive(entry.ownerPid)) continue; // the owning session is still running — leave it

    if (!(await pathExists(entry.path))) {
      // Registry entry whose path no longer exists: prune git's own metadata, drop the entry.
      await pruneWorktrees(pi, entry.repo).catch(() => {});
      await dropRegistryEntry(regPath, entry.id);
      continue;
    }

    if (await isDirty(pi, entry.path)) {
      // pid dead, tree dirty: keep it, drop nothing, report loudly. This is the whole reason
      // this item is not a one-liner.
      report(ctx, `[pi-config] worktree: orphaned worktree with uncommitted changes: ${entry.path}`, "warning");
      continue;
    }

    // pid dead, tree clean: reclaim it.
    try {
      await removeWorktree(pi, entry.repo, entry.path);
      await deleteBranchIfMerged(pi, entry.repo, entry.branch);
      await dropRegistryEntry(regPath, entry.id);
    } catch (err) {
      report(ctx, `[pi-config] worktree: sweep could not reclaim ${entry.path}: ${describeError(err)}`, "warning");
    }
  }

  await pruneWorktrees(pi, info.root).catch(() => {});
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40) || "agent";
}

function report(ctx: ExtensionContext | undefined, line: string, level: "info" | "warning" | "error"): void {
  surfaceOnce(ctx, `worktree:${level}:${line.slice(0, 160)}`, () => {
    // One channel, whichever this run mode has: ctx.ui.* is a no-op in -p and --mode json,
    // and in the TUI a stderr copy prints straight over PI's own frame.
    // `lib/announce.ts` picks by ctx.hasUI and still swallows a UI that throws.
    emitNotice(ctx, line, level);
  });
}

/**
 * **`isolation: worktree` is ours to honour; the
 * worktree itself comes from `EXT-23`.**
 *
 * The frontmatter key is not one `pi-subagents` knows — it lands in the package's `extraFields`
 * and is ignored. Honouring it means turning it into something the package acts on, at the moment
 * of dispatch, and there are exactly two ways to do that:
 *
 *   - **`EXT-23` is loaded**: it registers a worktree provider here, we ask it for a directory and
 *     write it to `input.cwd`. `EXT-23` owns creation, reuse, cleanup and the git plumbing.
 *   - **`EXT-23` is not loaded yet**: we set `input.worktree = true` and let `pi-subagents` create
 *     one. Verified supported for a single-agent call — `src/extension/index.ts:541` rejects a
 *     `worktree` argument *unless* it is `true` and an `agent` is named, which is precisely this
 *     shape.
 *
 * What this module will not do is fall back to "no isolation" and say nothing. An agent that
 * declares `isolation: worktree` declares it because running it in the user's checkout is unsafe;
 * quietly running it there anyway is the failure this project exists to avoid. If neither path is
 * available the dispatch is refused, by name.
 */
import type { Isolation } from "./registry.ts";

export interface WorktreeRequest {
  readonly agent: string;
  readonly toolCallId: string;
  /** The session's cwd — the worktree is created from the repository containing it. */
  readonly cwd: string;
}

export interface WorktreeGrant {
  /** Absolute path the child must run in. */
  readonly cwd: string;
  /** Free-form, for the audit entry: branch name, reuse or fresh, and so on. */
  readonly detail?: string;
}

export interface WorktreeProvider {
  /** Stable id, named in the audit entry and in `/agents`. `EXT-23` supplies "ext-23". */
  readonly id: string;
  create(request: WorktreeRequest): Promise<WorktreeGrant> | WorktreeGrant;
}

let provider: WorktreeProvider | undefined;

/** `EXT-23` calls this at `session_start`. Last registration wins; re-registering is announced. */
export function registerWorktreeProvider(next: WorktreeProvider): { replaced?: string } {
  const previous = provider?.id;
  provider = next;
  return previous !== undefined && previous !== next.id ? { replaced: previous } : {};
}

export function worktreeProvider(): WorktreeProvider | undefined {
  return provider;
}

/** Test-only. */
export function resetWorktreeProvider(): void {
  provider = undefined;
}

export type IsolationOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "provider"; readonly providerId: string; readonly cwd: string; readonly detail?: string }
  | { readonly kind: "package" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Applies an agent's declared isolation to a dispatch tool call, mutating `input` in place.
 * Input mutation is in-place and is not re-validated.
 */
export async function applyIsolation(
  input: Record<string, unknown>,
  isolation: Isolation,
  request: WorktreeRequest,
): Promise<IsolationOutcome> {
  if (isolation !== "worktree") return { kind: "none" };

  const active = provider;
  if (active !== undefined) {
    let grant: WorktreeGrant;
    try {
      grant = await active.create(request);
    } catch (err) {
      return {
        kind: "refused",
        reason:
          `agent "${request.agent}" declares isolation: worktree and the worktree provider ` +
          `"${active.id}" failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}. ` +
          `Refusing to run it in ${request.cwd} instead — that is what the declaration exists to prevent.`,
      };
    }
    if (!grant || typeof grant.cwd !== "string" || grant.cwd.length === 0) {
      return {
        kind: "refused",
        reason:
          `agent "${request.agent}" declares isolation: worktree and the worktree provider ` +
          `"${active.id}" returned no directory. Refusing to run it in ${request.cwd}.`,
      };
    }
    input.cwd = grant.cwd;
    return {
      kind: "provider",
      providerId: active.id,
      cwd: grant.cwd,
      ...(grant.detail !== undefined ? { detail: grant.detail } : {}),
    };
  }

  // No EXT-23 yet: hand it to pi-subagents' own worktree support. Only legal alongside `agent`.
  if (typeof input.agent !== "string" || input.agent.length === 0) {
    return {
      kind: "refused",
      reason:
        `agent "${request.agent}" declares isolation: worktree, but this call does not name a single ` +
        `agent, and no worktree provider (EXT-23) is registered. pi-subagents only accepts ` +
        `worktree: true together with agent: <name>.`,
    };
  }
  input.worktree = true;
  return { kind: "package" };
}

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
 *
 * The same standard applies to the package path, and used not to. Setting `input.worktree = true`
 * is a *request*: `pi-subagents` does not create the worktree at dispatch, it creates it inside
 * the child it spawns. So a repository that cannot host one still produced a dispatch that
 * returned a well-formed run id, and only then died out of band, in a place the lead was not
 * looking. A refusal that arrives after a successful-looking acknowledgement is not a refusal.
 * `preflightWorktree` answers the question here, while `block: true` still reaches the caller.
 *
 * The preflight is ours rather than the package's, on purpose. Nothing in this tree
 * value-imports `pi-subagents` — every import of it is `import type` — because Node refuses to
 * strip types under `node_modules`, so a runtime import would be unloadable by the gate and would
 * rest on a loader behaviour this repository has never demonstrated. `test/dispatch/isolation.
 * test.ts` closes the resulting drift risk from the other side: it loads the real package through
 * `jiti`, the loader the runtime itself uses for the package's TypeScript, and asserts the two
 * still agree on what a usable repository is.
 */
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
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

export type WorktreeFeasibility =
  | {
      readonly ok: true;
      readonly repoRoot: string;
      readonly commonDir: string;
      readonly baseCommit: string;
    }
  | { readonly ok: false; readonly reason: string };

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true });
  return { ok: run.status === 0, out: (run.stdout ?? "").trim(), err: (run.stderr ?? "").trim() };
}

/**
 * The directory `pi-subagents` ignores when it decides whether a tree is clean: its own durable
 * run state. Read from the package rather than restated, so a rename upstream shows up as a test
 * failure and not as a preflight that disagrees with the thing it is predicting.
 */
export const PACKAGE_STATE_DIR = ".pi/subagents";

/**
 * Can `pi-subagents` create a managed worktree from `cwd`?
 *
 * Three things have to hold, and the third is the one that surprises people.
 *
 * There has to be a repository, and it has to have a commit to branch from — `git worktree add`
 * cannot materialise a tree from an unborn HEAD.
 *
 * And the *caller's* working tree has to be clean. That is not a requirement of `git worktree
 * add`, which materialises a fresh tree at HEAD and never carries the source tree's dirt into it;
 * it is a precondition the package imposes on itself in `resolveRepoState`, and the shipped
 * package is what runs here — this repository patches nothing under `node_modules`, which is what
 * `PC-21` and `docs/limitations.md` are about. So the honest thing is to predict the refusal
 * rather than to argue with it: a lead holding uncommitted work finds out at dispatch, with the
 * remedy in the message, instead of watching a run id die somewhere it cannot see.
 *
 * Repository identity is `git rev-parse --git-common-dir`, never a path prefix. A session in a
 * linked worktree has a toplevel nowhere near the primary checkout and shares only the common
 * dir, so a prefix test reads it as a foreign repository — and a linked worktree is exactly where
 * this project expects its sessions to run.
 */
export function preflightWorktree(cwd: string): WorktreeFeasibility {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") {
    return {
      ok: false,
      reason: `${cwd} is not inside a git working tree${inside.err ? `: ${inside.err}` : ""}`,
    };
  }
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok || !root.out) {
    return { ok: false, reason: `cannot resolve the repository root of ${cwd}: ${root.err}` };
  }

  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok || !commonDir.out) {
    return { ok: false, reason: `cannot resolve the git common directory of ${cwd}: ${commonDir.err}` };
  }
  // In a primary checkout git answers with a bare `.git`. Left relative it would resolve against
  // whatever the process cwd happens to be, and two working trees of one repository would then
  // compare unequal for a reason that has nothing to do with them.
  const commonDirPath = isAbsolute(commonDir.out) ? commonDir.out : resolve(root.out, commonDir.out);

  const head = git(root.out, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return {
      ok: false,
      reason: `${root.out} has no HEAD to branch a worktree from (an unborn branch, or no commits yet)`,
    };
  }

  const status = git(root.out, ["status", "--porcelain", "--", `:!${PACKAGE_STATE_DIR}`]);
  if (status.ok && status.out.length > 0) {
    const files = status.out.split(/\r?\n/).length;
    return {
      ok: false,
      reason:
        `${root.out} has ${files} uncommitted change(s), and pi-subagents refuses managed worktree ` +
        `isolation on a dirty tree. Commit or stash them first. Do not answer this by declaring ` +
        `isolation: none — that drops the child into this very checkout, which is what the ` +
        `declaration exists to prevent`,
    };
  }

  return { ok: true, repoRoot: root.out, commonDir: commonDirPath, baseCommit: head.out };
}

/** Narrowed to what this module asks of it, so a test can answer without a real repository. */
export type WorktreePreflight = (cwd: string) => WorktreeFeasibility;

let preflight: WorktreePreflight = preflightWorktree;

/** Test-only. */
export function setWorktreePreflight(next: WorktreePreflight): void {
  preflight = next;
}

/** Test-only. */
export function resetWorktreePreflight(): void {
  preflight = preflightWorktree;
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
  const feasible = preflight(request.cwd);
  if (!feasible.ok) {
    return {
      kind: "refused",
      reason:
        `agent "${request.agent}" declares isolation: worktree, no worktree provider (EXT-23) is ` +
        `registered, and pi-subagents cannot create one from ${request.cwd}: ${feasible.reason}. ` +
        `Refusing now rather than returning a run id for a child that would fail after launch.`,
    };
  }
  input.worktree = true;
  return { kind: "package" };
}

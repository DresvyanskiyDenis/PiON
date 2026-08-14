/**
 * `GIT-*` — history destruction, and nothing else.
 *
 * ## What this gate stopped doing on 2026-08-14
 *
 * It used to cover `git push --force` on any branch, `git reset --hard`, `git branch -D`,
 * `git clean -f`, `git checkout -- .`, and a remote allowlist. Removed outright by owner
 * decision, 2026-08-14: the allow-list model was removed outright, and only catastrophic commands
 * were left to be blocked. Every one of those is a routine, recoverable operation — a reset has
 * the reflog, a deleted branch has the reflog, `clean -f` deletes only untracked files — and
 * gating them stopped real work far more often than it saved any. **Ordinary git is no longer
 * gated at all, and no audit record is written for it either: it is ordinary.**
 *
 * What is left is the pair that has no undo:
 *
 *   - `GIT-REWRITE` — `git filter-repo` / `filter-branch`. Verified against a damaged repo on
 *     2026-08-14: a *no-op* `git filter-repo --mailmap <file> --force` in a working checkout
 *     removed the `origin` remote and its `refs/remotes/*`, and truncated **every** reflog in the
 *     shared git dir to zero bytes — `logs/HEAD`, both branch reflogs, and the linked worktree's
 *     own `worktrees/<name>/logs/HEAD`. The commits survived; the undo path did not. This is the
 *     one git operation that destroys the thing every other git operation is recoverable *by*.
 *   - `GIT-FORCE-PROTECTED` — a force-push onto a branch in `policy.protectedBranches`. Remote
 *     history is the one copy no local reflog can restore.
 *
 * Both stay overridable with a written justification, which works headless. Force-push onto any
 * *other* branch is now ordinary work and passes silently.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardRule } from "../../lib/guarded-handler.ts";
import { denyWithEscapeHatch } from "../../lib/escape-hatch.ts";
import { program, tokenize, type Segment } from "../shell.ts";
import { commandStrings } from "../targets.ts";
import { tryOverride } from "../override.ts";
import type { GuardServices } from "../services.ts";
import type { Policy } from "../policy.ts";

interface GitHit {
  readonly id: string;
  readonly what: string;
  readonly legitimateUse: string;
}

/** git's own global options that consume the next word, so the subcommand is found correctly. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

export function destructiveGitGate(policy: Policy, services: GuardServices): GuardRule {
  return {
    id: "GIT",
    evaluate(event, ctx) {
      for (const command of commandStrings(event)) {
        for (const segment of tokenize(command)) {
          if (program(segment) !== "git") continue;
          const hit = inspect(segment, policy, ctx);
          if (!hit) continue;

          if (
            tryOverride({
              event,
              gateId: hit.id,
              keys: ["command", "cmd", "script"],
              services,
              detail: { what: hit.what },
            })
          ) {
            return { block: false };
          }
          return denyWithEscapeHatch({
            gateId: hit.id,
            what: hit.what,
            legitimateUse: hit.legitimateUse,
            overridable: true,
          });
        }
      }
      return { block: false };
    },
  };
}

function inspect(segment: Segment, policy: Policy, ctx: ExtensionContext): GitHit | null {
  const args = segment.argv.slice(1);
  const subIdx = subcommandIndex(args);
  if (subIdx === -1) return null;
  const sub = args[subIdx]!;
  const rest = args.slice(subIdx + 1);

  // A history rewrite is not just a rewrite — it expires every reflog in the shared git dir, so
  // there is nothing left to undo it with. See the module header for the measured evidence.
  if (sub === "filter-repo" || sub === "filter-branch") {
    return {
      id: "GIT-REWRITE",
      what: `git ${sub} (rewrites history, drops the origin remote and expires every reflog in the shared git dir)`,
      legitimateUse:
        "Rewrite a throwaway clone and push the result; in place there is no reflog left to undo it.",
    };
  }

  if (sub !== "push") return null;

  const short = shortFlags(rest);
  const long = longFlags(rest);
  const forcing =
    long.has("force") ||
    short.has("f") ||
    long.has("force-with-lease") ||
    long.has("force-if-includes");
  if (!forcing) return null;

  const operands = rest.filter((a) => !a.startsWith("-"));
  const branch = protectedTarget(operands, long, policy, segment, ctx);
  if (branch === undefined) return null;

  return {
    id: "GIT-FORCE-PROTECTED",
    what: `git push --force onto the protected branch "${branch}" (remote history has no reflog to restore it from)`,
    legitimateUse:
      "Force-push a non-protected branch freely; onto a protected one, say why in one line.",
  };
}

/**
 * Which protected branch this force-push would land on, or `undefined` when none would.
 *
 * The refspecs on the command line answer it directly when they are there. When they are not —
 * `git push -f`, `git push --force origin` — git uses the *current* branch, so the current branch
 * is what gets read, from `HEAD` on disk. Guessing "unknown, therefore refuse" instead would put
 * the plain two-word spelling back on the block list, which is the opposite of the instruction;
 * guessing "unknown, therefore allow" would let `git push -f` on `main` through, which is the one
 * shape this rule exists for. Reading the file is the only answer that is neither.
 */
function protectedTarget(
  operands: readonly string[],
  long: ReadonlySet<string>,
  policy: Policy,
  segment: Segment,
  ctx: ExtensionContext,
): string | undefined {
  // `--all` / `--mirror` push every local branch, so the protected ones are among them by
  // definition and no refspec names them.
  if (long.has("all") || long.has("mirror")) {
    return policy.protectedBranches[0];
  }

  const refspecs = operands.slice(1);
  if (refspecs.length > 0) {
    return pushTargets(refspecs).find((b) => policy.protectedBranches.includes(b));
  }

  const branch = currentBranch(repoDir(segment, ctx));
  return branch !== undefined && policy.protectedBranches.includes(branch) ? branch : undefined;
}

/** The directory `git` would run in: `git -C DIR …` when given, otherwise the session cwd. */
function repoDir(segment: Segment, ctx: ExtensionContext): string | undefined {
  const cwd = typeof ctx.cwd === "string" ? ctx.cwd : undefined;
  const args = segment.argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-C") continue;
    const dir = args[i + 1];
    if (dir === undefined) break;
    if (isAbsolute(dir)) return dir;
    return cwd === undefined ? undefined : resolve(cwd, dir);
  }
  return cwd;
}

/**
 * The checked-out branch name, read straight from `HEAD` — no subprocess, no `await`.
 *
 * Defensive to the point of paranoia on purpose: this runs inside a `tool_call` handler on every
 * force-push, and a throw here would surface as a guard internal error on a command that is very
 * likely legitimate. Not a repo, a detached HEAD, an unreadable git dir → `undefined`, which reads
 * as "no protected branch involved".
 */
function currentBranch(start: string | undefined): string | undefined {
  if (start === undefined) return undefined;
  try {
    const gitDir = findGitDir(start);
    if (gitDir === undefined) return undefined;
    const head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref?.[1];
  } catch {
    return undefined;
  }
}

/** Walks up for `.git`, following the `gitdir:` pointer a linked worktree leaves behind. */
function findGitDir(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = resolve(dir, ".git");
    if (existsSync(candidate)) {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"));
      const target = pointer?.[1]?.trim();
      if (target === undefined) return undefined;
      return isAbsolute(target) ? target : resolve(dir, target);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function subcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (GLOBAL_OPTS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** `-fd` contributes both `f` and `d`. Long flags are excluded. */
function shortFlags(args: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    for (const ch of arg.slice(1)) out.add(ch);
  }
  return out;
}

function longFlags(args: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--") || arg === "--") continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    out.add(eq === -1 ? body : body.slice(0, eq));
  }
  return out;
}

/** `main`, `HEAD:main`, `+main`, `refs/heads/main` → the destination branch names. */
function pushTargets(refspecs: readonly string[]): string[] {
  return refspecs.map((refspec) => {
    const withoutLead = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    const colon = withoutLead.lastIndexOf(":");
    const dest = colon === -1 ? withoutLead : withoutLead.slice(colon + 1);
    return dest.replace(/^refs\/heads\//, "");
  });
}

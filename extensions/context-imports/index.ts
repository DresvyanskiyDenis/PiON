/**
 * EXT-21 — context imports (`@path`) and lazy nested `AGENTS.md`.
 *
 * REQ-CTX-07: a bare `@path`, alone on its own line, inside an instruction file — or inside the
 * already-assembled system prompt itself — is expanded in place with the target file's content.
 * Resolved relative to the *importing* file for a nested import; relative to `ctx.cwd` for an
 * import found directly in the top-level prompt, since the prompt text has no single file of
 * origin. Skipped inside fenced and inline code spans. Recursion depth-capped at `MAX_DEPTH`
 * (REQ-CTX-07's floor of 4), memoized per session, a missing import announced exactly once.
 *
 * REQ-CTX-08: the first `read`/`edit`/`write` of a file in a subdirectory below `cwd` lazily
 * loads that subdirectory's — and every intervening subdirectory's — `AGENTS.md`/`CLAUDE.md`
 * (first hit per directory wins, at most once per directory per session) and delivers it via
 * `pi.sendMessage` for the *next* turn. `cwd`'s own instructions are assumed already present in
 * the base system prompt (PI's own `contextFiles` loading) and are not reloaded here.
 *
 * Auto-discovered as a standalone extension via the `extensions/<dir>/index.ts` subdirectory
 * pattern (PI's own extension docs, "Extension Locations"), same as `extensions/tasks/index.ts`
 * (EXT-22) and `extensions/big-results/index.ts` (EXT-29) — it does not go through wave-1's
 * single composed `extensions/index.ts`, so `settings.json`'s `"extensions"` array needs no
 * entry.
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";

export const id = "context-imports";

/** REQ-CTX-07's floor: a chain resolves at least this many levels deep. */
export const MAX_DEPTH = 4;

/** A bare `@path` alone on its line — not `@` mid-sentence, not inside a URL, not in prose. */
const IMPORT_RE = /^[ \t]*@([^\s`]+)[ \t]*$/gm;

export type NotifyLevel = "info" | "warning" | "error";
export type Notify = (message: string, level?: NotifyLevel) => void;

// Module-level, deliberately: this tree mandates exactly one PI extension file per
// discovered path, so this module has exactly one live instance per `pi` process — the same
// precondition `lib/once.ts` already leans on. Cleared on `session_start` (`/new`, `/resume`,
// `/fork` all re-fire it) so a fresh session does not inherit a stale expansion, a stale "missing"
// announcement, or a stale "already loaded this directory" mark from the session before it.
const memo = new Map<string, string>();
const announcedMisses = new Set<string>();
const announcedCycles = new Set<string>();
const loadedDirs = new Set<string>();

/** Test-only: drop all module state so each test starts from a clean registry. */
export function __resetForTests(): void {
  memo.clear();
  announcedMisses.clear();
  announcedCycles.clear();
  loadedDirs.clear();
}

/** Blanks out fenced and inline code before scanning, so an `@path` inside an example is never imported. */
export function maskCode(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** `~/…` expands against `$HOME`; everything else resolves against `baseDir`. */
export function resolveSpec(spec: string, baseDir: string): string {
  const home = process.env.HOME;
  const expanded = home && /^~(\/|$)/.test(spec) ? spec.replace(/^~/, home) : spec;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function makeNotify(ctx: ExtensionContext): Notify {
  // One channel, whichever this run mode has: `ctx.ui.notify` is a no-op in `-p` and `--mode json`,
  // which is exactly where the acceptance tests run, and in the TUI a
  // stderr copy prints straight over PI's own frame. See `lib/announce.ts`.
  return (message, level = "warning") => emitNotice(ctx, `[pi-config] context-imports: ${message}`, level);
}

/**
 * Expands one instruction file's `@path` imports, recursively, up to `MAX_DEPTH`.
 *
 * `chain` is the ordered list of absolute paths currently on the resolution stack (the
 * ancestors), not "every path ever seen during this scan". A genuine cycle is a path
 * re-appearing in its own ancestor chain; a diamond — two independent branches importing the
 * same file — is not a cycle, and `memo` already returns the first branch's fully-resolved
 * content for the second reference once that first branch has finished. Using the ancestor
 * chain instead of a scan-wide "seen" set also stays correct if this loop is ever parallelised
 * with `Promise.all` — a shared mutate-forever set would silently start reporting diamonds as
 * cycles the moment resolution order stopped being strictly sequential.
 */
export async function expand(
  file: string,
  depth: number,
  chain: readonly string[],
  notify: Notify,
): Promise<string> {
  const abs = resolve(file);
  const cached = memo.get(abs);
  if (cached !== undefined) return cached;

  const cycleAt = chain.indexOf(abs);
  if (cycleAt !== -1) {
    const cyclePath = [...chain.slice(cycleAt), abs].join(" -> ");
    if (!announcedCycles.has(cyclePath)) {
      announcedCycles.add(cyclePath);
      notify(`@import cycle, import stopped: ${cyclePath}`, "error");
    }
    return `<!-- @import cycle: ${cyclePath} -->`;
  }

  let body: string;
  try {
    body = await readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "not found" : `unreadable: ${describeError(err)}`;
    if (!announcedMisses.has(abs)) {
      announcedMisses.add(abs);
      notify(`@import: ${abs} ${reason}`, "warning");
    }
    return `<!-- @import missing: ${abs} -->`;
  }

  if (depth >= MAX_DEPTH) {
    // The depth cap is a designed limit, not a fault — but leaving it silent when it actually
    // bit (the file has its own unexpanded @imports) would be exactly the kind of quiet
    // degradation the rest of this tree always announces (`lib/paths.ts`'s `ensureStateRoot`,
    // `session-context.ts`'s `capBytes`).
    if ([...maskCode(body).matchAll(IMPORT_RE)].length > 0) {
      notify(
        `@import depth limit (${MAX_DEPTH}) reached at ${abs}; its own @imports were left unexpanded`,
        "warning",
      );
    }
    memo.set(abs, body);
    return body;
  }

  const nextChain = [...chain, abs];
  const jobs: { raw: string; target: string }[] = [];
  for (const m of maskCode(body).matchAll(IMPORT_RE)) {
    jobs.push({ raw: m[0], target: resolveSpec(m[1], dirname(abs)) });
  }
  let out = body;
  for (const j of jobs) {
    const inner = await expand(j.target, depth + 1, nextChain, notify);
    const label = relative(dirname(abs), j.target) || j.target;
    out = out.replace(j.raw, `<!-- begin @${label} -->\n${inner}\n<!-- end @${label} -->`);
  }
  memo.set(abs, out);
  return out;
}

/** REQ-CTX-07 — expand `@path` imports found directly in the assembled system prompt. */
async function expandPromptImports(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
  if (!event.systemPrompt.includes("@")) return undefined;
  const matches = [...maskCode(event.systemPrompt).matchAll(IMPORT_RE)];
  if (matches.length === 0) return undefined;

  const notify = makeNotify(ctx);
  try {
    let systemPrompt = event.systemPrompt;
    for (const m of matches) {
      const spec = m[1];
      const target = resolveSpec(spec, ctx.cwd);
      const inner = await expand(target, 1, [], notify);
      systemPrompt = systemPrompt.replace(m[0], `<!-- begin @${spec} -->\n${inner}\n<!-- end @${spec} -->`);
    }
    return { systemPrompt };
  } catch (err) {
    // Fail open on our own bug, loudly and exactly once: a bug here must cost the session its
    // import expansion, not every prompt the user types.
    surfaceOnce(ctx, "context-imports:before_agent_start", () => {
      notify(`import expansion failed, system prompt left unmodified: ${describeError(err)}`, "error");
    });
    return undefined;
  }
}

/** True when `dir` is strictly below `cwd` (not equal, not a sibling that merely shares a prefix). */
export function isBelowCwd(cwd: string, dir: string): boolean {
  if (dir === cwd) return false;
  const rel = relative(cwd, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** REQ-CTX-08 — lazily load nested AGENTS.md/CLAUDE.md between `touchedPath`'s directory and `cwd`. */
async function loadNestedInstructions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  touchedPath: string,
): Promise<void> {
  const cwd = resolve(ctx.cwd);
  const notify = makeNotify(ctx);
  let dir = dirname(resolve(cwd, touchedPath));

  while (isBelowCwd(cwd, dir)) {
    if (loadedDirs.has(dir)) {
      dir = dirname(dir);
      continue;
    }
    loadedDirs.add(dir);

    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = resolve(dir, name);
      const body = await readFile(file, "utf8").catch((err: unknown) => {
        // A subdirectory without its own instructions file is the common case, not a fault.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          notify(`cannot read ${file}: ${describeError(err)}`, "warning");
        }
        return undefined;
      });
      if (body === undefined) continue;

      const expanded = await expand(file, 1, [], notify);
      pi.sendMessage(
        {
          customType: "nested-instructions",
          content: [
            { type: "text", text: `Directory instructions from ${relative(cwd, file)}:\n\n${expanded}` },
          ],
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
      break; // AGENTS.md wins over CLAUDE.md when both exist in the same directory.
    }
    dir = dirname(dir);
  }
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", () => __resetForTests());

  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined> =>
      expandPromptImports(event, ctx),
  );

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const p = event.input.path;
    if (typeof p !== "string" || p.length === 0) return undefined;
    try {
      await loadNestedInstructions(pi, ctx, p);
    } catch (err) {
      surfaceOnce(ctx, "context-imports:tool_result", () => {
        makeNotify(ctx)(`nested-instructions load failed: ${describeError(err)}`, "error");
      });
    }
    return undefined;
  });
}

/**
 * EXT-02 — session context.
 *
 * Today's date, the per-session scratchpad directory (created, `0700`), the runtime facts the
 * agent cannot otherwise see (active model, thinking level, context window, subagent default
 * tier), the operator-identity file resolved from an ordered path list with an **announced**
 * miss, project state and git facts — injected into the system prompt exactly once per turn.
 *
 * The split is load-bearing, not cosmetic: **all I/O runs in `session_start`**, which fires once
 * per session (plus `reload`/`new`/`resume`/`fork`); **injection runs in `before_agent_start`**,
 * which fires on every user prompt and must therefore touch no disk and spawn no process.
 *
 * The one thing read on every prompt is `ctx.model` / `ctx.thinkingLevel`. That is not a
 * violation of the split: PI resolves both through in-memory getters at call time
 * (`dist/core/extensions/runner.js` `createContext()`), no file and no process is touched, and
 * `/model` mid-session would otherwise leave the block asserting a model the session no longer
 * runs. The config half of `## Runtime` — the subagent default tier — is file-backed and is
 * therefore resolved once, in `session_start`, like everything else.
 *
 * The Soul boundary is enforced here mechanically. A generic `OPERATOR.md` ships in the repo;
 * a personal overlay lives OUTSIDE the repo at `<configDir>/OPERATOR.local.md`. Any candidate
 * that resolves to a path inside the repo — including one handed in through the environment —
 * is **refused and announced**, never read. There is no `ssh` fallback and there never will be.
 */
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, chmod, open, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadDispatchSettings, type DispatchSettings } from "./dispatch/config.ts";
import { configDir, ensureStateRoot, repoRoot } from "./lib/paths.ts";
import { emitNotice } from "./lib/announce.ts";
import { sameRepo } from "./lib/same-repo.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";

export const id = "session-context";

/** The block is delimited by two marker LINES and there is exactly one block, ever. */
export const MARK_OPEN = "<!-- pi-config:session-context v1 -->";
export const MARK_CLOSE = "<!-- /pi-config:session-context v1 -->";

/**
 * REQ-CTX-33's hard cap, measured on the **delimited block** — markers, truncation notice and
 * all — because that is what actually costs tokens. Backstop for the per-section budgets below.
 */
export const MAX_BLOCK_BYTES = 8 * 1024;
/** REQ-CTX-14: head-N of each project doc. */
export const HEAD_LINES = 200;

/** Per-section budgets. Their sum plus headings stays comfortably under MAX_BLOCK_BYTES. */
const MAX_OPERATOR_BYTES = 4 * 1024;
const MAX_DOC_BYTES = 1024;
const MAX_GIT_LOG_BYTES = 512;
/** Never pull more than this off disk before taking the head; guards against a giant doc. */
const MAX_DOC_READ_BYTES = 256 * 1024;
/** A hung `git` (index.lock, network filesystem) must not stall session startup. */
const GIT_TIMEOUT_MS = 5_000;

const PROJECT_STATE_REL = join("docs", "project_state.md");
const ARCHITECTURE_REL = join("docs", "architecture.md");

export type Announce = (line: string, level?: "info" | "warning" | "error") => void;

export interface OperatorCandidate {
  /** Absolute path to try. */
  readonly path: string;
  /** Human label for the announcement — where this candidate came from. */
  readonly source: string;
  /** Only the tracked generic identity file is allowed to live inside the repo. */
  readonly allowInRepo: boolean;
}

export interface OperatorHit {
  readonly path: string;
  readonly source: string;
  readonly text: string;
}

export interface OperatorResolution {
  readonly hit: OperatorHit | null;
  /** One rendered line per candidate, in search order, with its outcome. */
  readonly searched: readonly string[];
  /** Candidates rejected for a reason other than absence. Always announced. */
  readonly refusals: readonly string[];
}

/**
 * What model this session is actually running, read from the live session runtime.
 *
 * Every field is nullable and a null is ALWAYS accompanied by `problem`: an agent that cannot be
 * told which model it is must be told that, not left to infer one. There is no configured-default
 * fallback here on purpose — `config/routing.json`'s `strong` tier is what the session was *asked*
 * to run, which is a different claim from what it *is* running after a `/model`.
 */
export interface LiveModel {
  /** `provider/id`, e.g. `github-copilot/claude-opus-5`. Null when the runtime exposed no model. */
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly contextWindow: number | null;
  /** Why the fields above are null. Rendered into the block, never swallowed. */
  readonly problem: string | null;
}

/** The tier a subagent gets when a dispatch names none — `config/dispatch.json` × `routing.json`. */
export interface SubagentDefault {
  readonly tier: string;
  /** `provider/id` the tier resolves to, or null with a `problem` saying why not. */
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly problem: string | null;
}

/** The shape `readLiveModel` needs. `ExtensionContext` satisfies it structurally. */
export interface LiveModelSource {
  readonly model?: { readonly provider?: string; readonly id?: string; readonly contextWindow?: number };
  readonly thinkingLevel?: string;
}

export interface GitFacts {
  readonly branch: string;
  readonly log: string;
  readonly dirty: number;
}

export interface SessionContextState {
  readonly sessionId: string;
  readonly scratch: string;
  /** YYYY-MM-DD in local time; the memo key for REQ-CTX-11's rollover recompute. */
  dateKey: string;
  /** Bumped by every `session_start`; part of the render-memo key, so the memo re-arms. */
  readonly epoch: number;
  /** Refreshed from `ctx` on every prompt — a model switch must not leave a stale claim behind. */
  live: LiveModel;
  /** File-backed, so resolved once in `session_start`. */
  readonly subagent: SubagentDefault;
  readonly operator: OperatorResolution;
  readonly projectState: string;
  readonly architecture: string;
  readonly git: GitFacts | null;
  /** Non-null when `collect()` failed wholesale. Rendered so the AGENT sees it too. */
  readonly failure: string | null;
}

let state: SessionContextState | null = null;
let renderMemo: { key: string; block: string } | null = null;
let epoch = 0;

/** Test-only: drop all module state so each test starts from a clean registry. */
export function __resetForTests(): void {
  state = null;
  renderMemo = null;
  epoch = 0;
}

/** Test-only: read back what `session_start` collected. */
export function __state(): SessionContextState | null {
  return state;
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    const announce = makeAnnounce(ctx);
    epoch += 1;
    renderMemo = null;
    state = await collect(pi, ctx, announce, epoch);
    // Exported so every spawned tool inherits it and "never /tmp" becomes enforceable.
    process.env.PI_SCRATCH_DIR = state.scratch;
    // REQ-CTX-13: the miss is announced, never silent — and re-armed by every session_start,
    // whatever its `reason`, because a new session is a new chance to notice.
    announceOperator(state.operator, event.reason, announce);
  });

  // REQ-CTX-17 / -33: compaction rebuilds the prompt from disk, so the block is re-injected by
  // before_agent_start on the next prompt. All this handler does is drop the render memo, so a
  // compaction that crossed midnight cannot leave a stale date in the block.
  pi.on("session_compact", () => {
    if (state) state.dateKey = "";
    renderMemo = null;
  });

  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined => {
      if (!state) return undefined;
      try {
        const today = todayKey();
        if (state.dateKey !== today) {
          state.dateKey = today;
          renderMemo = null;
        }
        // In-memory getters only — see the module docstring on why this one read lives here.
        state.live = readLiveModel(ctx);
        return { systemPrompt: injectOnce(event.systemPrompt, blockFor(state)) };
      } catch (err) {
        // Fail open on an internal error of this module, loudly and exactly once: a bug here
        // must cost the session its context block, not every prompt the user types.
        surfaceOnce(ctx, "session-context:before_agent_start", () => {
          makeAnnounce(ctx)(
            `injection failed, prompt left unmodified: ${describeError(err)}`,
            "error",
          );
        });
        return undefined;
      }
    },
  );

  // Debug surface used by this item's acceptance tests and by EXT-10's /doctor.
  pi.registerCommand("ctx-dump", {
    description: "Write the effective system prompt to the session scratchpad (debugging)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const dir = state?.scratch ?? (await ensureStateRoot());
      const out = join(dir, "system-prompt.txt");
      // `ctx.getSystemPrompt()` is the BASE prompt until a turn has run — `/ctx-dump` as the
      // only input of a `pi -p` invocation never triggers before_agent_start. injectOnce is
      // idempotent, so applying it here yields exactly what the next turn would carry,
      // whether or not a turn has already run.
      if (state) state.live = readLiveModel(ctx);
      const prompt = state ? injectOnce(ctx.getSystemPrompt(), blockFor(state)) : ctx.getSystemPrompt();
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await withFileMutationQueue(out, async () => {
          await writeFile(out, prompt, "utf8");
        });
      } catch (err) {
        throw new Error(`[pi-config] session-context: /ctx-dump could not write ${out}: ${describeError(err)}`, {
          cause: err,
        });
      }
      const note = state
        ? `system prompt written to ${out}`
        : `system prompt written to ${out} (session context NOT initialised — block absent)`;
      makeAnnounce(ctx)(note, "info");
    },
  });
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Removes any previously injected block, then appends exactly one.
 *
 * This is what makes REQ-CTX-17 hold: idempotent by construction, not by bookkeeping, so it
 * survives compaction, `/reload`, fork, and a second extension editing the same prompt earlier
 * in the `before_agent_start` chain.
 */
export function injectOnce(systemPrompt: string, block: string): string {
  const stripped = stripBlock(systemPrompt);
  // Budget the CONTENT so that markers + newlines + the truncation notice still fit inside
  // MAX_BLOCK_BYTES. Capping the content at MAX_BLOCK_BYTES instead overshoots the cap by the
  // size of the frame, which is precisely what the size-cap acceptance check measures.
  const note = `[session-context truncated to ${MAX_BLOCK_BYTES} bytes]`;
  const overhead =
    Buffer.byteLength(MARK_OPEN, "utf8") + Buffer.byteLength(MARK_CLOSE, "utf8") +
    Buffer.byteLength(note, "utf8") + 4; // three framing newlines plus the notice's own
  const capped = capBytes(block, MAX_BLOCK_BYTES - overhead, note);
  return `${stripped.trimEnd()}\n\n${MARK_OPEN}\n${capped}\n${MARK_CLOSE}\n`;
}

/** Removes every previously injected block, not just the first — a stacked prompt still heals. */
export function stripBlock(s: string): string {
  let out = s;
  for (;;) {
    const start = out.indexOf(MARK_OPEN);
    if (start === -1) return out;
    const end = out.indexOf(MARK_CLOSE, start);
    out = end === -1 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + MARK_CLOSE.length);
  }
}

function blockFor(s: SessionContextState): string {
  const l = s.live;
  const key = `${s.epoch}:${s.dateKey}:${l.model}:${l.thinkingLevel}:${l.contextWindow}:${l.problem}`;
  if (renderMemo && renderMemo.key === key) return renderMemo.block;
  const block = render(s);
  renderMemo = { key, block };
  return block;
}

// ---------------------------------------------------------------------------
// Collection — everything below runs once, in session_start
// ---------------------------------------------------------------------------

export async function collect(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  announce: Announce,
  epochValue: number,
): Promise<SessionContextState> {
  const sessionId = safeSessionId(ctx.sessionManager.getSessionId());
  let scratch = "";
  let failure: string | null = null;
  try {
    // ensureStateRoot announces its own degradation and returns the usable root.
    scratch = join(await ensureStateRoot((line) => announce(line, "warning")), "scratch", sessionId);
    await mkdir(scratch, { recursive: true, mode: 0o700 }); // REQ-CTX-12: created, not just named
    // mkdir's mode is masked by umask; chmod is not. The 0700 is the requirement, not a wish.
    await chmod(scratch, 0o700);
  } catch (err) {
    failure = `scratchpad directory could not be created: ${describeError(err)}`;
    announce(failure, "error");
  }

  const operator = await resolveOperator();

  const [projectState, architecture] = await Promise.all([
    readHead(join(ctx.cwd, PROJECT_STATE_REL), announce),
    readHead(join(ctx.cwd, ARCHITECTURE_REL), announce),
  ]);

  return {
    sessionId,
    scratch,
    dateKey: todayKey(),
    epoch: epochValue,
    live: readLiveModel(ctx),
    subagent: resolveSubagentDefault(announce),
    operator,
    projectState: capBytes(projectState, MAX_DOC_BYTES, `[truncated to ${MAX_DOC_BYTES} bytes]`),
    architecture: capBytes(architecture, MAX_DOC_BYTES, `[truncated to ${MAX_DOC_BYTES} bytes]`),
    git: await gitFacts(pi, ctx.cwd, announce),
    failure,
  };
}

/**
 * The session's own model, thinking level and context window, straight off the live runtime.
 *
 * `ctx.model` is `Model<TApi>` from `@earendil-works/pi-ai` — `provider`, `id` and `contextWindow`
 * are fields on it; `ctx.thinkingLevel` is a sibling getter on `ExtensionContext`. Both are
 * guarded getters that throw once the runner is torn down, so both are read inside the try and a
 * throw becomes a rendered `problem` rather than a lost section.
 */
export function readLiveModel(ctx: LiveModelSource): LiveModel {
  try {
    const model = ctx.model;
    const level = ctx.thinkingLevel ?? null;
    if (!model || !model.provider || !model.id) {
      return {
        model: null,
        thinkingLevel: level,
        contextWindow: null,
        problem: "the session runtime exposed no active model (ctx.model is undefined)",
      };
    }
    const window = typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : null;
    return {
      model: `${model.provider}/${model.id}`,
      thinkingLevel: level,
      contextWindow: window,
      problem: window === null ? "the active model declares no context window" : null,
    };
  } catch (err) {
    return {
      model: null,
      thinkingLevel: null,
      contextWindow: null,
      problem: `the session runtime refused to report its model: ${describeError(err)}`,
    };
  }
}

/**
 * `config/dispatch.json`'s `defaultTier` resolved through `config/routing.json`'s tier table.
 *
 * Synchronous file reads, so this belongs to `session_start` and nowhere else. The tier is
 * reported even when it does not resolve: "the default tier is `light` and this repo cannot say
 * what `light` is" is a fact worth injecting, and it is announced as well as rendered.
 */
export function resolveSubagentDefault(
  announce: Announce,
  settings: DispatchSettings = loadDispatchSettings(),
): SubagentDefault {
  const tier = settings.dispatch.defaultTier;
  const unresolved = (problem: string): SubagentDefault => {
    announce(`subagent default tier "${tier}" could not be resolved: ${problem}`, "warning");
    return { tier, model: null, thinkingLevel: null, problem };
  };
  if (!settings.routing) {
    return unresolved(
      `config/routing.json could not be loaded (${settings.problems.join("; ") || "no reason reported"})`,
    );
  }
  const def = settings.routing.tiers[tier];
  if (!def) {
    const known = Object.keys(settings.routing.tiers).join(", ") || "none";
    return unresolved(`config/routing.json declares no tier "${tier}" (declared: ${known})`);
  }
  return { tier, model: def.model, thinkingLevel: def.thinkingLevel ?? null, problem: null };
}

/**
 * Ordered search list for REQ-CTX-13. First readable hit wins; a miss is ANNOUNCED.
 *
 * The authoritative revision puts the personal overlay at
 * `<configDir>/OPERATOR.local.md` — outside the repo. An earlier draft put it inside the
 * repo at `config/operator/OPERATOR.local.md`; that placement is dropped, because the hard
 * constraint on this item is that a Soul-shaped file must never be readable from a repo path.
 */
export function operatorCandidates(): OperatorCandidate[] {
  const out: OperatorCandidate[] = [];
  const push = (raw: string | undefined, source: string, allowInRepo = false): void => {
    const trimmed = raw?.trim();
    if (trimmed) out.push({ path: resolve(trimmed), source, allowInRepo });
  };
  push(process.env.PI_IDENTITY_PATH, "$PI_IDENTITY_PATH");
  push(process.env.PI_OPERATOR_FILE, "$PI_OPERATOR_FILE");
  push(join(configDir(), "OPERATOR.local.md"), "personal overlay, git-ignored, outside the repo");
  push(join(repoRoot(), "config", "operator", "OPERATOR.md"), "generic operator identity, tracked", true);
  return out;
}

/**
 * True when `p` resolves to somewhere inside this repository.
 *
 * The prefix test answers for the primary checkout. It is not the whole question: a **linked git
 * worktree** of this same repo lives at a path with no textual relationship to `repoRoot()`, so an
 * operator-identity file placed in one would sail past a prefix-only check — the refusal below
 * exists precisely to stop such a file being readable from a repo path, and a second checkout of
 * the repo is a repo path. Ownership is git's answer, not the string's (`lib/same-repo.ts`); when
 * git cannot answer, the verdict is the prefix one, so this can only ever refuse more, never less.
 */
export function isInsideRepo(p: string): boolean {
  const root = resolve(repoRoot());
  const target = resolve(p);
  if (target === root) return false;
  const rel = relative(root, target);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return true;
  return sameRepo(root, target);
}

export async function resolveOperator(): Promise<OperatorResolution> {
  const searched: string[] = [];
  const refusals: string[] = [];
  let hit: OperatorHit | null = null;

  for (const candidate of operatorCandidates()) {
    if (hit) {
      searched.push(`${candidate.path} — not reached (${candidate.source})`);
      continue;
    }
    if (isInsideRepo(candidate.path) && !candidate.allowInRepo) {
      const why =
        `${candidate.path} — REFUSED: an operator-identity file supplied via ${candidate.source} ` +
        `must not live inside the repository; move it to ${join(configDir(), "OPERATOR.local.md")}`;
      searched.push(why);
      refusals.push(why);
      continue;
    }
    try {
      const text = await readCapped(candidate.path, MAX_DOC_READ_BYTES);
      hit = { path: candidate.path, source: candidate.source, text };
      searched.push(`${candidate.path} — USED (${candidate.source})`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        searched.push(`${candidate.path} — not found (${candidate.source})`);
      } else {
        const why = `${candidate.path} — unreadable: ${describeError(err)}`;
        searched.push(why);
        refusals.push(why);
      }
    }
  }
  // Nothing is announced here: `announceOperator` reports the outcome once per session_start,
  // tagged with the reason that re-armed it.
  return { hit, searched, refusals };
}

function announceOperator(
  op: OperatorResolution,
  reason: SessionStartEvent["reason"],
  announce: Announce,
): void {
  for (const r of op.refusals) announce(`operator candidate rejected (${reason}): ${r}`, "error");
  if (op.hit) return;
  announce(
    `no operator-identity file resolved (${reason}). Searched, in order:\n` +
      op.searched.map((l) => `  - ${l}`).join("\n"),
    "warning",
  );
}

async function gitFacts(pi: ExtensionAPI, cwd: string, announce: Announce): Promise<GitFacts | null> {
  const run = (args: string[]) => pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  // `pi.exec` NEVER rejects — it resolves with `code` even when the binary is missing (verified
  // against dist/core/exec.js 0.84.0). The spec's try/catch could therefore never fire and a
  // non-repo directory would have rendered an empty branch. Every exit code is checked instead.
  let inside;
  try {
    inside = await run(["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    announce(`git could not be executed in ${cwd}: ${describeError(err)}`, "warning");
    return null;
  }
  // Not a repository is a normal condition, not an error: stay quiet and omit the section.
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  const [branchR, logR, statusR] = await Promise.all([
    run(["branch", "--show-current"]),
    run(["log", "-5", "--oneline", "--no-decorate"]),
    run(["status", "--porcelain"]),
  ]);

  if (statusR.code !== 0) {
    announce(
      `git status failed in ${cwd} (exit ${statusR.code}): ${statusR.stderr.trim() || "no stderr"}`,
      "warning",
    );
    return null;
  }

  return {
    branch: branchR.code === 0 ? branchR.stdout.trim() || "(detached HEAD)" : "(branch unavailable)",
    log:
      logR.code === 0
        ? capBytes(logR.stdout.trim(), MAX_GIT_LOG_BYTES, "[git log truncated]")
        : "(no commit history)",
    dirty: statusR.stdout.split("\n").filter((l) => l.trim().length > 0).length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function render(s: SessionContextState): string {
  const parts: string[] = [];
  if (s.failure) {
    parts.push(
      `## Session context (degraded)\n${s.failure}\n` +
        `Say so before relying on anything below; do not work around it silently.`,
    );
  }
  parts.push(`## Today\n${s.dateKey}`); // REQ-CTX-11
  parts.push(renderRuntime(s));
  parts.push(
    `## Scratchpad\n${s.scratch}\n` + // REQ-CTX-12
      `This directory exists and is yours for this session. Never write temporary files to /tmp.`,
  );
  parts.push(renderOperator(s.operator)); // REQ-CTX-13
  const project = renderProject(s); // REQ-CTX-14
  if (project) parts.push(project);
  return parts.join("\n\n");
}

/**
 * What model this is, how hard it is thinking, how much room it has, and what a subagent gets.
 *
 * Every branch renders something. An unresolved model prints `UNRESOLVED` with the reason and an
 * instruction not to name one from memory — the failure mode this section exists to close is an
 * agent confidently answering "which model are you" out of its training data, and a silently
 * omitted section restores exactly that.
 */
function renderRuntime(s: SessionContextState): string {
  const { model, thinkingLevel, contextWindow, problem } = s.live;
  const level = thinkingLevel ?? "UNRESOLVED";
  const window = contextWindow === null ? "UNRESOLVED" : `${contextWindow} tokens`;
  const lines = [`## Runtime`];
  if (model) {
    lines.push(`model ${model} · thinking ${level} · context window ${window}`);
  } else {
    lines.push(
      `model UNRESOLVED — ${problem ?? "no reason reported"} · thinking ${level} · context window ${window}`,
      `Say the model is unknown when asked; never name one from memory.`,
    );
  }
  const sub = s.subagent;
  lines.push(
    sub.model
      ? `Subagent default tier: ${sub.tier} (${sub.model} @ ${sub.thinkingLevel ?? "provider default"}).`
      : `Subagent default tier: ${sub.tier} — UNRESOLVED: ${sub.problem ?? "no reason reported"}`,
  );
  lines.push(
    `Routing questions are answered from config/models.json and config/routing.json, never from memory.`,
  );
  return lines.join("\n");
}

function renderOperator(op: OperatorResolution): string {
  if (!op.hit) {
    return [
      `## Operator`,
      `No operator-identity file resolved. Searched, in order:`,
      ...op.searched.map((l) => `  - ${l}`),
      `Proceed without operator context; do not invent one.`,
    ].join("\n");
  }
  const lines = [`## Operator`, `Source: ${op.hit.path} (${op.hit.source})`];
  if (op.refusals.length > 0) {
    lines.push(``, `Rejected before this one:`, ...op.refusals.map((r) => `  - ${r}`));
  }
  lines.push(
    ``,
    capBytes(
      op.hit.text.trim(),
      MAX_OPERATOR_BYTES,
      `[operator file truncated to ${MAX_OPERATOR_BYTES} bytes — full file at ${op.hit.path}]`,
    ),
  );
  return lines.join("\n");
}

function renderProject(s: SessionContextState): string | null {
  if (!s.git && !s.projectState && !s.architecture) return null;
  const head = s.git
    ? `branch ${s.git.branch}, ${s.git.dirty} uncommitted file(s)\n\`\`\`\n${s.git.log}\n\`\`\``
    : `not a git repository`;
  const out = [`## Project`, head];
  if (s.projectState) out.push(``, `### ${PROJECT_STATE_REL} (head ${HEAD_LINES})`, s.projectState);
  if (s.architecture) out.push(``, `### ${ARCHITECTURE_REL} (head ${HEAD_LINES})`, s.architecture);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function todayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Byte-accurate cap with an ANNOUNCED truncation. Byte-accurate because REQ-CTX-33's budget is
 * a token budget, and a `String.length` cap under-counts every non-ASCII character.
 */
export function capBytes(s: string, maxBytes: number, note: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  // A cut inside a multi-byte sequence decodes to a trailing U+FFFD; drop it rather than ship it.
  const head = buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  return `${head}\n${note}`;
}

/**
 * A session id becomes a path segment, so it may not contain a separator, a `..` run, or a
 * leading dot. A single interior dot survives, so two distinct real ids cannot collide on one
 * scratch directory.
 */
export function safeSessionId(raw: string): string {
  const cleaned = (raw ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\./, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "unknown-session";
}

/** Reads at most `maxBytes` from `path`. Throws — the caller decides what absence means. */
export async function readCapped(path: string, maxBytes: number): Promise<string> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh?.close();
  }
}

async function readHead(path: string, announce: Announce): Promise<string> {
  try {
    const text = await readCapped(path, MAX_DOC_READ_BYTES);
    return text.split("\n").slice(0, HEAD_LINES).join("\n").trimEnd();
  } catch (err) {
    // A project without these docs is the common case, not a fault. Anything else is a fault.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      announce(`cannot read ${path}: ${describeError(err)}`, "warning");
    }
    return "";
  }
}

/**
 * One channel, whichever this run mode has: `ctx.ui.*` is a no-op in `-p` and `--mode json`
 * (which is exactly where CI runs, so a UI-only announcement would be a silent one there), and a
 * live surface in the TUI (where a second stderr copy prints straight over PI's own frame). See
 * `lib/announce.ts` for the full argument; `emitNotice` picks by `ctx.hasUI`.
 */
export function makeAnnounce(ctx?: ExtensionContext): Announce {
  return (line, level = "warning") => emitNotice(ctx, `[pi-config] session-context: ${line}`, level);
}

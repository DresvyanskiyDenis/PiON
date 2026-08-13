/**
 * Ports `nudge-verify.sh` onto PI's `(#33) input` event (REQ-EXT-20, `REQ-CTX-15` consumer).
 *
 * `input` is "the one place PI beats both predecessors" — Claude Code's
 * `UserPromptSubmit` could only append `additionalContext`; PI's `input` handler can return
 * `{ action: "transform", text }` and rewrite the user's message outright. This module still only
 * ever *appends* — the ported design rule is the point, not the new capability:
 *
 *   "Design rule: STAY SILENT. A hook that fires on every prompt is noise and gets tuned out
 *    ... Each signal is a concrete lexical marker, never a guess about intent."
 *
 * **`input` fires BEFORE skill and prompt-template expansion**. A `/skill:foo bar` prompt reaches this handler as the literal string
 * `/skill:foo bar` — the original script's `case "$PROMPT" in /*) exit 0 ;;` bailout is ported
 * unchanged for exactly that reason, and it still does the right thing here, but note the
 * ordering is the opposite of the intuition: this handler can never see an expanded template,
 * only ever the raw slash-prefixed input the user typed.
 *
 * Signals ported ("all three signals port unchanged"):
 *   1. a dependency of *this project's own manifest* is named in the prompt
 *   2. an explicit version string appears in the prompt
 *   3. the bailouts: a leading `/` (see above), and a too-short prompt
 *
 * DEVIATION: an earlier survey lists five original signals (manifest dependency, version number,
 * recency words EN+RU, pricing words, pasted stack trace) as "directly portable", but
 * the more specific, non-frozen porting decision — with a concrete acceptance
 * test — names only the two lexical *marker* signals plus the bailouts as what actually ports
 * into `EXT-17`. Recency/pricing words are already covered statically by the harness's own
 * "verify instead of recalling" instruction rather than by a hook, and a pasted stack trace is a
 * different behaviour (triage, not verification) with no PI event mapping given here. Implemented
 * per that narrower list; whether the other three should be added is left open.
 *
 * DEVIATION: the original bash script's exact version-string regex, dependency-manifest set, and
 * short-prompt threshold are not present anywhere in this repo (they live in
 * `~/.claude/hooks/nudge-verify.sh`, outside this repo). The constants
 * below are a reasonable reimplementation against the documented behaviour and its
 * acceptance test, not a byte-for-byte port.
 *
 * Collapse-into-EXT-15 decision (this module was asked to make the call): KEPT AS TYPESCRIPT.
 * The version-number signal alone is a
 * static pattern and could be a `pi-yaml-hooks` `match.pattern` rule, but the dependency-name
 * signal cannot: it requires reading and parsing this project's own manifest file(s) at runtime
 * and building a match set from their contents, which is dynamic per-project computation — exactly
 * the kind of expressiveness `EXT-15`'s YAML schema is deliberately capped short of
 * (`REQ-EXT-17`: "cap it at deny/warn/inject
 * ... let anything else be TypeScript"). Splitting one script's two signals across two owners
 * (a YAML rule for the version marker, TypeScript here for the dependency marker) would reintroduce
 * the "two places to look for one behaviour" problem the porting effort exists to remove, so both
 * signals stay in this one module.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { declareModule } from "./lib/manifest.ts";
import { emitNotice } from "./lib/announce.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";

export const id = "input-transform";

const MODULE_VERSION = "1.0.0";

/**
 * Appended, never substituted — see the file header. Points at the two tools the harness's own
 * "Context7 before code touching a library" / "verify instead of recalling" instructions name,
 * per the ported design's "nudge text points at web_search/web_fetch/context7-if-enabled".
 */
const NUDGE_SUFFIX =
  "\n\n[verify] This mentions a project dependency or a version — check Context7 (or web_search " +
  "for anything date-, pricing-, or limit-sensitive) before answering from memory.";

/**
 * Below this many words, no signal is trusted — mirrors the original's short-prompt bailout.
 * ASSUMPTION (see file header DEVIATION note): the literal original threshold is not available
 * in this repo. 3 words is chosen so "ok continue" (2 words) always bails regardless of what it
 * happens to contain, while the acceptance test's "why does pydantic v2.11 fail here" (6 words)
 * clears it easily.
 */
const MIN_PROMPT_WORDS = 3;

/** `\bv?\d+\.\d+(\.\d+)?\b` — "2.11", "v2.11", "3.13.0". A concrete lexical marker, not a guess. */
const VERSION_MARKER_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/;

/** Package-name-shaped token: word chars plus the punctuation real package names use. */
const TOKEN_RE = /[\w@./-]+/g;

const MANIFEST_FILES: ReadonlyArray<{
  readonly file: string;
  readonly parse: (raw: string) => readonly string[];
}> = [
  { file: "package.json", parse: namesFromPackageJson },
  { file: "pyproject.toml", parse: namesFromPyprojectToml },
];

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    declareModule({
      id,
      version: MODULE_VERSION,
      events: ["input", "session_start"],
      apis: ["on"],
    });
  });
  pi.on("input", handleInput);
}

async function handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
  try {
    if (!event.text || event.text.trim().length === 0) return { action: "continue" };
    const dependencyNames = await dependencyNamesFor(ctx.cwd);
    const decision = decide(event.text, dependencyNames);
    if (!decision.fire) return { action: "continue" };
    return { action: "transform", text: event.text + NUDGE_SUFFIX };
  } catch (err) {
    // Belt-and-braces: PI's own runner already catches a throwing `input` handler and continues
    // with the text unchanged (`emitInput` in `dist/core/extensions/runner.js`), so this branch
    // is not load-bearing for correctness — but REQ-EXT-16 wants the error surfaced once, in our
    // own words, rather than left to the platform's generic per-extension error report.
    surfaceOnce(ctx, `${id}:handler:${signature(err)}`, () => {
      emitNotice(
        ctx,
        `[pi-config] ${id}: failed internally, prompt left unchanged: ${describeError(err)}`,
        "error",
      );
    });
    return { action: "continue" };
  }
}

export interface NudgeDecision {
  readonly fire: boolean;
  readonly reason?: "dependency" | "version";
}

/** Pure decision function — the whole signal + bailout logic, independent of I/O. */
export function decide(text: string, dependencyNames: ReadonlySet<string>): NudgeDecision {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { fire: false };
  if (trimmed.startsWith("/")) return { fire: false }; // leading-slash bailout; see file header
  if (trimmed.split(/\s+/).length < MIN_PROMPT_WORDS) return { fire: false };
  if (dependencyNames.size > 0 && hasDependencyToken(trimmed, dependencyNames)) {
    return { fire: true, reason: "dependency" };
  }
  if (VERSION_MARKER_RE.test(trimmed)) return { fire: true, reason: "version" };
  return { fire: false };
}

function hasDependencyToken(text: string, dependencyNames: ReadonlySet<string>): boolean {
  const tokens = text.toLowerCase().match(TOKEN_RE) ?? [];
  return tokens.some((token) => dependencyNames.has(stripTrailingPunctuation(token)));
}

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[.,!?;:]+$/, "");
}

interface ManifestCacheEntry {
  readonly mtimeMs: number;
  readonly names: readonly string[];
}

const manifestCache = new Map<string, ManifestCacheEntry>();

/**
 * Dependency names declared by this project's own manifest(s), lower-cased and deduped.
 * Cached per absolute manifest path and invalidated on mtime change, so a long-lived session
 * picks up a `package.json`/`pyproject.toml` edit without re-reading on every single prompt.
 */
export async function dependencyNamesFor(cwd: string): Promise<ReadonlySet<string>> {
  const collected = new Set<string>();
  for (const { file, parse } of MANIFEST_FILES) {
    const path = join(cwd, file);
    try {
      const info = await stat(path);
      const cached = manifestCache.get(path);
      if (cached && cached.mtimeMs === info.mtimeMs) {
        for (const name of cached.names) collected.add(name);
        continue;
      }
      const raw = await readFile(path, "utf8");
      const names = parse(raw);
      manifestCache.set(path, { mtimeMs: info.mtimeMs, names });
      for (const name of names) collected.add(name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      manifestCache.delete(path);
      if (code === "ENOENT") continue; // no such manifest here — not a signal, not an error
      surfaceOnce(undefined, `${id}:manifest:${path}`, () => {
        process.stderr.write(
          `[pi-config] ${id}: could not read ${path}, dependency signal skipped for it: ` +
            `${describeError(err)}\n`,
        );
      });
    }
  }
  return collected;
}

function namesFromPackageJson(raw: string): readonly string[] {
  const json = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const keys = [
    ...Object.keys(json.dependencies ?? {}),
    ...Object.keys(json.devDependencies ?? {}),
    ...Object.keys(json.peerDependencies ?? {}),
    ...Object.keys(json.optionalDependencies ?? {}),
  ];
  return dedupeLower(keys);
}

/**
 * `[project.dependencies]` (PEP 621) + `[project.optional-dependencies]` + `[dependency-groups]`
 * (PEP 735, what `uv` writes) — no Poetry-specific tables, matching this harness's "uv, never
 * Poetry" convention. Each entry is a PEP 508 requirement string; only the bare name is kept.
 */
function namesFromPyprojectToml(raw: string): readonly string[] {
  const doc = parseToml(raw) as Record<string, unknown>;
  const specs: string[] = [];

  const project = doc.project as Record<string, unknown> | undefined;
  if (project) {
    collectSpecs(project.dependencies, specs);
    const optional = project["optional-dependencies"] as Record<string, unknown> | undefined;
    if (optional) for (const group of Object.values(optional)) collectSpecs(group, specs);
  }

  const groups = doc["dependency-groups"] as Record<string, unknown> | undefined;
  if (groups) for (const group of Object.values(groups)) collectSpecs(group, specs);

  const names = specs.map(extractPep508Name).filter((n): n is string => n !== undefined);
  return dedupeLower(names);
}

function collectSpecs(value: unknown, out: string[]): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) if (typeof entry === "string") out.push(entry);
}

const PEP508_NAME_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)/;

function extractPep508Name(spec: string): string | undefined {
  const match = PEP508_NAME_RE.exec(spec.trim());
  return match?.[1];
}

function dedupeLower(names: readonly string[]): readonly string[] {
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

function signature(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return msg.slice(0, 120);
}

/** Test-only. */
export function resetDependencyCache(): void {
  manifestCache.clear();
}

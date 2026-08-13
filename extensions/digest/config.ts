/**
 * `config/digest.json` — owned by `EXT-06` ("a previous revision
 * had a gate reading a file no item wrote"). This is the one place its shape is defined,
 * defaulted and validated; both `extensions/digest/index.ts` (the enqueue side) and
 * `bin/pi-digest-drain` (the worker) load through this module so they can never disagree
 * about what a field means.
 *
 * D-W2-5: the summariser is *config*, never a binary name. `kind: "pi"` names a
 * `config/routing.json` **tier** (REQ-CTX-25, REQ-CTX-80) — never a bare model id and never
 * `claude`; `kind: "command"` is an escape hatch to an arbitrary local binary; `kind: "off"`
 * disables summarisation while keeping the pipeline (and its guards) live.
 */
import { readFile } from "node:fs/promises";
import { digestConfigPath } from "./paths.ts";

/** Bumped whenever the digest file's *shape* changes, stamped into every digest's frontmatter
 *  so a stale/old-format digest is distinguishable from a legitimate "nothing happened". */
export const DIGEST_VERSION = 2;

/**
 * Recursion guard env var (shared between `index.ts`'s `register()` guard and
 * `bin/pi-digest-drain`'s summariser spawn, plus the racer test) — one literal, not two, so the
 * enqueue side and the worker side can never drift apart on the name.
 */
export const RECURSION_ENV = "PI_DIGEST_WORKER";

export type SummarizerKind = "pi" | "command" | "off";

export interface PiSummarizer {
  readonly kind: "pi";
  /** A `config/routing.json` tier name (e.g. "cheap") — never a raw model id. */
  readonly model: string;
  readonly timeoutMs: number;
}
export interface CommandSummarizer {
  readonly kind: "command";
  /** argv[0] plus its arguments. Never validated against a specific binary name here —
   *  REQ-CTX-80 ("no shipped code invokes `claude`") is enforced statically, by `bin/pi-check`
   *  (PC-07) walking the committed tree, not by a runtime allow/deny list. */
  readonly argv: readonly [string, ...string[]];
  readonly timeoutMs: number;
}
export interface OffSummarizer {
  readonly kind: "off";
}
export type Summarizer = PiSummarizer | CommandSummarizer | OffSummarizer;

export interface DigestConfig {
  readonly enabled: boolean;
  /** Sessions with fewer entries than this never get a digest — a one-line "say ok" test
   *  run should not produce a Markdown file. */
  readonly minTurns: number;
  /** The transcript is tail-sliced to this many bytes before it reaches the summariser. */
  readonly maxTranscriptBytes: number;
  /** `~` and `$HOME` are expanded (`expandHome()` below). */
  readonly outputDir: string;
  readonly summarizer: Summarizer;
}

export const DEFAULT_DIGEST_CONFIG: DigestConfig = {
  enabled: true,
  minTurns: 2,
  maxTranscriptBytes: 200_000,
  outputDir: "~/.pi/agent/digests",
  summarizer: { kind: "pi", model: "cheap", timeoutMs: 120_000 },
};

export class DigestConfigError extends Error {
  readonly path: string;
  constructor(message: string, path: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DigestConfigError";
    this.path = path;
  }
}

/**
 * Loads and validates `config/digest.json`. Fails loud (REQ-PRV-32): a missing file falls
 * back to defaults (there is nothing wrong with "not configured yet"), but a *present and
 * malformed* file throws — a typo in the summariser kind must never silently become
 * "digests stopped happening" with no trace.
 */
export async function loadDigestConfig(path: string = digestConfigPath()): Promise<DigestConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_DIGEST_CONFIG;
    throw new DigestConfigError(`could not read ${path}: ${(err as Error).message}`, path, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DigestConfigError(`${path} is not valid JSON: ${(err as Error).message}`, path, err);
  }

  return validateDigestConfig(parsed, path);
}

/** Exported so tests can exercise validation without touching the filesystem. */
export function validateDigestConfig(parsed: unknown, path = "<in-memory>"): DigestConfig {
  const fail = (msg: string): never => {
    throw new DigestConfigError(`${path}: ${msg}`, path);
  };
  if (typeof parsed !== "object" || parsed === null) fail("root must be a JSON object");
  const root = parsed as Record<string, unknown>;
  const digest = root.digest;
  if (typeof digest !== "object" || digest === null) fail('missing "digest" object');
  const d = digest as Record<string, unknown>;

  const enabled = d.enabled ?? DEFAULT_DIGEST_CONFIG.enabled;
  if (typeof enabled !== "boolean") fail('"digest.enabled" must be a boolean');

  const minTurns = d.minTurns ?? DEFAULT_DIGEST_CONFIG.minTurns;
  if (!isNonNegativeInt(minTurns)) fail('"digest.minTurns" must be a non-negative integer');

  const maxTranscriptBytes = d.maxTranscriptBytes ?? DEFAULT_DIGEST_CONFIG.maxTranscriptBytes;
  if (!isPositiveInt(maxTranscriptBytes)) {
    fail('"digest.maxTranscriptBytes" must be a positive integer');
  }

  const outputDir = d.outputDir ?? DEFAULT_DIGEST_CONFIG.outputDir;
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    fail('"digest.outputDir" must be a non-empty string');
  }

  const summarizer = validateSummarizer(d.summarizer, fail);

  return {
    enabled: enabled as boolean,
    minTurns: minTurns as number,
    maxTranscriptBytes: maxTranscriptBytes as number,
    outputDir: outputDir as string,
    summarizer,
  };
}

function validateSummarizer(raw: unknown, fail: (msg: string) => never): Summarizer {
  if (raw === undefined) return DEFAULT_DIGEST_CONFIG.summarizer;
  if (typeof raw !== "object" || raw === null) fail('"digest.summarizer" must be an object');
  const s = raw as Record<string, unknown>;
  const kind = s.kind;

  if (kind === "off") return { kind: "off" };

  if (kind === "pi") {
    const model = s.model;
    if (typeof model !== "string" || model.length === 0) {
      fail('"digest.summarizer.model" must name a config/routing.json tier (non-empty string)');
    }
    const timeoutMs = s.timeoutMs ?? 120_000;
    if (!isPositiveInt(timeoutMs)) fail('"digest.summarizer.timeoutMs" must be a positive integer');
    return { kind: "pi", model: model as string, timeoutMs: timeoutMs as number };
  }

  if (kind === "command") {
    const argv = s.argv;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string" && a.length > 0)) {
      fail('"digest.summarizer.argv" must be a non-empty array of non-empty strings');
    }
    const timeoutMs = s.timeoutMs ?? 120_000;
    if (!isPositiveInt(timeoutMs)) fail('"digest.summarizer.timeoutMs" must be a positive integer');
    return {
      kind: "command",
      argv: argv as [string, ...string[]],
      timeoutMs: timeoutMs as number,
    };
  }

  fail('"digest.summarizer.kind" must be "pi", "command" or "off"');
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** `~` and `$HOME`/`${HOME}` expansion for `outputDir`. No shell involved. */
export function expandHome(path: string): string {
  const home = process.env.HOME ?? "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path.replace(/\$\{HOME\}|\$HOME/g, home);
}

/**
 * EXT-11 — pinned-block **regeneration** (`REQ-CTX-37`).
 *
 * Regeneration, not preservation. PI decides what compaction drops: `prepareCompaction()` picks
 * the cut point from a token budget alone and an extension gets no say in which entries survive —
 * `SessionBeforeCompactResult` can cancel the pass or replace the *summary*, and nothing else. So
 * "pin this region" is not implementable as "make PI keep these bytes". What *is* implementable,
 * and is strictly better, is: after every compaction, re-read the pinned sources from disk and
 * re-state them. The block is then always current (an `AGENTS.md` edited mid-session shows its new
 * text) and it is byte-identical across compactions whenever the file is unchanged, which is
 * exactly what `REQ-CTX-37`'s acceptance measures.
 *
 * A personal identity file — the operator's own long-term self-model, under whatever name — is
 * out of scope for this harness and never ships with it, so a source whose base name is shaped
 * like one is **refused and announced**, never read. Same mechanical boundary that
 * `extensions/session-context.ts` enforces for the operator file, applied to pinned sources.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

export interface PinnedLimits {
  readonly maxBytesPerSource: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_PINNED_LIMITS: PinnedLimits = {
  maxBytesPerSource: 4096,
  maxTotalBytes: 16384,
};

export interface PinnedSource {
  /** Absolute path actually read. */
  readonly path: string;
  /** What the config asked for, as written. */
  readonly spec: string;
}

export interface PinnedBlock {
  readonly spec: string;
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface PinnedResult {
  readonly blocks: readonly PinnedBlock[];
  /** One line per source that was refused or unreadable. Always announced, never swallowed. */
  readonly problems: readonly string[];
}

/** A personal-identity file by name: `Soul.md`, `soul.local.md`, `MY-SOUL.markdown` — anything
 *  whose base name carries "soul". Refused as a pinned source, and the refusal is announced. */
export function isSoulShaped(p: string): boolean {
  return /(^|[^a-z])soul([^a-z]|$)/i.test(basename(p));
}

export function resolvePinnedSources(cwd: string, specs: readonly string[]): PinnedSource[] {
  return specs.map((spec) => ({
    spec,
    path: isAbsolute(spec) ? resolve(spec) : resolve(cwd, spec),
  }));
}

/**
 * Reads every pinned source under the byte budget.
 *
 * A missing source is a normal condition for a shared config (`CLAUDE.md` is not in every repo)
 * and is reported as a problem line only when it exists but cannot be read — an `ENOENT` is
 * silently skipped, matching `session-context.ts`'s `readHead`. Everything else is announced.
 */
export async function readPinned(
  sources: readonly PinnedSource[],
  limits: PinnedLimits = DEFAULT_PINNED_LIMITS,
): Promise<PinnedResult> {
  const blocks: PinnedBlock[] = [];
  const problems: string[] = [];
  let total = 0;

  for (const source of sources) {
    if (isSoulShaped(source.path)) {
      problems.push(
        `${source.path} — REFUSED: a Soul-shaped identity file is never injected, in any form ` +
          `(pinned source "${source.spec}")`,
      );
      continue;
    }
    if (total >= limits.maxTotalBytes) {
      problems.push(
        `${source.path} — skipped: the ${limits.maxTotalBytes}-byte pinned-block budget was already spent`,
      );
      continue;
    }
    let raw: string;
    try {
      const info = await stat(source.path);
      if (!info.isFile()) {
        problems.push(`${source.path} — skipped: not a regular file`);
        continue;
      }
      raw = await readFile(source.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        problems.push(`${source.path} — unreadable: ${(err as Error).message}`);
      }
      continue;
    }

    const budget = Math.min(limits.maxBytesPerSource, limits.maxTotalBytes - total);
    const { text, truncated } = capBytes(raw.trim(), budget);
    if (text.length === 0) continue;
    total += Buffer.byteLength(text, "utf8");
    blocks.push({ spec: source.spec, path: source.path, text, truncated });
  }

  return { blocks, problems };
}

function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  // A cut inside a multi-byte sequence decodes to a trailing U+FFFD; drop it rather than ship it.
  const head = buf.subarray(0, Math.max(maxBytes, 0)).toString("utf8").replace(/�+$/u, "");
  return { text: head, truncated: true };
}

/**
 * Renders the message re-stated after a compaction. Returns `""` when nothing survived, so the
 * caller can skip the send entirely rather than push an empty message into context.
 */
export function renderPinned(result: PinnedResult): string {
  if (result.blocks.length === 0) return "";
  const parts = [
    "The context was just compacted. These instruction sources are pinned: they are re-read from " +
      "disk after every compaction and are authoritative over anything the summary above says " +
      "about them.",
  ];
  for (const block of result.blocks) {
    parts.push(
      `\n### ${block.spec} (${block.path})\n${block.text}${
        block.truncated ? `\n[pinned source truncated — read ${block.path} for the rest]` : ""
      }`,
    );
  }
  return parts.join("\n");
}

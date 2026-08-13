/**
 * Where an oversized report goes.
 *
 * *"Every custom tool truncates with the exported helpers … and names the
 * overflow file in the returned text."* For this module the rule is more than housekeeping — a
 * teammate's report is the entire product of a separate session, and silently cutting it at 50 KB
 * would recreate the loss the module exists to prevent, one layer lower. So the full text is
 * written to the session scratch tree first and the truncated view names that file.
 *
 * The write goes through `withFileMutationQueue`, following the rule for file-mutating paths: two
 * teammates can deliver in the same turn, and the queue is keyed on the absolute path.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { scratchDir } from "../lib/paths.ts";

export interface SpilledReport {
  /** What goes back to the model. */
  readonly text: string;
  /** Set when the report did not fit and was written out in full. */
  readonly file?: string;
  readonly truncated: boolean;
}

export interface SpillOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  /** Injected by tests; defaults to the per-session scratch tree. */
  readonly dir?: string;
  readonly now?: number;
}

/**
 * Truncates from the **head**, not the tail: a report's conclusion is at the end, but its structure
 * and headline are at the start, and the full text is one `read` away by design.
 */
export async function spillReport(
  sessionId: string,
  teammate: string,
  report: string,
  options: SpillOptions = {},
): Promise<SpilledReport> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const result = truncateHead(report, { maxLines, maxBytes });
  if (!result.truncated) return { text: report, truncated: false };

  const dir = options.dir ?? join(scratchDir(sessionId), "teammates");
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${teammate}-${stamp}.md`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withFileMutationQueue(file, async () => {
    await writeFile(file, report, "utf8");
  });

  return {
    text:
      `${result.content}\n\n` +
      `[report truncated at ${result.outputLines}/${result.totalLines} lines ` +
      `(${formatSize(result.totalBytes)} total, limit hit: ${result.truncatedBy}). ` +
      `The complete report is at ${file} — read it before acting on the tail.]`,
    file,
    truncated: true,
  };
}

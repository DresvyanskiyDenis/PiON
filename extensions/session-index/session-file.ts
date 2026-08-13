/**
 * The one place that opens a *session* file for reading. `readFileSync` is the only fs call —
 * there is no write path anywhere in this module, which is what makes the indexer structurally
 * incapable of corrupting a session: a bug here can produce a stale or
 * wrong index row, never a mutated session.
 */
import { readFileSync } from "node:fs";
import {
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

export interface ParsedSession {
  readonly header: SessionHeader | null;
  readonly entries: readonly SessionEntry[];
}

/**
 * Reads and parses one session JSONL file. `parseSessionEntries` already skips malformed lines
 * rather than throwing; `migrateSessionEntries` is run so a pre-v3 file (an older PI version's
 * history) still yields a usable `entries` list instead of being silently misread. Throws only on
 * a read failure (missing file, permissions) — callers decide how to treat that.
 */
export function readSessionFile(path: string): ParsedSession {
  const content = readFileSync(path, "utf8");
  const fileEntries: FileEntry[] = parseSessionEntries(content);
  migrateSessionEntries(fileEntries);

  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  for (const fe of fileEntries) {
    if (fe.type === "session") header = fe;
    else entries.push(fe);
  }
  return { header, entries };
}

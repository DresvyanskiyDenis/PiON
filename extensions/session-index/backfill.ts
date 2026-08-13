/**
 * Offline re-index over `SessionManager.listAll()` — the `/index` command's implementation.
 * Read-only over every session file (`session-file.ts`'s `readFileSync`-only contract); the only
 * writes in this whole call are `upsertSession` calls into `index.db`.
 *
 * Two logical passes, one I/O pass: every file is read exactly once (pass 1), building an
 * in-memory `path -> id` map alongside the parsed entries; pass 2 resolves `parent_id` purely
 * from that map, no second disk read. `SessionHeader.parentSession` (despite the name) is a file
 * path, not an id — confirmed against `session-manager.js`: `parentSession: this.persist ?
 * previousSessionFile : undefined` on `/new` and `parentSession: resolvedSourcePath` on fork —
 * so it has to be resolved through the same map that backfill already builds for its own rows.
 */
import type { SessionEntry, SessionHeader, SessionInfo } from "@earendil-works/pi-coding-agent";
import { upsertSession } from "./db.ts";
import { readSessionFile } from "./session-file.ts";
import type { SqliteDatabase } from "./sqlite-runtime.ts";
import { accumulateSessionStats, isUnpricedProvider } from "./usage.ts";

export interface BackfillSkip {
  readonly path: string;
  readonly error: string;
}

export interface BackfillResult {
  readonly indexed: number;
  readonly skipped: readonly BackfillSkip[];
}

interface Parsed {
  readonly id: string;
  readonly header: SessionHeader | null;
  readonly entries: readonly SessionEntry[];
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function backfill(db: SqliteDatabase, sessions: readonly SessionInfo[]): BackfillResult {
  const parsedByPath = new Map<string, Parsed>();
  const skipped: BackfillSkip[] = [];

  // Pass 1: read + parse every file once. A single bad file is skipped, not fatal to the run.
  for (const info of sessions) {
    try {
      const { header, entries } = readSessionFile(info.path);
      parsedByPath.set(info.path, { id: header?.id ?? info.id, header, entries });
    } catch (err) {
      skipped.push({ path: info.path, error: describe(err) });
    }
  }

  const pathToId = new Map<string, string>();
  for (const [path, p] of parsedByPath) pathToId.set(path, p.id);

  let indexed = 0;
  const now = Date.now();
  for (const info of sessions) {
    const parsed = parsedByPath.get(info.path);
    if (!parsed) continue;

    const stats = accumulateSessionStats(parsed.entries);
    const parentPath = parsed.header?.parentSession ?? info.parentSessionPath ?? null;
    const parentId = parentPath ? (pathToId.get(parentPath) ?? null) : null;
    const costKnown = !isUnpricedProvider(stats.provider);

    upsertSession(db, {
      id: parsed.id,
      file: info.path,
      parentId,
      title: info.name ?? null,
      cwd: info.cwd || null,
      branch: null, // see git-probe.ts's module doc — no per-file git probe during backfill
      worktree: false,
      provider: stats.provider,
      model: stats.model,
      startedAt: stats.startedAt ?? info.created.getTime(),
      endedAt: stats.endedAt ?? info.modified.getTime(),
      turns: stats.turns,
      tokensInput: stats.tokensInput,
      tokensOutput: stats.tokensOutput,
      tokensReasoning: stats.tokensReasoning,
      tokensCacheRead: stats.tokensCacheRead,
      tokensCacheWrite: stats.tokensCacheWrite,
      costUsd: costKnown ? stats.costUsd : null,
      costKnown,
      indexedAt: now,
    });
    indexed += 1;
  }

  return { indexed, skipped };
}

/**
 * The crash-safe worktree registry.
 *
 * Every worktree `index.ts` creates for a sub-agent isolation grant is recorded here BEFORE the
 * `git worktree add` that brings it into existence, and dropped only after the matching
 * `git worktree remove` succeeds. That ordering — not a `finally` block — is what survives a
 * `kill -9`: a `finally` never runs on that signal, a file already on disk does.
 *
 * The registry lives next to the repo's own git metadata (`<git-common-dir>/pi-worktrees.json`),
 * scoped per-repo the same way `git worktree list` itself is — not under a global state root,
 * which would mix unrelated repos into one file and one lock.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RegistryEntry {
  readonly id: string;
  readonly path: string;
  readonly repo: string;
  readonly branch: string;
  readonly ownerPid: number;
  readonly toolCallId?: string;
  readonly createdAt: string;
}

type RegistryFile = Record<string, RegistryEntry>;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;

export function registryPath(commonDirAbs: string): string {
  return join(commonDirAbs, "pi-worktrees.json");
}

function isRegistryFile(v: unknown): v is RegistryFile {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function readRegistry(path: string): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRegistryFile(parsed) ? parsed : {};
  } catch {
    // Missing file, unreadable, or corrupt JSON: treated as empty. A bad registry must not
    // permanently disable cleanup — the alternative (throwing) would make one bad write
    // un-sweepable forever.
    return {};
  }
}

async function writeRegistryAtomic(path: string, data: RegistryFile): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

/**
 * A directory-`mkdir` mutex around the read-modify-write window. Two `pi` sessions in the same
 * repo can legitimately sweep or record at the same moment; without this a lost update could
 * drop an entry that was in fact still in use.
 */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${path}.lock`;
  await mkdir(join(lockDir, ".."), { recursive: true }).catch(() => {});
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        // Held this long is a crashed holder, not real contention — a stuck lock must never
        // permanently disable cleanup. Reclaim and retry once more.
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Records `entry` BEFORE the caller creates the worktree on disk. */
export async function record(path: string, entry: RegistryEntry): Promise<void> {
  await withLock(path, async () => {
    const reg = await readRegistry(path);
    reg[entry.id] = entry;
    await writeRegistryAtomic(path, reg);
  });
}

/** No-op if `id` is already absent. */
export async function drop(path: string, id: string): Promise<void> {
  await withLock(path, async () => {
    const reg = await readRegistry(path);
    if (id in reg) {
      delete reg[id];
      await writeRegistryAtomic(path, reg);
    }
  });
}

export async function all(path: string): Promise<RegistryEntry[]> {
  return Object.values(await readRegistry(path));
}

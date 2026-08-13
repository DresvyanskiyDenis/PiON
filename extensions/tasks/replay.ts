/**
 * EXT-22 — task-list glue: a minimal, dependency-free reader for
 * `@juicesharp/rpiv-todo`'s persisted `todo` tool-result envelope.
 *
 * **VP-07 (was V-10) correction, binding on this whole module tree**: the package has NO
 * filesystem persistence at all. Its `state/` module (`state/store.ts`) is an in-memory `Map`
 * keyed by session id; durability comes entirely from replaying the LAST `todo` toolResult on the
 * session branch (`docs/PACKAGES.md` "VP-07: transcript replay, no disk"; `state/replay.ts` in the
 * installed package). That covers `/reload` and compaction — which is what `REQ-CTX-70` actually
 * asks for — but NOT a new session: there is nothing written to disk to read across a process
 * boundary. Nothing in this tree assumes a `.pi/TODO.md` file or any other on-disk task list.
 *
 * This module re-derives that same last-write-wins read directly against the tool-result shape,
 * instead of importing the package's own `state/store.ts` / `state/replay.ts`. Those files ship in
 * the npm "files" allowlist (a deep import would resolve) but are not documented as public API and
 * carry no compatibility promise — `getRenderState()` in particular is scoped to whichever session
 * the package's OWN overlay considers "foreground", not to an arbitrary caller's session. The
 * `TaskDetails` envelope (`{ tasks, nextId }` under a resolved `todo` toolResult's `details`) is
 * different: the package's own `tool/types.ts` doc comment says its "field order and field names
 * are pinned by cross-version replay compatibility" — that is the stable integration point.
 *
 * Deliberately free of any `@earendil-works/pi-*` import — mirrors the package's own
 * `state/replay.ts`, which keeps `state/` PI-import-free for the same reason: this is trivially
 * unit-testable against a plain fixture, no jiti and no `ExtensionContext` mock required.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

const TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "pending",
  "in_progress",
  "completed",
  "deleted",
]);

export interface Task {
  readonly id: number;
  readonly subject: string;
  readonly status: TaskStatus;
}

/** Structural shape of `@earendil-works/pi-ai`'s `ToolResultMessage` — only the fields we read. */
export interface ToolResultLike {
  readonly toolName: string;
  readonly isError: boolean;
  readonly details?: unknown;
}

const TODO_TOOL_NAME = "todo";

function isTaskLike(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const t = value as { id?: unknown; subject?: unknown; status?: unknown };
  return (
    typeof t.id === "number" &&
    typeof t.subject === "string" &&
    typeof t.status === "string" &&
    TASK_STATUSES.has(t.status)
  );
}

function isTaskDetailsLike(value: unknown): value is { tasks: Task[] } {
  if (!value || typeof value !== "object") return false;
  const tasks = (value as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) && tasks.every(isTaskLike);
}

/** The `todo` tool's task array from one toolResult, or `undefined` when it isn't a match. */
function todoTasksFrom(msg: ToolResultLike): Task[] | undefined {
  if (msg.toolName !== TODO_TOOL_NAME || msg.isError) return undefined;
  return isTaskDetailsLike(msg.details) ? msg.details.tasks : undefined;
}

/**
 * Last-write-wins scan over an ordered list of toolResults (a single turn's `toolResults`, or a
 * branch mapped down to its toolResult messages). `undefined` when none of them is a successful
 * `todo` call — the caller decides what "no update this turn" means for its own cache.
 */
export function lastTodoTasks(toolResults: readonly ToolResultLike[]): Task[] | undefined {
  let result: Task[] | undefined;
  for (const msg of toolResults) {
    const tasks = todoTasksFrom(msg);
    if (tasks) result = tasks;
  }
  return result;
}

/**
 * Full-branch replay: same last-write-wins rule, walking the branch from its start. Used to
 * (re)prime a session's cache at `session_start` / `session_compact` / `session_tree` — the three
 * points a branch's identity can change under us, the same three events the installed package's
 * own `index.ts` re-derives its state from. Returns `[]` when no `todo` call is on the branch yet.
 *
 * Takes a bare `{ getBranch(): Iterable<unknown> }` rather than PI's `ReadonlySessionManager` type,
 * for the same PI-import-free reason as the rest of this module.
 */
export function replayTasksFromBranch(sessionManager: { getBranch(): Iterable<unknown> }): Task[] {
  const toolResults: ToolResultLike[] = [];
  for (const raw of sessionManager.getBranch()) {
    const entry = raw as { type?: unknown; message?: unknown };
    if (entry.type !== "message") continue;
    const msg = entry.message as
      | { role?: unknown; toolName?: unknown; isError?: unknown; details?: unknown }
      | undefined;
    if (!msg || msg.role !== "toolResult") continue;
    if (typeof msg.toolName !== "string" || typeof msg.isError !== "boolean") continue;
    toolResults.push(msg as ToolResultLike);
  }
  return lastTodoTasks(toolResults) ?? [];
}

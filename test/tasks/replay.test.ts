import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastTodoTasks, replayTasksFromBranch, type ToolResultLike } from "../../extensions/tasks/replay.ts";

function todoResult(tasks: unknown, overrides: Partial<ToolResultLike> = {}): ToolResultLike {
  return { toolName: "todo", isError: false, details: { tasks, nextId: 99 }, ...overrides };
}

function branchEntry(message: unknown) {
  return { type: "message", message };
}

/** `replayTasksFromBranch` reads real `SessionEntry` shapes, which carry `role: "toolResult"`. */
function todoBranchEntry(tasks: unknown, overrides: Partial<ToolResultLike> = {}) {
  return branchEntry({ role: "toolResult", ...todoResult(tasks, overrides) });
}

describe("lastTodoTasks", () => {
  it("returns undefined when no toolResult is a todo call", () => {
    const results: ToolResultLike[] = [
      { toolName: "bash", isError: false, details: { exitCode: 0 } },
      { toolName: "read", isError: false, details: {} },
    ];
    assert.equal(lastTodoTasks(results), undefined);
  });

  it("extracts the tasks array from a resolved todo call", () => {
    const tasks = [{ id: 1, subject: "alpha", status: "pending" }];
    const results: ToolResultLike[] = [todoResult(tasks)];
    assert.deepEqual(lastTodoTasks(results), tasks);
  });

  it("last-write-wins across multiple todo calls in the same list", () => {
    const first = [{ id: 1, subject: "alpha", status: "pending" }];
    const second = [
      { id: 1, subject: "alpha", status: "in_progress" },
      { id: 2, subject: "beta", status: "pending" },
    ];
    const results: ToolResultLike[] = [
      todoResult(first),
      { toolName: "bash", isError: false },
      todoResult(second),
    ];
    assert.deepEqual(lastTodoTasks(results), second);
  });

  it("ignores an errored todo call", () => {
    const tasks = [{ id: 1, subject: "alpha", status: "pending" }];
    const results: ToolResultLike[] = [todoResult(tasks, { isError: true })];
    assert.equal(lastTodoTasks(results), undefined);
  });

  it("ignores a todo result whose details do not match the pinned envelope", () => {
    const results: ToolResultLike[] = [
      { toolName: "todo", isError: false, details: { notTasks: true } },
      { toolName: "todo", isError: false, details: undefined },
      { toolName: "todo", isError: false, details: { tasks: [{ id: "not-a-number", subject: "x", status: "pending" }] } },
    ];
    assert.equal(lastTodoTasks(results), undefined);
  });

  it("rejects a task with an unknown status", () => {
    const results: ToolResultLike[] = [
      todoResult([{ id: 1, subject: "alpha", status: "archived" }]),
    ];
    assert.equal(lastTodoTasks(results), undefined);
  });
});

describe("replayTasksFromBranch", () => {
  it("returns [] on an empty branch", () => {
    assert.deepEqual(replayTasksFromBranch({ getBranch: () => [] }), []);
  });

  it("walks the branch and applies last-write-wins", () => {
    const tasksA = [{ id: 1, subject: "alpha", status: "pending" }];
    const tasksB = [{ id: 1, subject: "alpha", status: "completed" }];
    const branch = [
      branchEntry({ role: "userMessage", content: "hi" }),
      todoBranchEntry(tasksA),
      branchEntry({ role: "assistantMessage", content: "ok" }),
      todoBranchEntry(tasksB),
    ];
    assert.deepEqual(replayTasksFromBranch({ getBranch: () => branch }), tasksB);
  });

  it("skips non-message entries and non-toolResult messages", () => {
    const tasks = [{ id: 1, subject: "alpha", status: "pending" }];
    const branch = [
      { type: "compaction", summary: "…" },
      branchEntry({ role: "custom", customType: "task_reminder", content: "…" }),
      todoBranchEntry(tasks),
    ];
    assert.deepEqual(replayTasksFromBranch({ getBranch: () => branch }), tasks);
  });

  it("accepts any Iterable, not only an array", () => {
    const tasks = [{ id: 1, subject: "alpha", status: "pending" }];
    function* gen() {
      yield todoBranchEntry(tasks);
    }
    assert.deepEqual(replayTasksFromBranch({ getBranch: () => gen() }), tasks);
  });
});

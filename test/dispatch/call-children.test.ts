import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchChildren, distinctAgents } from "../../extensions/dispatch/call-children.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-children-"));
}

describe("dispatchChildren: which children a call actually launches", () => {
  it("calls a single-agent dispatch `single` and leaves its agent to the caller", () => {
    // `index.ts` resolves the top-level name through AGENT_KEYS for model routing already; this
    // module deliberately does not carry a second copy of that key list.
    const shape = dispatchChildren({ agent: "surgeon", task: "refactor" }, "/repo");
    assert.equal(shape.shape, "single");
    assert.deepEqual(shape.children, []);
  });

  it("launches nothing for a management or control action", () => {
    for (const action of ["status", "stop", "children.list"]) {
      assert.equal(dispatchChildren({ action, id: "run-1" }, "/repo").shape, "none");
    }
  });

  /** `action: "validate"` compiles a workflowScript offline. Compiling it must create no worktree. */
  it("launches nothing for action: validate, workflowScript and all", () => {
    const shape = dispatchChildren(
      { action: "validate", workflowScript: `return runs.run('main', {agent: 'surgeon', task: 'x'})` },
      "/repo",
    );
    assert.equal(shape.shape, "none");
    assert.deepEqual(shape.children, []);
  });

  it("reads every agent a workflowScript names, in order, with where it was named", () => {
    const shape = dispatchChildren(
      {
        workflowScript: [
          `const scouted = await runs.run('scout', {agent: "scout", task: 'read'});`,
          `const reviews = await runs.all([{key: 'a', agent: 'surgeon', task: 'edit'},`,
          `  {key: 'b', agent: "reviewer", task: 'review'}]);`,
          `return reviews;`,
        ].join("\n"),
      },
      "/repo",
    );
    assert.equal(shape.shape, "children");
    assert.deepEqual(shape.children.map((c) => c.agent), ["scout", "surgeon", "reviewer"]);
    assert.match(shape.children[1]!.where, /workflowScript child 2 \(agent: "surgeon"\)/);
  });

  it("does not mistake an identifier that merely ends in `agent` for a child", () => {
    const shape = dispatchChildren(
      { workflowScript: `const myAgent: 'x'; const o = {}; o.agent: 'y'; return runs.run('m', {agent: 'scout'})` },
      "/repo",
    );
    assert.deepEqual(shape.children.map((c) => c.agent), ["scout"]);
  });

  /**
   * The residue, pinned rather than hidden: a name that only exists at run time is invisible from
   * out here. The scan is a lower bound on the children, and the docstring says so — a test that
   * asserted otherwise would be asserting a guarantee this seam cannot make.
   */
  it("cannot see an agent name the script computes, and says nothing false about it", () => {
    const shape = dispatchChildren(
      { workflowScript: `const pick = (i) => i ? 'surgeon' : 'scout'; return runs.run('m', {agent: pick(1)})` },
      "/repo",
    );
    assert.equal(shape.shape, "children");
    assert.deepEqual(shape.children, []);
  });

  it("reads a workflowScriptPath off disk, resolved against the session cwd", () => {
    const dir = scratch();
    writeFileSync(join(dir, "flow.js"), `return runs.run('main', {agent: 'surgeon', task: 'edit'})`, "utf8");
    const shape = dispatchChildren({ workflowScriptPath: "flow.js" }, dir);
    assert.deepEqual(shape.children.map((c) => c.agent), ["surgeon"]);
    assert.equal(shape.unreadable, undefined);
  });

  it("reports an unreadable workflowScriptPath instead of reading it as `no children`", () => {
    const shape = dispatchChildren({ workflowScriptPath: "nope.js" }, scratch());
    assert.equal(shape.shape, "children");
    assert.deepEqual(shape.children, []);
    assert.match(shape.unreadable ?? "", /nope\.js could not be read/);
    assert.match(shape.unreadable ?? "", /isolation: worktree.* cannot be honoured/);
  });

  it("reads a fanout's per-entry agents", () => {
    const shape = dispatchChildren(
      { tasks: [{ agent: "surgeon", task: "edit" }, { agent: "scout", task: "read" }] },
      "/repo",
    );
    assert.equal(shape.shape, "children");
    assert.deepEqual(shape.children.map((c) => c.agent), ["surgeon", "scout"]);
    assert.equal(shape.children[0]!.where, "tasks[0]");
  });

  it("reads a chain's steps and the fanout a step nests inside itself", () => {
    const shape = dispatchChildren(
      {
        chain: [
          { agent: "scout", task: "read" },
          { parallel: [{ agent: "surgeon", task: "edit" }, { agent: "reviewer", task: "review" }] },
          // A dynamic fanout: `parallel` is the single child template every expanded child runs.
          { expand: { from: { output: "found", path: "/items" } }, parallel: { agent: "surgeon" } },
        ],
      },
      "/repo",
    );
    assert.deepEqual(shape.children.map((c) => c.agent), ["scout", "surgeon", "reviewer", "surgeon"]);
    assert.deepEqual(shape.children.map((c) => c.where), [
      "chain[0]",
      "chain[1].parallel[0]",
      "chain[1].parallel[1]",
      "chain[2].parallel",
    ]);
  });

  it("collapses repeated names once, in the order the call names them", () => {
    const shape = dispatchChildren(
      { tasks: [{ agent: "surgeon" }, { agent: "scout" }, { agent: "surgeon" }] },
      "/repo",
    );
    assert.deepEqual(distinctAgents(shape.children), ["surgeon", "scout"]);
  });

  it("ignores entries that name no agent rather than inventing one", () => {
    const shape = dispatchChildren({ tasks: [{ task: "edit" }, { agent: "   " }, "not-an-object", null] }, "/repo");
    assert.equal(shape.shape, "children");
    assert.deepEqual(shape.children, []);
  });
});

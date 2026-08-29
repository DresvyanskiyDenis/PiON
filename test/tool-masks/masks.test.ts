// The mask table on its own: no `pi`, no session, no TUI. What `/review` leaves the model holding
// is the whole point of the feature, so it is asserted as a value here rather than inferred from
// the behaviour of the module that applies it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMaskName,
  MASK_NAMES,
  MASKS,
  maskTools,
  READING_TOOLS,
  strictness,
  WEB_TOOLS,
} from "../../extensions/tool-masks/masks.ts";

/** A realistic full set for this install: PI's seven built-ins plus what this tree registers. */
const FULL = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "expand_result",
  "ask_user",
  "web_search",
  "web_fetch",
  "web_answer",
  "job",
  "teammate",
  "message_agent",
];

describe("tool-masks: the mask table", () => {
  it("names exactly the two masks the commands offer", () => {
    assert.deepEqual([...MASK_NAMES], ["review", "explore"]);
    assert.deepEqual(Object.keys(MASKS).sort(), ["explore", "review"]);
  });

  it("drops write, edit and bash under `review`", () => {
    const left = maskTools(FULL, "review");
    for (const tool of ["write", "edit", "bash"]) assert.ok(!left.includes(tool), `${tool} survived`);
  });

  it("keeps read and grep under `review`", () => {
    const left = maskTools(FULL, "review");
    for (const tool of ["read", "grep", "find", "ls"]) assert.ok(left.includes(tool), `${tool} was dropped`);
  });

  it("drops the web tools under `review` and keeps them under `explore`", () => {
    const review = maskTools(FULL, "review");
    const explore = maskTools(FULL, "explore");
    for (const tool of WEB_TOOLS) {
      assert.ok(!review.includes(tool), `${tool} survived /review`);
      assert.ok(explore.includes(tool), `${tool} was dropped by /explore`);
    }
  });

  it("keeps `explore` read-only: it adds web to `review` and nothing else", () => {
    assert.deepEqual(
      maskTools(FULL, "explore"),
      [...maskTools(FULL, "review"), ...WEB_TOOLS].filter((t) => FULL.includes(t)),
    );
    for (const tool of ["write", "edit", "bash"]) {
      assert.ok(!maskTools(FULL, "explore").includes(tool), `${tool} survived /explore`);
    }
  });

  it("masks out a tool nobody classified, rather than letting it through", () => {
    // The registry is open (MCP proxies, packages, this tree's own `registerTool`). An allow-list
    // is what makes an unknown name fail closed; this is the assertion that keeps it one.
    for (const mask of MASK_NAMES) {
      assert.ok(!maskTools([...FULL, "mcp_jira_create_issue"], mask).includes("mcp_jira_create_issue"));
    }
  });

  it("only ever narrows: nothing is activated that was not in the baseline", () => {
    for (const mask of MASK_NAMES) {
      // `read` is in every mask's allow list, but not in this baseline.
      assert.deepEqual(maskTools(["grep"], mask), ["grep"]);
    }
  });

  it("preserves the baseline's order, so restoring is a stable operation", () => {
    const reversed = [...READING_TOOLS].reverse();
    assert.deepEqual(maskTools(reversed, "review"), reversed);
  });

  it("ranks `review` as stricter than `explore`", () => {
    assert.ok(strictness("review") < strictness("explore"));
  });

  it("accepts only the two mask names", () => {
    assert.ok(isMaskName("review"));
    assert.ok(isMaskName("explore"));
    for (const bad of ["Review", "ship", "", null, undefined, 7]) assert.ok(!isMaskName(bad));
  });
});

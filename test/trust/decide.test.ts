/**
 * `EXT-30` — the `project_trust` decision itself (`REQ-PRV-58`, audit finding 29).
 *
 * Three invariants, and the third is the one a future "simplification" will break: the handler
 * must never answer `"no"`. `"no"` suppresses PI's own trust prompt, converting a question the
 * operator was supposed to answer into a silent refusal.
 */
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { decideTrust } from "../../extensions/trust.ts";

const ROOTS = [join(sep, "srv", "declared"), join(sep, "srv", "other")];

describe("decideTrust", () => {
  it("answers yes inside a declared root", () => {
    assert.deepEqual(decideTrust(join(ROOTS[0]!, "repo"), ROOTS), {
      trusted: "yes",
      remember: false,
    });
  });

  it("answers yes at the root itself", () => {
    assert.deepEqual(decideTrust(ROOTS[0]!, ROOTS), { trusted: "yes", remember: false });
  });

  it("never remembers a yes — the repo stays the source of truth", () => {
    const result = decideTrust(join(ROOTS[1]!, "deep", "nested"), ROOTS);
    assert.equal(result.trusted, "yes");
    assert.equal(result.remember, false, "a remembered yes outlives the root list that justified it");
  });

  it("answers undecided outside every declared root", () => {
    assert.deepEqual(decideTrust(join(sep, "srv", "elsewhere"), ROOTS), { trusted: "undecided" });
  });

  it("does not match a sibling that merely shares a prefix", () => {
    assert.deepEqual(decideTrust(`${ROOTS[0]!}-evil`, ROOTS), { trusted: "undecided" });
  });

  it("answers undecided when the root list is empty — never a blanket yes", () => {
    assert.deepEqual(decideTrust(join(sep, "srv", "declared", "repo"), []), { trusted: "undecided" });
    assert.deepEqual(decideTrust(sep, []), { trusted: "undecided" });
  });

  it("never answers no, for any cwd", () => {
    const cwds = [
      sep,
      join(sep, "srv"),
      join(sep, "srv", "declared"),
      join(sep, "srv", "declared", "repo"),
      join(sep, "tmp", "freshly-cloned-third-party-repo"),
      "",
      "relative/path",
    ];
    for (const cwd of cwds) {
      for (const roots of [ROOTS, []]) {
        assert.notEqual(decideTrust(cwd, roots).trusted, "no", `${cwd} with ${roots.length} roots`);
      }
    }
  });
});

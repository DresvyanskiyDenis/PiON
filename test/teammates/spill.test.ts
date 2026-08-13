import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spillReport } from "../../extensions/teammates/spill.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pi-teammates-"));
}

describe("spillReport", () => {
  it("returns a small report untouched and writes nothing", async () => {
    const dir = await scratch();
    const result = await spillReport("s1", "reviewer", "short report", { dir });
    assert.equal(result.text, "short report");
    assert.equal(result.truncated, false);
    assert.equal(result.file, undefined);
  });

  it("writes the FULL report to disk and names the file in the truncated view", async () => {
    const dir = await scratch();
    const report = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const result = await spillReport("s1", "reviewer", report, { dir, maxLines: 10, now: 0 });

    assert.equal(result.truncated, true);
    assert.ok(result.file, "an oversized report must be written out, not just cut");
    assert.match(result.text, /report truncated at 10\/500 lines/);
    assert.ok(result.text.includes(result.file!), "the overflow file must be named in the text");
    assert.equal(await readFile(result.file!, "utf8"), report, "nothing is lost on disk");
  });

  it("keeps the head, because a report's structure is at the top", async () => {
    const dir = await scratch();
    const report = ["# Findings", "1. first", "2. second", "3. third"].join("\n");
    const result = await spillReport("s1", "reviewer", report, { dir, maxLines: 2, now: 0 });
    assert.match(result.text, /^# Findings\n1\. first/);
  });

  it("names the file after the teammate, so two deliveries in one turn do not collide", async () => {
    const dir = await scratch();
    const long = "x".repeat(200);
    const a = await spillReport("s1", "reviewer", long, { dir, maxBytes: 10, now: 0 });
    const b = await spillReport("s1", "researcher", long, { dir, maxBytes: 10, now: 0 });
    assert.notEqual(a.file, b.file);
    assert.match(a.file!, /reviewer-/);
    assert.match(b.file!, /researcher-/);
  });
});

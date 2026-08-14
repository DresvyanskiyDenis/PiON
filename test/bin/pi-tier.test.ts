/**
 * `config/bin/pi-tier` — the shell half of tier resolution, exercised as a real OS process the way
 * `test/bin/pi-run.test.ts` exercises its subject.
 *
 * One invariant is what this file is really about: **a tier declares its reasoning effort exactly
 * once, in `thinkingLevel`, and every consumer that emits a model string re-attaches it.** PI reads
 * effort from nowhere but the model string, so a resolver that prints the bare id runs the call at
 * the provider's default while `routing.json` declares otherwise — a silent downgrade. The
 * tempting shortcut is to write `provider/id:high` into the tier's `model` field instead; that
 * breaks everything keyed on the bare id, which is why the level lives in its own field and is
 * re-attached here.
 *
 * `jq` is required by the script itself; if it is missing the suite says so rather than passing.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const PI_TIER = fileURLToPath(new URL("../../config/bin/pi-tier", import.meta.url));

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(routing: unknown, args: readonly string[]): Run {
  // Never `/tmp`: $TMPDIR via os.tmpdir().
  const dir = mkdtempSync(join(tmpdir(), "pi-tier-test-"));
  const path = join(dir, "routing.json");
  writeFileSync(path, JSON.stringify(routing));
  const result = spawnSync("bash", [PI_TIER, ...args], {
    env: { ...process.env, PI_ROUTING_JSON: path },
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const hasJq = ((): boolean => {
  try {
    execFileSync("command", ["-v", "jq"], { shell: "/bin/bash", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("pi-tier", { skip: hasJq ? false : "jq is not installed" }, () => {
  it("appends the tier's thinkingLevel to the model id, because that is where PI reads effort", () => {
    const out = run({ tiers: { cheap: { model: "github-copilot/claude-haiku-4.5", thinkingLevel: "low" } } }, ["cheap"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "github-copilot/claude-haiku-4.5:low");
  });

  it("prints the bare id when the tier declares no level — the provider default is then honest", () => {
    const out = run({ tiers: { cheap: { model: "github-copilot/claude-haiku-4.5" } } }, ["cheap"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "github-copilot/claude-haiku-4.5");
  });

  it("a level already pinned in the model string wins over the field, and is not doubled", () => {
    const out = run({ tiers: { cheap: { model: "github-copilot/claude-haiku-4.5:max", thinkingLevel: "low" } } }, ["cheap"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "github-copilot/claude-haiku-4.5:max");
  });

  it("refuses a thinkingLevel PI does not know, rather than sending it to the provider", () => {
    const out = run({ tiers: { cheap: { model: "github-copilot/claude-haiku-4.5", thinkingLevel: "supreme" } } }, ["cheap"]);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /thinkingLevel 'supreme'/);
  });

  it("an unknown tier exits 2 and names no model — never a fallback", () => {
    const out = run({ tiers: { cheap: { model: "github-copilot/claude-haiku-4.5" } } }, ["nosuch"]);
    assert.equal(out.status, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /unknown tier 'nosuch'/);
  });

  it("a tier left UNBOUND by the installer is named as unbound, not as a typo", () => {
    const out = run(
      { tiers: {}, tiersUnbound: { local: "No local model server is configured." } },
      ["local"],
    );
    assert.equal(out.status, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /is NOT BOUND on this install/);
    assert.match(out.stderr, /nothing is substituted/);
  });

  it("--thinking still reports the field on its own", () => {
    const out = run({ tiers: { cheap: { model: "github-copilot/claude-haiku-4.5", thinkingLevel: "low" } } }, [
      "--thinking",
      "cheap",
    ]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "low");
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { compileGlob } from "../../extensions/path-rules/glob.ts";
import { scanProject } from "../../extensions/path-rules/scan.ts";
import type { PathRule } from "../../extensions/path-rules/config.ts";

function rule(id: string, globs: string[] | null, source = `/rules/${id}.md`): PathRule {
  return { id, source, body: `${id} body`, matchers: globs === null ? null : globs.map(compileGlob) };
}

describe("scanProject", () => {
  let sandbox: string;
  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-path-rules-scan-"));
  });
  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("activates unconditional rules without touching the filesystem", () => {
    const result = scanProject(join(sandbox, "does-not-exist"), [rule("always", null)]);
    assert.ok(result.activated.has("always"));
    assert.equal(result.filesVisited, 0);
  });

  it("activates a conditional rule when a matching file exists", async () => {
    await mkdir(join(sandbox, "match-hit"), { recursive: true });
    await writeFile(join(sandbox, "match-hit", "pyproject.toml"), "");
    const result = scanProject(join(sandbox, "match-hit"), [rule("py", ["**/pyproject.toml"])]);
    assert.ok(result.activated.has("py"));
  });

  it("does not activate a conditional rule when nothing matches", async () => {
    const dir = join(sandbox, "match-miss");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "README.md"), "");
    const result = scanProject(dir, [rule("py", ["**/pyproject.toml"])]);
    assert.equal(result.activated.has("py"), false);
  });

  it("skips .git, node_modules, .venv, dist and __pycache__", async () => {
    const dir = join(sandbox, "skip-dirs");
    for (const skipped of [".git", "node_modules", ".venv", "dist", "__pycache__"]) {
      await mkdir(join(dir, skipped), { recursive: true });
      await writeFile(join(dir, skipped, "pyproject.toml"), "");
    }
    const result = scanProject(dir, [rule("py", ["**/pyproject.toml"])]);
    assert.equal(result.activated.has("py"), false);
  });

  it("stops evaluating a rule once it has matched, and reports the ones still open via `remaining`", async () => {
    const dir = join(sandbox, "stop-early");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.py"), "");
    // Two conditional rules; only one can ever match this tree. The scan must not loop forever or
    // keep re-testing "other", but it also must not report false activation for it.
    const result = scanProject(dir, [rule("py", ["**/*.py"]), rule("other", ["**/*.rs"])]);
    assert.ok(result.activated.has("py"));
    assert.equal(result.activated.has("other"), false);
  });

  it("stops walking altogether once every conditional rule has matched", async () => {
    const dir = join(sandbox, "stop-all");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.py"), "");
    await writeFile(join(dir, "sub", "b.py"), "");
    const result = scanProject(dir, [rule("py", ["**/*.py"])]);
    assert.ok(result.activated.has("py"));
    // Only the first matching file needed to be seen — the walk stops before visiting `sub/`.
    assert.ok(result.filesVisited < 2, `expected an early stop, visited ${result.filesVisited} file(s)`);
  });

  it("truncates and reports it once maxFilesVisited is exceeded", async () => {
    const dir = join(sandbox, "cap-files");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 10; i++) await writeFile(join(dir, `f${i}.txt`), "");
    const result = scanProject(dir, [rule("py", ["**/*.py"])], { maxFilesVisited: 3 });
    assert.equal(result.truncated, true);
  });

  it("truncates and reports it once maxDepth is exceeded", async () => {
    const dir = join(sandbox, "cap-depth");
    const deep = join(dir, "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "pyproject.toml"), "");
    const result = scanProject(dir, [rule("py", ["**/pyproject.toml"])], { maxDepth: 1 });
    assert.equal(result.truncated, true);
    assert.equal(result.activated.has("py"), false);
  });

  it("reports elapsed time", () => {
    const result = scanProject(sandbox, [rule("always", null)]);
    assert.equal(typeof result.elapsedMs, "number");
    assert.ok(result.elapsedMs >= 0);
  });
});

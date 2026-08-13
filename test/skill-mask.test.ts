import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register, resolvePrivateRoot, resolveWorkRoot } from "../extensions/skill-mask.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";

const REPO_KEY = "PI_CONFIG_REPO";

/** Captures the `resources_discover` handler the module registers. */
function fakePi(): { pi: ExtensionAPI; fire: (event: unknown) => unknown } {
  let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const pi = {
    on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "resources_discover") handler = h;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fire: (event: unknown) => {
      if (!handler) throw new Error("resources_discover handler was never registered");
      return handler(event, { hasUI: false });
    },
  };
}

/** Swallows and returns everything written to stderr while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T> | T): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    process.stderr.write = original;
  }
}

describe("skill-mask: root resolvers", () => {
  let dir: string;
  const originalRepo = process.env[REPO_KEY];

  afterEach(() => {
    if (originalRepo === undefined) delete process.env[REPO_KEY];
    else process.env[REPO_KEY] = originalRepo;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("return undefined when the directories do not exist under the repo root", () => {
    dir = mkdtempSync(join(tmpdir(), "skill-mask-test-"));
    process.env[REPO_KEY] = dir;
    assert.equal(resolveWorkRoot(), undefined);
    assert.equal(resolvePrivateRoot(), undefined);
  });

  it("return the paths when the directories exist", () => {
    dir = mkdtempSync(join(tmpdir(), "skill-mask-test-"));
    mkdirSync(join(dir, "skills-work"));
    mkdirSync(join(dir, "skills-private"));
    process.env[REPO_KEY] = dir;
    assert.equal(resolveWorkRoot(), join(dir, "skills-work"));
    assert.equal(resolvePrivateRoot(), join(dir, "skills-private"));
  });
});

describe("skill-mask: register + resources_discover end-to-end", () => {
  let dir: string;
  const originalRepo = process.env[REPO_KEY];

  before(() => resetSurfaced());
  afterEach(() => {
    if (originalRepo === undefined) delete process.env[REPO_KEY];
    else process.env[REPO_KEY] = originalRepo;
    if (dir) rmSync(dir, { recursive: true, force: true });
    resetSurfaced();
  });

  // Every case below points REPO_KEY at a temp dir on purpose. Without it `repoRoot()` resolves to
  // the real checkout, which HAS both directories, and "contributes nothing" would be testing the
  // owner's filesystem rather than the branch under test.
  function tempRepo(...subdirs: string[]): string {
    dir = mkdtempSync(join(tmpdir(), "skill-mask-test-"));
    for (const sub of subdirs) mkdirSync(join(dir, sub));
    process.env[REPO_KEY] = dir;
    return dir;
  }

  const discover = (cwd?: unknown) => ({ type: "resources_discover", cwd, reason: "startup" });

  it("contributes both roots, private first, when both directories exist", async () => {
    tempRepo("skills-private", "skills-work");
    const { pi, fire } = fakePi();
    register(pi);
    const result = await fire(discover("/repos/anywhere"));
    assert.deepEqual(result, { skillPaths: [join(dir, "skills-private"), join(dir, "skills-work")] });
  });

  it("contributes only skills-private/ when skills-work/ is absent", async () => {
    tempRepo("skills-private");
    const { pi, fire } = fakePi();
    register(pi);
    const result = await fire(discover("/repos/anywhere"));
    assert.deepEqual(result, { skillPaths: [join(dir, "skills-private")] });
  });

  it("contributes only skills-work/ when skills-private/ is absent", async () => {
    tempRepo("skills-work");
    const { pi, fire } = fakePi();
    register(pi);
    const result = await fire(discover("/repos/anywhere"));
    assert.deepEqual(result, { skillPaths: [join(dir, "skills-work")] });
  });

  it("contributes nothing when neither directory exists (the fresh-clone case)", async () => {
    tempRepo();
    const { pi, fire } = fakePi();
    register(pi);
    const result = await fire(discover("/repos/anywhere"));
    assert.equal(result, undefined);
  });

  it("ignores cwd entirely — any value, including one that throws, yields the same roots", async () => {
    tempRepo("skills-private", "skills-work");
    const expected = { skillPaths: [join(dir, "skills-private"), join(dir, "skills-work")] };
    const { pi, fire } = fakePi();
    register(pi);

    // The first two used to be the "work prefix matched" / "did not match" branches; the third was
    // the missing-cwd guard. All three are now the same code path.
    assert.deepEqual(await fire(discover("/repos/work/sub")), expected);
    assert.deepEqual(await fire(discover("/repos/personal")), expected);
    assert.deepEqual(await fire(discover(null)), expected);

    const poisoned = {
      type: "resources_discover",
      reason: "startup",
      get cwd(): string {
        throw new Error("cwd must never be read");
      },
    };
    const { value, lines } = await captureStderr(() => fire(poisoned));
    assert.deepEqual(value, expected);
    assert.equal(lines.length, 0);
  });

  it("fails open and surfaces the error once when resolving a root throws", async () => {
    const { pi, fire } = fakePi();
    register(pi);

    // `repoRoot()` reads `process.env.PI_CONFIG_REPO`; `process.env` rejects accessor descriptors,
    // so the whole object is swapped for a copy whose getter throws, then restored.
    const originalEnv = process.env;
    const poisonedEnv = { ...process.env };
    Object.defineProperty(poisonedEnv, REPO_KEY, {
      get(): string {
        throw new Error("boom");
      },
      configurable: true,
    });
    process.env = poisonedEnv;
    try {
      const { value, lines } = await captureStderr(() => fire(discover("/repos/anywhere")));
      assert.equal(value, undefined);
      assert.ok(lines.some((l) => l.includes("skill-mask: resources_discover handler failed") && l.includes("boom")));

      const { lines: secondLines } = await captureStderr(() => fire(discover("/repos/anywhere")));
      assert.ok(!secondLines.some((l) => l.includes("skill-mask")));
    } finally {
      process.env = originalEnv;
    }
  });
});

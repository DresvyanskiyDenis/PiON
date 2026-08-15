import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PathDefaultsShapeError, loadPathDefaults, validatePathDefaults } from "../../extensions/path-defaults/config.ts";

function grab(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

const VALID = {
  version: 1,
  tier: "strong",
  egress: { web: "allow", mcp: "allow", publicModels: "allow" },
};

describe("validatePathDefaults — shape", () => {
  it("accepts a well-formed file", () => {
    const parsed = validatePathDefaults(VALID, "<inline>");
    assert.equal(parsed.tier, "strong");
    assert.deepEqual(parsed.egress, { web: "allow", mcp: "allow", publicModels: "allow" });
  });

  it("rejects a non-object value", () => {
    const err = grab(() => validatePathDefaults(null, "<inline>"));
    assert.ok(err instanceof PathDefaultsShapeError);
    assert.match(err.message, /must be a JSON object/);

    assert.match(grab(() => validatePathDefaults([1, 2], "<inline>")).message, /must be a JSON object/);
    assert.match(grab(() => validatePathDefaults("nope", "<inline>")).message, /must be a JSON object/);
  });

  it("rejects a version other than 1", () => {
    const err = grab(() => validatePathDefaults({ ...VALID, version: 2 }, "<inline>"));
    assert.match(err.message, /"version" must be 1/);
  });

  it("rejects a missing or empty tier", () => {
    const bad = { version: 1, egress: { web: "allow", mcp: "allow", publicModels: "allow" } };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /"tier" must be a non-empty string/);
  });

  it("rejects a non-string tier", () => {
    const bad = { version: 1, tier: 5, egress: { web: "allow", mcp: "allow", publicModels: "allow" } };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /"tier" must be a non-empty string/);
  });

  it("rejects a malformed egress object", () => {
    assert.match(
      grab(() => validatePathDefaults({ version: 1, tier: "fast" }, "<inline>")).message,
      /"egress" must be an object/,
    );
    assert.match(
      grab(() =>
        validatePathDefaults(
          { version: 1, tier: "fast", egress: { web: "sometimes", mcp: "allow", publicModels: "allow" } },
          "<inline>",
        ),
      ).message,
      /egress\.web must be "allow" or "deny"/,
    );
  });

  it("names the offending source in every error", () => {
    const err = grab(() => validatePathDefaults(null, "/some/path.json"));
    assert.match(err.message, /^\/some\/path\.json:/);
  });
});

describe("loadPathDefaults — file I/O", () => {
  let sandbox: string;
  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-path-defaults-config-"));
  });
  after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("reads and validates a real file", async () => {
    const file = join(sandbox, "ok.json");
    await writeFile(file, JSON.stringify(VALID));
    const parsed = loadPathDefaults(file);
    assert.equal(parsed.tier, "strong");
  });

  it("throws a plain Error with an ENOENT cause for a missing file", () => {
    const err = grab(() => loadPathDefaults(join(sandbox, "does-not-exist.json")));
    assert.ok(!(err instanceof PathDefaultsShapeError));
    assert.match(err.message, /could not read/);
    assert.equal((err.cause as NodeJS.ErrnoException).code, "ENOENT");
  });

  it("throws on malformed JSON", async () => {
    const file = join(sandbox, "bad.json");
    await writeFile(file, "{ not json");
    const err = grab(() => loadPathDefaults(file));
    assert.match(err.message, /is not valid JSON/);
  });

  it("throws PathDefaultsShapeError on a structurally invalid but valid-JSON file", async () => {
    const file = join(sandbox, "shape.json");
    await writeFile(file, JSON.stringify({ version: 1, tier: 5 }));
    const err = grab(() => loadPathDefaults(file));
    assert.ok(err instanceof PathDefaultsShapeError);
  });
});

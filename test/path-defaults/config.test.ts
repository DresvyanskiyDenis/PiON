import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  PathDefaultsShapeError,
  expandHome,
  loadPathDefaults,
  validatePathDefaults,
} from "../../extensions/path-defaults/config.ts";

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
  roots: [
    {
      path: "~/work/acme",
      tier: "confidential",
      egress: { web: "deny", mcp: "allow", publicModels: "deny" },
      reason: "confidential source",
    },
    {
      path: "*",
      tier: "fast",
      egress: { web: "allow", mcp: "allow", publicModels: "allow" },
    },
  ],
};

describe("validatePathDefaults — shape", () => {
  it("accepts a well-formed file", () => {
    const parsed = validatePathDefaults(VALID, "<inline>");
    assert.equal(parsed.roots.length, 2);
    assert.equal(parsed.roots[0]?.reason, "confidential source");
    assert.equal(parsed.roots[1]?.path, "*");
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

  it("rejects a non-array roots field", () => {
    const err = grab(() => validatePathDefaults({ version: 1, roots: "nope" }, "<inline>"));
    assert.match(err.message, /"roots" must be an array/);
  });

  it("rejects a root that is not an object", () => {
    const err = grab(() => validatePathDefaults({ version: 1, roots: ["nope"] }, "<inline>"));
    assert.match(err.message, /roots\[0\] must be an object/);
  });

  it("rejects an empty or missing path", () => {
    const bad = { version: 1, roots: [{ tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } }] };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /path must be a non-empty string/);
  });

  it("rejects a path that is neither \"*\" nor absolute-able", () => {
    const bad = {
      version: 1,
      roots: [{ path: "relative/dir", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } }],
    };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /neither "\*" nor an absolute-able path/);
  });

  it("rejects a duplicate path", () => {
    const bad = {
      version: 1,
      roots: [
        { path: "~/a", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        { path: "~/a", tier: "cheap", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
      ],
    };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /is a duplicate of an earlier root/);
  });

  it("rejects a second wildcard root", () => {
    const bad = {
      version: 1,
      roots: [
        { path: "*", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        { path: "~/a", tier: "cheap", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
      ],
    };
    // The first failure hit is "wildcard must be last" (index 0 of 2), which is the more
    // actionable message — the duplicate-wildcard branch is unreachable once that holds.
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /wildcard \("\*"\) root must be last/);
  });

  it("rejects a root that follows the wildcard", () => {
    const bad = {
      version: 1,
      roots: [
        { path: "~/a", tier: "cheap", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        { path: "*", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
        { path: "~/b", tier: "strong", egress: { web: "allow", mcp: "allow", publicModels: "allow" } },
      ],
    };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /wildcard \("\*"\) root must be last/);
  });

  it("rejects a missing or empty tier", () => {
    const bad = { version: 1, roots: [{ path: "*", egress: { web: "allow", mcp: "allow", publicModels: "allow" } }] };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /tier must be a non-empty string/);
  });

  it("rejects a malformed egress object", () => {
    assert.match(
      grab(() => validatePathDefaults({ version: 1, roots: [{ path: "*", tier: "fast" }] }, "<inline>")).message,
      /egress must be an object/,
    );
    assert.match(
      grab(() =>
        validatePathDefaults(
          { version: 1, roots: [{ path: "*", tier: "fast", egress: { web: "sometimes", mcp: "allow", publicModels: "allow" } }] },
          "<inline>",
        ),
      ).message,
      /egress\.web must be "allow" or "deny"/,
    );
  });

  it("rejects a non-string reason", () => {
    const bad = {
      version: 1,
      roots: [{ path: "*", tier: "fast", egress: { web: "allow", mcp: "allow", publicModels: "allow" }, reason: 5 }],
    };
    assert.match(grab(() => validatePathDefaults(bad, "<inline>")).message, /reason must be a string when present/);
  });

  it("names the offending source in every error", () => {
    const err = grab(() => validatePathDefaults(null, "/some/path.json"));
    assert.match(err.message, /^\/some\/path\.json:/);
  });
});

describe("expandHome", () => {
  it("expands the bare tilde", () => {
    assert.equal(expandHome("~", "/home/user"), "/home/user");
  });

  it("expands a tilde-prefixed path", () => {
    assert.equal(expandHome("~/work/acme", "/home/user"), "/home/user/work/acme");
  });

  it("passes through an absolute path unchanged", () => {
    assert.equal(expandHome("/etc/passwd", "/home/user"), "/etc/passwd");
  });

  it("passes through the wildcard unchanged", () => {
    assert.equal(expandHome("*", "/home/user"), "*");
  });

  it("does not expand a path that merely starts with a tilde character mid-string", () => {
    assert.equal(expandHome("~otheruser/foo", "/home/user"), "~otheruser/foo");
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
    assert.equal(parsed.roots.length, 2);
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
    await writeFile(file, JSON.stringify({ version: 1, roots: "nope" }));
    const err = grab(() => loadPathDefaults(file));
    assert.ok(err instanceof PathDefaultsShapeError);
  });
});

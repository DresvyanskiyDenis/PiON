import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import {
  decide,
  dependencyNamesFor,
  id,
  register,
  resetDependencyCache,
} from "../extensions/input-transform.ts";
import { manifestReport, resetManifest } from "../extensions/lib/manifest.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";

let sandbox: string;
after(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  resetDependencyCache();
  resetSurfaced();
  resetManifest();
});

function fakeContext(cwd: string, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => {} },
    ...overrides,
  } as unknown as ExtensionContext;
}

function inputEvent(text: string): InputEvent {
  return { type: "input", text, source: "interactive" };
}

describe("decide — pure signal + bailout logic", () => {
  it("fires on a manifest-declared dependency name", () => {
    const decision = decide("why does pydantic break here", new Set(["pydantic"]));
    assert.deepEqual(decision, { fire: true, reason: "dependency" });
  });

  it("fires on an explicit version string even with no manifest match", () => {
    const decision = decide("does this work on 3.13.0 still", new Set());
    assert.deepEqual(decision, { fire: true, reason: "version" });
  });

  it("does not fire on plain text with no marker", () => {
    assert.deepEqual(decide("please refactor this function", new Set(["pydantic"])), { fire: false });
  });

  it("bails out on a leading slash — input fires before skill expansion", () => {
    assert.deepEqual(decide("/skill:sofa anything v2.11", new Set()), { fire: false });
  });

  it("bails out on a too-short prompt even if it would otherwise match", () => {
    assert.deepEqual(decide("v2.11", new Set()), { fire: false });
  });

  it("bails out on empty / whitespace-only text", () => {
    assert.deepEqual(decide("   ", new Set(["pydantic"])), { fire: false });
  });

  it("does not match a dependency name as a substring of another word", () => {
    // "click" is a dep, but "clickable" must not trip it — token match, not substring match
    assert.deepEqual(decide("make this button clickable please", new Set(["click"])), { fire: false });
  });

  it("matches a scoped npm package written as one token", () => {
    const decision = decide("why does @tanstack/query refetch twice", new Set(["@tanstack/query"]));
    assert.deepEqual(decision, { fire: true, reason: "dependency" });
  });

  it("the acceptance-test prompts from content_port.md §4.7 Step H-5", () => {
    const deps = new Set(["pydantic"]);
    assert.equal(decide("why does pydantic v2.11 fail here", deps).fire, true);
    assert.equal(decide("ok continue", deps).fire, false);
    assert.equal(decide("/skill:sofa anything", deps).fire, false);
  });
});

describe("dependencyNamesFor — manifest reading", () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-input-transform-"));
  });

  it("extracts names from package.json across all four dependency fields", async () => {
    await writeFile(
      join(sandbox, "package.json"),
      JSON.stringify({
        dependencies: { fastify: "^4.0.0" },
        devDependencies: { vitest: "^4.0.0" },
        peerDependencies: { react: "^19.0.0" },
        optionalDependencies: { fsevents: "^2.0.0" },
      }),
    );
    const names = await dependencyNamesFor(sandbox);
    assert.deepEqual([...names].sort(), ["fastify", "fsevents", "react", "vitest"]);
  });

  it("extracts bare names from pyproject.toml's PEP 508 version specifiers", async () => {
    await writeFile(
      join(sandbox, "pyproject.toml"),
      [
        "[project]",
        'name = "demo"',
        'dependencies = ["pydantic>=2.0", "fastapi[standard]>=0.100", "requests"]',
        "",
        "[project.optional-dependencies]",
        'dev = ["pytest>=8.0"]',
        "",
        "[dependency-groups]",
        'lint = ["ruff==0.6.1"]',
      ].join("\n"),
    );
    const names = await dependencyNamesFor(sandbox);
    assert.deepEqual(
      [...names].sort(),
      ["fastapi", "pydantic", "pytest", "requests", "ruff"],
    );
  });

  it("merges both manifests when both are present", async () => {
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ dependencies: { express: "^5" } }));
    await writeFile(
      join(sandbox, "pyproject.toml"),
      '[project]\ndependencies = ["pydantic"]\n',
    );
    const names = await dependencyNamesFor(sandbox);
    assert.deepEqual([...names].sort(), ["express", "pydantic"]);
  });

  it("returns an empty set, not an error, when neither manifest exists", async () => {
    const names = await dependencyNamesFor(sandbox);
    assert.equal(names.size, 0);
  });

  it("skips an unreadable/malformed manifest and still surfaces the error once, not per call", async () => {
    await writeFile(join(sandbox, "pyproject.toml"), "this is not [ valid toml");
    let stderrCalls = 0;
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string" && chunk.includes(id)) stderrCalls++;
      return original(chunk as never, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      await dependencyNamesFor(sandbox);
      await dependencyNamesFor(sandbox);
      await dependencyNamesFor(sandbox);
    } finally {
      process.stderr.write = original;
    }
    assert.equal(stderrCalls, 1, "the read failure must be surfaced exactly once (REQ-EXT-16)");
  });

  it("invalidates its cache when the manifest's mtime changes", async () => {
    const path = join(sandbox, "package.json");
    await writeFile(path, JSON.stringify({ dependencies: { alpha: "1.0.0" } }));
    const first = await dependencyNamesFor(sandbox);
    assert.deepEqual([...first], ["alpha"]);

    // Force a distinct mtime — some filesystems have 1s mtime resolution.
    await new Promise((r) => setTimeout(r, 1100));
    await writeFile(path, JSON.stringify({ dependencies: { beta: "1.0.0" } }));
    const second = await dependencyNamesFor(sandbox);
    assert.deepEqual([...second], ["beta"]);
  });
});

describe("register — wiring into PI's event system", () => {
  it("declares itself at session_start and transforms on input", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    register(pi);
    assert.ok(handlers.has("session_start"), "must register a session_start handler");
    assert.ok(handlers.has("input"), "must register an input handler");

    const dir = await mkdtemp(join(tmpdir(), "pi-input-transform-register-"));
    sandbox = dir;
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { pydantic: "0" } }));
    const ctx = fakeContext(dir);

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const report = manifestReport();
    assert.ok(report.modules.some((m) => m.id === id), "session_start must declare this module");

    const result = await handlers.get("input")!(inputEvent("why does pydantic v2.11 fail here"), ctx);
    assert.deepEqual(result, {
      action: "transform",
      text:
        "why does pydantic v2.11 fail here" +
        "\n\n[verify] This mentions a project dependency or a version — check Context7 (or web_search " +
        "for anything date-, pricing-, or limit-sensitive) before answering from memory.",
    });

    const unchanged = await handlers.get("input")!(inputEvent("ok continue"), ctx);
    assert.deepEqual(unchanged, { action: "continue" });
  });

  it("degrades to the version-only signal, not a crash, when cwd has no manifest at all", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    register(pi);

    // cwd that does not exist at all — both manifest stat() calls fail ENOENT, handled silently.
    // The version marker in the prompt still fires: dependencyNamesFor() never throwing is what
    // keeps this working rather than tripping the handler's outer catch.
    const ctx = fakeContext(join(tmpdir(), "pi-input-transform-does-not-exist-" + Date.now()));
    const result = await handlers.get("input")!(inputEvent("why does pydantic v2.11 fail here"), ctx);
    assert.deepEqual(result, {
      action: "transform",
      text:
        "why does pydantic v2.11 fail here" +
        "\n\n[verify] This mentions a project dependency or a version — check Context7 (or web_search " +
        "for anything date-, pricing-, or limit-sensitive) before answering from memory.",
    });
  });
});

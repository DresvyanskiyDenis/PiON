import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { decide, id, register } from "../extensions/input-transform.ts";
import { manifestReport, resetManifest } from "../extensions/lib/manifest.ts";
import { resetSurfaced } from "../extensions/lib/once.ts";

const NUDGE =
  "\n\n[verify] This mentions a version — check Context7 (or web_search for anything date-, " +
  "pricing-, or limit-sensitive) before answering from memory.";

/**
 * The regression case. In a project whose `pyproject.toml` declares `mcp`, this ordinary English
 * sentence used to fire the nudge, because `mcp` matched a declared dependency name as a bare
 * token. There is no library reference in it — see the file header's DECISION note.
 */
const ORDINARY_ENGLISH_WITH_A_DEPENDENCY_WORD =
  "we speak only about UI, client side. We do not touch mcp wrapper";

/** What that project's `pyproject.toml` declares — the manifest that used to supply the signal. */
const PYPROJECT_DECLARING_MCP = [
  "[project]",
  'name = "ui-agent"',
  'dependencies = ["mcp>=1.2", "openai>=1.0", "pandas", "numpy"]',
].join("\n");

let sandbox: string;
after(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
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
  it("fires on an explicit version string", () => {
    assert.deepEqual(decide("does this work on 3.13.0 still"), { fire: true, reason: "version" });
  });

  it("fires on a v-prefixed version string", () => {
    assert.deepEqual(decide("why does pydantic v2.11 fail here"), { fire: true, reason: "version" });
  });

  it("does not fire on plain text with no marker", () => {
    assert.deepEqual(decide("please refactor this function"), { fire: false });
  });

  it("does not fire on a bare library name with no version — the dependency signal is gone", () => {
    assert.deepEqual(decide("why does pydantic break here"), { fire: false });
  });

  it("does not fire on an ordinary sentence containing a dependency name (regression)", () => {
    assert.deepEqual(decide(ORDINARY_ENGLISH_WITH_A_DEPENDENCY_WORD), { fire: false });
  });

  it("bails out on a leading slash — input fires before skill expansion", () => {
    assert.deepEqual(decide("/skill:sofa anything v2.11"), { fire: false });
  });

  it("bails out on a too-short prompt even if it would otherwise match", () => {
    assert.deepEqual(decide("v2.11"), { fire: false });
  });

  it("bails out on empty / whitespace-only text", () => {
    assert.deepEqual(decide("   "), { fire: false });
  });

  it("the acceptance-test prompts of the ported hook", () => {
    // The acceptance case still passes on the version marker alone: its firing prompt carries
    // "v2.11".
    assert.equal(decide("why does pydantic v2.11 fail here").fire, true);
    assert.equal(decide("ok continue").fire, false);
    assert.equal(decide("/skill:sofa anything").fire, false);
  });
});

describe("register — wiring into PI's event system", () => {
  function registerHandlers(): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    register(pi);
    return handlers;
  }

  it("declares itself at session_start and transforms on input", async () => {
    const handlers = registerHandlers();
    assert.ok(handlers.has("session_start"), "must register a session_start handler");
    assert.ok(handlers.has("input"), "must register an input handler");

    const dir = await mkdtemp(join(tmpdir(), "pi-input-transform-register-"));
    sandbox = dir;
    const ctx = fakeContext(dir);

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const report = manifestReport();
    assert.ok(report.modules.some((m) => m.id === id), "session_start must declare this module");

    const result = await handlers.get("input")!(inputEvent("why does pydantic v2.11 fail here"), ctx);
    assert.deepEqual(result, {
      action: "transform",
      text: "why does pydantic v2.11 fail here" + NUDGE,
    });

    const unchanged = await handlers.get("input")!(inputEvent("ok continue"), ctx);
    assert.deepEqual(unchanged, { action: "continue" });
  });

  it("stays silent on an ordinary sentence even when the cwd's manifest declares that word as a dependency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-input-transform-mcp-"));
    sandbox = dir;
    await writeFile(join(dir, "pyproject.toml"), PYPROJECT_DECLARING_MCP);
    const handlers = registerHandlers();
    const ctx = fakeContext(dir);

    const result = await handlers.get("input")!(
      inputEvent(ORDINARY_ENGLISH_WITH_A_DEPENDENCY_WORD),
      ctx,
    );
    assert.deepEqual(
      result,
      { action: "continue" },
      "a declared dependency name used as an ordinary English word must not fire the nudge",
    );
  });

  it("still fires on a version marker in a cwd that has no manifest at all", async () => {
    const handlers = registerHandlers();
    // cwd that does not exist at all — nothing about the project is read any more, so the
    // version marker is decided purely from the prompt text.
    const ctx = fakeContext(join(tmpdir(), "pi-input-transform-does-not-exist-" + Date.now()));
    const result = await handlers.get("input")!(inputEvent("why does pydantic v2.11 fail here"), ctx);
    assert.deepEqual(result, {
      action: "transform",
      text: "why does pydantic v2.11 fail here" + NUDGE,
    });
  });
});

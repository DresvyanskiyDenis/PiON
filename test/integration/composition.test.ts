/**
 * Integration-level proof that the composition root is real:
 *
 *   1. `extensions/index.ts` loads through **jiti**, the same loader PI's
 *      `core/extensions/loader.js` uses, with `moduleCache: false` exactly as PI sets it.
 *   2. Its default export is a factory function (PI rejects anything else with
 *      "Extension does not export a valid factory function").
 *   3. Invoking it against a recording `ExtensionAPI` registers every module in
 *      `lib/manifest.ts`'s `DECLARED_MODULES` — the set is now complete, `trust` (EXT-30)
 *      included.
 *   4. `guard` is registered before `bash` and before `hooks` — a blocked tool call must
 *      never be mutated first — and `trust` immediately follows `guard`, so the EXT-30
 *      deadman reads a registry in which `guard`'s load record already exists.
 *   5. No module fails to load (the composition root catches per-module failures and
 *      records them; this test asserts the recorded failure set is empty).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const require_ = createRequire(import.meta.url);

// `lib/paths.ts` defaults `repoRoot()` to `~/pi-config`, the installed symlink. Nothing in a
// test tree may depend on install.sh having been run, and `extensions/bash.ts` reads its
// timeout policy from that root inside `register()` — so point it at the checkout.
process.env.PI_CONFIG_REPO = repoRoot;

interface Recorded {
  events: string[];
  tools: string[];
  commands: string[];
}

function recordingApi(rec: Recorded): unknown {
  const noop = () => undefined;
  return {
    on: (event: string) => {
      rec.events.push(event);
      return noop;
    },
    registerTool: (def: { name?: string } | string) => {
      rec.tools.push(typeof def === "string" ? def : (def.name ?? "<anonymous>"));
      return noop;
    },
    registerCommand: (name: string) => {
      rec.commands.push(name);
      return noop;
    },
    registerProvider: noop,
    registerMessageRenderer: noop,
    registerEntryRenderer: noop,
    registerFlag: noop,
    registerShortcut: noop,
    registerTheme: noop,
    setPromptGuidelines: noop,
    addPromptGuideline: noop,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    events: { on: () => noop, emit: noop, off: noop },
    sendMessage: noop,
    log: noop,
  };
}

describe("extensions/index.ts — the composition root", () => {
  it("loads through jiti and exports a factory that registers every declared module", async () => {
    const { createJiti } = require_("jiti");
    // PI sets `moduleCache: false`, which is correct for it: it makes exactly ONE
    // `jiti.import()` call per extension and the whole graph under that call shares
    // instances. This test needs to read the registry that `index.ts` wrote, so it must
    // share the graph across its own several imports — hence the cache is on here.
    const jiti = createJiti(import.meta.url, { moduleCache: true });

    const factory = await jiti.import(resolve(repoRoot, "extensions/index.ts"), { default: true });
    assert.equal(typeof factory, "function", "PI requires a default-exported factory function");

    const manifest = await jiti.import(resolve(repoRoot, "extensions/lib/manifest.ts"));
    const indexMod = await jiti.import(resolve(repoRoot, "extensions/index.ts"));

    const declared: readonly string[] = manifest.DECLARED_MODULES;
    const order: readonly string[] = indexMod.MODULE_ORDER;

    // EXT-30 closed the last hole: declared and composed must now be the same set.
    assert.deepEqual(
      declared.filter((id) => !order.includes(id)),
      [],
      "every declared module must be composed — EXT-30 built `trust`, nothing else may be absent",
    );
    assert.deepEqual(
      order.filter((id) => !declared.includes(id)),
      [],
      "every composed module must also be declared in DECLARED_MODULES",
    );

    // guard first, and strictly before the two modules that mutate a tool call.
    assert.equal(order[0], "guard", "guard must be the first module registered");
    assert.equal(order[1], "trust", "trust (EXT-30) must register immediately after guard");
    assert.ok(order.indexOf("guard") < order.indexOf("bash"), "guard must precede bash");
    assert.ok(order.indexOf("guard") < order.indexOf("hooks"), "guard must precede hooks");
    assert.equal(order[order.length - 1], "doctor", "doctor must be last so it observes everything");

    const rec: Recorded = { events: [], tools: [], commands: [] };
    manifest.resetManifest();
    await factory(recordingApi(rec));

    assert.deepEqual(manifest.failedModules(), [], "no module may fail to register");
    assert.deepEqual(
      manifest.absentModules(),
      [],
      "after a full composition nothing may be expected-but-absent",
    );
    assert.ok(rec.events.length > 0, "the composed harness must bind at least one event handler");
  });
});

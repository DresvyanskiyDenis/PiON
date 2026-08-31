import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `subagents.watchdog` in `config/settings.default.json`.
//
// The block does not live where you would look for it. `pi-subagents` has its own extension
// config (`config/subagent.json`), and a `watchdog` key there is read by nobody: the package
// resolves `getAgentDir()/settings.json` in `watchdog/settings.ts` and then reads exactly
// `settings.subagents.watchdog`. PI's own settings loader carries that unknown top-level key
// through a load/save round trip untouched, so the agent settings file is the only surface.
//
// Everything asserted about the package is asserted against its SOURCE TEXT, not by importing it.
// `pi-subagents` ships `.ts` under `node_modules`, and bare `node --test` refuses to strip types
// there (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — PI itself loads it through jiti. Same
// constraint, same answer, as `test/dispatch/ceiling.test.ts`. Every assertion below therefore
// names the file to re-read when it breaks.
//
// The settings file the installer writes is generated and git-ignored, so the template it is
// generated from is what this file pins. The installer only ever rewrites the handful of keys it
// asks about; the watchdog block passes through verbatim.

const repoFile = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string): string => readFileSync(repoFile(relative), "utf8");

const PKG = "node_modules/pi-subagents/src";
const SETTINGS_SRC = read(`${PKG}/watchdog/settings.ts`);
const CHILD_STATUS = read(`${PKG}/watchdog/child-status.ts`);
const WAIT_CONFIG = read(`${PKG}/runs/background/wait-config.ts`);
const SUBAGENT_WAIT = read(`${PKG}/runs/background/subagent-wait.ts`);
const AUTO_DRAIN = read(`${PKG}/runs/background/auto-drain.ts`);

interface Watchdog {
  enabled?: boolean;
  main?: { enabled?: boolean };
  children?: { enabled?: boolean };
  asyncCompletion?: { enabled?: boolean; autoFollowBlockers?: boolean };
}

const TEMPLATE = JSON.parse(read("config/settings.default.json")) as { subagents?: { watchdog?: Watchdog } };
const WATCHDOG: Watchdog = TEMPLATE.subagents?.watchdog ?? {};

/** The `new Set([...])` literal that `assertKnownFields` refuses anything outside of. */
function fieldSet(name: string): ReadonlySet<string> {
  const found = SETTINGS_SRC.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(found, `watchdog/settings.ts no longer declares ${name} — re-read its parsers`);
  return new Set([...found[1]!.matchAll(/"([^"]+)"/g)].map((hit) => hit[1]!));
}

/** The body of `DEFAULT_WATCHDOG_CONFIG`, so a default this block leans on cannot move silently. */
function shippedDefaults(): string {
  const start = SETTINGS_SRC.indexOf("export const DEFAULT_WATCHDOG_CONFIG");
  assert.ok(start > 0, "watchdog/settings.ts no longer exports DEFAULT_WATCHDOG_CONFIG");
  return SETTINGS_SRC.slice(start, SETTINGS_SRC.indexOf("\n};", start));
}

/** Package sources mentioning a needle — the "is this knob wired yet" canaries below. */
function mentioning(needle: string): string[] {
  const root = repoFile(PKG);
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes(needle)) acc.push(full);
    }
    return acc;
  };
  return walk(root).map((file) => file.slice(root.length + 1)).sort();
}

describe("config/settings.default.json: subagents.watchdog", () => {
  it("spells every field the way the strict parser spells it", () => {
    // `assertKnownFields` THROWS on an unknown field and `resolveWatchdogConfig` turns that into a
    // settings error for the file as a whole. A typo here is not an ignored key — it is a watchdog
    // that silently falls back to the shipped defaults, which are off.
    const levels: ReadonlyArray<readonly [string, Record<string, unknown> | undefined, string]> = [
      ["subagents.watchdog", WATCHDOG as Record<string, unknown>, "WATCHDOG_FIELDS"],
      ["subagents.watchdog.main", WATCHDOG.main, "ENDPOINT_FIELDS"],
      ["subagents.watchdog.children", WATCHDOG.children, "CHILDREN_FIELDS"],
      ["subagents.watchdog.asyncCompletion", WATCHDOG.asyncCompletion, "ASYNC_COMPLETION_FIELDS"],
    ];
    for (const [path, block, set] of levels) {
      assert.ok(block, `${path} is missing from config/settings.default.json`);
      for (const key of Object.keys(block)) {
        assert.ok(fieldSet(set).has(key), `${path}.${key} is not in ${set} — pi-subagents would refuse the whole file`);
      }
    }
  });

  it("reviews a child's agent_end and follows up an async child that came back blocked", () => {
    assert.equal(WATCHDOG.children?.enabled, true, "a writer child's agent_end must be reviewed");
    assert.equal(WATCHDOG.asyncCompletion?.enabled, true, "an async completion must be reviewed");
    assert.equal(
      WATCHDOG.asyncCompletion?.autoFollowBlockers,
      true,
      "a blocked async child is followed up by the watchdog, not by a manual full-price resume",
    );
  });

  it("keeps the top-level flag on, because the child flag is ANDed with it", () => {
    assert.equal(WATCHDOG.enabled, true, "without this, children.enabled resolves to nothing");
    assert.match(
      CHILD_STATUS,
      /const enabled = input\.config\.enabled && \(override\?\.enabled \?\? input\.config\.children\.enabled\)/,
      "watchdog/child-status.ts no longer ANDs the child flag with the top-level one — re-read " +
        "resolveChildWatchdogConfig before trusting the enabled/children split in the template",
    );
  });

  it("says main.enabled: false out loud, because it would otherwise be derived", () => {
    // `resolvePatch` defaults `main.enabled` to `config.enabled`. Left implicit, turning the
    // watchdog on for children would also buy a review model call at every agent_end of the LEAD.
    // Children and async completions are the point here; the lead endpoint is its own decision.
    assert.equal(WATCHDOG.main?.enabled, false);
    assert.match(
      SETTINGS_SRC,
      /config\.main\.enabled = patch\.main\?\.enabled \?\? config\.enabled;/,
      "resolvePatch no longer derives main.enabled from enabled — the explicit false may now be " +
        "redundant, or may mean something else",
    );
    assert.match(
      read(`${PKG}/watchdog/runtime.ts`),
      /return this\.configResult\.ok && this\.configResult\.config\.main\.enabled;/,
      "watchdog/runtime.ts no longer gates the lead endpoint on main.enabled",
    );
  });

  it("leans on auto-follow defaults that are still the defaults", () => {
    const defaults = shippedDefaults();
    assert.match(defaults, /blockers: true/, "autoFollow.blockers is no longer on by default — set it explicitly");
    assert.match(defaults, /maxAttempts: 3/, "autoFollow.maxAttempts is no longer 3 by default");
    // The two flags the template does set are exactly the ones that ship OFF. If upstream flips
    // them, the block becomes decoration and should be re-read rather than kept out of habit.
    assert.match(
      defaults,
      /asyncCompletion: \{\s*enabled: false,\s*autoFollowBlockers: false,\s*\}/,
      "asyncCompletion no longer ships off by default",
    );
    assert.match(defaults, /children: \{\s*enabled: false,/, "children no longer ship off by default");
  });
});

describe("what config cannot say to pi-subagents 0.57.0", () => {
  it("asyncCompletion is parsed and then consumed by nothing", () => {
    // The knob is accepted by the parser and read by no runtime. The block is correct and takes
    // effect the day upstream wires it; until then an empty async completion is not recovered by
    // configuration alone. When this assertion fails, upstream wired it up — say so in the docs.
    assert.deepEqual(
      mentioning("asyncCompletion"),
      ["watchdog/settings.ts", "watchdog/types.ts"],
      "asyncCompletion has a consumer now: the settings template really does cover the empty async " +
        "child. Update docs/configuration/settings.md and config/README.md",
    );
  });

  it("subagent_wait's stopOnAttention default is code, and no key reaches it", () => {
    // A progress ping with no question still ends a blocking wait, and every spurious wake is a
    // full cache miss. The default comes from injected deps, and the only injector is the package's
    // own auto-drain. Patching node_modules would be inert anyway — the installed tree is what
    // runs, and PC-21 keeps it unmodified — so the harness writes the value onto the call instead,
    // from the `DSP-WAIT` rule in `extensions/dispatch/wait-attention.ts`. These assertions stay:
    // they are what says that workaround is still needed and still correct, and the day one of
    // them fails, a real key exists and the workaround can be deleted.
    assert.match(
      SUBAGENT_WAIT,
      /const stopOnAttention = params\.stopOnAttention \?\? deps\.stopOnAttention !== false;/,
      "subagent-wait.ts changed how the default resolves — re-read it, config may now reach it",
    );
    assert.ok(!fieldSet("WATCHDOG_FIELDS").has("stopOnAttention"));
    assert.ok(
      !SETTINGS_SRC.includes("stopOnAttention"),
      "subagents.watchdog grew a stopOnAttention field — set it in config/settings.default.json and " +
        "drop the workaround note from docs/configuration/settings.md",
    );
    assert.ok(
      !WAIT_CONFIG.includes("stopOnAttention"),
      "the wait tool's config grew a stopOnAttention field — set it in config/subagent.default.json",
    );
    assert.match(WAIT_CONFIG, /export interface ResolvedWaitToolConfig \{\s*enabled: boolean;\s*\}/);
    assert.match(AUTO_DRAIN, /stopOnAttention: false,/, "auto-drain is the only injector of the default");
    // Two files, and only one of them is code: auto-drain injects the dep, wait-tool carries it in
    // the tool DESCRIPTION the model reads — the per-call escape hatch that stands in for a default
    // this repo cannot set.
    assert.deepEqual(mentioning("stopOnAttention: false"), [
      "runs/background/auto-drain.ts",
      "runs/background/wait-tool.ts",
    ]);
    assert.match(
      read(`${PKG}/runs/background/wait-tool.ts`),
      /\{ stopOnAttention: false \} .{0,20}for blocking waits only/,
      "the wait tool stopped advertising the per-call override that DSP-WAIT writes for the lead",
    );
  });
});

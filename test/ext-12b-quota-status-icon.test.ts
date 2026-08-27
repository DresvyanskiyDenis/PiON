// EXT-12b — the quota status segment's icon mapping.
//
// Nothing in the quota extension's runtime needed changing for this: `extensions/quota/index.ts`
// already calls `ctx.ui.setStatus("quota", render(snap))` (and `ctx.ui.setStatus("quota",
// undefined/"quota —")` on the degrade paths) on every refresh, and @narumitw/pi-statusline's
// `extensionStatusIcons` mechanism renders *any* `ctx.ui.setStatus` key automatically in the
// below-powerline "Extension statuses" row — an icon entry is cosmetic, not load-bearing. The
// whole deliverable is that one icon mapping, and it lives in `config/pi-statusline.json` under
// `extensionStatusIcons`.
//
// What this file guards is the join between two modules that do not import each other: the icon
// map is keyed by the status key the quota extension publishes, and nothing at runtime complains
// if the two drift — the icon simply stops appearing. Assert the agreement here instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const STATUSLINE_PATH = fileURLToPath(new URL("../config/pi-statusline.json", import.meta.url));
const QUOTA_INDEX_PATH = fileURLToPath(new URL("../extensions/quota/index.ts", import.meta.url));

function loadIcons(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(STATUSLINE_PATH, "utf8"));
  return doc.extensionStatusIcons;
}

describe("config/pi-statusline.json — extensionStatusIcons", () => {
  it("is valid, parseable JSON carrying an extensionStatusIcons object", () => {
    assert.doesNotThrow(() => loadIcons());
    const icons = loadIcons();
    assert.equal(typeof icons, "object");
    assert.ok(icons !== null && !Array.isArray(icons));
  });

  it("carries the quota key, alongside whatever other modules have claimed one", () => {
    // This file guards the quota join specifically, so it asserts the key is present rather than
    // that it is alone. It was `deepEqual(["quota"])` while quota was the only module publishing
    // a status icon; `subagent-cost` claiming one made "quota is the only key" a statement about
    // an unrelated module. What this test owns is that quota's icon exists and matches the key
    // the quota extension publishes — asserted below.
    assert.ok(Object.keys(loadIcons()).includes("quota"));
  });

  it("the icon value is a single non-empty string", () => {
    const icons = loadIcons();
    assert.equal(typeof icons.quota, "string");
    assert.ok((icons.quota as string).length > 0);
  });

  it("the icon key matches the literal STATUS_KEY extensions/quota/index.ts publishes", () => {
    // Regression guard: if the quota extension ever renames its ctx.ui.setStatus key, the icon
    // mapping silently stops matching and the icon disappears from the statusline. Catch that
    // here instead of at runtime — neither file imports the other.
    const src = readFileSync(QUOTA_INDEX_PATH, "utf8");
    const match = src.match(/const STATUS_KEY = "([^"]+)"/);
    assert.ok(match, 'extensions/quota/index.ts must define `const STATUS_KEY = "..."`');
    assert.ok(Object.hasOwn(loadIcons(), match![1]));
  });

  it("does not collide with a status key another extension already reserves", () => {
    // The reserved roster: worktree/tasks/jobs/scope, plus the quota key asserted above.
    const reserved = ["worktree", "tasks", "jobs", "scope"];
    for (const key of Object.keys(loadIcons())) assert.ok(!reserved.includes(key));
  });
});

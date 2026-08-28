// The reading half of auto-update: what the flag file means, what the block says, and that the
// block cannot stack. The scheduling half (cron) is exercised end-to-end in
// test/ext-28-install.suite.mjs, against a fake `crontab` on the fixture PATH — never the real one.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MARK_CLOSE,
  MARK_OPEN,
  id,
  injectOnce,
  parseConfig,
  parseFlag,
  render,
  shortRange,
  stripBlock,
} from "../../extensions/auto-update/index.ts";

const A = "dc1f125aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const B = "444c3e9aa1b2c3d4e5f60718293a4b5c6d7e8f90";

test("id is stable", () => {
  assert.equal(id, "auto-update");
});

test("parseFlag reads what auto-update-check.sh writes, comment line and all", () => {
  const written =
    "# Written by scripts/auto-update-check.sh. Delete this file to dismiss the reminder.\n" +
    `range=${A}..${B}\ncommits=3\nchecked=2026-08-28T09:00:00Z\n`;
  assert.deepEqual(parseFlag(written), { range: `${A}..${B}`, commits: 3 });
});

test("parseFlag: a file with no range is meaningless, and says so with null", () => {
  assert.equal(parseFlag("commits=3\n"), null);
  assert.equal(parseFlag(""), null);
  assert.equal(parseFlag("# only a comment\n"), null);
});

test("parseFlag: an unusable count degrades to 0, it does not throw the whole reminder away", () => {
  // The range is the part somebody can act on. Losing the count to a truncated write must not
  // cost them the message that an update exists at all.
  assert.deepEqual(parseFlag(`range=${A}..${B}\ncommits=\n`), { range: `${A}..${B}`, commits: 0 });
  assert.deepEqual(parseFlag(`range=${A}..${B}\ncommits=lots\n`), { range: `${A}..${B}`, commits: 0 });
  assert.deepEqual(parseFlag(`range=${A}..${B}\ncommits=-2\n`), { range: `${A}..${B}`, commits: 0 });
});

test("shortRange abbreviates two object ids and leaves anything else alone", () => {
  assert.equal(shortRange(`${A}..${B}`), "dc1f125..444c3e9");
  assert.equal(shortRange("HEAD..origin/main"), "HEAD..origin/main");
});

test("render names the count, the range and how to dismiss it", () => {
  const block = render({ range: `${A}..${B}`, commits: 3 }, "prompt");
  assert.match(block, /\[update available]/);
  assert.match(block, /3 new commits/);
  assert.match(block, /dc1f125\.\.444c3e9/);
  assert.match(block, /scripts\/update\.sh/);
  assert.match(block, /update-pending/);
});

test("render: one commit is singular, and an unknown count says neither 0 nor a number", () => {
  assert.match(render({ range: `${A}..${B}`, commits: 1 }, "prompt"), /1 new commit\b/);
  const unknown = render({ range: `${A}..${B}`, commits: 0 }, "prompt");
  assert.match(unknown, /new commits/);
  assert.doesNotMatch(unknown, /\b0 new/);
});

test("render in auto mode reports what already happened, and does not ask for it to be run", () => {
  const block = render({ range: `${A}..${B}`, commits: 2 }, "auto");
  assert.match(block, /started in the background/);
  assert.doesNotMatch(block, /Run `scripts\/update\.sh`/);
});

test("injectOnce is idempotent: applying it twice leaves exactly one block", () => {
  const base = "You are a helpful agent.";
  const once = injectOnce(base, "first");
  const twice = injectOnce(once, "second");
  assert.equal(twice.split(MARK_OPEN).length - 1, 1);
  assert.equal(twice.split(MARK_CLOSE).length - 1, 1);
  assert.match(twice, /second/);
  assert.doesNotMatch(twice, /first/);
  assert.match(twice, /^You are a helpful agent\./);
});

test("stripBlock heals a prompt that already carries several stacked blocks", () => {
  const stacked = `head\n${MARK_OPEN}\na\n${MARK_CLOSE}\nmiddle\n${MARK_OPEN}\nb\n${MARK_CLOSE}\ntail`;
  const out = stripBlock(stacked);
  assert.doesNotMatch(out, /pi-config:auto-update/);
  assert.match(out, /head/);
  assert.match(out, /middle/);
  assert.match(out, /tail/);
});

test("parseConfig: the shipped template reads as off", () => {
  assert.deepEqual(parseConfig('{"autoUpdate":{"enabled":false,"mode":"prompt"}}', "t"), {
    enabled: false,
    mode: "prompt",
  });
});

test("parseConfig: only a literal true enables it — a string 'true' does not", () => {
  assert.equal(parseConfig('{"autoUpdate":{"enabled":true,"mode":"auto"}}', "t").enabled, true);
  assert.equal(parseConfig('{"autoUpdate":{"enabled":"true"}}', "t").enabled, false);
  assert.equal(parseConfig("{}", "t").enabled, false);
});

test("parseConfig: an unknown mode is announced and read as prompt, never as auto", () => {
  const said: string[] = [];
  const cfg = parseConfig('{"autoUpdate":{"enabled":true,"mode":"automatic"}}', "t.json", (l) => said.push(l));
  assert.equal(cfg.mode, "prompt");
  assert.equal(said.length, 1);
  assert.match(said[0], /automatic/);
});

test("parseConfig: unparseable JSON is announced and reads as off, not as the shipped default", () => {
  const said: string[] = [];
  const cfg = parseConfig("{ not json", "t.json", (l) => said.push(l));
  assert.deepEqual(cfg, { enabled: false, mode: "prompt" });
  assert.equal(said.length, 1);
  assert.match(said[0], /not valid JSON/);
});

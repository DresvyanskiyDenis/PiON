/**
 * EXT-11 — the session facts file.
 *
 * The properties under test are the ones the mechanism is worthless without, in the order they
 * matter: a fact written before a compaction is still readable after it; both caps bite, and
 * overflow announces itself instead of quietly shortening the list; a configuration that says
 * nothing about facts behaves the way the extension behaved before they existed; and two sessions
 * running at the same moment cannot write into each other's file.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  appendFact,
  DEFAULT_FACTS_LIMITS,
  factsPathFor,
  formatFactLine,
  PROVENANCE_UNSTATED,
  readFacts,
  renderFacts,
} from "../../extensions/compaction/facts.ts";
import { parseConfig } from "../../extensions/compaction/index.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ext11-facts-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the facts file is a sibling of the transcript and is named after it", () => {
  const path = factsPathFor("/agent/sessions/proj/2026-08-28T06-16-51_9f14ab02.jsonl", "9f14ab02", "/state");
  assert.equal(path, "/agent/sessions/proj/2026-08-28T06-16-51_9f14ab02.facts.md");
});

test("a session with no transcript still gets a file of its own under the state root", () => {
  assert.equal(factsPathFor(undefined, "9f14ab02", "/state"), "/state/facts/9f14ab02.facts.md");
  assert.equal(factsPathFor("", "9f14ab02", "/state"), "/state/facts/9f14ab02.facts.md");
});

test("two sessions running at once never write the same file", async () => {
  const sessions = join(dir, "sessions");
  const first = factsPathFor(join(sessions, "2026-08-29T10-00-00_aaaaaaaa.jsonl"), "aaaaaaaa", dir);
  const second = factsPathFor(join(sessions, "2026-08-29T10-00-01_bbbbbbbb.jsonl"), "bbbbbbbb", dir);
  assert.notEqual(first, second);

  // Interleaved, the way a parent session and a subagent would actually append. Each file has to
  // hold its own facts and nothing else, or a compaction in one session restates the other's
  // context as though it were established here.
  await appendFact(first, "the first session resolved the endpoint to /v1", "curl");
  await appendFact(second, "the second session resolved the endpoint to /v2", "curl");
  await appendFact(first, "the first session confirmed it twice", "curl");

  const readFirst = await readFacts(first);
  const readSecond = await readFacts(second);
  assert.equal(readFirst.total, 2);
  assert.equal(readSecond.total, 1);
  assert.ok(readFirst.lines.every((line) => !line.includes("second session")));
  assert.ok(readSecond.lines.every((line) => !line.includes("first session")));

  // The no-transcript fallback is keyed the same way, so the guarantee does not depend on a
  // session having a file on disk.
  assert.notEqual(factsPathFor(undefined, "aaaaaaaa", dir), factsPathFor(undefined, "bbbbbbbb", dir));
});

test("a fact recorded before a compaction is read back from disk afterwards, unchanged", async () => {
  const path = join(dir, "survives.facts.md");
  await appendFact(path, "The service answers on the /openai/v1 form of the base URL", "curl, 200 OK");

  // Compaction rewrites the transcript and touches nothing else, and this module re-reads the
  // file rather than remembering it. Reading twice is therefore the whole simulation: the fact
  // was never in the context being summarised.
  const rendered = renderFacts(await readFacts(path));
  assert.match(rendered, /The service answers on the \/openai\/v1 form of the base URL/);
  assert.match(rendered, /established: curl, 200 OK/);
  assert.match(rendered, /authoritative/);
});

test("a fact with no provenance is marked unstated rather than dressed up as verified", async () => {
  const path = join(dir, "unstated.facts.md");
  await appendFact(path, "Something taken on trust", undefined);
  const result = await readFacts(path);
  assert.match(result.lines[0]!, new RegExp(PROVENANCE_UNSTATED));
});

test("an empty fact is refused loudly instead of appending a blank entry", async () => {
  const path = join(dir, "empty.facts.md");
  await assert.rejects(() => appendFact(path, "   \n  ", "nothing"), /nothing to record/);
});

test("a fact spanning several lines is collapsed, because the file is one fact per line", async () => {
  const path = join(dir, "multiline.facts.md");
  await appendFact(path, "first half\nsecond half", "one\ntwo");
  const raw = await readFile(path, "utf8");
  assert.equal(raw.trimEnd().split("\n").filter((line) => line.startsWith("- `")).length, 1);
  const result = await readFacts(path);
  assert.match(result.lines[0]!, /first half second half/);
  assert.match(result.lines[0]!, /established: one two/);
});

test("maxEntries drops the oldest, and the rendered block says how many it dropped", async () => {
  const path = join(dir, "entries.facts.md");
  for (let i = 1; i <= 10; i += 1) await appendFact(path, `fact number ${i}`, "test");
  const result = await readFacts(path, { maxEntries: 4, maxBytes: 100_000 });
  assert.equal(result.total, 10);
  assert.equal(result.lines.length, 4);
  assert.equal(result.dropped, 6);
  assert.match(result.lines[0]!, /fact number 7/);
  assert.match(result.lines[3]!, /fact number 10/);
  const rendered = renderFacts(result);
  assert.match(rendered, /6 older fact\(s\) dropped/);
  assert.ok(rendered.includes(path));
});

test("maxBytes bites on its own, so both caps are enforced on the same read", async () => {
  const path = join(dir, "bytes.facts.md");
  for (let i = 1; i <= 10; i += 1) await appendFact(path, `padded fact ${i} ${"x".repeat(60)}`, "test");
  const generous = await readFacts(path, { maxEntries: 10, maxBytes: 100_000 });
  assert.equal(generous.lines.length, 10);
  assert.equal(generous.dropped, 0);

  const tight = await readFacts(path, { maxEntries: 10, maxBytes: 400 });
  assert.ok(tight.lines.length < 10, "the entry cap allowed all ten, so the byte cap must cut");
  assert.ok(Buffer.byteLength(tight.lines.join("\n"), "utf8") <= 400);
  assert.equal(tight.dropped, 10 - tight.lines.length);
  assert.match(tight.lines.at(-1)!, /padded fact 10/);
  assert.match(renderFacts(tight), new RegExp(`${tight.dropped} older fact\\(s\\) dropped`));
});

test("a shortened list always names the file it was shortened from", async () => {
  const path = join(dir, "loudness.facts.md");
  for (let i = 1; i <= 5; i += 1) await appendFact(path, `fact ${i}`, "test");
  const rendered = renderFacts(await readFacts(path, { maxEntries: 1, maxBytes: 100_000 }));
  assert.match(rendered, /4 older fact\(s\) dropped/);
  assert.match(rendered, /before concluding that something was never established/);
  assert.ok(rendered.includes(path));
});

test("a single newest entry over the byte cap is cut and marked, never dropped", async () => {
  const path = join(dir, "oversized.facts.md");
  await appendFact(path, "ю".repeat(400), "test");
  const result = await readFacts(path, { maxEntries: 40, maxBytes: 40 });
  assert.equal(result.lines.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.lines[0]!.includes("�"), false, "a cut must not land inside a character");
  assert.ok(Buffer.byteLength(result.lines[0]!, "utf8") <= 40);
  assert.match(renderFacts(result), /cut to fit the byte budget/);
});

test("a session that recorded nothing renders nothing, so no message is sent", async () => {
  const result = await readFacts(join(dir, "never-written.facts.md"));
  assert.deepEqual(result.lines, []);
  assert.equal(result.total, 0);
  assert.deepEqual(result.problems, []);
  assert.equal(renderFacts(result), "");
});

test("only fact lines count, so a header or a hand-written note is not restated as a fact", async () => {
  const path = join(dir, "handwritten.facts.md");
  await appendFact(path, "a recorded fact", "test");
  await writeFile(path, `${await readFile(path, "utf8")}a note somebody typed\n\n## a heading\n`, "utf8");
  const result = await readFacts(path);
  assert.equal(result.total, 1);
  assert.match(result.lines[0]!, /a recorded fact/);
});

test("the writer emits exactly the shape the reader recognises", async () => {
  const line = formatFactLine("2026-08-29T10:00:00.000Z", "a fact", "a source");
  const path = join(dir, "shape.facts.md");
  await writeFile(path, `${line}\n`, "utf8");
  const result = await readFacts(path);
  assert.deepEqual([...result.lines], [line]);
  assert.match(line, /^- `2026-08-29T10:00:00\.000Z` a fact _\(established: a source\)_$/);
});

test("a file that exists but cannot be read is announced, never swallowed", async () => {
  const result = await readFacts(dir); // a directory: EISDIR rather than ENOENT
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /unreadable/);
  assert.equal(renderFacts(result), "");
});

test("a config with no facts key behaves as before: the defaults, and no file means no block", async () => {
  const parsed = parseConfig({ compaction: { pinned: { sources: ["AGENTS.md"] } } });
  assert.equal(parsed.pinned.facts.enabled, true);
  assert.equal(parsed.pinned.facts.maxEntries, DEFAULT_FACTS_LIMITS.maxEntries);
  assert.equal(parsed.pinned.facts.maxBytes, DEFAULT_FACTS_LIMITS.maxBytes);
  // Compatibility does not rest on the key defaulting to off. It rests on the file: a tree that
  // never calls the tool has none, the render is empty, and no message is ever sent. Measured
  // here against the very defaults an absent key produces.
  const result = await readFacts(join(dir, "absent-config.facts.md"), parsed.pinned.facts);
  assert.equal(renderFacts(result), "");
  assert.deepEqual(result.problems, []);
});

test("the caps are configurable and enabled:false is honoured", () => {
  const parsed = parseConfig({
    compaction: { pinned: { facts: { enabled: false, maxEntries: 5, maxBytes: 100 } } },
  });
  assert.equal(parsed.pinned.facts.enabled, false);
  assert.equal(parsed.pinned.facts.maxEntries, 5);
  assert.equal(parsed.pinned.facts.maxBytes, 100);
});

test("a malformed facts block falls back to the defaults rather than switching the mechanism off", () => {
  for (const raw of [{ compaction: { pinned: { facts: "nonsense" } } }, { compaction: { pinned: { facts: {} } } }]) {
    const parsed = parseConfig(raw);
    assert.equal(parsed.pinned.facts.enabled, true);
    assert.equal(parsed.pinned.facts.maxEntries, DEFAULT_FACTS_LIMITS.maxEntries);
    assert.equal(parsed.pinned.facts.maxBytes, DEFAULT_FACTS_LIMITS.maxBytes);
  }
});

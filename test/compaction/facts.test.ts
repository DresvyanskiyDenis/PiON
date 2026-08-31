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
  DEFAULT_FACTS_WARN_RATIO,
  factsPathFor,
  formatFactLine,
  isRuledOutLine,
  nearingCapLine,
  PROVENANCE_UNSTATED,
  readFacts,
  renderFacts,
} from "../../extensions/compaction/facts.ts";
import { parseConfig, register } from "../../extensions/compaction/index.ts";

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
  const firstA = await appendFact(first, "the first session resolved the endpoint to /v1", "curl");
  const secondA = await appendFact(second, "the second session resolved the endpoint to /v2", "curl");
  const firstB = await appendFact(first, "the first session confirmed it twice", "curl");

  // The index is per file too, so the second session's first entry is its entry 1 even though the
  // first session had already recorded one. A counter shared across sessions would have said 2.
  assert.deepEqual([firstA.index, firstA.total], [1, 1]);
  assert.deepEqual([secondA.index, secondA.total], [1, 1]);
  assert.deepEqual([firstB.index, firstB.total], [2, 2]);

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

/* ---------------------------------------------------------------------------------------------
 * Parallel writes: nothing lost, and the number reported back is an identity
 * ------------------------------------------------------------------------------------------- */

test("the index is the entry's own position, and total is the count it is not a substitute for", async () => {
  const path = join(dir, "identity.facts.md");
  const first = await appendFact(path, "the first thing", "test");
  const second = await appendFact(path, "the second thing", "test");
  assert.deepEqual([first.index, first.total], [1, 1]);
  assert.deepEqual([second.index, second.total], [2, 2]);
  assert.equal(first.kind, "fact");
});

test("N parallel writes produce N lines with N distinct indices and lose none", async () => {
  const path = join(dir, "parallel.facts.md");
  const n = 24;
  // The shape that motivated the change: several fact calls issued in one turn and resolved
  // together. A post-hoc count answers two of them with the same number, which is
  // indistinguishable from a lost write, so both halves are asserted here: the count on disk, and
  // the uniqueness of the answers handed back.
  const written = await Promise.all(
    Array.from({ length: n }, (_v, i) => appendFact(path, `parallel fact ${i}`, "test")),
  );

  const indices = written.map((w) => w.index).sort((x, y) => x - y);
  assert.deepEqual(indices, Array.from({ length: n }, (_v, i) => i + 1), "every index is used exactly once");

  const result = await readFacts(path, { maxEntries: 1000, maxBytes: 1_000_000 });
  assert.equal(result.total, n, "no append overwrote another");
  for (const { line } of written) {
    assert.equal(result.lines.filter((l) => l === line).length, 1, `exactly one copy of: ${line}`);
  }
  for (let i = 0; i < n; i += 1) {
    assert.equal(result.lines.filter((l) => l.includes(`parallel fact ${i} `)).length, 1);
  }
  // The last write to resolve saw the whole file, so at least one report carries the final count.
  assert.equal(Math.max(...written.map((w) => w.total)), n);
});

test("a race to create the file writes one header, not one per writer", async () => {
  const path = join(dir, "header-race.facts.md");
  await Promise.all(Array.from({ length: 8 }, (_v, i) => appendFact(path, `racing fact ${i}`, "test")));
  const raw = await readFile(path, "utf8");
  assert.equal(raw.split("# Session facts").length - 1, 1, "the header is created exclusively, once");
  assert.equal((await readFacts(path)).total, 8);
});

test("two entries recorded in the same millisecond are still two addressable lines", async () => {
  const path = join(dir, "same-ms.facts.md");
  const clock = new Date("2026-08-30T16:36:54.000Z");
  const a = await appendFact(path, "first in this millisecond", "test", { now: clock });
  const b = await appendFact(path, "second in this millisecond", "test", { now: clock });
  assert.notEqual(a.line, b.line);
  assert.deepEqual([a.index, b.index], [1, 2]);
  assert.match(a.line, /2026-08-30T16:36:54\.000Z/);
  assert.match(b.line, /2026-08-30T16:36:54\.001Z/);
});

/* ---------------------------------------------------------------------------------------------
 * The ruled_out class
 * ------------------------------------------------------------------------------------------- */

test("a ruled-out approach is recorded as its own class, with the reason in the line", async () => {
  const path = join(dir, "ruled-out.facts.md");
  const { line, kind } = await appendFact(
    path,
    "reading the schema from the catalog API",
    "returns 403 for this token; three attempts, same result",
    { kind: "ruled_out" },
  );
  assert.equal(kind, "ruled_out");
  assert.ok(isRuledOutLine(line));
  assert.match(line, /\*\*ruled out:\*\* reading the schema from the catalog API/);
  assert.match(line, /_\(because: returns 403 for this token/);

  const result = await readFacts(path);
  assert.equal(result.total, 1);
  assert.equal(result.ruledOut, 1);
  assert.deepEqual([...result.lines], [line]);
});

test("a ruled_out entry with no reason is refused — the reason is the whole point of the class", async () => {
  const path = join(dir, "ruled-out-no-reason.facts.md");
  await assert.rejects(
    () => appendFact(path, "an approach", undefined, { kind: "ruled_out" }),
    /must say what ruled the approach out/,
  );
  await assert.rejects(() => appendFact(path, "an approach", "  ", { kind: "ruled_out" }), /ruled the approach out/);
  assert.equal((await readFacts(path)).total, 0, "nothing was written");
});

test("an ordinary fact is not marked, and formatFactLine defaults to that class", () => {
  const plain = formatFactLine("2026-08-29T10:00:00.000Z", "a fact", "a source");
  assert.equal(isRuledOutLine(plain), false);
  assert.match(plain, /^- `2026-08-29T10:00:00\.000Z` a fact _\(established: a source\)_$/);
  const ruled = formatFactLine("2026-08-29T10:00:00.000Z", "an approach", "why", "ruled_out");
  assert.equal(isRuledOutLine(ruled), true);
});

test("the restatement marks the class and states the obligation, in chronological order", async () => {
  const path = join(dir, "restate-ruled-out.facts.md");
  await appendFact(path, "the gateway base URL is the /openai/v1 form", "curl, 200 OK");
  await appendFact(path, "the mlflow/v1 form", "INVALID_PARAMETER_VALUE on every call", { kind: "ruled_out" });
  await appendFact(path, "the token is read from the environment", "config/providers/example.json");

  const result = await readFacts(path);
  assert.equal(result.ruledOut, 1);
  const rendered = renderFacts(result);
  assert.match(rendered, /\*\*ruled out:\*\* the mlflow\/v1 form/);
  assert.match(rendered, /because: INVALID_PARAMETER_VALUE on every call/);
  assert.match(rendered, /1 of the entries above are approaches already ruled out/);
  assert.match(rendered, /Read them before any further fix-work/);
  // One list, in the order the work happened: the outcome that replaced the dead end follows it.
  assert.ok(rendered.indexOf("mlflow/v1") > rendered.indexOf("openai/v1 form"));
  assert.ok(rendered.indexOf("read from the environment") > rendered.indexOf("mlflow/v1"));
});

test("ruled-out entries are capped on a par with facts, and a dropped one is named as dropped", async () => {
  const path = join(dir, "ruled-out-caps.facts.md");
  await appendFact(path, "the first dead end", "it timed out", { kind: "ruled_out" });
  await appendFact(path, "the second dead end", "wrong permissions", { kind: "ruled_out" });
  for (let i = 1; i <= 4; i += 1) await appendFact(path, `ordinary fact ${i}`, "test");

  // The caps do not privilege the class in either direction: oldest first, whatever it is.
  const result = await readFacts(path, { maxEntries: 3, maxBytes: 100_000 });
  assert.equal(result.total, 6);
  assert.equal(result.dropped, 3);
  assert.equal(result.droppedRuledOut, 2);
  assert.equal(result.ruledOut, 0);

  const rendered = renderFacts(result);
  assert.match(rendered, /3 older fact\(s\) dropped/);
  assert.match(rendered, /2 of the dropped entries were ruled-out approaches/);
  assert.doesNotMatch(rendered, /of the entries above are approaches already ruled out/);

  // Read whole, both classes are there and both survive a restatement.
  const whole = renderFacts(await readFacts(path));
  assert.match(whole, /the first dead end/);
  assert.match(whole, /ordinary fact 4/);
});

test("a reader counts a ruled_out line as an entry, so half the file cannot go missing", async () => {
  const path = join(dir, "both-classes.facts.md");
  await appendFact(path, "an outcome", "test");
  await appendFact(path, "an approach", "a reason", { kind: "ruled_out" });
  const result = await readFacts(path);
  assert.equal(result.total, 2);
  assert.equal(result.lines.length, 2);
});

/* ---------------------------------------------------------------------------------------------
 * The budget is stated where the agent already looks, not only in `/compaction-status`
 * ------------------------------------------------------------------------------------------- */

test("the tool says nothing about the budget until the file is near a cap, then names both", async () => {
  const sessionFile = join(dir, "sessions", "2026-08-31T00-00-00_warncap.jsonl");
  const tool = factTool();
  const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "warncap" } };
  const record = async (n: number) =>
    (await tool.execute("call", { fact: `fact number ${n}`, provenance: "test" }, undefined, undefined, ctx))
      .content[0].text as string;

  // The shipped caps: 40 entries, 8000 bytes, warn at 0.75 — so 29 entries is under and 30 is on.
  let text = "";
  for (let i = 1; i <= 29; i += 1) text = await record(i);
  assert.doesNotMatch(text, /nearing the cap/, "29 of 40 entries must not warn");

  text = await record(30);
  assert.match(text, /^recorded fact 30 of 30 in this session/);
  assert.match(text, /\n30\/40 entries, [\d.]+KB\/8KB — nearing the cap\.$/);
});

test("the byte cap warns on its own, before the entry cap is anywhere near", () => {
  const limits = { maxEntries: 40, maxBytes: 8000 };
  assert.equal(nearingCapLine({ total: 4, bytes: 5999 }, limits), null);
  assert.equal(nearingCapLine({ total: 4, bytes: 6200 }, limits), "4/40 entries, 6.2KB/8KB — nearing the cap.");
  // The line reports the file's own weight, not the weight of what survived the caps: entries
  // already evicted are exactly the evidence that the budget is binding.
  assert.equal(nearingCapLine({ total: 60, bytes: 9000 }, limits), "60/40 entries, 9KB/8KB — nearing the cap.");
});

test("the warn ratio is configurable, and both ends of the clamp stay usable", async () => {
  const path = join(dir, "ratio.facts.md");
  for (let i = 1; i <= 10; i += 1) await appendFact(path, `fact number ${i}`, "test");
  const result = await readFacts(path, { maxEntries: 40, maxBytes: 8000 });
  assert.equal(result.total, 10);

  assert.equal(nearingCapLine(result, { maxEntries: 40, maxBytes: 8000 }, 0.75), null);
  assert.match(nearingCapLine(result, { maxEntries: 40, maxBytes: 8000 }, 0.25) ?? "", /10\/40 entries/);
  // 0 states usage on every call; 1 holds it back until a cap is actually reached.
  assert.notEqual(nearingCapLine({ total: 0, bytes: 0 }, { maxEntries: 40, maxBytes: 8000 }, 0), null);
  assert.equal(nearingCapLine({ total: 39, bytes: 10 }, { maxEntries: 40, maxBytes: 8000 }, 1), null);
  assert.notEqual(nearingCapLine({ total: 40, bytes: 10 }, { maxEntries: 40, maxBytes: 8000 }, 1), null);
  // A cap of zero can keep nothing, so it is full rather than a division by it.
  assert.equal(nearingCapLine({ total: 0, bytes: 0 }, { maxEntries: 0, maxBytes: 0 }), "0/0 entries, 0KB/0KB — nearing the cap.");
});

test("warnRatio is parsed beside the caps, defaults to 0.75, and is clamped to a fraction", () => {
  assert.equal(parseConfig({}).pinned.facts.warnRatio, DEFAULT_FACTS_WARN_RATIO);
  assert.equal(parseConfig({ compaction: { pinned: { facts: { warnRatio: 0.5 } } } }).pinned.facts.warnRatio, 0.5);
  assert.equal(parseConfig({ compaction: { pinned: { facts: { warnRatio: 4 } } } }).pinned.facts.warnRatio, 1);
  assert.equal(parseConfig({ compaction: { pinned: { facts: { warnRatio: -1 } } } }).pinned.facts.warnRatio, 0);
  assert.equal(
    parseConfig({ compaction: { pinned: { facts: { warnRatio: "nonsense" } } } }).pinned.facts.warnRatio,
    DEFAULT_FACTS_WARN_RATIO,
  );
});

/** The registered `fact` tool itself, so the reply under test is the one the agent receives. */
function factTool(): any {
  const tools: any[] = [];
  register({
    on: () => {},
    appendEntry: () => {},
    sendMessage: () => {},
    registerCommand: () => {},
    registerTool: (tool: any) => void tools.push(tool),
  } as any);
  const tool = tools.find((t) => t.name === "fact");
  assert.ok(tool, "the fact tool must be registered under the shipped config");
  return tool;
}

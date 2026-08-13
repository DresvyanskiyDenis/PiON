/**
 * EXT-11 — pinned-block regeneration (`REQ-CTX-37`).
 *
 * The acceptance that matters is stability: the block re-read after compaction N+1 is byte-identical
 * to the one re-read after compaction N whenever the source file has not changed, and it tracks the
 * file when it has. Plus the hard boundary — a Soul-shaped source is refused, never read.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  DEFAULT_PINNED_LIMITS,
  isSoulShaped,
  readPinned,
  renderPinned,
  resolvePinnedSources,
} from "../../extensions/compaction/pinned.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ext11-pinned-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\nRule one.\n", "utf8");
  await writeFile(join(dir, "Soul.local.md"), "SECRET IDENTITY TEXT", "utf8");
  await mkdir(join(dir, "adir"), { recursive: true });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("Soul-shaped names are recognised in every casing and separator", () => {
  const shaped = [
    "Soul.local.md",
    "soul.local.md",
    "SOUL.markdown",
    "my-soul.local.md",
    "soul_local.md",
    "/a/b/Soul.local.md",
  ];
  for (const name of shaped) {
    assert.equal(isSoulShaped(name), true, `${name} should be Soul-shaped`);
  }
  for (const name of ["AGENTS.md", "CLAUDE.md", "console.md", "soulful-design.md"]) {
    assert.equal(isSoulShaped(name), false, `${name} should not be Soul-shaped`);
  }
});

test("a Soul-shaped source is refused and announced, never read", async () => {
  const sources = resolvePinnedSources(dir, ["Soul.local.md"]);
  const result = await readPinned(sources, DEFAULT_PINNED_LIMITS);
  assert.equal(result.blocks.length, 0);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /REFUSED/);
  assert.doesNotMatch(result.problems[0]!, /SECRET IDENTITY TEXT/);
  assert.equal(renderPinned(result), "");
});

test("a missing source is skipped silently — not every repo has a CLAUDE.md", async () => {
  const result = await readPinned(resolvePinnedSources(dir, ["nope.md"]));
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.problems, []);
});

test("a source that exists but is not a regular file is announced", async () => {
  const result = await readPinned(resolvePinnedSources(dir, ["adir"]));
  assert.equal(result.blocks.length, 0);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /not a regular file/);
});

test("relative specs resolve against cwd, absolute specs are kept", () => {
  const [rel, abs] = resolvePinnedSources("/work", ["AGENTS.md", "/etc/x.md"]);
  assert.equal(rel!.path, "/work/AGENTS.md");
  assert.equal(abs!.path, "/etc/x.md");
});

test("regeneration is byte-identical across passes while the file is unchanged", async () => {
  const sources = resolvePinnedSources(dir, ["AGENTS.md"]);
  const first = renderPinned(await readPinned(sources));
  const second = renderPinned(await readPinned(sources));
  assert.equal(first, second);
  assert.match(first, /Rule one\./);
});

test("regeneration tracks an edit made mid-session — the block is current, not a snapshot", async () => {
  const sources = resolvePinnedSources(dir, ["AGENTS.md"]);
  const before_ = renderPinned(await readPinned(sources));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\nRule two.\n", "utf8");
  const after_ = renderPinned(await readPinned(sources));
  assert.notEqual(before_, after_);
  assert.match(after_, /Rule two\./);
  await writeFile(join(dir, "AGENTS.md"), "# Agents\nRule one.\n", "utf8");
});

test("a source over its per-source budget is truncated and says so", async () => {
  await writeFile(join(dir, "big.md"), "x".repeat(9000), "utf8");
  const result = await readPinned(resolvePinnedSources(dir, ["big.md"]), {
    maxBytesPerSource: 100,
    maxTotalBytes: 1000,
  });
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0]!.truncated, true);
  assert.equal(Buffer.byteLength(result.blocks[0]!.text, "utf8"), 100);
  assert.match(renderPinned(result), /pinned source truncated/);
});

test("the total budget stops later sources and announces the skip", async () => {
  await writeFile(join(dir, "a.md"), "a".repeat(200), "utf8");
  await writeFile(join(dir, "b.md"), "b".repeat(200), "utf8");
  const result = await readPinned(resolvePinnedSources(dir, ["a.md", "b.md"]), {
    maxBytesPerSource: 200,
    maxTotalBytes: 200,
  });
  assert.equal(result.blocks.length, 1);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /budget was already spent/);
});

test("truncation never cuts a multi-byte character in half", async () => {
  await writeFile(join(dir, "utf8.md"), "ю".repeat(50), "utf8");
  const result = await readPinned(resolvePinnedSources(dir, ["utf8.md"]), {
    maxBytesPerSource: 9,
    maxTotalBytes: 100,
  });
  const text = result.blocks[0]!.text;
  assert.equal(text.includes("�"), false);
  assert.equal(text, "юююю");
});

test("renderPinned marks the block authoritative over the summary and names each path", async () => {
  const result = await readPinned(resolvePinnedSources(dir, ["AGENTS.md"]));
  const rendered = renderPinned(result);
  assert.match(rendered, /pinned/i);
  assert.match(rendered, /authoritative/i);
  assert.ok(rendered.includes(join(dir, "AGENTS.md")));
});

test("an empty source contributes no block and no problem", async () => {
  await writeFile(join(dir, "empty.md"), "   \n\n", "utf8");
  const result = await readPinned(resolvePinnedSources(dir, ["empty.md"]));
  assert.equal(result.blocks.length, 0);
  assert.equal(result.problems.length, 0);
  assert.equal(renderPinned(result), "");
});

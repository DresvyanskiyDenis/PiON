import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  AGENT_SCHEMA,
  agentDir,
  deliver,
  drainInbox,
  ensureAgentsRoot,
  inboxDir,
  listAgents,
  MessageAgentError,
  readRecord,
  registerAgent,
  renderDirectory,
  requireAgent,
  slugifyAgentName,
  unregisterAgent,
} from "../../extensions/message-agent/directory.ts";

let sandbox: string;
let root: string;
let counter = 0;

/** A pid that is certainly not running: 2^22 is above every default `pid_max`. */
const DEAD_PID = 4_194_303;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-message-agent-dir-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});
beforeEach(async () => {
  root = join(sandbox, `run-${counter++}`);
  await ensureAgentsRoot(root);
});

describe("agent names (EXT-32)", () => {
  it("slugifies anything an operator is likely to export", () => {
    assert.equal(slugifyAgentName("Reviewer"), "reviewer");
    assert.equal(slugifyAgentName("PiON::config"), "pion-config");
    assert.equal(slugifyAgentName("  spaced  out  "), "spaced-out");
  });

  it("prefixes a name that does not start with a letter, rather than refusing it", () => {
    assert.equal(slugifyAgentName("2fast"), "agent-2fast");
    assert.equal(slugifyAgentName("019a-7c31"), "agent-019a-7c31");
  });

  it("throws on a name with nothing usable left in it", () => {
    assert.throws(() => slugifyAgentName("---"), MessageAgentError);
    assert.throws(() => slugifyAgentName(""), MessageAgentError);
  });
});

describe("session directory (EXT-32)", () => {
  it("registers a session and reads it back", async () => {
    const { record, requested } = await registerAgent({
      root,
      name: "alpha",
      sessionId: "s-alpha",
      cwd: "/work/alpha",
    });
    assert.equal(record.name, "alpha");
    assert.equal(requested, "alpha");
    assert.equal(record.schema, AGENT_SCHEMA);
    assert.deepEqual(await readRecord(root, "alpha"), record);
  });

  it("lists every reachable session, sorted", async () => {
    await registerAgent({ root, name: "beta", sessionId: "s-b", cwd: "/w" });
    await registerAgent({ root, name: "alpha", sessionId: "s-a", cwd: "/w" });
    const { agents, problems } = await listAgents(root);
    assert.deepEqual(
      agents.map((a) => a.name),
      ["alpha", "beta"],
    );
    assert.deepEqual(problems, []);
  });

  it("sweeps a registration whose process is gone, so the name can be reclaimed", async () => {
    await registerAgent({ root, name: "ghost", sessionId: "s-ghost", cwd: "/w", pid: DEAD_PID });
    const { agents } = await listAgents(root);
    assert.deepEqual(agents, []);
    assert.equal(await readRecord(root, "ghost"), undefined);

    const { record, requested } = await registerAgent({ root, name: "ghost", sessionId: "s-new", cwd: "/w" });
    assert.equal(record.name, "ghost");
    assert.equal(requested, "ghost");
  });

  it("hands a suffixed name to the second live claimant, and says which was asked for", async () => {
    await registerAgent({ root, name: "reviewer", sessionId: "s-1", cwd: "/w" });
    const second = await registerAgent({ root, name: "reviewer", sessionId: "s-2", cwd: "/w" });
    assert.equal(second.requested, "reviewer");
    assert.equal(second.record.name, "reviewer-2");
    assert.equal((await readRecord(root, "reviewer"))?.sessionId, "s-1");
  });

  it("lets the same session re-register under its own name", async () => {
    await registerAgent({ root, name: "same", sessionId: "s-same", cwd: "/w" });
    const again = await registerAgent({ root, name: "same", sessionId: "s-same", cwd: "/w2" });
    assert.equal(again.record.name, "same");
    assert.equal((await readRecord(root, "same"))?.cwd, "/w2");
  });

  it("reports an unreadable directory entry instead of hiding it", async () => {
    await registerAgent({ root, name: "broken", sessionId: "s-x", cwd: "/w" });
    await writeFile(join(agentDir(root, "broken"), "agent.json"), "{not json");
    const { agents, problems } = await listAgents(root);
    assert.deepEqual(agents, []);
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.name, "broken");
  });

  it("unregisters only its own registration", async () => {
    await registerAgent({ root, name: "held", sessionId: "s-owner", cwd: "/w" });
    assert.equal(await unregisterAgent(root, "held", "s-someone-else"), false);
    assert.notEqual(await readRecord(root, "held"), undefined);
    assert.equal(await unregisterAgent(root, "held", "s-owner"), true);
    assert.equal(await readRecord(root, "held"), undefined);
  });

  it("refuses an unknown address and names the reachable ones", async () => {
    await registerAgent({ root, name: "alpha", sessionId: "s-a", cwd: "/w" });
    await assert.rejects(() => requireAgent(root, "nobody"), /no live session named "nobody".*alpha/s);
  });

  it("refuses an address whose process is gone, and removes the claim", async () => {
    await registerAgent({ root, name: "zombie", sessionId: "s-z", cwd: "/w", pid: DEAD_PID });
    await assert.rejects(() => requireAgent(root, "zombie"), MessageAgentError);
    assert.equal(await readRecord(root, "zombie"), undefined);
  });

  it("renders the directory with the calling session marked", async () => {
    await registerAgent({ root, name: "alpha", sessionId: "s-a", cwd: "/w" });
    const text = renderDirectory(await listAgents(root), "alpha");
    assert.match(text, /alpha.*\(this session\)/);
  });
});

describe("inbox (EXT-32)", () => {
  it("delivers a message and drains it oldest first", async () => {
    await registerAgent({ root, name: "target", sessionId: "s-t", cwd: "/w" });
    await deliver({ root, target: "target", from: "a", fromSessionId: "s-a", message: "first", now: 1_000 });
    await deliver({ root, target: "target", from: "b", fromSessionId: "s-b", message: "second", now: 2_000 });

    const { messages, problems } = await drainInbox(root, "target");
    assert.deepEqual(problems, []);
    assert.deepEqual(
      messages.map((m) => m.message),
      ["first", "second"],
    );
    assert.deepEqual(
      messages.map((m) => m.from),
      ["a", "b"],
    );
  });

  it("removes what it drained, so a message is delivered exactly once", async () => {
    await registerAgent({ root, name: "once", sessionId: "s-o", cwd: "/w" });
    await deliver({ root, target: "once", from: "a", fromSessionId: "s-a", message: "hello" });
    assert.equal((await drainInbox(root, "once")).messages.length, 1);
    assert.equal((await drainInbox(root, "once")).messages.length, 0);
  });

  it("drains an empty and a never-created inbox without throwing", async () => {
    assert.deepEqual((await drainInbox(root, "never-existed")).messages, []);
  });

  it("keeps an unparseable envelope as .bad instead of looping on it or deleting it", async () => {
    await registerAgent({ root, name: "rough", sessionId: "s-r", cwd: "/w" });
    await deliver({ root, target: "rough", from: "a", fromSessionId: "s-a", message: "good" });
    await writeFile(join(inboxDir(root, "rough"), "0000-bad.json"), "{ truncated");

    const first = await drainInbox(root, "rough");
    assert.deepEqual(
      first.messages.map((m) => m.message),
      ["good"],
    );
    assert.equal(first.problems.length, 1);

    const second = await drainInbox(root, "rough");
    assert.deepEqual(second.messages, []);
    assert.deepEqual(second.problems, []);
    const left = await readdir(inboxDir(root, "rough"));
    assert.deepEqual(left, ["0000-bad.json.bad"]);
    assert.equal(await readFile(join(inboxDir(root, "rough"), "0000-bad.json.bad"), "utf8"), "{ truncated");
  });
});

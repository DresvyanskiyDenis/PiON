/**
 * The regression suite for session `488f77ad`.
 *
 * Every case here is a behaviour that actually happened on the old harness — a teammate that wrote a
 * complete report and never delivered it, five times out of five — or a behaviour that must not be
 * introduced while fixing it (an unbounded reminder loop, a delivery reported as an empty answer).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_REMINDERS, OBLIGATION_LINE, REPLY_TOOL } from "../../extensions/teammates/contract.ts";
import { runExchange } from "../../extensions/teammates/exchange.ts";
import { TeamRegistry } from "../../extensions/teammates/team.ts";
import { FakeSession, sinkDeliver, type Turn } from "./fake.ts";

function withTeammate(script: Turn[]): { registry: TeamRegistry; session: FakeSession } {
  const registry = new TeamRegistry({ ownerSessionId: "lead-1" });
  const session = new FakeSession("reviewer", sinkDeliver(registry, "reviewer"), script);
  registry.add({ name: "reviewer", agent: "code-reviewer", session, spawnedAt: Date.now() });
  return { registry, session };
}

describe("runExchange", () => {
  it("carries the delivery obligation on the message itself, not only on the spawn", async () => {
    const { registry, session } = withTeammate([{ act: "deliver", report: "LGTM" }]);
    await runExchange({ registry, name: "reviewer", message: "review src/a.ts" });
    assert.match(session.prompts[0]!, /review src\/a\.ts/);
    assert.ok(session.prompts[0]!.includes(OBLIGATION_LINE), "every lead message restates the contract");
    assert.match(session.prompts[0]!, new RegExp(REPLY_TOOL));
  });

  it("a teammate that delivers on the first turn is never reminded", async () => {
    const { registry, session } = withTeammate([{ act: "deliver", report: "LGTM" }]);
    const result = await runExchange({ registry, name: "reviewer", message: "review" });
    assert.equal(result.outcome.phase, "delivered");
    assert.equal(result.outcome.delivery?.report, "LGTM");
    assert.equal(result.outcome.reminders, 0);
    assert.equal(session.prompts.length, 1);
  });

  it("THE 488f77ad SHAPE: finished the work, said nothing - reminded twice, then released", async () => {
    const updates: string[] = [];
    const { registry, session } = withTeammate([
      { act: "silent" },
      { act: "silent" },
      { act: "silent" },
    ]);
    const result = await runExchange({
      registry,
      name: "reviewer",
      message: "review",
      onUpdate: (line) => updates.push(line),
    });

    assert.equal(result.outcome.phase, "abandoned");
    assert.equal(result.outcome.reminders, MAX_REMINDERS);
    assert.equal(result.outcome.delivery, undefined);
    // 1 original + exactly 2 reminders. Not 3, not 22.
    assert.equal(session.prompts.length, 1 + MAX_REMINDERS);
    assert.equal(updates.length, MAX_REMINDERS);
    assert.match(updates[0]!, /went idle without delivering — reminding \(1\/2\)/);
    assert.match(updates[1]!, /\(2\/2\)/);
    assert.match(session.prompts[1]!, /reminder 1 of 2/);
    assert.match(session.prompts[2]!, /reminder 2 of 2/);
    // The lead is handed something to act on rather than an empty notification.
    assert.equal(result.sessionFile, "/tmp-fake/reviewer.jsonl");
    assert.match(result.salvage ?? "", /working notes from reviewer/);
  });

  it("a teammate that delivers only after the second reminder still succeeds", async () => {
    const { registry, session } = withTeammate([
      { act: "silent" },
      { act: "silent" },
      { act: "deliver", report: "the real report" },
    ]);
    const result = await runExchange({ registry, name: "reviewer", message: "review" });
    assert.equal(result.outcome.phase, "delivered");
    assert.equal(result.outcome.reminders, MAX_REMINDERS);
    assert.equal(result.outcome.delivery?.report, "the real report");
    assert.equal(session.prompts.length, 3);
    assert.equal(result.salvage, undefined, "a delivered exchange needs no salvage");
  });

  it('"blocked" is a delivery, not a failure to deliver', async () => {
    const { registry } = withTeammate([
      { act: "deliver", report: "the repo is not checked out", status: "blocked" },
    ]);
    const result = await runExchange({ registry, name: "reviewer", message: "review" });
    assert.equal(result.outcome.phase, "blocked");
    assert.equal(result.outcome.delivery?.status, "blocked");
    assert.equal(result.outcome.reminders, 0);
  });

  it("the registry is left resting, not stuck working, after every outcome", async () => {
    for (const script of [
      [{ act: "deliver", report: "x" } as Turn],
      [{ act: "silent" } as Turn, { act: "silent" } as Turn, { act: "silent" } as Turn],
    ]) {
      const { registry } = withTeammate(script);
      await runExchange({ registry, name: "reviewer", message: "review" });
      assert.equal(registry.require("reviewer").obligation, undefined);
      assert.ok(["idle", "abandoned"].includes(registry.require("reviewer").status));
      assert.equal(registry.require("reviewer").history.length, 1);
    }
  });

  it("a second message reaches the SAME session - the point of a teammate", async () => {
    const { registry, session } = withTeammate([
      { act: "deliver", report: "first" },
      { act: "deliver", report: "second" },
    ]);
    const a = await runExchange({ registry, name: "reviewer", message: "review src/a.ts" });
    const b = await runExchange({ registry, name: "reviewer", message: "what did you say?" });
    assert.equal(a.outcome.delivery?.report, "first");
    assert.equal(b.outcome.delivery?.report, "second");
    assert.equal(session.prompts.length, 2, "one live session, two turns");
    assert.equal(registry.require("reviewer").history.length, 2);
  });

  it("an aborted turn ends the exchange without reminding and is never a delivery", async () => {
    const controller = new AbortController();
    const registry = new TeamRegistry({ ownerSessionId: "lead-1" });
    const session = new FakeSession("reviewer", sinkDeliver(registry, "reviewer"), []);
    const original = session.prompt.bind(session);
    session.prompt = async (text: string) => {
      controller.abort();
      await original(text);
    };
    registry.add({ name: "reviewer", agent: "code-reviewer", session, spawnedAt: Date.now() });

    const result = await runExchange({
      registry,
      name: "reviewer",
      message: "review",
      signal: controller.signal,
    });
    assert.equal(result.outcome.phase, "aborted");
    assert.equal(result.outcome.reminders, 0);
    assert.equal(session.prompts.length, 1);
    assert.match(result.outcome.reason ?? "", /turn was aborted/);
  });

  it("a child that throws fails loud, names the transcript, and does not leave state behind", async () => {
    const { registry } = withTeammate([{ act: "throw", message: "provider 502" }]);
    await assert.rejects(
      runExchange({ registry, name: "reviewer", message: "review" }),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /teammate "reviewer" \(agent code-reviewer\) failed mid-exchange/);
        assert.match(msg, /Error: provider 502/);
        assert.match(msg, /\/tmp-fake\/reviewer\.jsonl/);
        return true;
      },
    );
    assert.equal(registry.require("reviewer").obligation, undefined);
    assert.equal(registry.require("reviewer").history[0]?.phase, "aborted");
  });

  it("a reply from a teammate the lead is not waiting on is refused, not silently accepted", async () => {
    const { registry } = withTeammate([{ act: "deliver", report: "x" }]);
    await runExchange({ registry, name: "reviewer", message: "review" });
    const verdict = registry.deliver("reviewer", "unsolicited afterthought", "complete");
    assert.equal(verdict.accepted, false);
    assert.equal(registry.require("reviewer").history.length, 1);
  });

  it("sending to an unknown teammate throws instead of returning nothing", async () => {
    const { registry } = withTeammate([]);
    await assert.rejects(runExchange({ registry, name: "ghost", message: "hi" }), /no teammate "ghost"/);
  });
});

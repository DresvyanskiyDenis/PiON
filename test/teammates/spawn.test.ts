/**
 * The structural half of the delivery obligation: what a child is given, before it is asked
 * anything. If these assertions fail, the obligation has quietly gone back to being advice.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_CONTRACT, MAX_REMINDERS, REPLY_TOOL } from "../../extensions/teammates/contract.ts";
import { createReplyTool } from "../../extensions/teammates/runtime.ts";
import { buildSpawnRequest, splitModel, widenTools } from "../../extensions/teammates/spawn.ts";
import { TeamRegistry } from "../../extensions/teammates/team.ts";
import { FakeSession, sinkDeliver } from "./fake.ts";

const AGENT = {
  name: "code-reviewer",
  systemPrompt: "You review code. Return your report as your final message.",
  target: { model: "copilot/gpt-5", provider: "copilot" },
};

describe("buildSpawnRequest - the obligation is appended by the RUNTIME", () => {
  it("appends the delivery contract to every spawn, whatever the agent file says", () => {
    const req = buildSpawnRequest("reviewer", AGENT, "/repo");
    assert.equal(req.systemPromptAppend.length, 2);
    assert.match(req.systemPromptAppend[0]!, /You review code/);
    assert.equal(req.systemPromptAppend[1], DELIVERY_CONTRACT);
  });

  it("puts the contract LAST, so it outranks an agent file written for the sub-agent contract", () => {
    const req = buildSpawnRequest("reviewer", AGENT, "/repo");
    const persona = req.systemPromptAppend.indexOf(req.systemPromptAppend[0]!);
    const contract = req.systemPromptAppend.indexOf(DELIVERY_CONTRACT);
    assert.ok(contract > persona, "the delivery contract must be the more recent instruction");
  });

  it("the contract text names the tool, the discard, and the blocked path", () => {
    assert.match(DELIVERY_CONTRACT, new RegExp(`${REPLY_TOOL}\\(report=`));
    assert.match(DELIVERY_CONTRACT, /delivered \*\*nowhere\*\*/);
    assert.match(DELIVERY_CONTRACT, /status="blocked"/);
    assert.match(DELIVERY_CONTRACT, new RegExp(`reminded at most ${MAX_REMINDERS} times`));
  });

  it("an agent with no tool allowlist keeps PI's default set", () => {
    assert.equal(widenTools(undefined), undefined);
    assert.equal(buildSpawnRequest("reviewer", AGENT, "/repo").tools, undefined);
  });

  it("THE TRAP: a restrictive tools: list is widened so the teammate CAN deliver", () => {
    const req = buildSpawnRequest("reviewer", { ...AGENT, tools: ["read", "grep"] }, "/repo");
    assert.deepEqual(req.tools, ["read", "grep", REPLY_TOOL]);
  });

  it("an allowlist that already names the reply tool is not duplicated", () => {
    assert.deepEqual(widenTools(["read", REPLY_TOOL]), ["read", REPLY_TOOL]);
  });

  it("splits provider/id for the SDK, and tolerates a bare id", () => {
    assert.deepEqual(splitModel("copilot/gpt-5", "copilot"), { provider: "copilot", id: "gpt-5" });
    assert.deepEqual(splitModel("gpt-5", "copilot"), { provider: "copilot", id: "gpt-5" });
    assert.deepEqual(buildSpawnRequest("r", AGENT, "/repo").model, { provider: "copilot", id: "gpt-5" });
  });

  it("an agent with no resolved model carries none, rather than a guess", () => {
    const req = buildSpawnRequest("r", { name: "x", systemPrompt: "y" }, "/repo");
    assert.equal(req.model, undefined);
  });
});

describe("createReplyTool - the single write path", () => {
  const registry = new TeamRegistry({ ownerSessionId: "lead-1" });
  registry.add({
    name: "reviewer",
    agent: "code-reviewer",
    session: new FakeSession("reviewer", sinkDeliver(registry, "reviewer"), []),
    spawnedAt: Date.now(),
  });
  const tool = createReplyTool("reviewer", registry);

  it("is named reply_to_lead and says the final message is discarded", () => {
    assert.equal(tool.name, REPLY_TOOL);
    assert.match(tool.description, /ONLY way your work reaches anyone/);
    assert.match(tool.description, /discarded/);
    assert.ok(tool.promptSnippet, "the child must see it in its own tool list");
    assert.ok((tool.promptGuidelines ?? []).some((g) => g.includes("blocked")));
  });

  it("writes a report into the open obligation and confirms it to the child", async () => {
    const obligation = registry.open("reviewer");
    const result = await tool.execute("call-1", { report: "LGTM" }, undefined, undefined, {} as never);
    assert.equal(obligation.delivery?.report, "LGTM");
    assert.equal(obligation.delivery?.status, "complete");
    assert.match(textOf(result), /^delivered$/);
    registry.close("reviewer");
  });

  it('carries status="blocked" through', async () => {
    const obligation = registry.open("reviewer");
    await tool.execute(
      "call-2",
      { report: "no network", status: "blocked" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(obligation.delivery?.status, "blocked");
    registry.close("reviewer");
  });

  it("tells the child plainly when its report was NOT received", async () => {
    const result = await tool.execute("call-3", { report: "too late" }, undefined, undefined, {} as never);
    assert.match(textOf(result), /not delivered/);
    assert.equal((result.details as { accepted: boolean }).accepted, false);
  });

  it("a report delivered after release is reported as late, not as accepted", async () => {
    const obligation = registry.open("reviewer");
    for (let i = 0; i <= MAX_REMINDERS; i += 1) obligation.onIdle();
    const result = await tool.execute("call-4", { report: "I had it" }, undefined, undefined, {} as never);
    assert.match(textOf(result), /received late/);
    assert.equal(obligation.lateDelivery?.report, "I had it");
    registry.close("reviewer");
  });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

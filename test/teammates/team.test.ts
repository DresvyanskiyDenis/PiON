import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_TEAMMATES } from "../../extensions/teammates/contract.ts";
import { TeamRegistry, TeammateError } from "../../extensions/teammates/team.ts";
import { FakeSession, sinkDeliver } from "./fake.ts";

function team(): TeamRegistry {
  return new TeamRegistry({ ownerSessionId: "lead-1" });
}

function join(registry: TeamRegistry, name: string, agent = "code-reviewer"): FakeSession {
  const session = new FakeSession(name, sinkDeliver(registry, name), []);
  registry.add({ name, agent, session, spawnedAt: Date.now() });
  return session;
}

describe("TeamRegistry - the named, session-scoped registry", () => {
  it("addresses a teammate by name across calls", () => {
    const t = team();
    join(t, "reviewer");
    assert.equal(t.require("reviewer").agent, "code-reviewer");
    assert.equal(t.require("reviewer").session, t.require("reviewer").session);
  });

  it("refuses a duplicate name rather than silently replacing a live session", () => {
    const t = team();
    join(t, "reviewer");
    assert.throws(() => join(t, "reviewer"), /already exists/);
  });

  it("caps the team and names who is already there", () => {
    const t = team();
    for (let i = 0; i < MAX_TEAMMATES; i += 1) join(t, `mate-${i}`);
    assert.throws(
      () => join(t, "one-too-many"),
      (err: unknown) =>
        err instanceof TeammateError && /refused — 4 already live \(mate-0, mate-1, mate-2, mate-3\)/.test(err.message),
    );
  });

  it("rejects names that are not handles", () => {
    const t = team();
    for (const bad of ["", "Reviewer", "1st", "has space", "a".repeat(33), "trailing_underscore"]) {
      assert.throws(() => t.assertCanSpawn(bad), /invalid/, `expected "${bad}" to be rejected`);
    }
    t.assertCanSpawn("code-reviewer-2");
  });

  it("a missing teammate throws and lists who is live - never an empty answer", () => {
    const t = team();
    join(t, "reviewer");
    assert.throws(() => t.require("ghost"), /no teammate "ghost". Live teammates: reviewer/);
  });

  it("deliver() with no open obligation is refused, and says so to the child", () => {
    const t = team();
    join(t, "reviewer");
    const verdict = t.deliver("reviewer", "unsolicited", "complete");
    assert.equal(verdict.accepted, false);
    assert.match(verdict.note, /not waiting on you/);
  });

  it("deliver() for an unknown teammate tells the child its report was not received", () => {
    const t = team();
    const verdict = t.deliver("ghost", "report", "complete");
    assert.equal(verdict.accepted, false);
    assert.match(verdict.note, /no longer registered/);
  });

  it("open/deliver/close is the whole happy path, and the transcript keeps the report", () => {
    const t = team();
    join(t, "reviewer");
    t.open("reviewer");
    assert.equal(t.require("reviewer").status, "working");
    assert.equal(t.deliver("reviewer", "LGTM", "complete").accepted, true);
    const outcome = t.close("reviewer");
    assert.equal(outcome?.phase, "delivered");
    assert.equal(t.require("reviewer").status, "idle");
    assert.deepEqual(
      t.require("reviewer").transcript.map((l) => l.from),
      ["teammate"],
    );
  });

  it("an abandoned exchange leaves the teammate marked abandoned and STRANDED", () => {
    const t = team();
    join(t, "reviewer");
    const ob = t.open("reviewer");
    for (let i = 0; i < 5; i += 1) ob.onIdle();
    t.close("reviewer");
    assert.equal(t.require("reviewer").status, "abandoned");
    const stranded = t.stranded();
    assert.equal(stranded.length, 1);
    assert.match(stranded[0]!.why, /UNDELIVERED/);
  });

  it("a teammate mid-exchange counts as stranded until it delivers", () => {
    const t = team();
    join(t, "reviewer");
    t.open("reviewer");
    assert.match(t.stranded()[0]!.why, /still working/);
    t.deliver("reviewer", "done", "complete");
    t.close("reviewer");
    assert.deepEqual(t.stranded(), []);
  });

  it("a late delivery is recorded but does not clear the stranded flag", () => {
    const t = team();
    join(t, "reviewer");
    const ob = t.open("reviewer");
    for (let i = 0; i < 5; i += 1) ob.onIdle();
    t.close("reviewer");
    t.deliver("reviewer", "I had it all along", "complete");
    assert.equal(t.stranded().length, 1);
  });

  it("render() names the transcript file of every teammate, delivered or not", () => {
    const t = team();
    join(t, "reviewer");
    const text = t.render();
    assert.match(text, /reviewer/);
    assert.match(text, /transcript: \/tmp-fake\/reviewer\.jsonl/);
    assert.match(text, /1\/4/);
  });

  it("render() on an empty team says so and names the owning session", () => {
    assert.match(team().render(), /no teammates in session lead-1/);
  });

  it("remove() disposes the child session and frees the name", () => {
    const t = team();
    const session = join(t, "reviewer");
    return t.remove("reviewer").then(() => {
      assert.equal(session.disposed, 1);
      assert.equal(t.size, 0);
      t.assertCanSpawn("reviewer");
    });
  });

  it("clear() disposes every child - no orphan sessions at shutdown", async () => {
    const t = team();
    const a = join(t, "a");
    const b = join(t, "b");
    await t.clear();
    assert.equal(a.disposed, 1);
    assert.equal(b.disposed, 1);
    assert.equal(t.size, 0);
  });

  it("a child whose dispose() throws does not strand the others", async () => {
    const t = team();
    const good = join(t, "good");
    const bad = join(t, "bad");
    bad.dispose = () => {
      throw new Error("boom");
    };
    await t.clear();
    assert.equal(good.disposed, 1);
    assert.equal(t.size, 0);
  });
});

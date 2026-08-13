import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { denyWithEscapeHatch } from "../../extensions/lib/escape-hatch.ts";
import {
  dispatchVetoes,
  EGRESS_RANK,
  egressAllows,
  evaluateDispatch,
  registerDispatchVeto,
  resetDispatchVetoes,
  type DispatchRequest,
} from "../../extensions/lib/dispatch-veto.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

const req = (over: Partial<DispatchRequest> = {}): DispatchRequest => ({
  agentType: "general-purpose",
  prompt: "find out what changed in the vite 8 release",
  ...over,
});

describe("egressAllows", () => {
  it("a confidential session may not dispatch onto a public provider", () => {
    assert.equal(egressAllows("confidential", "public"), false);
    assert.equal(egressAllows("confidential", "internal"), false);
    assert.equal(egressAllows("confidential", "confidential"), true);
  });

  it("a less restricted session may dispatch onto a more restricted provider", () => {
    assert.equal(egressAllows("public", "confidential"), true);
    assert.equal(egressAllows("internal", "confidential"), true);
    assert.equal(egressAllows("internal", "public"), false);
    assert.equal(egressAllows("public", "public"), true);
  });

  it("the ranks match config/routing.json's egress vocabulary", () => {
    assert.deepEqual(Object.keys(EGRESS_RANK).sort(), ["confidential", "internal", "public"]);
    assert.ok(EGRESS_RANK.confidential < EGRESS_RANK.internal);
    assert.ok(EGRESS_RANK.internal < EGRESS_RANK.public);
  });
});

describe("evaluateDispatch", () => {
  beforeEach(() => {
    resetDispatchVetoes();
    resetSurfaced();
  });

  it("no registered veto means no veto — EXT-05 fills the implementation, not EXT-01", async () => {
    assert.deepEqual(dispatchVetoes(), []);
    assert.deepEqual(await evaluateDispatch(req()), { veto: false });
  });

  it("the first veto wins and short-circuits", async () => {
    const seen: string[] = [];
    registerDispatchVeto({
      id: "DV-A",
      evaluate: () => {
        seen.push("DV-A");
        return { veto: false };
      },
    });
    registerDispatchVeto({
      id: "DV-SPECIALIST",
      evaluate: () => {
        seen.push("DV-SPECIALIST");
        return {
          veto: true,
          denial: {
            gateId: "DV-SPECIALIST",
            what: "dispatching general-purpose for web research",
            legitimateUse: "The researcher agent covers this.",
            overridable: true,
          },
        };
      },
    });
    registerDispatchVeto({
      id: "DV-NEVER",
      evaluate: () => {
        seen.push("DV-NEVER");
        return { veto: false };
      },
    });

    const verdict = await evaluateDispatch(req());
    assert.equal(verdict.veto, true);
    assert.deepEqual(seen, ["DV-A", "DV-SPECIALIST"]);
  });

  it("a veto's denial feeds straight into the escape hatch — one gate vocabulary", async () => {
    registerDispatchVeto({
      id: "DV-SPECIALIST",
      evaluate: () => ({
        veto: true,
        denial: {
          gateId: "DV-SPECIALIST",
          what: "general-purpose was dispatched for a web-research prompt",
          legitimateUse: "Use the researcher agent.",
          overridable: true,
        },
      }),
    });
    const verdict = await evaluateDispatch(req());
    assert.equal(verdict.veto, true);
    if (!verdict.veto) return;
    const { reason } = denyWithEscapeHatch(verdict.denial);
    assert.match(reason, /Blocked by gate DV-SPECIALIST/);
    assert.match(reason, /Use the researcher agent\./);
    assert.match(reason, /PI-JUSTIFY\(DV-SPECIALIST\)/);
  });

  it("a veto that throws is skipped and surfaced once, never blocking dispatch", async () => {
    const lines: string[] = [];
    registerDispatchVeto({
      id: "DV-BROKEN",
      evaluate: () => {
        throw new Error("routing.json is malformed");
      },
    });
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(await evaluateDispatch(req(), (l) => void lines.push(l)), { veto: false });
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /DV-BROKEN failed internally and was skipped/);
    assert.match(lines[0], /routing.json is malformed/);
  });

  it("a broken veto does not stop a later working one", async () => {
    registerDispatchVeto({
      id: "DV-BROKEN",
      evaluate: () => {
        throw new Error("boom");
      },
    });
    registerDispatchVeto({
      id: "DV-EGRESS",
      evaluate: (r) =>
        r.parentEgress && r.childEgress && !egressAllows(r.parentEgress, r.childEgress)
          ? {
              veto: true,
              denial: {
                gateId: "DV-EGRESS",
                what: `a ${r.parentEgress} session may not dispatch onto a ${r.childEgress} provider`,
                overridable: false,
              },
            }
          : { veto: false },
    });

    const blocked = await evaluateDispatch(
      req({ parentEgress: "confidential", childEgress: "public", childProvider: "github-copilot" }),
      () => {},
    );
    assert.equal(blocked.veto, true);
    if (blocked.veto) assert.equal(blocked.denial.overridable, false);

    const fine = await evaluateDispatch(
      req({ parentEgress: "confidential", childEgress: "confidential" }),
      () => {},
    );
    assert.deepEqual(fine, { veto: false });
  });

  it("an async veto is awaited", async () => {
    registerDispatchVeto({
      id: "DV-ASYNC",
      evaluate: async () => ({
        veto: true,
        denial: { gateId: "DV-ASYNC", what: "async match", overridable: true },
      }),
    });
    assert.equal((await evaluateDispatch(req())).veto, true);
  });

  it("dispatchVetoes returns a copy, so a caller cannot mutate the registry", () => {
    registerDispatchVeto({ id: "DV-A", evaluate: () => ({ veto: false }) });
    const copy = dispatchVetoes() as unknown as unknown[];
    copy.length = 0;
    assert.equal(dispatchVetoes().length, 1);
  });
});

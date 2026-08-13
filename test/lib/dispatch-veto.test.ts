import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { denyWithEscapeHatch } from "../../extensions/lib/escape-hatch.ts";
import * as dispatchVeto from "../../extensions/lib/dispatch-veto.ts";
import {
  dispatchVetoes,
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

/**
 * WITHDRAWN 2026-08-13. This module used to export `EGRESS_RANK` (an ordering over the three egress
 * classes) and `egressAllows()` (the predicate built on it), which together let a session be refused
 * a provider classed "looser" than itself. Three tests here asserted that ordering.
 *
 * The rule was withdrawn because it refused far more than it protected: with most providers classed
 * looser than the session, most agents became undispatchable and changing provider inside a session
 * was impossible. The class survives as a reporting label only — which means there must be no
 * ordering left for anything to compare against. These two tests are the guard that nobody
 * reintroduces one, and they replace the three that asserted it.
 */
describe("egress classes are labels, not a lattice", () => {
  it("exports no rank table and no containment predicate", () => {
    const surface = dispatchVeto as unknown as Record<string, unknown>;
    assert.equal(surface.EGRESS_RANK, undefined, "an ordering over the classes is the withdrawn rule");
    assert.equal(surface.egressAllows, undefined, "the containment predicate is the withdrawn rule");
  });

  it("still carries the class on a request, for reporting", () => {
    const r = req({ parentEgress: "confidential", childEgress: "public" });
    assert.equal(r.parentEgress, "confidential");
    assert.equal(r.childEgress, "public");
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
      id: "DV-PROVIDER",
      evaluate: (r) =>
        r.childProvider === "forbidden-provider"
          ? {
              veto: true,
              denial: {
                gateId: "DV-PROVIDER",
                what: `the provider "${r.childProvider}" is not configured`,
                overridable: false,
              },
            }
          : { veto: false },
    });

    const blocked = await evaluateDispatch(
      req({ parentEgress: "confidential", childEgress: "public", childProvider: "forbidden-provider" }),
      () => {},
    );
    assert.equal(blocked.veto, true);
    if (blocked.veto) assert.equal(blocked.denial.overridable, false);

    // The same pair of classes that the withdrawn containment rule refused: no veto looks at them.
    const fine = await evaluateDispatch(
      req({ parentEgress: "confidential", childEgress: "public", childProvider: "github-copilot" }),
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertDispatchShape,
  describeReturnContract,
  parseReturnContract,
} from "../../extensions/dispatch/contract.ts";

const joined = (problems: readonly string[]) => problems.join("\n");

describe("parseReturnContract", () => {
  it("defaults to a subagent returning text", () => {
    const r = parseReturnContract({}, "scout");
    assert.deepEqual(r.contract, { mode: "subagent", returns: "text" });
    assert.deepEqual(r.problems, []);
  });

  it("accepts a subagent with a structured return", () => {
    const r = parseReturnContract({ mode: "subagent", returns: "object" }, "scout");
    assert.deepEqual(r.contract, { mode: "subagent", returns: "object" });
    assert.deepEqual(r.problems, []);
  });

  it("REQUIRES delivery on a teammate - the hard-won contract", () => {
    const r = parseReturnContract({ mode: "teammate" }, "reviewer");
    assert.equal(r.problems.length, 1);
    assert.match(joined(r.problems), /requires delivery/);
    assert.match(joined(r.problems), /delivered NOWHERE/);
  });

  it("accepts a teammate that declares its channel", () => {
    const r = parseReturnContract({ mode: "teammate", delivery: "SendMessage to the lead" }, "reviewer");
    assert.deepEqual(r.problems, []);
    assert.equal(r.contract.mode, "teammate");
    assert.equal(r.contract.delivery, "SendMessage to the lead");
    assert.equal(r.contract.returns, "text");
  });

  it("rejects returns: object on a teammate, because nothing is returned", () => {
    const r = parseReturnContract({ mode: "teammate", delivery: "SendMessage", returns: "object" }, "reviewer");
    assert.equal(r.problems.length, 1);
    assert.match(joined(r.problems), /cannot declare returns: object/);
    assert.equal(r.contract.returns, "text", "the contract is normalised to text regardless");
  });

  it("rejects delivery: on a subagent, because its final message IS the return value", () => {
    const r = parseReturnContract({ delivery: "SendMessage" }, "scout");
    assert.equal(r.problems.length, 1);
    assert.match(joined(r.problems), /only meaningful with mode: teammate/);
  });

  it("rejects an unknown mode and an unknown returns shape by name", () => {
    const r = parseReturnContract({ mode: "worker", returns: "json" }, "scout");
    assert.equal(r.problems.length, 2);
    assert.match(joined(r.problems), /mode "worker" is not one of subagent\|teammate/);
    assert.match(joined(r.problems), /returns "json" is not one of text\|object/);
  });

  it("rejects a blank delivery channel", () => {
    const r = parseReturnContract({ mode: "teammate", delivery: "   " }, "reviewer");
    assert.match(joined(r.problems), /delivery must be a non-empty string/);
  });

  it("reports every problem at once, so one load pass sees them all", () => {
    const r = parseReturnContract({ mode: "teammate", returns: "object" }, "reviewer");
    assert.equal(r.problems.length, 2);
  });
});

describe("describeReturnContract", () => {
  it("says where the result goes", () => {
    assert.match(describeReturnContract({ mode: "subagent", returns: "text" }), /final message is the return value/);
    assert.match(
      describeReturnContract({ mode: "teammate", returns: "text", delivery: "SendMessage" }),
      /returns nothing; delivers via SendMessage/,
    );
  });
});

describe("assertDispatchShape", () => {
  const teammate = { mode: "teammate", returns: "text", delivery: "SendMessage" } as const;
  const subagent = { mode: "subagent", returns: "text" } as const;

  it("lets a subagent be dispatched any way at all", () => {
    assert.equal(assertDispatchShape(subagent, { structuredOutput: true, awaitsResult: true }, "scout"), undefined);
  });

  it("refuses a teammate under an output schema", () => {
    const msg = assertDispatchShape(teammate, { structuredOutput: true, awaitsResult: false }, "reviewer");
    assert.match(msg ?? "", /cannot satisfy a structured output schema/);
  });

  it("refuses a teammate the caller intends to wait on", () => {
    const msg = assertDispatchShape(teammate, { structuredOutput: false, awaitsResult: true }, "reviewer");
    assert.match(msg ?? "", /delivered through "SendMessage", not returned to this tool call/);
  });

  it("allows an async, unstructured teammate dispatch", () => {
    assert.equal(
      assertDispatchShape(teammate, { structuredOutput: false, awaitsResult: false }, "reviewer"),
      undefined,
    );
  });
});

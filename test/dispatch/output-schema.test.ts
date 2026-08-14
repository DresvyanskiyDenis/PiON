/**
 * Regression cover for `DSP-SCHEMA` (`extensions/dispatch/output-schema.ts`).
 *
 * The failure this closes: a sub-agent finished a long run, then died on
 * `structured_output failed (exit 1): Validation failed for tool "structured_output": - value:
 * must not have additional properties`, because the orchestrating model had generated an
 * `outputSchema` closed with `additionalProperties: false` and the child answered with three keys
 * more than it was asked for. Nothing was missing and nothing was mistyped — the answer was a
 * superset of the contract, and the whole run was discarded for it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeRelaxation,
  relaxClosedObjects,
  relaxDispatchOutputSchemas,
} from "../../extensions/dispatch/output-schema.ts";

/** The shape from the failing dispatch, trimmed to the keys that matter. */
const CLOSED_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "risks"],
  additionalProperties: false,
} as const;

describe("relaxClosedObjects", () => {
  it("REGRESSION: drops additionalProperties:false at the root and reports the pointer", () => {
    const { schema, relaxed } = relaxClosedObjects(CLOSED_SCHEMA);
    assert.deepEqual(relaxed, ["#"]);
    assert.equal((schema as Record<string, unknown>).additionalProperties, undefined);
  });

  it("leaves required, type and per-property schemas exactly as they were", () => {
    const { schema } = relaxClosedObjects(CLOSED_SCHEMA);
    assert.deepEqual(schema, {
      type: "object",
      properties: {
        summary: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "risks"],
    });
  });

  it("does not mutate the schema it was handed", () => {
    const input = { type: "object", properties: {}, additionalProperties: false };
    relaxClosedObjects(input);
    assert.equal(input.additionalProperties, false);
  });

  it("reaches nested objects under properties, items, $defs and anyOf", () => {
    const { schema, relaxed } = relaxClosedObjects({
      type: "object",
      properties: {
        finding: { type: "object", properties: {}, additionalProperties: false },
        list: { type: "array", items: { type: "object", additionalProperties: false } },
      },
      $defs: { source: { type: "object", additionalProperties: false } },
      anyOf: [{ type: "object", additionalProperties: false }],
    });
    assert.deepEqual(relaxed.sort(), [
      "#/$defs/source",
      "#/anyOf/0",
      "#/properties/finding",
      "#/properties/list/items",
    ]);
    const out = schema as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(out.properties.finding.additionalProperties, undefined);
    assert.equal(out.$defs.source.additionalProperties, undefined);
  });

  it("keeps additionalProperties when it is a schema — that constrains extras, it does not ban them", () => {
    const { schema, relaxed } = relaxClosedObjects({
      type: "object",
      additionalProperties: { type: "string" },
    });
    assert.deepEqual(relaxed, []);
    assert.deepEqual((schema as Record<string, unknown>).additionalProperties, { type: "string" });
  });

  it("still opens a closed object nested inside an additionalProperties schema", () => {
    const { relaxed } = relaxClosedObjects({
      type: "object",
      additionalProperties: { type: "object", additionalProperties: false },
    });
    assert.deepEqual(relaxed, ["#/additionalProperties"]);
  });

  it("reports nothing for an already-open schema", () => {
    assert.deepEqual(relaxClosedObjects({ type: "object", properties: { a: { type: "string" } } }).relaxed, []);
  });

  it("passes non-schema values straight through", () => {
    assert.deepEqual(relaxClosedObjects(undefined), { schema: undefined, relaxed: [] });
    assert.deepEqual(relaxClosedObjects(true), { schema: true, relaxed: [] });
  });
});

describe("relaxDispatchOutputSchemas", () => {
  it("REGRESSION: rewrites the dispatch call's outputSchema in place", () => {
    const input: Record<string, unknown> = {
      agent: "researcher",
      task: "investigate",
      outputSchema: { ...CLOSED_SCHEMA },
    };
    const applied = relaxDispatchOutputSchemas(input);
    assert.deepEqual(applied, [{ argument: "outputSchema", paths: ["#"] }]);
    assert.equal((input.outputSchema as Record<string, unknown>).additionalProperties, undefined);
    assert.deepEqual((input.outputSchema as Record<string, unknown>).required, ["summary", "risks"]);
  });

  it("reaches the same argument on every item of a fanout array", () => {
    const input: Record<string, unknown> = {
      tasks: [
        { agent: "researcher", outputSchema: { type: "object", additionalProperties: false } },
        { agent: "researcher", outputSchema: { type: "object" } },
      ],
    };
    const applied = relaxDispatchOutputSchemas(input);
    assert.deepEqual(applied, [{ argument: "tasks[0].outputSchema", paths: ["#"] }]);
  });

  it("leaves a call with no outputSchema byte-identical", () => {
    const input: Record<string, unknown> = { agent: "researcher", task: "investigate" };
    assert.deepEqual(relaxDispatchOutputSchemas(input), []);
    assert.deepEqual(input, { agent: "researcher", task: "investigate" });
  });

  it("leaves an already-open outputSchema untouched and reports no rewrite", () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const input: Record<string, unknown> = { agent: "researcher", outputSchema: schema };
    assert.deepEqual(relaxDispatchOutputSchemas(input), []);
    assert.equal(input.outputSchema, schema, "the object identity is preserved when nothing changed");
  });
});

describe("describeRelaxation", () => {
  it("names the agent, the argument, the pointer and what is still enforced", () => {
    const line = describeRelaxation("researcher", [{ argument: "outputSchema", paths: ["#"] }]);
    assert.match(line, /"researcher"/);
    assert.match(line, /additionalProperties: false/);
    assert.match(line, /outputSchema \(#\)/);
    assert.match(line, /Required keys and types are still enforced/);
  });
});

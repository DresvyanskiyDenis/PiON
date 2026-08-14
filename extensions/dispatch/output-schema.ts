/**
 * `DSP-SCHEMA` — the one keyword in a model-authored `outputSchema` that turns a finished run into
 * a discarded one.
 *
 * ## What was observed
 *
 * A sub-agent dispatched with an `outputSchema` the ORCHESTRATING MODEL invented for that one call
 * ran for minutes, did the work, and finished — then died on:
 *
 *     structured_output failed (exit 1): Validation failed for tool "structured_output":
 *       - value: must not have additional properties
 *
 * The schema declared seven keys and closed itself with `additionalProperties: false`; the child
 * submitted those seven plus three more. Nothing was missing. Nothing was mistyped. The answer was
 * a superset of the contract.
 *
 * ## Why relaxing it is right rather than lenient
 *
 * 1. **Nobody asked for closedness.** The schema is not ours and not the agent file's: it is
 *    generated per call by the orchestrating model, which is copying the OpenAI strict-mode idiom
 *    where `additionalProperties: false` is mandatory. `pi-subagents` reinforces it — the argument
 *    is described as "JSON Schema object for strict structured output"
 *    (`src/extension/schemas.ts`). It is a habit, not a decision.
 *
 * 2. **The failure is not recoverable, only survivable-looking.** `detectSubagentError`
 *    (`src/shared/utils.ts`) scans backwards for an errored `toolResult` and stops only at the last
 *    assistant message carrying TEXT. A structured-output run ends on a tool call, not on text, so
 *    that stop marker never exists and the scan reaches the already-superseded validation error.
 *    `src/runs/foreground/execution.ts` then sets `exitCode = 1` BEFORE the block that would have
 *    read the captured output. Observed end to end: the child retried, wrote "Structured output
 *    captured.", and the parent still received `structured_output failed (exit 1)`. Whatever the
 *    child does after the first violation is unreachable — that code is in `node_modules/` and is
 *    not ours to patch.
 *
 * 3. **The contract the caller actually depends on is untouched.** `required`, `type`, per-property
 *    schemas, nested objects — all still validated, all still able to fail the run loudly. Only
 *    "and nothing else" is dropped. A parent reads the keys it asked for; an extra key is
 *    information it ignores, never a wrong answer.
 *
 * This is a rewrite, so it is announced (`DSP-RESOLVE` rewrites models and fanout widths on the
 * same principle). It is not a fallback and it substitutes nothing: no schema is replaced, no
 * validation is skipped, and a genuinely wrong shape still aborts the run.
 *
 * ## Reach
 *
 * The dispatch tool's own `outputSchema` argument, and the same argument on each item of a fanout
 * array (`tasks`, `parallel`, `chain`, `expand` — `concurrency.ts`'s `FANOUT_KEYS`). A schema built
 * inside a `workflowScript` string is out of reach from a `tool_call` hook and is left alone.
 */
import { FANOUT_KEYS } from "./concurrency.ts";

/** Keywords whose value is a MAP of subschemas. */
const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"] as const;
/** Keywords whose value is an ARRAY of subschemas. */
const ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
/** Keywords whose value is a single subschema (`items` may also be an array, handled below). */
const SINGLE_KEYWORDS = ["items", "not", "if", "then", "else", "contains", "propertyNames"] as const;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `schema` with every `additionalProperties: false` removed, and the JSON-pointer
 * paths it removed them from. `additionalProperties: <schema>` is left alone: it constrains the
 * shape of an extra key rather than forbidding one outright.
 */
export function relaxClosedObjects(schema: unknown, pointer = "#"): { schema: unknown; relaxed: string[] } {
  if (!isSchemaObject(schema)) return { schema, relaxed: [] };

  const out: Record<string, unknown> = { ...schema };
  const relaxed: string[] = [];

  if (out.additionalProperties === false) {
    delete out.additionalProperties;
    relaxed.push(pointer);
  } else if (isSchemaObject(out.additionalProperties)) {
    const nested = relaxClosedObjects(out.additionalProperties, `${pointer}/additionalProperties`);
    out.additionalProperties = nested.schema;
    relaxed.push(...nested.relaxed);
  }

  for (const keyword of MAP_KEYWORDS) {
    const entries = out[keyword];
    if (!isSchemaObject(entries)) continue;
    out[keyword] = Object.fromEntries(
      Object.entries(entries).map(([name, nested]) => {
        const result = relaxClosedObjects(nested, `${pointer}/${keyword}/${name}`);
        relaxed.push(...result.relaxed);
        return [name, result.schema];
      }),
    );
  }

  for (const keyword of ARRAY_KEYWORDS) {
    const entries = out[keyword];
    if (!Array.isArray(entries)) continue;
    out[keyword] = entries.map((nested, i) => {
      const result = relaxClosedObjects(nested, `${pointer}/${keyword}/${i}`);
      relaxed.push(...result.relaxed);
      return result.schema;
    });
  }

  for (const keyword of SINGLE_KEYWORDS) {
    const entry = out[keyword];
    if (Array.isArray(entry)) {
      out[keyword] = entry.map((nested, i) => {
        const result = relaxClosedObjects(nested, `${pointer}/${keyword}/${i}`);
        relaxed.push(...result.relaxed);
        return result.schema;
      });
      continue;
    }
    if (!isSchemaObject(entry)) continue;
    const result = relaxClosedObjects(entry, `${pointer}/${keyword}`);
    out[keyword] = result.schema;
    relaxed.push(...result.relaxed);
  }

  return { schema: out, relaxed };
}

export interface SchemaRelaxation {
  /** Where the schema sat on the call, e.g. `outputSchema` or `tasks[2].outputSchema`. */
  readonly argument: string;
  /** JSON-pointer paths inside that schema that were opened. */
  readonly paths: readonly string[];
}

/**
 * Rewrites every reachable `outputSchema` on a dispatch call in place. Returns one entry per
 * schema that actually changed; an empty array means the call was left byte-identical.
 */
export function relaxDispatchOutputSchemas(input: Record<string, unknown>): SchemaRelaxation[] {
  const applied: SchemaRelaxation[] = [];

  const relaxAt = (owner: Record<string, unknown>, argument: string): void => {
    const current = owner.outputSchema;
    if (!isSchemaObject(current)) return;
    const { schema, relaxed } = relaxClosedObjects(current);
    if (relaxed.length === 0) return;
    owner.outputSchema = schema;
    applied.push({ argument, paths: relaxed });
  };

  relaxAt(input, "outputSchema");

  for (const key of FANOUT_KEYS) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    value.forEach((item, i) => {
      if (isSchemaObject(item)) relaxAt(item, `${key}[${i}].outputSchema`);
    });
  }

  return applied;
}

/** The one-line reason shown to the human, naming the agent, the argument and the paths. */
export function describeRelaxation(agent: string, applied: readonly SchemaRelaxation[]): string {
  const where = applied
    .map((a) => `${a.argument} (${a.paths.join(", ")})`)
    .join("; ");
  return (
    `dispatch: dropped \`additionalProperties: false\` from the outputSchema of "${agent}" — ${where}. ` +
    `Required keys and types are still enforced; only "and no other keys" was removed, because a ` +
    `child that answers with MORE than it was asked for otherwise loses the whole run.`
  );
}

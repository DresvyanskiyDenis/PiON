/**
 * `<project>/.pi/lead-model.json` — the shape, the parser, the validator and the one writer.
 *
 * ## What the file names, and why it is a tier
 *
 * A `config/routing.json` tier name, exactly as `config/path-defaults.json` does, rather than a
 * literal `provider/id`. `config/README.md` rule 3 ("no bare model id outside `routing.json` and
 * `models.json`") is reason enough on its own, and it costs nothing here: the pin's job is to stop
 * the lead moving *under a work stream*, and a tier resolves through a committed config file that
 * does not move on its own either.
 *
 * ## Why `reason` is required, and why it has a floor
 *
 * A pin is not a preference, it is a recorded decision, and a decision with no reason is a
 * preference wearing a hat. {@link MIN_REASON_LENGTH} is the cheapest floor that can be put under
 * "say something": it rules out `"x"`, `"tmp"` and `"."` without pretending to judge prose. The
 * same floor is enforced here and by the `/lead-model` command, because they write the same field,
 * and a file that only the command validated would be a file anyone can hand-edit past the check.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Short enough that no honest reason trips it, long enough that a placeholder does. */
export const MIN_REASON_LENGTH = 12;

export interface LeadModelPin {
  readonly version: 1;
  /** A `config/routing.json` tier name, resolved by `extensions/path-defaults/routing.ts`. */
  readonly tier: string;
  /** `YYYY-MM-DD`, the day this pin was last set. Written by `/lead-model`, read by people. */
  readonly since: string;
  /** Why this project is on this tier, in the operator's own words. */
  readonly reason: string;
}

/**
 * No TypeScript parameter properties on purpose: Node's `--test` type-strips rather than
 * transforms, so `constructor(readonly x: T)` throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at run
 * time. `extensions/path-defaults/config.ts` carries the same note for the same reason.
 */
export class LeadModelShapeError extends Error {
  readonly source: string;

  constructor(message: string, source: string) {
    super(`${source}: ${message}`);
    this.name = "LeadModelShapeError";
    this.source = source;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Structural validation only. Never touches disk and never resolves a tier, which keeps it unit
 * testable and lets `bin/rules/pc-30-lead-model-shape.mjs` restate the same rules offline in plain
 * JavaScript against a committed pin. Throws on the first problem, naming `source`.
 */
export function validateLeadModelPin(value: unknown, source: string): LeadModelPin {
  const fail = (message: string): never => {
    throw new LeadModelShapeError(message, source);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return fail(`"version" must be 1, got ${JSON.stringify(obj.version)}`);

  if (typeof obj.tier !== "string" || obj.tier.length === 0) {
    return fail('"tier" must be a non-empty string naming a config/routing.json tier');
  }
  if (typeof obj.since !== "string" || !ISO_DATE.test(obj.since)) {
    return fail(`"since" must be a YYYY-MM-DD date, got ${JSON.stringify(obj.since)}`);
  }
  if (typeof obj.reason !== "string" || obj.reason.trim().length < MIN_REASON_LENGTH) {
    return fail(
      `"reason" must say why this project is pinned, in at least ${MIN_REASON_LENGTH} characters. ` +
        "A pin without a reason is a preference, and the next session cannot tell the two apart.",
    );
  }

  return { version: 1, tier: obj.tier, since: obj.since, reason: obj.reason.trim() };
}

/** @throws {LeadModelShapeError} on a malformed shape, or a plain `Error` on a missing/unreadable file. */
export function loadLeadModelPin(path: string): LeadModelPin {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  return validateLeadModelPin(parsed, path);
}

/**
 * Writes the pin, creating `<project>/.pi/` on first use.
 *
 * Validated before it is written, so the one writer in this tree cannot produce a file its own
 * reader would reject. Formatted like every other config file here (2-space, trailing newline),
 * because this file is meant to be read and reviewed in a diff.
 */
export async function writeLeadModelPin(path: string, pin: LeadModelPin): Promise<void> {
  const checked = validateLeadModelPin(pin, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
}

/**
 * EXT-11 — the session facts file: the half of the pinned path that carries what was *learned*.
 *
 * ## The asymmetry this closes
 *
 * `./pinned.ts` re-reads `AGENTS.md` and its siblings from disk after every compaction and states
 * them again, so an instruction file survives any number of passes byte for byte. Nothing does the
 * same for a discovery. Everything established during a session — the endpoint that actually
 * answered, the parameter that turned out to be required, the approach that was tried and ruled
 * out, the correction the operator typed in — exists only inside the summary the compactor writes,
 * and the next compaction summarises that summary rather than the original dialogue.
 *
 * The consequence is not that detail is lost slowly. It is lost geometrically, and it is lost in
 * one direction only: doctrine is restated verbatim forever while findings fade, so a long session
 * drifts steadily towards knowing what it is supposed to do and not what it has already learned.
 * The visible symptom is an agent paying a second time — another API call, another remote run,
 * another round of the operator's attention — for something it established hours earlier and can
 * no longer see.
 *
 * ## The mechanism
 *
 * The same one, pointed at a second source. A plain append-only Markdown file, one fact per line,
 * each line carrying an ISO timestamp, the fact in a sentence, and how it was established. The
 * `fact` tool appends to it; the compaction handler re-reads it from disk and states it beside the
 * pinned block. Provenance is not decoration: without it a later turn cannot tell a thing that was
 * verified from a thing that was assumed, and a fact it cannot trust is one it will re-derive.
 *
 * ## Where the file lives, and why not somewhere more convenient
 *
 * Beside the session transcript, named after it. Three properties follow from that one choice, and
 * all three are requirements rather than conveniences:
 *
 *  - **Outside every working tree.** The file can never be staged, committed or pushed by accident,
 *    which matters because facts are exactly the kind of content that quotes internal hostnames,
 *    identifiers and error bodies.
 *  - **Keyed by session id.** Two sessions running at the same time — a parent and its subagent,
 *    or two terminals in the same project — cannot write into each other's file or read each
 *    other's context back out of a compaction.
 *  - **Session-scoped.** It dies with the session. This is deliberately not a memory system: there
 *    is no store, no index, no retrieval, and nothing accumulates across sessions for nobody to
 *    curate.
 *
 * A session started with `--no-session` has no transcript to sit beside; the fallback keys the
 * state root on the session id instead, which keeps all three properties.
 *
 * ## Both caps, and why the marker is not optional
 *
 * `maxEntries` and `maxBytes` are enforced on every read, oldest first, and the rendered block
 * states how many entries it dropped and which file to read for the rest. Reporting the drop is
 * the part that cannot be skipped: a list quietly cut to fit looks complete, so its *absences* get
 * read as evidence — the agent concludes a thing was never established and goes to establish it,
 * which is the precise failure this module exists to prevent.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { capBytes } from "./pinned.ts";

export interface FactsLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export const DEFAULT_FACTS_LIMITS: FactsLimits = {
  maxEntries: 40,
  maxBytes: 8000,
};

/** Recorded when the caller states no provenance. Visible on purpose: it is the weaker claim. */
export const PROVENANCE_UNSTATED = "not stated";

/**
 * A fact line, and the only shape `readFacts` counts. Anchored on the timestamp so the file's own
 * header, and anything a human adds to it by hand, are left alone rather than restated as facts.
 */
const FACT_LINE = /^- `[^`]+` \S/;

const HEADER = [
  "# Session facts",
  "",
  "Appended by the `fact` tool, re-read after every compaction. One fact per line: when it was",
  "established, what it is, and how it was established. Session-scoped, never committed.",
  "",
].join("\n");

export interface FactsResult {
  /** The file the lines came from, named in the render so dropped entries stay reachable. */
  readonly path: string;
  /** Oldest first, after both caps. */
  readonly lines: readonly string[];
  /** How many entries the caps dropped. Always surfaced, never swallowed. */
  readonly dropped: number;
  /** How many entries the file holds. */
  readonly total: number;
  /** The newest entry alone was over `maxBytes` and was cut. */
  readonly truncated: boolean;
  /** One line per condition that stopped a read. Announced, never swallowed. */
  readonly problems: readonly string[];
}

/**
 * The facts file for one session.
 *
 * `sessionFile` is `ctx.sessionManager.getSessionFile()`. PI keeps session transcripts under the
 * agent directory, so the sibling this returns is outside the project by construction. A session
 * with no transcript falls back to `<stateRoot>/facts/<sessionId>.facts.md`.
 */
export function factsPathFor(sessionFile: string | undefined, sessionId: string, stateRoot: string): string {
  if (sessionFile !== undefined && sessionFile.length > 0) {
    return join(dirname(sessionFile), `${basename(sessionFile).replace(/\.jsonl$/i, "")}.facts.md`);
  }
  return join(stateRoot, "facts", `${sessionId}.facts.md`);
}

/** One line, exactly as it is written and exactly as it is restated. */
export function formatFactLine(at: string, fact: string, provenance: string): string {
  return `- \`${at}\` ${collapse(fact)} _(established: ${collapse(provenance)})_`;
}

/** A newline inside a fact would split it across two lines and break the file's one contract. */
function collapse(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/**
 * Appends one fact, creating the file and its directory on first use. Returns the line written.
 *
 * An empty fact throws instead of appending a blank entry. The caller asked for something to be
 * recorded and nothing was: that is exactly the case that must not pass quietly.
 */
export async function appendFact(
  path: string,
  fact: string,
  provenance: string | undefined,
  now: Date = new Date(),
): Promise<string> {
  const text = collapse(fact);
  if (text.length === 0) throw new Error("fact: the fact text is empty, so there is nothing to record");
  const line = formatFactLine(now.toISOString(), text, provenance ?? PROVENANCE_UNSTATED);
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOrUndefined(path);
  await appendFile(path, `${existing === undefined ? HEADER : ""}${line}\n`, "utf8");
  return line;
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Reads the facts file under both caps.
 *
 * `maxEntries` is applied first and `maxBytes` second, both dropping from the oldest end. The entry
 * cap is the one an operator reasons about ("the last forty things I learned"); the byte cap is the
 * one that protects the context budget compaction has just reclaimed, and it has to be able to
 * override the first because entry length is unbounded.
 *
 * A single newest entry larger than the byte cap is cut rather than dropped. Discarding the most
 * recent fact outright in order to protect a budget that it alone exceeds trades the wrong thing
 * away, and the cut is marked so the block never implies the entry was short.
 *
 * A missing file is the normal case — most sessions never record anything — and returns an empty
 * result with no problem line, matching how `readPinned` treats an absent source.
 */
export async function readFacts(path: string, limits: FactsLimits = DEFAULT_FACTS_LIMITS): Promise<FactsResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const problems =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : [`${path} — unreadable: ${(err as Error).message}`];
    return { path, lines: [], dropped: 0, total: 0, truncated: false, problems };
  }

  const all = raw.split("\n").map((line) => line.trimEnd()).filter((line) => FACT_LINE.test(line));
  const maxEntries = Math.max(0, Math.trunc(limits.maxEntries));
  const maxBytes = Math.max(0, Math.trunc(limits.maxBytes));

  const kept = all.slice(Math.max(0, all.length - maxEntries));
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > maxBytes) kept.shift();

  let truncated = false;
  if (kept.length === 1 && Buffer.byteLength(kept[0]!, "utf8") > maxBytes) {
    const cut = capBytes(kept[0]!, maxBytes);
    kept[0] = cut.text;
    truncated = cut.truncated;
  }

  return { path, lines: kept, dropped: all.length - kept.length, total: all.length, truncated, problems: [] };
}

/**
 * Renders the block restated after a compaction. Returns `""` when the session has recorded
 * nothing, so the caller can skip the send rather than push an empty message into a context that
 * was just cleared.
 */
export function renderFacts(result: FactsResult): string {
  if (result.total === 0) return "";
  const parts = [
    "The context was just compacted. These facts were established during this session and are " +
      "re-read from disk after every compaction. Each one says how it was established: an " +
      "established fact is authoritative over anything the summary above says about it, and is " +
      "not worth deriving a second time.",
    "",
    ...result.lines,
  ];
  if (result.dropped > 0) {
    parts.push(
      "",
      `[${result.dropped} older fact(s) dropped from this block by the budget on a ${result.total}-entry ` +
        `file. Every one of them is still in ${result.path} — read it before concluding that ` +
        `something was never established.]`,
    );
  }
  if (result.truncated) parts.push("", `[the newest fact was cut to fit the byte budget — read ${result.path}]`);
  parts.push("", `Record the next one with the fact tool. The file is ${result.path}.`);
  return parts.join("\n");
}

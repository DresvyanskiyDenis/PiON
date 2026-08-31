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
 * ## Two classes, because only one of them was ever recorded
 *
 * A file that holds only outcomes is a record of what worked. The other half was missing entirely:
 * every approach that was tried and abandoned left no trace, so after a compaction the session no
 * longer remembered refusing a dead end and walked back into it at full cost — the same failure
 * this module exists to prevent, pointed at the negative result instead of the positive one.
 *
 * `ruled_out` is therefore a first-class kind rather than a convention in the prose: it is marked
 * in the line, counted on read, and named in the restatement, so a later turn reads "this was
 * tried, and here is what ruled it out" instead of one more faceless fact. A `ruled_out` entry
 * with no reason is refused, because an abandonment carrying no reason is exactly the record a
 * later turn talks itself back out of.
 *
 * ## Concurrency, and what "fact N" is allowed to mean
 *
 * Two `fact` calls in one turn run in parallel against one file. Two properties are needed, and
 * they are met differently:
 *
 *  - **No entry is lost.** Each append is one `appendFile` on an `O_APPEND` descriptor, so the
 *    seek-to-end and the write are a single atomic step and interleaved writers cannot overwrite
 *    each other. The header is created with `wx` — create-exclusive, one winner, the losers see
 *    `EEXIST` — rather than by a read-then-write, which let two first writers each conclude the
 *    file was absent and each prepend a header.
 *  - **The number reported back is an identity, not a count.** A count of the whole file taken
 *    after the write answers the same number to every caller whose append landed before any of
 *    them re-read, which is indistinguishable from a write that was lost — and being blind to
 *    that distinction is worse than either failure alone. {@link appendFact} returns the 1-based
 *    position of *its own* line, located in the file it just wrote, with the count alongside it.
 *
 * Locating one's own line requires the line to be unique, so timestamps are strictly increasing
 * per file within a process ({@link stampFor}): two entries recorded in the same millisecond are
 * written one millisecond apart. That is the price of an addressable entry, and it is paid
 * knowingly rather than by adding a nonce every reader would then have to read forever.
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
 *
 * Both classes are capped by the same rule, oldest first: a `ruled_out` entry is neither
 * privileged nor sacrificed. The marker additionally says how many of the dropped entries were
 * ruled-out approaches, because that is the absence most likely to be misread as permission.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * The fraction of either cap at which the `fact` tool starts stating usage in its reply.
 *
 * 0.75 leaves a quarter of the budget between the first warning and the first eviction — enough
 * room that an agent told "you are close" can finish what it is recording rather than stop mid-
 * task. Lower and the line is noise on every call; higher and it arrives after the oldest entries
 * have already gone.
 */
export const DEFAULT_FACTS_WARN_RATIO = 0.75;

/** Recorded when the caller states no provenance. Visible on purpose: it is the weaker claim. */
export const PROVENANCE_UNSTATED = "not stated";

/**
 * The two classes of entry. `fact` is an outcome, something established. `ruled_out` is an approach
 * that was abandoned together with the reason it was abandoned, which is the half a session never
 * kept and therefore paid for twice.
 */
export type FactKind = "fact" | "ruled_out";

/** The in-line marker for the `ruled_out` class. Written by the writer, read by the reader. */
const RULED_OUT_MARK = "**ruled out:**";

/**
 * A fact line, and the only shape `readFacts` counts. Anchored on the timestamp so the file's own
 * header, and anything a human adds to it by hand, are left alone rather than restated as facts.
 * Both classes match it: the class marker sits inside the body, so a reader that knows nothing
 * about `ruled_out` still sees every entry instead of silently dropping half the file.
 */
const FACT_LINE = /^- `[^`]+` \S/;

/** The same anchor, plus the class marker. */
const RULED_OUT_LINE = /^- `[^`]+` \*\*ruled out:\*\* \S/;

const HEADER = [
  "# Session facts",
  "",
  "Appended by the `fact` tool, re-read after every compaction. One entry per line: when it was",
  "established, what it is, and how it was established. Entries marked `**ruled out:**` are",
  "approaches that were abandoned, with the reason. Session-scoped, never committed.",
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
  /**
   * What every entry in the file weighs, before either cap — the figure `maxBytes` is measured
   * against. Not the size of {@link lines}: those are already under the cap by construction, so
   * they can never show that the budget is binding.
   */
  readonly bytes: number;
  /** How many of {@link lines} are ruled-out approaches. */
  readonly ruledOut: number;
  /** How many of the dropped entries were ruled-out approaches. Named in the drop marker. */
  readonly droppedRuledOut: number;
  /** The newest entry alone was over `maxBytes` and was cut. */
  readonly truncated: boolean;
  /** One line per condition that stopped a read. Announced, never swallowed. */
  readonly problems: readonly string[];
}

/** What one append did: the line, and where in the file it landed. */
export interface AppendedFact {
  /** The line exactly as written. */
  readonly line: string;
  /** Its 1-based position among the file's entries. An identity: two appends never share one. */
  readonly index: number;
  /** How many entries the file holds now. Larger than `index` when another writer got there too. */
  readonly total: number;
  /** The class recorded. */
  readonly kind: FactKind;
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
export function formatFactLine(at: string, fact: string, provenance: string, kind: FactKind = "fact"): string {
  return kind === "ruled_out"
    ? `- \`${at}\` ${RULED_OUT_MARK} ${collapse(fact)} _(because: ${collapse(provenance)})_`
    : `- \`${at}\` ${collapse(fact)} _(established: ${collapse(provenance)})_`;
}

/** Whether a line records an abandoned approach rather than an outcome. */
export function isRuledOutLine(line: string): boolean {
  return RULED_OUT_LINE.test(line);
}

/** A newline inside a fact would split it across two lines and break the file's one contract. */
function collapse(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/**
 * Strictly increasing timestamps, per file, within this process.
 *
 * Two parallel `fact` calls in one turn land in the same millisecond routinely, and an entry that
 * cannot be told apart from its neighbour cannot be given an identity. One millisecond of drift
 * under a burst buys an addressable line; the alternative, a nonce carried in the text, would be
 * paid for in every restatement, forever, by every reader.
 */
const lastStampMs = new Map<string, number>();

function stampFor(path: string, now: Date): string {
  const ms = Math.max(now.getTime(), (lastStampMs.get(path) ?? 0) + 1);
  lastStampMs.set(path, ms);
  return new Date(ms).toISOString();
}

export interface AppendFactOptions {
  /** `ruled_out` records an abandoned approach, and its reason is mandatory. Defaults to `fact`. */
  readonly kind?: FactKind;
  /** Injectable clock. Still passed through {@link stampFor}, so two calls never collide. */
  readonly now?: Date;
}

/**
 * Appends one entry, creating the file and its directory on first use.
 *
 * An empty fact throws instead of appending a blank entry. The caller asked for something to be
 * recorded and nothing was: that is exactly the case that must not pass quietly. A `ruled_out`
 * with no reason throws for the same reason, because the reason is the entire content of the class.
 *
 * The returned {@link AppendedFact.index} is read back from the file, so it accounts for whatever a
 * concurrent writer appended in between rather than assuming this call was alone.
 */
export async function appendFact(
  path: string,
  fact: string,
  provenance: string | undefined,
  options: AppendFactOptions = {},
): Promise<AppendedFact> {
  const kind = options.kind ?? "fact";
  const text = collapse(fact);
  if (text.length === 0) throw new Error("fact: the fact text is empty, so there is nothing to record");
  const reason = collapse(provenance ?? "");
  if (kind === "ruled_out" && reason.length === 0) {
    throw new Error(
      "fact: a ruled_out entry must say what ruled the approach out. Pass the reason as provenance, "
        + "or record it as an ordinary fact instead.",
    );
  }

  const line = formatFactLine(stampFor(path, options.now ?? new Date()), text, reason || PROVENANCE_UNSTATED, kind);
  await mkdir(dirname(path), { recursive: true });
  // Create-exclusive, so exactly one of N racing first writers writes the header and the losers get
  // EEXIST instead of each concluding the file is absent and prepending a second copy.
  try {
    await writeFile(path, HEADER, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // One `appendFile` is one write on an O_APPEND descriptor: atomic against other appenders.
  await appendFile(path, `${line}\n`, "utf8");

  const all = factLinesOf((await readOrUndefined(path)) ?? "");
  // `lastIndexOf`: if an identical line somehow already existed, the one just written is the later.
  const found = all.lastIndexOf(line);
  return { line, index: found >= 0 ? found + 1 : all.length, total: all.length, kind };
}

function factLinesOf(raw: string): string[] {
  return raw.split("\n").map((line) => line.trimEnd()).filter((line) => FACT_LINE.test(line));
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
    return {
      path,
      lines: [],
      dropped: 0,
      total: 0,
      bytes: 0,
      ruledOut: 0,
      droppedRuledOut: 0,
      truncated: false,
      problems,
    };
  }

  const all = factLinesOf(raw);
  const maxEntries = Math.max(0, Math.trunc(limits.maxEntries));
  const maxBytes = Math.max(0, Math.trunc(limits.maxBytes));

  const kept = all.slice(Math.max(0, all.length - maxEntries));
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > maxBytes) kept.shift();

  const dropped = all.length - kept.length;
  const droppedRuledOut = all.slice(0, dropped).filter(isRuledOutLine).length;
  const ruledOut = kept.filter(isRuledOutLine).length;

  let truncated = false;
  if (kept.length === 1 && Buffer.byteLength(kept[0]!, "utf8") > maxBytes) {
    const cut = capBytes(kept[0]!, maxBytes);
    kept[0] = cut.text;
    truncated = cut.truncated;
  }

  return {
    path,
    lines: kept,
    dropped,
    total: all.length,
    bytes: Buffer.byteLength(all.join("\n"), "utf8"),
    ruledOut,
    droppedRuledOut,
    truncated,
    problems: [],
  };
}

/**
 * The usage line the `fact` tool appends to its reply once the file is within `warnRatio` of
 * either cap, and `null` while it is not.
 *
 * The budget is otherwise invisible from inside a turn: the caps live in config, the eviction
 * notice fires only after entries have already been dropped, and `/compaction-status` has to be
 * asked. Stating usage where the agent already looks costs one line and removes the guess.
 *
 * Silence is the load-bearing half: below the ratio the reply says nothing about the budget, so
 * the line means "this is now worth your attention" rather than being noise on every call. A cap
 * of zero counts as full — nothing can be kept under it — instead of dividing by it.
 */
export function nearingCapLine(
  result: Pick<FactsResult, "total" | "bytes">,
  limits: FactsLimits,
  warnRatio: number = DEFAULT_FACTS_WARN_RATIO,
): string | null {
  const maxEntries = Math.max(0, Math.trunc(limits.maxEntries));
  const maxBytes = Math.max(0, Math.trunc(limits.maxBytes));
  const used = Math.max(ratio(result.total, maxEntries), ratio(result.bytes, maxBytes));
  if (used < warnRatio) return null;
  return `${result.total}/${maxEntries} entries, ${kb(result.bytes)}/${kb(maxBytes)} — nearing the cap.`;
}

/** A cap of zero is full at any usage, rather than `Infinity` or `NaN`. */
function ratio(used: number, cap: number): number {
  return cap <= 0 ? 1 : used / cap;
}

/** Decimal KB, one place, trailing `.0` dropped: `6.2KB`, `8KB`. */
function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1).replace(/\.0$/, "")}KB`;
}

/**
 * Renders the block restated after a compaction. Returns `""` when the session has recorded
 * nothing, so the caller can skip the send rather than push an empty message into a context that
 * was just cleared.
 *
 * The entries stay in one chronological list. An approach was ruled out *at a point in the work*,
 * and splitting the two classes into separate blocks would lose the order that explains why. The
 * class travels in each line's own marker and is named once below the list, which is what turns
 * "one more fact" into "this was tried, and here is what ruled it out".
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
  if (result.ruledOut > 0) {
    parts.push(
      "",
      `[${result.ruledOut} of the entries above are approaches already ruled out this session, marked ` +
        `"${RULED_OUT_MARK}" with what ruled each one out. They bind exactly as the facts do: do not ` +
        `retry one, or reason your way back into it, without new evidence that its stated reason no ` +
        `longer holds. Read them before any further fix-work.]`,
    );
  }
  if (result.dropped > 0) {
    const ruledOutNote =
      result.droppedRuledOut > 0
        ? ` ${result.droppedRuledOut} of the dropped entries were ruled-out approaches, so an approach ` +
          `missing from this block is not an approach that was never refused.`
        : "";
    parts.push(
      "",
      `[${result.dropped} older fact(s) dropped from this block by the budget on a ${result.total}-entry ` +
        `file. Every one of them is still in ${result.path} — read it before concluding that ` +
        `something was never established.${ruledOutNote}]`,
    );
  }
  if (result.truncated) parts.push("", `[the newest fact was cut to fit the byte budget — read ${result.path}]`);
  parts.push(
    "",
    `Record the next one with the fact tool, kind "ruled_out" for an approach you are abandoning, ` +
      `with the reason. The file is ${result.path}.`,
  );
  return parts.join("\n");
}

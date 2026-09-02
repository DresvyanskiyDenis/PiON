/**
 * EXT-32 — the live session directory and the per-session inbox.
 *
 * `EXT-25`'s `team.ts` is a *session-scoped* registry: it maps a handle to a child session this
 * process created, it is cleared at `session_shutdown`, and it is deliberately not persisted. That
 * is the right shape for a lead talking to its own children and the wrong shape for two sessions
 * that never spawned each other — session A cannot see session B in a map that lives in B's own
 * process.
 *
 * So this module is the part `team.ts` cannot be: a directory on disk that every session writes its
 * own registration into and every session may read.
 *
 * ```
 * <state>/agents/<name>/
 *   agent.json                     {schema, name, sessionId, pid, cwd, sessionFile?, startedAt}
 *   inbox/<id>.json                one undelivered message each — {schema, id, from, fromSessionId, at, message}
 *   inbox/<id>.bad                 an envelope that would not parse, kept rather than deleted
 *   inbox/.delivering/<id>.json    drained, handed to the turn loop, delivery not yet observed
 * ```
 *
 * `<state>/agents`, not `~/.pi/agent/sessions`: `lib/paths.ts` owns every path this tree writes and
 * `configDir()` is PI's own config directory — a harness that scatters its runtime state through the
 * agent's config tree is a harness whose config cannot be copied between machines. `EXT-24` made the
 * same call for `<state>/jobs` and for the same reason; this is that decision applied again, not a
 * new one.
 *
 * Liveness is a pid, checked at read time. Nothing observes another session's exit — a session that
 * is SIGKILLed never runs `session_shutdown` — so a registration is a *claim* that is verified when
 * somebody looks, exactly like `EXT-24`'s lazily-reaped job states. A name whose pid is gone is not
 * reachable and is swept, so it can be claimed again.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isProcessAlive } from "../jobs/lock.ts";
import { describeError } from "../lib/once.ts";
import { stateRoot } from "../lib/paths.ts";

/** Bumped whenever the on-disk shape changes; an older reader refuses rather than guesses. */
export const AGENT_SCHEMA = 1;

/**
 * Bumped separately from `AGENT_SCHEMA`: an envelope and an `agent.json` registration evolve on
 * different clocks — `kind`/`instructions` is a message-shape change, not a registration-shape one,
 * and coupling the two would force every registration reader to learn about envelope fields it never
 * touches.
 *
 * `drainInbox()` reads this as a floor, not an equality: a *newer* schema than this build knows about
 * is still accepted as long as the fields this build understands (`id`, `message`) are present and
 * well-typed, so a session running an older build never chokes on an envelope a newer peer sent it —
 * it just does not see the new fields. Only a schema *older* than 1, or a shape too broken to stage,
 * is rejected.
 */
export const ENVELOPE_SCHEMA = 2;

/**
 * The addressing rule. Same shape as `EXT-25`'s teammate handles — a name the model can hold in its
 * head and retype — and deliberately a separate constant: a teammate handle is scoped to one lead's
 * registry, an agent name is machine-wide, so the two are free to diverge without either silently
 * widening the other.
 */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** How many `-2`, `-3`, … suffixes a contested name is offered before registration gives up. */
export const MAX_NAME_SUFFIX = 99;

export interface AgentRecord {
  readonly schema: number;
  readonly name: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly startedAt: number;
}

export interface Envelope {
  readonly schema: number;
  readonly id: string;
  /** The sender's directory name, which is also the address a reply goes back to. */
  readonly from: string;
  readonly fromSessionId: string;
  readonly at: number;
  readonly message: string;
  /**
   * `"message"` when absent — the ordinary chat envelope every build before this one ever wrote.
   * Anything else is a control envelope: it is never handed to `pi.sendMessage()`, only to a handler
   * registered for that kind (`control.ts`). An unrecognised kind is tolerated, not an error — see
   * `drainInbox()`.
   */
  readonly kind?: string;
  /** Free-text sent alongside a control envelope, e.g. what a `"compact"` sender wants kept. */
  readonly instructions?: string;
}

/** A directory entry that exists but cannot be read as schema `AGENT_SCHEMA`. */
export interface DirectoryProblem {
  readonly name: string;
  readonly reason: string;
}

export interface DirectoryListing {
  readonly agents: readonly AgentRecord[];
  readonly problems: readonly DirectoryProblem[];
}

export class MessageAgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MessageAgentError";
  }
}

/** `<state>/agents`. Recomputed per call so a test can move `XDG_STATE_HOME`. */
export function agentsRoot(): string {
  return join(stateRoot(), "agents");
}

export function agentDir(root: string, name: string): string {
  return join(root, name);
}

export function inboxDir(root: string, name: string): string {
  return join(root, name, "inbox");
}

/**
 * `inbox/.delivering` — where a drained envelope waits between "taken off disk" and "observed in
 * the transcript".
 *
 * Inside `inbox/`, not beside it, so one `rm -rf` of an agent directory still takes everything
 * addressed to that name; dot-prefixed so `drainInbox`'s `readdir` cannot mistake the staging area
 * for an envelope.
 */
export function deliveringDir(root: string, name: string): string {
  return join(inboxDir(root, name), ".delivering");
}

/**
 * Fails loud on an unwritable state root rather than relocating to a tmpdir.
 *
 * `EXT-24`'s `ensureJobsRoot` reasoning applies verbatim and more sharply: a directory the other
 * sessions cannot find is not a degraded directory, it is an unreachable session that still reports
 * itself as reachable.
 */
export async function ensureAgentsRoot(root = agentsRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * Zero-padded so a plain `readdir` sort is chronological, which is what makes the inbox readable by
 * eye and by `ls`. The drain does not *rely* on it — it sorts on the timestamp inside the envelope —
 * because a name is metadata and the `at` field is the fact.
 */
export function newMessageId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, "0")}-${randomUUID().slice(0, 8)}`;
}

/**
 * Turns anything into a legal agent name, or throws when there is nothing left to work with.
 *
 * Used on `PI_AGENT_NAME` and on the session-id fallback alike, so an operator who exports
 * `PI_AGENT_NAME=Reviewer` is addressable as `reviewer` rather than unaddressable.
 */
export function slugifyAgentName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const named = slug === "" ? "" : /^[a-z]/.test(slug) ? slug : `agent-${slug}`.slice(0, 32).replace(/-+$/g, "");
  if (!AGENT_NAME_PATTERN.test(named)) {
    throw new MessageAgentError(
      `"${raw}" cannot be used as an agent name: use lower-case letters, digits and hyphens, ` +
        `starting with a letter, at most 32 characters.`,
    );
  }
  return named;
}

function parseRecord(name: string, raw: string): AgentRecord {
  const parsed = JSON.parse(raw) as Partial<AgentRecord>;
  if (parsed.schema !== AGENT_SCHEMA) {
    throw new MessageAgentError(
      `agent ${name}: agent.json is schema ${String(parsed.schema)}, this build reads ${AGENT_SCHEMA}`,
    );
  }
  return parsed as AgentRecord;
}

/** `undefined` when nothing is registered under `name`. Throws when a registration is unreadable. */
export async function readRecord(root: string, name: string): Promise<AgentRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(agentDir(root, name), "agent.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MessageAgentError(`agent ${name}: agent.json is unreadable: ${describeError(err)}`, {
      cause: err,
    });
  }
  return parseRecord(name, raw);
}

async function writeRecord(root: string, record: AgentRecord): Promise<void> {
  const dir = agentDir(root, record.name);
  await mkdir(join(dir, "inbox"), { recursive: true, mode: 0o700 });
  const tmp = join(dir, `agent.json.${process.pid}.${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(dir, "agent.json"));
}

export function isReachable(record: AgentRecord): boolean {
  return isProcessAlive(record.pid);
}

/**
 * Every registration on this machine, with the unreachable ones removed from disk as they are found.
 *
 * Sweeping inside the read is deliberate: this is the only routine every session runs regularly, and
 * a stale name that is never swept is a name nobody can ever claim again.
 */
export async function listAgents(
  root: string,
  options: { readonly sweep?: boolean } = {},
): Promise<DirectoryListing> {
  const entries = await readdir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw new MessageAgentError(`agents root ${root} is unreadable: ${describeError(err)}`, { cause: err });
  });

  const agents: AgentRecord[] = [];
  const problems: DirectoryProblem[] = [];
  for (const name of entries.filter((entry) => !entry.startsWith("."))) {
    try {
      const record = await readRecord(root, name);
      if (record === undefined) continue;
      if (isReachable(record)) {
        agents.push(record);
        continue;
      }
      if (options.sweep !== false) await rm(agentDir(root, name), { recursive: true, force: true });
    } catch (err) {
      problems.push({ name, reason: describeError(err) });
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, problems };
}

export interface RegisterRequest {
  readonly root: string;
  readonly name: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly pid?: number;
  readonly now?: number;
}

export interface RegisterResult {
  readonly record: AgentRecord;
  /** The name that was asked for, which differs from `record.name` only on a live collision. */
  readonly requested: string;
}

/**
 * Claims a name for this session.
 *
 * A collision with a registration whose process is gone, or with this session's own earlier
 * registration, is a takeover — that name is free. A collision with a *live* other session is not:
 * two sessions answering to one address is the failure this directory exists to prevent, so the
 * caller is given `<name>-2` instead and `RegisterResult.requested` says so. The caller announces it;
 * silently answering to a different name than the operator exported is what would actually lose a
 * message.
 */
export async function registerAgent(req: RegisterRequest): Promise<RegisterResult> {
  const requested = slugifyAgentName(req.name);
  const pid = req.pid ?? process.pid;
  const startedAt = req.now ?? Date.now();

  for (let suffix = 1; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    const candidate = suffix === 1 ? requested : `${requested.slice(0, 29)}-${suffix}`;
    const held = await readRecord(req.root, candidate).catch(() => undefined);
    if (held !== undefined && held.sessionId !== req.sessionId && isReachable(held)) continue;
    const record: AgentRecord = {
      schema: AGENT_SCHEMA,
      name: candidate,
      sessionId: req.sessionId,
      pid,
      cwd: req.cwd,
      ...(req.sessionFile !== undefined ? { sessionFile: req.sessionFile } : {}),
      startedAt,
    };
    await writeRecord(req.root, record);
    return { record, requested };
  }

  throw new MessageAgentError(
    `agent name "${requested}" and its first ${MAX_NAME_SUFFIX} variants are all held by live ` +
      `sessions; this session was not registered and cannot be messaged. Set PI_AGENT_NAME to ` +
      `something distinctive.`,
  );
}

/**
 * Drops this session's registration, and only this session's.
 *
 * The `sessionId` check is the whole signature: a session that was renamed, or that is shutting down
 * after a different session already took its swept name over, must not delete the live holder's
 * registration on its way out.
 */
export async function unregisterAgent(root: string, name: string, sessionId: string): Promise<boolean> {
  const held = await readRecord(root, name).catch(() => undefined);
  if (held === undefined || held.sessionId !== sessionId) return false;
  await rm(agentDir(root, name), { recursive: true, force: true });
  return true;
}

/**
 * Resolves an address to a live registration, or throws with the reachable names.
 *
 * Fails loud, with the alternatives in the same breath: `message_agent` is fire-and-forget, so a
 * misrouted message that "succeeded" is a message nobody will ever chase.
 */
export async function requireAgent(root: string, name: string): Promise<AgentRecord> {
  const record = await readRecord(root, name).catch(() => undefined);
  if (record !== undefined && isReachable(record)) return record;
  if (record !== undefined) await rm(agentDir(root, name), { recursive: true, force: true });
  const { agents } = await listAgents(root);
  const live = agents.map((a) => a.name);
  throw new MessageAgentError(
    `no live session named "${name}". ` +
      (live.length > 0
        ? `Reachable sessions: ${live.join(", ")}.`
        : `No sessions are reachable — nothing is registered in ${root}.`) +
      ` List them with message_agent(action="list").`,
  );
}

export interface DeliverRequest {
  readonly root: string;
  readonly target: string;
  readonly from: string;
  readonly fromSessionId: string;
  readonly message: string;
  /** Omitted means "message" — see `Envelope.kind`. */
  readonly kind?: string;
  readonly instructions?: string;
  readonly now?: number;
}

/**
 * Writes one message into the target's inbox and returns the envelope.
 *
 * The temp-file-then-rename is what makes a concurrent drain see either no file or a whole one, and
 * it is what lets two senders write to the same inbox at once without a lock: every envelope is its
 * own file under a unique name, so there is no read-modify-write to race on.
 */
export async function deliver(req: DeliverRequest): Promise<Envelope> {
  const at = req.now ?? Date.now();
  const envelope: Envelope = {
    schema: ENVELOPE_SCHEMA,
    id: newMessageId(at),
    from: req.from,
    fromSessionId: req.fromSessionId,
    at,
    message: req.message,
    ...(req.kind !== undefined ? { kind: req.kind } : {}),
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
  };
  const dir = inboxDir(req.root, req.target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(dir, `${envelope.id}.json`));
  return envelope;
}

export interface DrainResult {
  readonly messages: readonly Envelope[];
  readonly problems: readonly DirectoryProblem[];
}

/**
 * Takes everything currently in this session's inbox, oldest first, and *stages* it.
 *
 * Staging, not deleting. `pi.sendMessage()` is fire-and-forget and `deliverAs: "followUp"` waits
 * for the running turn to end, so the gap between "drained" and "read by the model" is measured in
 * minutes. Unlinking here would leave the only copy of somebody's message in a local variable for
 * the whole of that window: a crash, a `/clear` or a session switch inside it loses the message
 * with no trace and no retry. So the envelope moves to `inbox/.delivering/<id>.json` and stays
 * there until delivery is actually observed (`clearDelivered`); a session that died in the window
 * puts it back on its next start (`sweepDelivering`). That is `EXT-23`'s worktree-registry idiom
 * applied again — record before you act, sweep at `session_start` — not a new one.
 *
 * The staged file is also the in-flight view that did not exist before: `ls inbox/.delivering/`
 * separates "never sent" from "in flight" from "lost", which no amount of reading the audit log
 * could, because the audit log recorded success at drain time.
 *
 * An envelope that will not parse is renamed to `<id>.bad` rather than deleted: it is somebody's
 * message, the drain must not loop on it forever, and a message quietly dropped is the exact failure
 * `EXT-25` was built around. `id` is validated alongside `message` because the staged copy is filed
 * under it — an envelope whose identity is not a string has nowhere to be staged.
 */
export async function drainInbox(root: string, name: string): Promise<DrainResult> {
  const dir = inboxDir(root, name);
  const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw new MessageAgentError(`inbox ${dir} is unreadable: ${describeError(err)}`, { cause: err });
  });

  const pending = entries.filter((e) => e.endsWith(".json")).sort();
  const staging = deliveringDir(root, name);
  if (pending.length > 0) await mkdir(staging, { recursive: true, mode: 0o700 });

  const messages: Envelope[] = [];
  const problems: DirectoryProblem[] = [];
  for (const entry of pending) {
    const path = join(dir, entry);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Envelope>;
      // A floor, not an equality: a *newer* schema than ENVELOPE_SCHEMA is still staged as long as
      // the fields this build understands are well-typed, so a build lagging behind a peer's never
      // chokes on an envelope that just carries fields it does not yet know about.
      if (
        typeof parsed.schema !== "number" ||
        parsed.schema < AGENT_SCHEMA ||
        typeof parsed.id !== "string" ||
        typeof parsed.message !== "string"
      ) {
        throw new MessageAgentError(
          `envelope ${entry} is schema ${String(parsed.schema)} with ${typeof parsed.id} id and ` +
            `${typeof parsed.message} message`,
        );
      }
      messages.push(parsed as Envelope);
      await rename(path, join(staging, `${parsed.id}.json`));
    } catch (err) {
      problems.push({ name: entry, reason: describeError(err) });
      await rename(path, `${path}.bad`).catch(() => {});
    }
  }
  messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { messages, problems };
}

/**
 * Puts every staged envelope back in the inbox, except the ones named in `exclude`, and says which
 * ones moved. Run at `session_start` and on every settle cycle.
 *
 * Anything still in `.delivering/` and not in `exclude` was drained by *some* process that never
 * confirmed reading it, and nobody is going to. Redelivering a message the model may already have
 * seen is a duplicate; leaving it staged is a message that vanished. `EXT-32` exists because the
 * second failure is the worse one, so this sweeps rather than reaps.
 *
 * `exclude` is how a live session tells this apart from its own genuinely in-flight batches: at
 * `session_start` nothing is tracked yet, so everything staged is swept, exactly as before; mid-life,
 * the caller passes the ids it is still waiting on `settle()` to observe, so a message actually
 * queued behind the current turn is left alone rather than redelivered out from under it.
 */
export async function sweepDelivering(
  root: string,
  name: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<readonly string[]> {
  const staging = deliveringDir(root, name);
  const entries = await readdir(staging).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw new MessageAgentError(`staging area ${staging} is unreadable: ${describeError(err)}`, { cause: err });
  });

  const inbox = inboxDir(root, name);
  const recovered: string[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const id = entry.slice(0, -".json".length);
    if (exclude.has(id)) continue;
    await rename(join(staging, entry), join(inbox, entry));
    recovered.push(id);
  }
  return recovered;
}

/**
 * Drops the staged copies of envelopes whose delivery has been observed. The other end of `drainInbox`.
 *
 * Forgiving by design: the same batch can be confirmed by two lifecycle events reading one
 * transcript entry, and a staged file that is already gone is precisely the state this asks for.
 */
export async function clearDelivered(root: string, name: string, ids: readonly string[]): Promise<void> {
  const staging = deliveringDir(root, name);
  for (const id of ids) {
    await rm(join(staging, `${id}.json`), { force: true });
  }
}

/**
 * Puts specific staged envelopes back in the inbox for the next drain to retry.
 *
 * `sweepDelivering` recovers everything *not* excluded — the coarse, whole-batch sweep run at
 * `session_start`. `recoverStaged` is the fine-grained twin a control handler needs: one deferred or
 * failed envelope must go back to the inbox without disturbing every other envelope still
 * legitimately staged behind an in-flight batch. A missing entry is ignored, same as `clearDelivered`
 * — a staged file that is already gone is not a bug to raise here.
 */
export async function recoverStaged(root: string, name: string, ids: readonly string[]): Promise<void> {
  const staging = deliveringDir(root, name);
  const inbox = inboxDir(root, name);
  for (const id of ids) {
    await rename(join(staging, `${id}.json`), join(inbox, `${id}.json`)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        throw new MessageAgentError(`recovering staged envelope ${id} failed: ${describeError(err)}`, { cause: err });
      }
    });
  }
}

/** `/peers` and `message_agent(action="list")`. One line per reachable session. */
export function renderDirectory(listing: DirectoryListing, self: string | undefined): string {
  if (listing.agents.length === 0 && listing.problems.length === 0) {
    return `no sessions are registered (not even this one — see /doctor).`;
  }
  const rows = listing.agents.map((a) => {
    const label = `${a.name}${a.name === self ? " (this session)" : ""}`;
    const age = Math.max(0, Math.round((Date.now() - a.startedAt) / 60_000));
    return `  ${label.padEnd(36)} pid=${String(a.pid).padEnd(8)} up=${age}m  ${a.cwd}`;
  });
  const problems = listing.problems.map((p) => `  problem: ${p.name}: ${p.reason}`);
  return [`reachable sessions (${listing.agents.length}):`, ...rows, ...problems].join("\n");
}

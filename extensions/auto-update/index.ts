/**
 * auto-update — say that an update is waiting, at the one moment somebody can act on it.
 *
 * The feature is three pieces that never call each other directly. `scripts/auto-update-check.sh`
 * runs from cron, fetches, and writes `<agent-dir>/update-pending` when this checkout is behind
 * `origin/main`. This module reads that file at `session_start` and puts one short block in the
 * system prompt. `scripts/update.sh` applies the update and deletes the file. A flag file rather
 * than a call chain is what lets the noticing run every half hour on a schedule while the telling
 * happens per session and the applying happens once, deliberately.
 *
 * The split of work across the two handlers is copied from `session-context.ts`, for the reason
 * given there: **all I/O runs in `session_start`**, which fires once per session; the injection in
 * `before_agent_start` fires on every prompt and therefore touches no disk. A `stat` per turn is
 * cheap and still wrong — the cost is not the syscall, it is that a per-turn read makes the
 * message change under the agent mid-conversation.
 *
 * FAIL OPEN, and deliberately. Every failure path — an unreadable flag file, a malformed one, a
 * missing config, an update that will not start — costs this session its reminder and nothing
 * else. This module registers no `tool_call` handler and can block nothing; the guarantee it owes
 * is the negative one, that a bug in a convenience feature never costs somebody a session. Each
 * failure is still announced once through `emitNotice`, because the alternative to a loud
 * degradation is a feature that has been silently dead for a month.
 *
 * `mode: "auto"` runs `scripts/update.sh --yes` in a detached child, and the warning belongs
 * here rather than only in the docs: it fast-forwards the checkout that the session reading this
 * sentence is running from. PI has already loaded its extensions by then, so the running session
 * keeps the code it started with, but any file it reads afterwards — an agent definition, a
 * skill, a config — may have moved underneath it. That is why `prompt` is the default and why the
 * installer's question says so.
 */
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, lockDir, repoRoot } from "../lib/paths.ts";
import { emitNotice } from "../lib/announce.ts";
import { runDetached } from "../lib/detach.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";

export const id = "auto-update";

/** The block is delimited by two marker LINES and there is exactly one block, ever. */
export const MARK_OPEN = "<!-- pi-config:auto-update v1 -->";
export const MARK_CLOSE = "<!-- /pi-config:auto-update v1 -->";

/** Written by `scripts/auto-update-check.sh`; removed by `scripts/update.sh`. */
export const FLAG_BASENAME = "update-pending";

/** Bumped when the detached worker's contract changes. Recorded in the lock meta. */
const UPDATE_WORKER_VERSION = "1";

export type UpdateMode = "prompt" | "auto";

export interface AutoUpdateConfig {
  readonly enabled: boolean;
  readonly mode: UpdateMode;
}

/** What the flag file says, once parsed. `commits` is 0 when the file did not state a count. */
export interface PendingUpdate {
  readonly range: string;
  readonly commits: number;
}

const DEFAULT_CONFIG: AutoUpdateConfig = { enabled: false, mode: "prompt" };

let pending: PendingUpdate | null = null;

/** Test-only: drop module state so each test starts from a clean slate. */
export function __resetForTests(): void {
  pending = null;
}

/**
 * `extensions/` is symlinked into `~/.pi/agent/extensions`, so `import.meta.url` points at the
 * symlink; `realpath` gets back to the repository the file actually lives in. Same shape, same
 * reason, as `extensions/tasks/index.ts`.
 */
export function configPaths(): string[] {
  const out: string[] = [];
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    out.push(resolve(dirname(here), "..", "..", "config", "auto-update.json"));
  } catch {
    // A distribution that cannot realpath its own module falls through to repoRoot().
  }
  out.push(resolve(repoRoot(), "config", "auto-update.json"));
  return out;
}

/**
 * Reads the preference. A file that will not parse is reported and treated as disabled — the one
 * case where falling back to the shipped default is right, because the shipped default is off and
 * "off" is the safe reading of "I could not tell".
 */
export function loadConfig(announce?: (line: string) => void): AutoUpdateConfig {
  const found = configPaths().find((p) => existsSync(p));
  if (found === undefined) return DEFAULT_CONFIG;
  let raw: string;
  try {
    raw = readFileSync(found, "utf8");
  } catch (err) {
    announce?.(`${found} could not be read (${describeError(err)}); auto-update stays off`);
    return DEFAULT_CONFIG;
  }
  return parseConfig(raw, found, announce);
}

/**
 * The whole reading of the file, separated from finding it. Split so the parsing rules are
 * testable without a test that depends on whether the machine running it happens to have an
 * installed `config/auto-update.json` next to the module — the first candidate path is derived
 * from the module's own location and cannot be redirected by an environment variable.
 */
export function parseConfig(raw: string, source: string, announce?: (line: string) => void): AutoUpdateConfig {
  let cfg: Partial<AutoUpdateConfig>;
  try {
    const parsed = JSON.parse(raw) as { autoUpdate?: Partial<AutoUpdateConfig> };
    cfg = parsed.autoUpdate ?? {};
  } catch (err) {
    announce?.(`${source} is not valid JSON (${describeError(err)}); auto-update stays off`);
    return DEFAULT_CONFIG;
  }
  // Anything other than the two written modes is a typo, not a third behaviour. Announce it and
  // take the conservative one: nobody's tree gets fast-forwarded because of a misspelling.
  let mode: UpdateMode = "prompt";
  if (cfg.mode === "auto") mode = "auto";
  else if (cfg.mode !== undefined && cfg.mode !== "prompt") {
    announce?.(
      `${source} sets autoUpdate.mode="${String(cfg.mode)}", which is neither "prompt" nor "auto" — using "prompt"`,
    );
  }
  return { enabled: cfg.enabled === true, mode };
}

export function flagPath(): string {
  return join(configDir(), FLAG_BASENAME);
}

/**
 * Parses the `key=value` flag file. Tolerant on purpose: the reminder is worth showing even when
 * one field is missing, so an unparsable count degrades to 0 (rendered as "new commits", not "0
 * commits") and only a missing range makes the file meaningless.
 */
export function parseFlag(text: string): PendingUpdate | null {
  let range = "";
  let commits = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "range") range = value;
    else if (key === "commits") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) commits = n;
    }
  }
  return range === "" ? null : { range, commits };
}

/** `dc1f125..444c3e9` — the range as a person reads it, from the two full ids the file carries. */
export function shortRange(range: string): string {
  return range
    .split("..")
    .map((sha) => (/^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha))
    .join("..");
}

export function render(p: PendingUpdate, mode: UpdateMode): string {
  const what = p.commits > 0 ? `${p.commits} new commit${p.commits === 1 ? "" : "s"}` : "new commits";
  const head = `[update available] PiON has ${what} on origin/main (${shortRange(p.range)}).`;
  if (mode === "auto") {
    return (
      `${head}\n` +
      `scripts/update.sh --yes was started in the background for this session (autoUpdate.mode is "auto").\n` +
      `Do not start it again, and do not report the update as applied until somebody has read that run's output.`
    );
  }
  return (
    `${head}\n` +
    `Run \`scripts/update.sh\` to apply them. To dismiss this reminder, delete ${flagPath()}.\n` +
    `Applying it is the operator's call: it fast-forwards this checkout. Say it is waiting; do not run it unasked.`
  );
}

/** Removes any previously injected block, then appends exactly one. Idempotent by construction. */
export function injectOnce(systemPrompt: string, block: string): string {
  const stripped = stripBlock(systemPrompt);
  return `${stripped.trimEnd()}\n\n${MARK_OPEN}\n${block}\n${MARK_CLOSE}\n`;
}

export function stripBlock(s: string): string {
  let out = s;
  for (;;) {
    const start = out.indexOf(MARK_OPEN);
    if (start === -1) return out;
    const end = out.indexOf(MARK_CLOSE, start);
    out = end === -1 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + MARK_CLOSE.length);
  }
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const announce = makeAnnounce(ctx);
    pending = null;
    try {
      const cfg = loadConfig((line) => announce(line, "warning"));
      if (!cfg.enabled) return;

      const path = flagPath();
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        // Absent is the normal state — it means this checkout is current. Anything else is not.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          announce(`cannot read ${path}: ${describeError(err)}`, "warning");
        }
        return;
      }

      const parsed = parseFlag(text);
      if (parsed === null) {
        announce(`${path} carries no commit range — ignoring it; scripts/auto-update-check.sh writes that file`, "warning");
        return;
      }
      pending = parsed;

      if (cfg.mode === "auto") await startUpdate(announce);
      else announce(`an update is waiting: ${shortRange(parsed.range)} — run scripts/update.sh when it suits you`, "info");
    } catch (err) {
      announce(`session_start failed, no update reminder this session: ${describeError(err)}`, "error");
    }
  });

  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined => {
      const state = pending;
      if (!state) return undefined;
      try {
        return { systemPrompt: injectOnce(event.systemPrompt, render(state, loadConfig().mode)) };
      } catch (err) {
        // Fail open on an internal error, loudly and exactly once: a bug here must cost the
        // reminder, not every prompt the user types.
        surfaceOnce(ctx, "auto-update:before_agent_start", () => {
          makeAnnounce(ctx)(`injection failed, prompt left unmodified: ${describeError(err)}`, "error");
        });
        return undefined;
      }
    },
  );
}

/**
 * Starts `scripts/update.sh --yes` detached, under the same lock-and-recursion guard every other
 * background worker in this tree uses. Two sessions opened a minute apart would otherwise start
 * two fast-forwards of one checkout, which is a race over `.git/index` with a script that
 * explicitly refuses to stash.
 */
async function startUpdate(announce: Announce): Promise<void> {
  const script = join(repoRoot(), "scripts", "update.sh");
  if (!existsSync(script)) {
    announce(`autoUpdate.mode is "auto" but ${script} does not exist — nothing was started`, "error");
    return;
  }
  const outcome = await runDetached([script, "--yes"], {
    lockDir: lockDir("auto-update"),
    version: UPDATE_WORKER_VERSION,
    cwd: repoRoot(),
    onError: (line) => announce(line, "error"),
  });
  switch (outcome) {
    case "spawned":
    case "stale-cleared":
      announce(`autoUpdate.mode is "auto": started ${script} --yes in the background`, "warning");
      break;
    case "locked":
      announce("an update is already running in another session — this one did not start a second", "info");
      break;
    case "recursion":
      // We are inside a worker this harness spawned. An update triggered by an update is a loop.
      break;
    case "error":
      announce("the background update could not be started — run scripts/update.sh by hand", "error");
      break;
  }
}

type Announce = (line: string, level?: "info" | "warning" | "error") => void;

/**
 * One channel, whichever this run mode has — see `lib/announce.ts`. `ctx.ui.*` is a no-op under
 * `-p` and `--mode json`, which is exactly where a UI-only announcement would be a silent one.
 */
export function makeAnnounce(ctx?: ExtensionContext): Announce {
  return (line, level = "warning") => emitNotice(ctx, `[pi-config] auto-update: ${line}`, level);
}

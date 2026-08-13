/**
 * The cross-harness hook shim (REQ-EXT-25): stdin JSON in, decision JSON out.
 *
 * The existing Claude Code hook scripts (`block-dangerous-bash.sh`, `protect-secrets.sh`) must
 * stay callable as processes so one script serves Claude Code, Copilot CLI and PI. Both scripts
 * open with `INPUT=$(cat)` and emit Claude Code's `hookSpecificOutput` envelope, and the
 * requirement's acceptance criterion is that the file works *unmodified*. That fixes two things
 * this module cannot negotiate away: the payload arrives on stdin, and the reply is parsed in
 * Claude Code's shape.
 *
 * Spawn latency lands on the hot path (`PreToolUse:Read` fired 750x, `:Bash` 315x in 65 days),
 * so a missing or unusable script is memoized after the first look.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { describeError, surfaceOnce } from "./once.ts";

export interface HookDecision {
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  systemMessage?: string;
  /** Claude Code's SessionStart/UserPromptSubmit context-injection channel. */
  additionalContext?: string;
}

export interface ExecHookOptions {
  readonly timeoutMs?: number; // default 3000 — a hook is on the hot path
  readonly cwd?: string;
  /** Where hook failures are surfaced. Defaults to stderr. Deduped per script + failure class. */
  readonly onError?: (line: string) => void;
  /** Hard cap on captured output. Default 1 MiB; more than that is a runaway script. */
  readonly maxOutputBytes?: number;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const unusable = new Set<string>();

/**
 * Runs a hook script with a JSON payload on stdin and parses a JSON decision from stdout.
 *
 * Fail-open by contract: a missing script, a timeout, an unexpected exit code or unparsable
 * stdout all return `{}` — the caller must treat `{}` as "no opinion", never as "allow".
 * Exit code 2 is Claude Code's "block, and feed stderr back to the model", and is honoured.
 *
 * @param pi accepted so every call site written against the module contract compiles
 *   unchanged. It is not used: PI's `ExecOptions` is `{ signal, timeout, cwd }` with no stdin
 *   channel (verified against `dist/core/exec.d.ts` in 0.84.0), and the hook contract is
 *   stdin-based. See the module note.
 */
export async function execHook(
  pi: ExtensionAPI | null | undefined,
  scriptPath: string,
  payload: unknown,
  opts: ExecHookOptions = {},
): Promise<HookDecision> {
  void pi;
  if (unusable.has(scriptPath)) return {};

  const report = opts.onError ?? defaultOnError;
  try {
    await access(scriptPath, constants.X_OK);
  } catch (err) {
    unusable.add(scriptPath);
    // A hook that is present but not executable is a silent no-op — the exact failure mode
    // REQ-EXT-16 forbids. Name it once; the memo keeps it off the hot path afterwards.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      surfaceOnce(undefined, `exec-hook:unusable:${scriptPath}`, () =>
        report(`[pi-config] hook ${scriptPath} is not executable and was skipped: ${describeError(err)}`),
      );
    }
    return {};
  }

  let res: RawRun;
  try {
    res = await run(scriptPath, payload, opts);
  } catch (err) {
    surfaceOnce(undefined, `exec-hook:spawn:${scriptPath}`, () =>
      report(`[pi-config] hook ${scriptPath} could not be run: ${describeError(err)}`),
    );
    return {};
  }

  if (res.timedOut) {
    surfaceOnce(undefined, `exec-hook:timeout:${scriptPath}`, () =>
      report(
        `[pi-config] hook ${scriptPath} exceeded ${opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS} ms and was killed; treated as no opinion`,
      ),
    );
    return {};
  }

  if (res.code === 2) {
    const reason = res.stderr.trim() || `Blocked by hook ${scriptPath} (exit 2, no reason given)`;
    return { decision: "deny", reason };
  }

  if (res.code !== 0) {
    surfaceOnce(undefined, `exec-hook:exit${res.code}:${scriptPath}`, () =>
      report(
        `[pi-config] hook ${scriptPath} exited ${res.code}; treated as no opinion. stderr: ${res.stderr.trim().slice(0, 400)}`,
      ),
    );
    return {};
  }

  const stdout = res.stdout.trim();
  if (!stdout) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    surfaceOnce(undefined, `exec-hook:badjson:${scriptPath}`, () =>
      report(
        `[pi-config] hook ${scriptPath} wrote non-JSON stdout; treated as no opinion: ${describeError(err)}`,
      ),
    );
    return {};
  }
  return normalizeDecision(parsed);
}

/**
 * Maps every reply shape the ported scripts actually emit onto `HookDecision`:
 *   - `hookSpecificOutput.permissionDecision` / `.permissionDecisionReason` / `.additionalContext`
 *     — what `protect-secrets.sh` and `block-dangerous-bash.sh` write today
 *   - legacy flat `decision: "approve" | "block"` with `reason`
 *   - already-normalised `decision: "allow" | "deny" | "ask"`
 */
export function normalizeDecision(parsed: unknown): HookDecision {
  if (typeof parsed !== "object" || parsed === null) return {};
  const raw = parsed as Record<string, unknown>;
  const out: HookDecision = {};

  const specific = raw.hookSpecificOutput;
  if (typeof specific === "object" && specific !== null) {
    const s = specific as Record<string, unknown>;
    const d = asDecision(s.permissionDecision);
    if (d) out.decision = d;
    if (typeof s.permissionDecisionReason === "string") out.reason = s.permissionDecisionReason;
    if (typeof s.additionalContext === "string") out.additionalContext = s.additionalContext;
  }

  const flat = asDecision(raw.decision);
  if (flat) out.decision = flat;
  if (typeof raw.reason === "string" && out.reason === undefined) out.reason = raw.reason;
  if (typeof raw.systemMessage === "string") out.systemMessage = raw.systemMessage;
  if (typeof raw.additionalContext === "string" && out.additionalContext === undefined) {
    out.additionalContext = raw.additionalContext;
  }
  return out;
}

/** Test-only: forget which scripts were found missing or non-executable. */
export function resetHookCache(): void {
  unusable.clear();
}

function asDecision(v: unknown): HookDecision["decision"] | undefined {
  if (v === "allow" || v === "deny" || v === "ask") return v;
  if (v === "approve") return "allow";
  if (v === "block") return "deny";
  return undefined;
}

interface RawRun {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/**
 * Node-implemented timeout. Neither `timeout(1)` nor `gtimeout(1)` exists on this machine,
 * and shelling out for a stopwatch would add a second spawn to the hot path.
 */
function run(scriptPath: string, payload: unknown, opts: ExecHookOptions): Promise<RawRun> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<RawRun>((resolve, reject) => {
    const child = spawn(scriptPath, [], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let hardKill: NodeJS.Timeout | undefined;
    const softKill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 500);
      hardKill.unref();
    }, timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      if (hardKill) clearTimeout(hardKill);
      fn();
    };

    const cap = (current: string, chunk: Buffer): string => {
      if (current.length >= maxBytes) return current;
      return (current + chunk.toString("utf8")).slice(0, maxBytes);
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = cap(stderr, c);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) =>
      finish(() => resolve({ stdout, stderr, code: code ?? (signal ? 128 : 1), timedOut })),
    );

    child.stdin?.on("error", () => {
      // The script exited without reading stdin (an early `exit 0`). EPIPE here is normal
      // and must not be reported as a hook failure; the close handler still resolves.
    });
    child.stdin?.end(JSON.stringify(payload ?? {}));
  });
}

function defaultOnError(line: string): void {
  process.stderr.write(`${line}\n`);
}

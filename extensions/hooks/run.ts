/**
 * The `run` action's script executor — deliberately the OPPOSITE polarity of
 * `../lib/exec-hook.ts` (`EXT-01`).
 *
 * `exec-hook.ts` says of itself: "Fail-open by contract: a missing script, a timeout, an
 * unexpected exit code or unparsable stdout all return `{}` — the caller must treat `{}` as
 * 'no opinion', never as 'allow'." That is exactly correct for its job (the legacy
 * cross-harness shim, an optional enhancement) and exactly wrong for this one. `pi-yaml-hooks`
 * was rejected for the same four failure classes doing the same thing to a *guardrail*
 * (`docs/DENYLIST.md` §4a, findings #3 and #4). So this module cannot reuse `exec-hook.ts`: the
 * whole point is that here, those failure classes BLOCK instead.
 *
 * The one case this treats as a genuine pass-through, not a failure: a script that runs to
 * completion, exits 0, and deliberately writes nothing. That is a script author choosing to
 * have no opinion — a real evaluation outcome, not an infrastructure failure — and is the only
 * way a `run` rule can let a tool call proceed.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

export type RunOutcome =
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "no-opinion" }
  /** An infrastructure failure: the script could not be evaluated as configured. Callers must
   *  block on this, never treat it as "no-opinion". */
  | { readonly verdict: "blocked-internal"; readonly reason: string };

export const DEFAULT_RUN_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DENY_EXIT_CODE = 2;

export interface RunGuardScriptOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export async function runGuardScript(
  command: string,
  args: readonly string[],
  payload: unknown,
  opts: RunGuardScriptOptions = {},
): Promise<RunOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  try {
    await access(command, constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "?";
    return {
      verdict: "blocked-internal",
      reason: `script "${command}" is missing or not executable (${code})`,
    };
  }

  let result: RawResult;
  try {
    result = await spawnWithTimeout(command, args, payload, opts);
  } catch (err) {
    return {
      verdict: "blocked-internal",
      reason: `script "${command}" could not be run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.timedOut) {
    return {
      verdict: "blocked-internal",
      reason: `script "${command}" exceeded ${timeoutMs} ms and was killed`,
    };
  }

  if (result.code === DENY_EXIT_CODE) {
    const reason = result.stderr.trim() || `denied by "${command}" (exit 2)`;
    return { verdict: "deny", reason };
  }

  if (result.code !== 0) {
    return {
      verdict: "blocked-internal",
      reason: `script "${command}" exited ${result.code}, which is not 0 or 2: ${result.stderr.trim().slice(0, 300)}`,
    };
  }

  const stdout = result.stdout.trim();
  if (!stdout) return { verdict: "no-opinion" }; // ran fine, chose to say nothing — a real pass

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      verdict: "blocked-internal",
      reason: `script "${command}" wrote non-JSON stdout: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const decision = (parsed as { decision?: unknown } | null)?.decision;
  if (decision === "deny") {
    const reason = (parsed as { reason?: unknown }).reason;
    return { verdict: "deny", reason: typeof reason === "string" ? reason : `denied by "${command}"` };
  }
  return { verdict: "no-opinion" };
}

interface RawResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly timedOut: boolean;
}

/** Node-implemented timeout, same reasoning as `exec-hook.ts`: no `timeout(1)`/`gtimeout(1)` on macOS. */
function spawnWithTimeout(
  command: string,
  args: readonly string[],
  payload: unknown,
  opts: RunGuardScriptOptions,
): Promise<RawResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<RawResult>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });

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

    const cap = (current: string, chunk: Buffer): string =>
      current.length >= maxBytes ? current : (current + chunk.toString("utf8")).slice(0, maxBytes);

    child.stdout?.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) =>
      finish(() => resolve({ stdout, stderr, code: code ?? (signal ? 128 : 1), timedOut })),
    );
    child.stdin?.on("error", () => {
      // Script exited without reading stdin. Normal (e.g. `exit 2` at the top of the file) and
      // must not be reported as a run failure — `close` still resolves.
    });
    child.stdin?.end(JSON.stringify(payload ?? {}));
  });
}

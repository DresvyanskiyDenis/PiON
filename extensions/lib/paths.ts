/**
 * Every path this tree writes to, in one place.
 *
 * `configDir()` delegates to PI's own `getAgentDir()` rather than recomputing it. PI derives
 * both the directory name (`CONFIG_DIR_NAME`, from `package.json` `piConfig.configDir`) and the
 * override env var (`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`) from the same rebrand switch,
 * so a hand-rolled copy is wrong for a rebranded distribution in exactly the case the rule
 * "never hardcode `.pi`" exists to cover — and the enterprise rebrand path is explicitly on
 * the table.
 */
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export { CONFIG_DIR_NAME };

/** `~/.pi/agent`, or whatever the running distribution and its env override say. */
export function configDir(): string {
  return getAgentDir();
}

/** Everything this harness writes that is not PI's own config. */
export function stateRoot(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-config");
}

export function scratchDir(sessionId: string): string {
  return join(stateRoot(), "scratch", sessionId);
}

export function lockDir(name: string): string {
  return join(stateRoot(), "locks", name);
}

/**
 * Where a headless run (`ctx.hasUI === false`) records a provider abort it cannot otherwise put in
 * front of anyone. A detached `-p`/`--mode json` process has no TUI to notify and its stderr often
 * goes nowhere an operator will look until much later — the exit code says *that* it failed, this
 * file is the only durable record of *why*.
 */
export function providerAbortLogPath(): string {
  return join(stateRoot(), "provider-abort.log");
}

export function repoRoot(): string {
  return process.env.PI_CONFIG_REPO ?? join(homedir(), "pi-config");
}

/** Used only when `stateRoot()` is unwritable; announced, never silent. */
export function fallbackTmp(): string {
  return join(tmpdir(), "pi-config");
}

/**
 * Creates `stateRoot()` (0700) and returns it. When it cannot be created, announces the
 * degradation through `announce` and returns `fallbackTmp()` instead. The announcement is the
 * point: a harness that quietly relocates its state loses a session digest and says nothing.
 */
export async function ensureStateRoot(announce?: (line: string) => void): Promise<string> {
  const preferred = stateRoot();
  try {
    await mkdir(preferred, { recursive: true, mode: 0o700 });
    return preferred;
  } catch (err) {
    const fallback = fallbackTmp();
    const say = announce ?? ((line: string) => process.stderr.write(`${line}\n`));
    say(
      `[pi-config] state root ${preferred} is unusable (${(err as Error).message}); ` +
        `falling back to ${fallback} — state will not survive a reboot`,
    );
    await mkdir(fallback, { recursive: true, mode: 0o700 });
    return fallback;
  }
}

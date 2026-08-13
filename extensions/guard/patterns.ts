/**
 * The catastrophic-bash pattern set — `REQ-PRV-36`, `REQ-EXT-15`.
 *
 * Ported from `~/.claude/hooks/block-dangerous-bash.sh`, including its comments.
 *
 * The `rm -rf` matcher carries its own post-mortem: the original pattern silently required `r`
 * **before** `f`, so `rm -fr /` walked through for months. The corrected
 * pattern is ported character-for-character, and `\bmkfs\.` — commented out on the Mac in a
 * "temporarily, restore right after" note — is **restored** here.
 *
 * **Design rule, carried over verbatim from the original script and enforced by the test table:**
 * `rm -rf ./build` is ordinary work and must pass. Guarding it is what made the old
 * `permissions.deny Bash(rm -rf *)` unusable.
 */
import { program, tokenize } from "./shell.ts";

/**
 * `raw`     — tested against the whole command string, so a pattern may span a pipe.
 * `program` — tested against the effective program of each pipeline segment.
 */
export type DangerScope = "raw" | "program";

export interface DangerPattern {
  readonly id: string;
  readonly re: RegExp;
  readonly what: string;
  readonly overridable: boolean;
  readonly scope: DangerScope;
}

const RM_FLAGS =
  String.raw`(-[a-zA-Z]*(([rR][a-zA-Z]*f)|(f[a-zA-Z]*[rR]))[a-zA-Z]*` +
  String.raw`|-[rR][a-zA-Z]*\s+-f[a-zA-Z]*` +
  String.raw`|-f[a-zA-Z]*\s+-[rR][a-zA-Z]*` +
  String.raw`|--recursive\s+--force|--force\s+--recursive)`;
const RM_TARGET = String.raw`(/|/\*|~|~/|\$HOME|\$\{HOME\})`;

export const DANGER_PATTERNS: readonly DangerPattern[] = [
  {
    id: "DB-RM-ROOT",
    re: new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+${RM_TARGET}(\s|$)`),
    what: "recursive force-delete of / , ~ or $HOME",
    overridable: false,
    scope: "raw",
  },
  {
    id: "DB-FORKBOMB",
    re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    what: "fork bomb",
    overridable: false,
    scope: "raw",
  },
  {
    id: "DB-DD-DISK",
    re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/,
    what: "dd writing to a raw block device",
    overridable: false,
    scope: "raw",
  },
  {
    id: "DB-CURL-SH",
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
    what: "piping a downloaded script into a shell",
    overridable: true,
    scope: "raw",
  },
  {
    id: "DB-REDIR-DISK",
    re: />\s*\/dev\/(sd|nvme|disk)/,
    what: "redirecting output onto a raw block device",
    overridable: false,
    scope: "raw",
  },
  {
    id: "DB-CHMOD-777",
    re: /\bchmod\s+-R\s+777\s+\/(\s|$)/,
    what: "chmod -R 777 on /",
    overridable: false,
    scope: "raw",
  },
  {
    // `REQ-PRV-36` spells this `\bshutdown\s`, which blocks `grep -r shutdown ./src`. The spec's
    // own MUST_PASS table requires that command to run, so the match is made on the effective
    // PROGRAM of a segment instead of on the raw text — the tokeniser is what makes that possible.
    id: "DB-SHUTDOWN",
    re: /^(shutdown|halt|reboot|poweroff)$/,
    what: "shutting the machine down",
    overridable: true,
    scope: "program",
  },
  // RESTORED. It was commented out on 2026-07 to partition an HDD on `dna` and never put back —
  // an outstanding regression, fixed before porting.
  {
    id: "DB-MKFS",
    re: /\bmkfs\./,
    what: "creating a filesystem (destroys the target device)",
    overridable: false,
    scope: "raw",
  },
];

/**
 * Collapses repeated letters inside a **single-dash** flag cluster: `-rrrrffff` -> `-rf`.
 *
 * This exists for one reason and it is not cosmetic. `RM_FLAGS` is an ambiguous pattern —
 * `-[a-zA-Z]*(([rR][a-zA-Z]*f)|(f[a-zA-Z]*[rR]))[a-zA-Z]*` can match a long cluster in a very
 * large number of ways, and every one of them is re-tried when the trailing `\s+<target>` fails.
 * Measured on this machine before the fix: `rm -` + 1000×"r" + 1000×"f" took **704 ms**, and
 * 1400+1400 took **2 093 ms**, growing superlinearly. The model controls that string, the guard
 * runs on every tool call, and a `tool_call` handler that stalls stalls the turn.
 *
 * Flag letters are a *set*, so deduplicating them cannot change which commands match: `rm -rrf /`
 * and `rm -rf /` are the same command to `rm`. The bound is 52 characters (the alphabet), which
 * takes the pathological case back to microseconds. Long-form flags are deliberately untouched —
 * `--recursive` must survive intact for the `--recursive\s+--force` alternative.
 */
export function normalizeFlagRuns(command: string): string {
  return command.replace(/(?<![A-Za-z0-9-])-([A-Za-z]{2,})(?![A-Za-z])/g, (_m, letters: string) => {
    const seen = new Set<string>();
    let out = "";
    for (const ch of letters) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      out += ch;
    }
    return `-${out}`;
  });
}

/** Raw-scope patterns only. Signature preserved from an earlier draft. */
export function matchDangerous(raw: string): DangerPattern | null {
  const normalized = normalizeFlagRuns(raw);
  for (const p of DANGER_PATTERNS) {
    if (p.scope === "raw" && p.re.test(normalized)) return p;
  }
  return null;
}

/** Program-scope patterns only. */
export function matchDangerousPrograms(names: readonly string[]): DangerPattern | null {
  for (const p of DANGER_PATTERNS) {
    if (p.scope !== "program") continue;
    for (const name of names) if (p.re.test(name)) return p;
  }
  return null;
}

/**
 * Both scopes, in `DANGER_PATTERNS` order, against one command line.
 * This is what the gate calls; the two narrower functions exist for tests and reuse.
 */
export function matchCommand(command: string): DangerPattern | null {
  const segments = tokenize(command);
  const names: string[] = [];
  for (const seg of segments) {
    const p = program(seg);
    if (p !== undefined) names.push(p);
  }
  const normalized = normalizeFlagRuns(command);
  for (const p of DANGER_PATTERNS) {
    if (p.scope === "raw") {
      if (p.re.test(normalized)) return p;
    } else if (names.some((n) => p.re.test(n))) {
      return p;
    }
  }
  return null;
}

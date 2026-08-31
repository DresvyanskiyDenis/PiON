// bin/lib/hook-scripts.mjs — extract and validate `action: run` hook scripts from config/hooks.yaml.
//
// ## The failure this exists for
//
// `config/hooks.yaml` carries two `action: run` rules whose command is `~/bin/pi-constraints-hook`,
// a symlink `scripts/install.sh` creates. `extensions/hooks/run.ts` fails CLOSED on a missing script —
// a guardrail that cannot be evaluated must not permit the call. So a symlink that is absent
// (install.sh never re-run) or stale does not disable the guardrail: it kills `write` and `edit`,
// with no trace visible except one blocked-call reason per attempt.
//
// ## Why this is a MODE, not a rule
//
// `bin/rules/*.mjs` answers questions about the repo TREE and runs in CI, where `$HOME/bin` does
// not exist. A rule asking "is this install current?" would fail every CI run for a reason CI
// cannot fix. Install state is machine state; it gets its own mode, run by install.sh, update.sh,
// postinstall-verify.sh, and by any human typing `bin/pi-check --doctor`.

import { lstatSync, readlinkSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export const HOOKS_FILE = "config/hooks.yaml";

/** The empty gate `docs/extending/hooks.md` documents as the off-switch, repo-relative. */
export const HOOKS_OFF_FILE = "config/hooks-off.yaml";

export function installPaths(env = process.env) {
  const home = env.HOME || homedir();
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  return { home, binDir: join(home, "bin"), stableLink: join(home, "pi-config"), agentDir };
}

export function extractRunCommands(text) {
  const lines = text.split("\n");
  const commands = [];
  let currentId = "<unnamed>";
  let runActions = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const idMatch = /^-\s+id:\s*(\S+)/.exec(trimmed);
    if (idMatch) {
      currentId = stripQuotes(idMatch[1]);
      continue;
    }
    if (/^action:\s*run\s*$/.test(trimmed)) {
      runActions++;
      continue;
    }
    const cmdMatch = /^command:\s*(.+)$/.exec(trimmed);
    if (cmdMatch) {
      const command = scalar(cmdMatch[1]);
      if (command === "") return { ok: false, error: `${HOOKS_FILE}:${i + 1}: "command:" has an empty value` };
      commands.push({ ruleId: currentId, command, line: i + 1 });
    }
  }

  if (runActions !== commands.length) {
    return {
      ok: false,
      error:
        `${HOOKS_FILE}: found ${runActions} "action: run" rule(s) but ${commands.length} "command:" value(s) — ` +
        `this scanner does not understand the file's shape and would under-report installed hooks`,
    };
  }
  return { ok: true, commands };
}

function scalar(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.length >= 2) || (v.startsWith("'") && v.length >= 2)) {
    const quote = v[0];
    const end = v.indexOf(quote, 1);
    if (end > 0) return v.slice(1, end);
  }
  const hash = v.indexOf(" #");
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

function stripQuotes(value) {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHome(command, home) {
  if (command === "~") return home;
  if (command.startsWith("~/")) return join(home, command.slice(2));
  return command;
}

const REINSTALL = "re-run ./scripts/install.sh";

/**
 * What `$AGENT_DIR/hooks.yaml` currently IS on this machine: the repo's rule set, the documented
 * off-switch (`config/hooks-off.yaml`), something else, a real file, or nothing.
 *
 * Informational, never a finding. It returns a `note`, not a `message`, so it cannot reach the
 * finding path by accident, and `runDoctor` never lets it move the exit code:
 *
 * - Guardrails switched off on purpose is a legitimate state, not a defect. Failing on it would
 *   make `--doctor` unrunnable exactly when the operator has chosen the state it reports, and both
 *   `install.sh` and `update.sh` treat a `--doctor` finding as fatal.
 * - A real file where the installer's symlink belongs is not this mode's business either:
 *   `link_one` already backs it up and relinks on the next install, loudly.
 *
 * What it buys is the one thing an off-switch otherwise lacks. A hook layer carrying zero rules is
 * indistinguishable from a machine that never installed one — the same invisibility the missing-`run`
 * -script case is made of — and this line tells the two apart from a shell, before a session starts.
 */
export function describeInstalledHooksFile(paths) {
  const path = join(paths.agentDir, "hooks.yaml");
  const active = join(paths.stableLink, HOOKS_FILE);
  const off = join(paths.stableLink, HOOKS_OFF_FILE);

  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return {
      path,
      state: "absent",
      target: null,
      note:
        `nothing installed here, so the hook layer loads zero rules (a missing file is normal to the ` +
        `loader, not a failure). If that is deliberate, prefer the recorded off-switch — ` +
        `ln -sf ${off} ${path} — which still reads as a decision six months later. Otherwise: ${REINSTALL}`,
    };
  }

  if (!stats.isSymbolicLink()) {
    return {
      path,
      state: "file",
      target: null,
      note:
        `a real file, not the installer's symlink: whatever rules it carries are the ones running, ` +
        `and install.sh backs it up and relinks on its next run`,
    };
  }

  const target = readlinkSync(path);
  try {
    statSync(path); // follows the link
  } catch {
    return {
      path,
      state: "dangling",
      target,
      note: `points at ${target}, which does not exist — the loader reads that as "no file" and loads zero rules. ${REINSTALL}`,
    };
  }

  if (target === off) {
    return { path, state: "off", target, note: `GUARDRAILS OFF — linked to the empty gate. Back on: ln -sf ${active} ${path}` };
  }
  if (target === active) {
    return { path, state: "active", target, note: `linked to the repo's rule set` };
  }
  return {
    path,
    state: "elsewhere",
    target,
    note:
      `points at ${target}, which is neither ${active} nor ${off} — install.sh and update.sh will ` +
      `re-point it at the rule set on their next run`,
  };
}

/**
 * @param ctx repo-reading context
 * @param paths from `installPaths()`
 * @param installed from `describeInstalledHooksFile()`. When the machine's gate is the empty one,
 *   `config/hooks.yaml`'s `run` rules are not loaded on this machine and cannot fail closed on it —
 *   so their install state is not a finding, and reporting it would make `--doctor` fail (and with
 *   it `install.sh` and `update.sh`) over a rule nobody is running. The one check that survives is
 *   the repo-shape one: a rule naming a `~/bin` script this repo does not ship is broken for every
 *   machine that DOES opt in, and `--doctor` is where it gets caught.
 */
export function checkInstalledHookScripts(ctx, paths, installed = null) {
  const rule = "PD-01";
  const gateIsOff = installed?.state === "off";
  const text = ctx.readText(HOOKS_FILE);
  if (text === null) return [];

  const extracted = extractRunCommands(text);
  if (!extracted.ok) return [{ rule, file: HOOKS_FILE, message: `${extracted.error} — fix the file or this scanner` }];

  const findings = [];
  for (const { ruleId, command, line } of extracted.commands) {
    const target = expandHome(command, paths.home);
    const name = basename(target);
    const label = `hook "${ruleId}" (${command})`;

    const source = `config/bin/${name}`;
    const linkable = target === join(paths.binDir, name);
    if (linkable && !ctx.exists(source)) {
      findings.push({
        rule,
        file: HOOKS_FILE,
        line,
        message:
          `${label} names a script under ~/bin, but this repo has no ${source} — install.sh will never link it, ` +
          `so the rule blocks every matching tool call on every machine. Add the script or drop the rule.`,
      });
      continue;
    }
    if (gateIsOff) continue;

    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      findings.push({
        rule,
        file: target,
        line,
        message: `${label} is NOT installed — the rule fails closed, so its tool is dead this session. ${REINSTALL}`,
      });
      continue;
    }

    if (linkable) {
      const want = join(paths.stableLink, "config", "bin", name);
      if (!stats.isSymbolicLink()) {
        findings.push({
          rule,
          file: target,
          line,
          message: `${label} is a real file where a symlink to ${want} belongs — it will not track this repo. ${REINSTALL}`,
        });
        continue;
      }
      const have = readlinkSync(target);
      if (have !== want) {
        findings.push({
          rule,
          file: target,
          line,
          message: `${label} points at ${have}, not at ${want} — a stale link from an earlier checkout. ${REINSTALL}`,
        });
        continue;
      }
    }

    try {
      statSync(target);
      accessSync(target, constants.X_OK);
    } catch (err) {
      const code = err && err.code ? err.code : "?";
      findings.push({
        rule,
        file: target,
        line,
        message: `${label} resolves to a target that is missing or not executable (${code}) — the rule fails closed. ${REINSTALL}`,
      });
    }
  }
  return findings;
}

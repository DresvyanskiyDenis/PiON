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

export function installPaths(env = process.env) {
  const home = env.HOME || homedir();
  return { home, binDir: join(home, "bin"), stableLink: join(home, "pi-config") };
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

export function checkInstalledHookScripts(ctx, paths) {
  const rule = "PD-01";
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

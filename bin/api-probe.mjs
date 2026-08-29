#!/usr/bin/env node
// bin/api-probe.mjs — the drift detector for abandon criterion A-2 (EXT-31).
//
// This port depends on ~33 PI lifecycle events and a single-vendor extension API that is
// moving fast (0.84.1 shipped the day after 0.84.0). This script reads that surface straight
// from the installed @earendil-works/pi-coding-agent package's shipped .d.ts files — never
// from documentation, never from memory — and either records it (dump mode) or diffs the
// currently-installed surface against a previously recorded lock (check mode), exiting
// non-zero when something we depend on has been removed or renamed.
//
// Why .d.ts and not the running binary directly: PI's standalone binary distribution (the
// one `pi update`/the curl installer puts on PATH, e.g. ~/.local/pi/<version>/pi/pi) ships a
// package.json for version metadata but no type declarations at all — it is a bundled
// executable. --pi therefore names the *binary* whose behaviour we're being asked about;
// this script resolves *types* in two steps and refuses to proceed rather than guess:
//   1. Walk up from --pi's real path looking for a package.json named
//      @earendil-works/pi-coding-agent whose own dist/ ships .d.ts files — this is true for
//      node_modules/.bin/pi, and is the shape a full npm-package-style side-by-side release
//      unpack would have too (the "fetch, unpack, do not link yet" upgrade recipe). When found,
//      that tree's version is the binary's version by construction.
//   2. Otherwise (today's standalone-binary case) fall back to this repo's own pinned
//      devDependency in node_modules, and abort loudly if ITS version disagrees with what
//      `--pi --version` reports — a probe run must never silently record one version's
//      surface while claiming to describe another.
//
// Usage:
//   bin/api-probe.mjs --pi <path-to-pi-binary>                    dump mode (default)
//       Extracts the current surface and prints it as JSON to stdout. Redirect stdout to
//       create or refresh config/api-surface.lock.json.
//   bin/api-probe.mjs --pi <path-to-pi-binary> --check [--lock <path>]
//       Extracts the current surface and diffs it against the lock file (default:
//       config/api-surface.lock.json). Prints a human-readable report to stdout.
//
// Exit codes:
//   0  dump succeeded, or check found no breaking change
//   1  check found a breaking change — a locked event, ExtensionAPI member, or depended-on
//      Settings key is missing from the installed package. This is A-2's detector signal. Only
//      Settings keys PI itself declared at lock time count: package-owned keys (recorded in the
//      lock as `settingsKeysNotDeclaredByPi`) were never PI's to remove.
//   2  the probe itself could not run: missing/bad --pi, binary/package version mismatch,
//      package not installed, expected interface not found (zero or more than one match),
//      lock file missing or corrupt for --check. Fail loud, never a silent 0.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * Replaces the current user's home directory with "~" in an absolute path before it goes
 * into recorded JSON output. The lock file is committed to a private-but-GitHub-hosted repo,
 * so a machine-local absolute path (which embeds the macOS account name) is not something
 * that belongs in it verbatim.
 */
function redactHome(absolutePath) {
  const home = homedir();
  return absolutePath === home || absolutePath.startsWith(home + "/") ? "~" + absolutePath.slice(home.length) : absolutePath;
}

function usageError(message) {
  process.stderr.write(`api-probe: ${message}\n`);
  process.stderr.write(
    "usage: bin/api-probe.mjs --pi PATH [--dump]\n" + "       bin/api-probe.mjs --pi PATH --check [--lock PATH]\n",
  );
  process.exitCode = 2;
}

function failLoud(message) {
  process.stderr.write(`api-probe: ${message}\n`);
  process.exitCode = 2;
}

/** Recursively collects .d.ts file paths under `dir`, skipping any nested node_modules. */
function findDtsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findDtsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Finds the `export interface ExtensionAPI { ... }` declaration in a parsed .d.ts source
 * (re-exports like `export type { ExtensionAPI } from "./x.ts"` do not match — they are not
 * InterfaceDeclaration nodes). Returns { events, apiMethods } or null if this file doesn't
 * contain it.
 */
function extractExtensionAPI(sourceFile) {
  let found = null;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "ExtensionAPI") {
      const events = new Set();
      const apiMethods = new Set();
      for (const member of node.members) {
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const name = member.name.text;
        apiMethods.add(name);
        if (name === "on" && ts.isMethodSignature(member)) {
          const firstParam = member.parameters[0];
          const paramType = firstParam?.type;
          if (paramType && ts.isLiteralTypeNode(paramType) && ts.isStringLiteral(paramType.literal)) {
            events.add(paramType.literal.text);
          }
        }
      }
      found = { events: [...events], apiMethods: [...apiMethods] };
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Finds `export interface Settings { ... }` and returns its top-level property names, or null. */
function extractSettingsKeys(sourceFile) {
  let found = null;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "Settings") {
      const keys = new Set();
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          keys.add(member.name.text);
        }
      }
      found = [...keys];
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Scans every .d.ts under pkgDir/dist for exactly one ExtensionAPI interface and exactly one
 * Settings interface. Throws a descriptive Error (never returns a partial/empty surface) if
 * either is missing or ambiguous — an ambiguous match means PI restructured its dist layout
 * enough that this probe can no longer trust its own extraction, which is itself the kind of
 * drift this tool exists to surface loudly rather than paper over.
 */
function extractInstalledSurface(pkgDir) {
  const distDir = join(pkgDir, "dist");
  if (!existsSync(distDir)) {
    throw new Error(`${PACKAGE_NAME} has no dist/ directory at ${distDir} — cannot read any .d.ts`);
  }
  const files = findDtsFiles(distDir);
  const apiHits = [];
  const settingsHits = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const api = extractExtensionAPI(sf);
    if (api) apiHits.push({ file, ...api });
    const settings = extractSettingsKeys(sf);
    if (settings) settingsHits.push({ file, keys: settings });
  }
  if (apiHits.length === 0) {
    throw new Error(`found no "export interface ExtensionAPI" in any .d.ts under ${distDir}`);
  }
  if (apiHits.length > 1) {
    const at = apiHits.map((h) => relative(pkgDir, h.file)).join(", ");
    throw new Error(`found "export interface ExtensionAPI" in ${apiHits.length} files (${at}) — expected exactly one`);
  }
  if (settingsHits.length === 0) {
    throw new Error(`found no "export interface Settings" in any .d.ts under ${distDir}`);
  }
  if (settingsHits.length > 1) {
    const at = settingsHits.map((h) => relative(pkgDir, h.file)).join(", ");
    throw new Error(`found "export interface Settings" in ${settingsHits.length} files (${at}) — expected exactly one`);
  }
  return {
    events: apiHits[0].events.sort(),
    apiMethods: apiHits[0].apiMethods.sort(),
    settingsAvailable: settingsHits[0].keys.sort(),
    sourceFiles: {
      extensionApi: relative(pkgDir, apiHits[0].file),
      settings: relative(pkgDir, settingsHits[0].file),
    },
  };
}

/**
 * Reads the top-level keys of config/settings.json — "the settings keys we depend on".
 *
 * Not all of them belong to PI core. PI's SettingsManager JSON.parses settings.json verbatim,
 * applies a small key migration and keeps every unrecognised key (dist/core/settings-manager.js
 * loadFromStorage/migrateSettings — there is no schema strip), and installed PI packages read
 * their own top-level key straight off that object. A key PI's own `Settings` interface never
 * declares is therefore normal, not an error — see the partition in probeCurrent().
 */
function readDependedSettingsKeys(repoRoot) {
  const path = join(repoRoot, "config", "settings.json");
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist — cannot determine which settings keys we depend on`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON — ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object at the top level`);
  }
  return Object.keys(parsed).sort();
}

/** Walks up from `startDir` for the nearest ancestor (inclusive) containing a package.json. */
function findPackageJsonUpward(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageJson(pkgJsonPath) {
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (typeof pkgJson.version !== "string" || pkgJson.version.length === 0) {
    throw new Error(`${pkgJsonPath} has no "version" field`);
  }
  return pkgJson;
}

/**
 * Resolves the npm package tree to read .d.ts from for the binary named by `--pi`.
 *
 * Step 1: look for a package.json named @earendil-works/pi-coding-agent co-located with the
 * binary (walking upward) whose own dist/ ships .d.ts files. True for node_modules/.bin/pi,
 * and for any side-by-side npm-package-style release unpack.
 *
 * Step 2: today's standalone binary distribution has a package.json (for version metadata)
 * but no dist/ and no .d.ts anywhere near it, so step 1 finds nothing usable — fall back to
 * this repo's own pinned devDependency. Version agreement against `--pi --version` is
 * checked by the caller; this function only resolves *where* to read types from.
 */
function resolvePackage(piPath, repoRoot) {
  const realPi = realpathSync(piPath);
  const nearJsonPath = findPackageJsonUpward(dirname(realPi));
  if (nearJsonPath) {
    const pkgDir = dirname(nearJsonPath);
    const pkgJson = readPackageJson(nearJsonPath);
    const distDir = join(pkgDir, "dist");
    if (pkgJson.name === PACKAGE_NAME && existsSync(distDir) && findDtsFiles(distDir).length > 0) {
      return { pkgDir, version: pkgJson.version, coLocated: true };
    }
  }
  const fallbackDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(fallbackDir)) {
    throw new Error(
      `${PACKAGE_NAME} ships no .d.ts near "${piPath}" (the standalone binary distribution has none), and the ` +
        `fallback — this repo's own devDependency at ${fallbackDir} — is not installed either. api-probe cannot ` +
        `read a surface it cannot find.`,
    );
  }
  const pkgJson = readPackageJson(join(fallbackDir, "package.json"));
  if (pkgJson.name !== PACKAGE_NAME) {
    throw new Error(`${join(fallbackDir, "package.json")} names package "${pkgJson.name}", expected "${PACKAGE_NAME}"`);
  }
  return { pkgDir: fallbackDir, version: pkgJson.version, coLocated: false };
}

/** Runs `<piPath> --version` and extracts a semver-shaped token from its output. */
function readBinaryVersion(piPath) {
  let stdout;
  try {
    stdout = execFileSync(piPath, ["--version"], { encoding: "utf8" });
  } catch (err) {
    throw new Error(`\`${piPath} --version\` failed to run — ${err.message}`);
  }
  const trimmed = stdout.trim();
  const match = trimmed.match(/\d+\.\d+\.\d+/);
  if (!match) {
    throw new Error(`\`${piPath} --version\` printed "${trimmed}" — no version number found in it`);
  }
  return match[0];
}

/**
 * Resolves types, verifies the binary/package version agreement, and extracts the full
 * current surface exactly once. Returns { surface, settingsAvailable } — `surface` is the
 * dump-mode JSON payload; `settingsAvailable` (the complete current Settings key set, not
 * just the ones we depend on) is the extra piece --check needs for diffing and that the
 * public lock schema deliberately doesn't carry.
 */
function probeCurrent(repoRoot, piPath) {
  const { pkgDir, version: pkgVersion, coLocated } = resolvePackage(piPath, repoRoot);
  const binaryVersion = readBinaryVersion(piPath);
  if (binaryVersion !== pkgVersion) {
    const origin = coLocated ? `co-located with the binary at ${pkgDir}` : `this repo's devDependency fallback at ${pkgDir}`;
    throw new Error(
      `version mismatch: "${piPath}" reports ${binaryVersion}, but the resolved ${PACKAGE_NAME}@${pkgVersion} ` +
        `(${origin}) is what ships the .d.ts this probe reads. Install/unpack a matching version before trusting ` +
        `this probe's output, or point --pi at a binary matching ${pkgVersion}.`,
    );
  }
  const installed = extractInstalledSurface(pkgDir);
  const settingsKeys = readDependedSettingsKeys(repoRoot);
  // Partition, don't abort. A key config/settings.json carries that PI's `Settings` interface
  // does not declare is either package-owned (the documented PI convention — see
  // readDependedSettingsKeys) or a mistake, and this probe cannot tell those apart: PI ships no
  // machine-readable ownership map and an uninstalled package contributes no type at all.
  // Recording the partition in the lock keeps the fact visible in every diff while confining the
  // A-2 breaking-change verdict to the half PI actually owns — a key PI declared when the lock
  // was taken and no longer declares. Folding unowned keys into that verdict, as this probe used
  // to, makes every package-owned key a permanent false positive; dropping them silently would
  // let a genuine upstream removal be reclassified as "package-owned" and disappear.
  const settingsKeysNotDeclaredByPi = settingsKeys.filter((k) => !installed.settingsAvailable.includes(k));
  const surface = {
    probeVersion: 1,
    generatedAt: new Date().toISOString(),
    pi: {
      package: PACKAGE_NAME,
      packageVersion: pkgVersion,
      binaryPath: redactHome(resolve(piPath)),
      binaryVersion,
      sourceFiles: installed.sourceFiles,
    },
    events: installed.events,
    apiMethods: installed.apiMethods,
    settingsKeys,
    settingsKeysNotDeclaredByPi,
  };
  return { surface, settingsAvailable: installed.settingsAvailable };
}

/** Compares the current installed surface against a recorded lock. Returns a report object. */
function diffSurface(current, lock) {
  const removedEvents = (lock.events ?? []).filter((e) => !current.events.includes(e));
  const addedEvents = current.events.filter((e) => !(lock.events ?? []).includes(e));
  const removedMethods = (lock.apiMethods ?? []).filter((m) => !current.apiMethods.includes(m));
  const addedMethods = current.apiMethods.filter((m) => !(lock.apiMethods ?? []).includes(m));
  // Settings: check the lock's depended-on keys against what the CURRENT installed package
  // still offers (installed.settingsAvailable), not against a freshly re-read config/settings.json —
  // this is "diff the installed PI against the lock", not "diff the config against the lock".
  // Keys the lock itself recorded as not declared by PI are excluded: PI never offered them, so
  // PI cannot have removed them. Anything the lock did NOT record that way was PI-declared when
  // the lock was taken, so its absence now is exactly the A-2 signal.
  const lockNotDeclaredByPi = lock.settingsKeysNotDeclaredByPi ?? [];
  const removedSettingsKeys = (lock.settingsKeys ?? []).filter(
    (k) => !current.settingsAvailable.includes(k) && !lockNotDeclaredByPi.includes(k),
  );
  const breaking = removedEvents.length > 0 || removedMethods.length > 0 || removedSettingsKeys.length > 0;
  return {
    breaking,
    removedEvents,
    addedEvents,
    removedMethods,
    addedMethods,
    removedSettingsKeys,
    settingsKeysNotDeclaredByPi: current.settingsKeysNotDeclaredByPi ?? [],
  };
}

function formatReport(report, lock, currentBinaryVersion) {
  const lines = [];
  lines.push(`api-probe: lock recorded against ${lock.pi?.package}@${lock.pi?.packageVersion ?? "?"}; installed binary is ${currentBinaryVersion}`);
  if (report.breaking) {
    lines.push("BREAKING CHANGE DETECTED — abandon criterion A-2 detector fired:");
    for (const e of report.removedEvents) lines.push(`  removed event:        "${e}"`);
    for (const m of report.removedMethods) lines.push(`  removed ExtensionAPI member: "${m}"`);
    for (const k of report.removedSettingsKeys) lines.push(`  removed Settings key:  "${k}" (we depend on it)`);
  } else {
    lines.push("no breaking change — all locked events, ExtensionAPI members and depended-on Settings keys are still present.");
  }
  if (report.addedEvents.length > 0) lines.push(`  (informational) new event(s) since lock: ${report.addedEvents.join(", ")}`);
  if (report.addedMethods.length > 0) lines.push(`  (informational) new ExtensionAPI member(s) since lock: ${report.addedMethods.join(", ")}`);
  if (report.settingsKeysNotDeclaredByPi.length > 0) {
    lines.push(
      `  (informational) config/settings.json key(s) PI's own Settings type does not declare, so not covered by this check: ` +
        `${report.settingsKeysNotDeclaredByPi.join(", ")} — each must be owned by an installed package, or it is dead config`,
    );
  }
  return lines.join("\n");
}

async function main(argv) {
  const args = argv.slice(2);
  let piPath = null;
  let check = false;
  let lockArg = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pi") {
      piPath = args[++i];
      if (piPath === undefined) return usageError('"--pi" requires a path argument');
    } else if (a === "--dump") {
      // default mode; accepted explicitly for symmetry with --check
    } else if (a === "--check") {
      check = true;
    } else if (a === "--lock") {
      lockArg = args[++i];
      if (lockArg === undefined) return usageError('"--lock" requires a path argument');
    } else {
      return usageError(`unknown argument "${a}"`);
    }
  }

  if (!piPath) return usageError('missing required "--pi PATH" (the pi binary to probe)');

  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(scriptPath));

  if (!existsSync(piPath) || !statSync(piPath).isFile()) {
    return failLoud(`--pi path does not exist or is not a file: ${piPath}`);
  }

  let surface, settingsAvailable;
  try {
    ({ surface, settingsAvailable } = probeCurrent(repoRoot, piPath));
  } catch (err) {
    return failLoud(`could not build the API surface — ${err.message}`);
  }

  if (!check) {
    process.stdout.write(JSON.stringify(surface, null, 2) + "\n");
    process.exitCode = 0;
    return;
  }

  const lockPath = lockArg ? resolve(process.cwd(), lockArg) : join(repoRoot, "config", "api-surface.lock.json");
  if (!existsSync(lockPath)) {
    return failLoud(`lock file not found: ${lockPath} — run without --check first to create it`);
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    return failLoud(`lock file is not valid JSON: ${lockPath} — ${err.message}`);
  }

  const report = diffSurface(
    {
      events: surface.events,
      apiMethods: surface.apiMethods,
      settingsAvailable,
      settingsKeysNotDeclaredByPi: surface.settingsKeysNotDeclaredByPi,
    },
    lock,
  );
  process.stdout.write(formatReport(report, lock, surface.pi.binaryVersion) + "\n");
  process.exitCode = report.breaking ? 1 : 0;
}

main(process.argv).catch((err) => {
  process.stderr.write(`api-probe: internal error — ${String(err.stack ?? err)}\n`);
  process.exitCode = 2;
});

// bin/rules/pc-19-npm-registry-version-agreement.mjs — VP-10.
//
// "Can an npm id resolve to a DIFFERENT version under `npm view` than under `npm pack`?"
// (VP-10 — observed on @spences10/pi-team-mode: 0.0.57 vs 0.0.9, unexplained).
// This is the ONE rule in the whole pi-check tree allowed to spawn a process
// and touch the network — every other rule stays offline (REQ-PRV-12a). It reads licence
// and version truth only from `npm view`/`npm pack` against the tarball, never from a
// GitHub API repo-root lookup — the source of the two false rejects (@gotgenes,
// @thurstonsand) docs/DENYLIST.md §2's method note records; conflating "absent from the
// tarball" with "absent from the GitHub repo root" is exactly the mistake this rule must
// not repeat.
//
// Gated hard behind `requiresLive` + `ctx.live` (see bin/pi-check's CLI): it never runs
// under a bare `--all` or `--only packages`, which are specified to stay "< 2s offline".
// The full P1-P5 review procedure this rule mechanises one step of is
// run "on adoption and on a bump" (docs/PACKAGES.md's own header), not on every CI pass.

/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackagesLock, LOCK_PATH } from "../lib/packages.mjs";

export const id = "PC-19";
export const title = "npm view and npm pack agree on each pinned package's resolved version (VP-10)";
export const tags = ["packages", "live"];
export const closes = ["VP-10"];
/** Never runs under --all or --only packages without --live — see bin/pi-check's CLI gate. */
export const requiresLive = true;

/**
 * Pure comparison, no I/O — kept separate from `run()` so the finding-generation logic has
 * real unit-test coverage without a test ever touching the network.
 * @param {{ name: string, lockVersion: string, viewVersion: string, packVersion: string }} p
 * @returns {Finding[]}
 */
export function compareResolvedVersions({ name, lockVersion, viewVersion, packVersion }) {
  /** @type {Finding[]} */
  const findings = [];
  if (viewVersion !== packVersion) {
    findings.push({
      rule: id,
      file: LOCK_PATH,
      message: `"${name}": npm view resolves "${viewVersion}" but npm pack resolves "${packVersion}" for the same "${name}@${lockVersion}" request (VP-10)`,
    });
  }
  if (packVersion !== lockVersion) {
    findings.push({
      rule: id,
      file: LOCK_PATH,
      message: `"${name}": npm pack resolves "${packVersion}" but config/packages.lock.json pins "${lockVersion}" — re-run the P5 pin step in docs/PACKAGES.md`,
    });
  }
  return findings;
}

/** @param {string} name @param {string} version @returns {string} */
function npmView(name, version) {
  const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return out.trim().replace(/^"|"$/g, "");
}

/** @param {string} name @param {string} version @param {string} cwd @returns {string} */
function npmPack(name, version, cwd) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", `${name}@${version}`], {
    encoding: "utf8",
    cwd,
  });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.version) throw new Error(`npm pack --json produced no "version" field for "${name}@${version}"`);
  return String(first.version);
}

/**
 * @param {RuleContext & { live?: boolean }} ctx
 * @returns {Finding[]}
 */
export function run(ctx) {
  if (!ctx.live) return []; // the CLI gate is the primary defence; this is the fail-closed default

  const lock = readPackagesLock(ctx);
  if ("error" in lock) return [{ rule: id, file: LOCK_PATH, message: lock.error }];
  if (lock.entries.length === 0) return [];

  const scratch = mkdtempSync(join(tmpdir(), "pi-check-pc19-"));
  /** @type {Finding[]} */
  const findings = [];
  try {
    for (const entry of lock.entries) {
      if (typeof entry?.name !== "string" || typeof entry?.version !== "string") continue;
      let viewVersion, packVersion;
      try {
        viewVersion = npmView(entry.name, entry.version);
        packVersion = npmPack(entry.name, entry.version, scratch);
      } catch (err) {
        findings.push({
          rule: id,
          file: LOCK_PATH,
          message: `could not resolve "${entry.name}@${entry.version}" against the npm registry — ${String(err.message ?? err)}`,
        });
        continue;
      }
      findings.push(
        ...compareResolvedVersions({ name: entry.name, lockVersion: entry.version, viewVersion, packVersion }),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return findings;
}

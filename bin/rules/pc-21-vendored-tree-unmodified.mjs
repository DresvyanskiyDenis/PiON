// bin/rules/pc-21-vendored-tree-unmodified.mjs — closes the review finding "nothing detects an
// unrecorded edit to a vendored file".
//
// The gap it closes: `test/mcp/vendor.test.ts` checks the TARBALL sha256 recorded in
// `config/packages.lock.json` / `pi-packages/vendor.lock.json`. That proves what was downloaded on
// 2026-08-07. It says nothing about the bytes sitting in `pi-packages/` today, which are what PI
// actually loads (`config/settings.json` wires the package by local path). Between those two facts
// there was room for an agent, a bad merge or an undocumented hand-patch to change a vendored
// module with every gate staying green — including inside `config.ts`, `server-manager.ts` and
// `stdio-guard.ts`, the three files carrying the F1 MCP security patches.
//
// The rule is deliberately dumb: hash the tree, compare against a recorded manifest, report every
// difference. It has no opinion about whether a change is good — a legitimate re-vendor or a new
// local patch is recorded by re-running the regeneration command, which puts the new hashes in a
// reviewable diff next to the code change that caused them.

/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import {
  MANIFEST_PATH,
  REGENERATE_COMMAND,
  VENDOR_ROOT,
  diffVendorTree,
  hashVendoredTree,
  readVendorManifest,
  shortDigest,
} from "../lib/vendor-manifest.mjs";

export const id = "PC-21";
export const title = "The on-disk vendored tree matches its recorded per-file sha256 manifest (no unrecorded edit)";
// Tagged "packages" so it joins PC-09/PC-17/PC-18 in `--only packages`, the offline subset
// scripts/install.sh step 8 and postinstall-verify.sh run. Hashing ~60 small files costs
// single-digit milliseconds, well inside the "< 2s offline" budget that subset exists to protect.
export const tags = ["packages"];
export const closes = ["EXT-30 — the vendored tree drifts from its recorded digests without anyone noticing"];

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  // Not-applicable, not a pass-by-accident: a tree with no `pi-packages/` at all vendors nothing,
  // so there is nothing to record and nothing to protect (every pi-check fixture other than this
  // rule's own is in that state, as is a checkout before the vendoring step of install.sh). The
  // moment the directory exists, a missing manifest becomes a finding — see below. The two cases
  // are split precisely so "vendored tree present, record absent" can never read as clean.
  const vendorRootExists = ctx.exists(VENDOR_ROOT);

  const manifest = readVendorManifest(ctx);
  if ("error" in manifest) {
    return [{ rule: id, file: MANIFEST_PATH, message: manifest.error }];
  }
  if ("missing" in manifest) {
    if (!vendorRootExists) return [];
    return [
      {
        rule: id,
        file: MANIFEST_PATH,
        message: `"${VENDOR_ROOT}/" is present but no vendored-file manifest is recorded — the on-disk vendored tree is unverifiable, which is an unknown, not a clean pass; generate it with \`${REGENERATE_COMMAND}\` and commit the result`,
      },
    ];
  }

  const hashed = hashVendoredTree(ctx);
  if ("error" in hashed) {
    return [{ rule: id, file: hashed.file, message: hashed.error }];
  }

  /** @type {Finding[]} */
  const findings = [];
  for (const change of diffVendorTree(manifest.files, hashed.files)) {
    if (change.kind === "modified") {
      findings.push({
        rule: id,
        file: change.path,
        message: `vendored file changed since it was recorded — ${MANIFEST_PATH} has ${shortDigest(change.recorded)}…, on disk it hashes to ${shortDigest(change.actual)}…; if the edit is intended (a version bump, or a new local patch documented in ${VENDOR_ROOT}/vendor.lock.json's localPatches) re-record it with \`${REGENERATE_COMMAND}\``,
      });
    } else if (change.kind === "added") {
      findings.push({
        rule: id,
        file: change.path,
        message: `vendored file is on disk but not recorded in ${MANIFEST_PATH} (hashes to ${shortDigest(change.actual)}…) — a file added to a vendored package after review; document it, then re-record with \`${REGENERATE_COMMAND}\``,
      });
    } else {
      findings.push({
        rule: id,
        file: change.path,
        message: `vendored file is recorded in ${MANIFEST_PATH} (${shortDigest(change.recorded)}…) but is missing from disk — a vendored module was deleted; note that ${VENDOR_ROOT}/pi-mcp-adapter/stdio-guard.ts is a local security patch whose loss disarms the F1 layer-2 stdio guard, so this is never routine, then re-record with \`${REGENERATE_COMMAND}\``,
      });
    }
  }
  // Uncapped on purpose: a whole-package re-vendor legitimately produces one finding per changed
  // file. Truncating the list would hide exactly the file a reader is looking for, and the fix for
  // the noise is one command, not a quieter rule.
  return findings;
}

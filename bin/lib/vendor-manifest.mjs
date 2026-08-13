// bin/lib/vendor-manifest.mjs — the hasher, serializer and comparator behind PC-21.
//
// Why this exists: `test/mcp/vendor.test.ts` verifies the *tarball* sha256 of each vendored
// package against `config/packages.lock.json`. Nothing verified the tree that is actually on disk
// and actually imported, so an edit made to `pi-packages/**/*.ts` after install — by an agent, a
// bad merge, or a hand-patch nobody wrote down — passed every gate. The `localPatches` entries in
// the lock file are the legitimate version of that edit; this file is what makes the illegitimate
// version visible.
//
// Zero dependencies beyond node:crypto/node:fs/node:path, matching pi-check's own constraint.
// Pure reads: no process spawn, no network, so PC-21 stays inside the offline
// "--all"/"--only packages" default path. The ONE write in this module is
// `serializeVendorManifest`'s output, and it is written by bin/pi-check's
// `--write-vendor-manifest` mode — never by a rule.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {import("../types.mjs").RuleContext} RuleContext */

/** The vendored tree, relative to the repo root. */
export const VENDOR_ROOT = "pi-packages";

/**
 * Where the recorded hashes live.
 *
 * DECISION — a new file, next to `pi-packages/vendor.lock.json`, not inside it and not inside
 * `config/packages.lock.json`:
 *   - `config/packages.lock.json` is the *review* ledger (what was reviewed, at which version,
 *     with which tarball hash). It is written by hand during a package review. This manifest is
 *     machine-generated per re-vendor and is ~60 lines of churn; mixing a generated artefact into
 *     a hand-maintained reviewed ledger makes the review diff unreadable and invites regenerating
 *     over a human edit.
 *   - `pi-packages/vendor.lock.json` records provenance *and* the prose of every local patch. Same
 *     argument: it is hand-authored, and a bulk hash rewrite landing in the same file as the patch
 *     narrative would bury the narrative.
 *   - Living under `pi-packages/` keeps the record next to what it describes: delete the vendored
 *     tree and its manifest goes with it, so the two cannot drift apart across a move.
 */
export const MANIFEST_PATH = `${VENDOR_ROOT}/vendor-files.lock.json`;

export const ALGORITHM = "sha256";

/**
 * The recorded scope, and it is recorded IN the manifest so the rule can refuse to compare a
 * manifest generated under a different scope rather than silently reporting every newly-in-scope
 * file as "added".
 *
 * EXT-30's original wording was `pi-packages/**\/*.ts`, and `.ts` alone was the first
 * implementation. That scope does not survive its own threat model: the vendored tree also ships
 * `cli.js`, `app-bridge.bundle.js`, `mcp-keyring-helper.cjs`, `mcp-script-worker.mjs` and
 * `package.json`, all of which execute or decide what executes. A rule that hashes the TypeScript
 * and leaves the JavaScript unhashed tells an attacker exactly which file to edit. Widened
 * 2026-08-11.
 *
 * `.md` is in for a different reason: `skills/mcp-scripting/SKILL.md` is model-facing instruction
 * text shipped inside a vendored package, i.e. prompt content that arrives with the dependency.
 *
 * Still NOT covered, stated so nobody reads a green PC-21 as more than it is: extension-less files
 * (`LICENSE`), and any binary asset a future vendored package might ship. Widening again is one
 * entry here plus one regeneration.
 */
export const INCLUDE = ["**/*.ts", "**/*.js", "**/*.cjs", "**/*.mjs", "**/*.json", "**/*.md"];

/**
 * Extensions derived from `INCLUDE` for `ctx.listFiles`. Kept derived rather than written twice —
 * the two drifting apart is exactly how a file silently leaves the scope while the manifest still
 * claims to cover it.
 */
export const INCLUDE_EXTS = INCLUDE.map((glob) => glob.replace("**/*", ""));

/** The single documented way to re-record the tree. Quoted verbatim into every finding. */
export const REGENERATE_COMMAND = "node bin/pi-check --write-vendor-manifest";

/**
 * Hashes every in-scope vendored file, in sorted-by-path order.
 *
 * Hashing is over the RAW BYTES (`readFileSync` with no encoding), not `ctx.readText`'s utf8
 * decode: a decode/re-encode round trip normalises invalid byte sequences and would hash two
 * different files to the same digest. This is also why it does not go through the RuleContext —
 * the context is text-oriented by design.
 *
 * A read or hash failure is returned as an error, never skipped. A file that `listFiles` just
 * enumerated but that cannot be read is exactly the state this rule exists to notice.
 *
 * @param {RuleContext} ctx
 * @returns {{ files: Map<string, string> } | { error: string, file: string }}
 */
export function hashVendoredTree(ctx) {
  // listFiles always excludes node_modules/.git/dist. That is correct here: the vendored copy
  // resolves its dependencies from the repo-root node_modules, so a node_modules directory under
  // pi-packages/ is not vendored source and is not committed.
  // The manifest itself is excluded: it lives inside VENDOR_ROOT and ends in `.json`, so with the
  // 2026-08-11 scope widening it would otherwise hash itself — a file whose content depends on its
  // own digest has no fixed point, and every regeneration would report a change.
  const relPaths = ctx.listFiles({ dir: VENDOR_ROOT, exts: INCLUDE_EXTS }).filter((p) => p !== MANIFEST_PATH);
  const sorted = [...relPaths].sort(); // code-unit order — locale-independent, unlike localeCompare
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const rel of sorted) {
    try {
      const bytes = readFileSync(join(ctx.repoRoot, rel));
      files.set(rel, createHash(ALGORITHM).update(bytes).digest("hex"));
    } catch (err) {
      return {
        file: rel,
        error: `cannot read or hash vendored file "${rel}" — ${String(err.message ?? err)}; PC-21 reports this as a finding rather than skipping the file, since an unreadable vendored file is an unknown, not a clean pass`,
      };
    }
  }
  return { files };
}

/**
 * The manifest text for a set of hashes. Deterministic and idempotent BY DESIGN: no timestamp, no
 * host, no generator version. Regenerating an unchanged tree must produce a byte-identical file,
 * so `git diff` after a regeneration answers "did the vendored tree change?" with no noise. That
 * is the property that makes the regeneration command safe to run at any time.
 *
 * @param {Map<string, string>} files path -> sha256, any order (sorted here)
 * @returns {string}
 */
export function serializeVendorManifest(files) {
  /** @type {Record<string, string>} */
  const ordered = {};
  for (const path of [...files.keys()].sort()) ordered[path] = files.get(path);
  return (
    JSON.stringify(
      {
        algorithm: ALGORITHM,
        root: VENDOR_ROOT,
        include: INCLUDE,
        regenerate: REGENERATE_COMMAND,
        fileCount: files.size,
        files: ordered,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Reads and shape-checks the recorded manifest.
 *
 * `missing` is returned distinctly from `error` because the two produce different findings: a
 * missing manifest means "this tree was never recorded" (regenerate), a malformed one means
 * "somebody edited the record by hand" (read it before regenerating over it).
 *
 * @param {RuleContext} ctx
 * @returns {{ files: Map<string, string> } | { missing: true } | { error: string }}
 */
export function readVendorManifest(ctx) {
  if (!ctx.exists(MANIFEST_PATH)) return { missing: true };
  let parsed;
  try {
    parsed = ctx.readJSON(MANIFEST_PATH);
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { error: `${MANIFEST_PATH} is not a JSON object — regenerate it with \`${REGENERATE_COMMAND}\`` };
  }
  // Scope agreement first. Comparing a tree against a manifest recorded under a different
  // algorithm, root or include set produces confident nonsense (every file "modified", or every
  // file "added"), which is worse than reporting that the two are not comparable.
  if (parsed.algorithm !== ALGORITHM) {
    return { error: `${MANIFEST_PATH} records algorithm "${String(parsed.algorithm)}" but PC-21 hashes with "${ALGORITHM}" — not comparable; regenerate with \`${REGENERATE_COMMAND}\`` };
  }
  if (parsed.root !== VENDOR_ROOT) {
    return { error: `${MANIFEST_PATH} records root "${String(parsed.root)}" but PC-21 scans "${VENDOR_ROOT}" — not comparable; regenerate with \`${REGENERATE_COMMAND}\`` };
  }
  if (!Array.isArray(parsed.include) || parsed.include.join(",") !== INCLUDE.join(",")) {
    return { error: `${MANIFEST_PATH} records include ${JSON.stringify(parsed.include)} but PC-21 scans ${JSON.stringify(INCLUDE)} — not comparable; regenerate with \`${REGENERATE_COMMAND}\`` };
  }
  const raw = parsed.files;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${MANIFEST_PATH} has no "files" object — regenerate it with \`${REGENERATE_COMMAND}\`` };
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const [path, digest] of Object.entries(raw)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      return { error: `${MANIFEST_PATH} entry "${path}" is not a 64-character lowercase ${ALGORITHM} digest — the record was hand-edited; read it before regenerating over it` };
    }
    files.set(path, digest);
  }
  // fileCount is redundant with files, and that is the point: a hand-edit that deletes a row to
  // silence a finding has to remember to fix the count too.
  if (typeof parsed.fileCount === "number" && parsed.fileCount !== files.size) {
    return { error: `${MANIFEST_PATH} declares fileCount ${parsed.fileCount} but carries ${files.size} entries — the record was hand-edited; read it before regenerating over it` };
  }
  return { files };
}

/**
 * @typedef {Object} VendorTreeChange
 * @property {"modified" | "added" | "removed"} kind
 * @property {string} path repo-root-relative POSIX path
 * @property {string} [recorded] the recorded digest ("modified"/"removed")
 * @property {string} [actual] the on-disk digest ("modified"/"added")
 */

/**
 * All three change classes are reported, not just "modified": a file ADDED to a vendored package
 * is how you smuggle code into a reviewed tree, and a file REMOVED is how you silently drop a
 * patched module (`stdio-guard.ts` is a vendored *addition* of ours — losing it disarms the F1
 * layer-2 control without breaking a single import).
 *
 * @param {Map<string, string>} recorded
 * @param {Map<string, string>} actual
 * @returns {VendorTreeChange[]}
 */
export function diffVendorTree(recorded, actual) {
  /** @type {VendorTreeChange[]} */
  const changes = [];
  for (const path of [...new Set([...recorded.keys(), ...actual.keys()])].sort()) {
    const before = recorded.get(path);
    const after = actual.get(path);
    if (before === undefined) changes.push({ kind: "added", path, actual: after });
    else if (after === undefined) changes.push({ kind: "removed", path, recorded: before });
    else if (before !== after) changes.push({ kind: "modified", path, recorded: before, actual: after });
  }
  return changes;
}

/** Digests are quoted short in messages — enough to correlate two runs, never the whole digest. */
export function shortDigest(digest) {
  return typeof digest === "string" ? digest.slice(0, 12) : "(none)";
}

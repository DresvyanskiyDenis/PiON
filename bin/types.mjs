// bin/types.mjs — shared JSDoc typedefs for pi-check and its rule modules.
//
// This file exports nothing at runtime. It exists so every rule module can write
//   /** @typedef {import("../types.mjs").Finding} Finding */
// and get editor/type-checking support without a build step or a dependency on `lib/`
// (REQ-PRV-12a: pi-check has zero dependencies, including on this repo's own `lib/`).

/**
 * @typedef {Object} Finding
 * @property {string} rule    - the rule id that produced this finding, e.g. "PC-06"
 * @property {string} file    - path to the offending file, relative to the scanned repo root
 * @property {number} [line]  - 1-indexed line number, when the finding is line-addressable
 * @property {string} message - human-readable description, greppable, no secrets ever included
 * @property {"error" | "warn"} [severity]
 *   Absent means `"error"` — the original and overwhelmingly common case, so it stays the
 *   default rather than becoming a field every rule has to remember. `"warn"` is reported and
 *   counted separately and does NOT set a non-zero exit code: it is for a configuration that is
 *   legal, loads, and is nonetheless known to buy nothing (PC-31's identical `empty-response`
 *   retry is the first). A rule that can prove the tree is wrong emits an error; a rule that can
 *   only say "this will not do what you think" emits a warning, and blocking CI on the second
 *   kind is how a gate gets turned off, taking every real finding with it.
 */

/**
 * @typedef {Object} RuleContext
 * @property {string} repoRoot
 *   Absolute path to the root of the tree being validated (the `--repo` value, or the
 *   directory containing `bin/` by default).
 * @property {boolean} live
 *   True only when `--live` was passed on the CLI. Every rule except PC-19 ignores this —
 *   it exists so PC-19 (the sole rule allowed to spawn `npm` and touch the network) can
 *   fail closed by default instead of trusting its own CLI-level gate alone.
 * @property {(relPath: string) => boolean} exists
 * @property {(relPath: string) => string | null} readText
 *   Returns the file's raw text, or null if the file does not exist. Never throws on a
 *   missing file.
 * @property {(relPath: string) => unknown} readJSON
 *   Parses a JSON file. Throws a descriptive Error (naming the file) on a missing file or
 *   invalid JSON — callers that must tolerate a missing file should call `exists` first.
 * @property {(relPath: string) => Array<{ line: number, text: string }>} lines
 *   1-indexed line records for a file. Empty array if the file does not exist.
 * @property {(opts: { dir: string, exts?: string[], excludeDirs?: string[] }) => string[]} listFiles
 *   Recursively lists files under `dir` (a path relative to repoRoot), relative to
 *   repoRoot, filtered by extension when `exts` is given. Always excludes
 *   `node_modules`, `.git`, and `dist` regardless of `excludeDirs`. Returns `[]` when
 *   `dir` does not exist — a missing directory is not an error, since W1 content
 *   (e.g. `agents/`) may not have landed yet.
 * @property {(text: string, matchIndex: number) => boolean} isProviderQualified
 *   True if the token found at `matchIndex` in `text` is already part of a
 *   `provider/id`-shaped string (i.e. a `/` appears between the token and the nearest
 *   preceding delimiter).
 */

export {};

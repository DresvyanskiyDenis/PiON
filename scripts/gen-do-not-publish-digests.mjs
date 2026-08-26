#!/usr/bin/env node
// scripts/gen-do-not-publish-digests.mjs — regenerate config/do-not-publish.digests.txt.
//
// Reads one name per line on stdin and writes the salted digest file PC-25 checks against. The
// names are never stored: that is the whole point of the digest file, and it is why this script
// takes them on stdin rather than from anything on disk. Keep the source list wherever the private
// harness keeps it; it does not belong in this repository in any form.
//
//     printf '%s\n' name-one name-two | node scripts/gen-do-not-publish-digests.mjs > config/do-not-publish.digests.txt
//
// Output is sorted by digest, so the file does not leak the order the names were supplied in.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SALT = "pion-do-not-publish-v1"; // must match bin/rules/pc-25-no-do-not-publish-names.mjs

const names = readFileSync(0, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

if (names.length === 0) {
  process.stderr.write("no names on stdin — refusing to write an empty gate\n");
  process.exit(1);
}

const rows = names.map((name) => {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    process.stderr.write(`a name tokenises to nothing and cannot be checked for\n`);
    process.exit(1);
  }
  const digest = createHash("sha256").update(`${SALT}\n${tokens.join("-")}`).digest("hex");
  return `${tokens.length} ${digest}`;
});

process.stdout.write(
  [
    "# Salted SHA-256 digests of the names that must never appear in this repository.",
    "#",
    "# One per line, `<token-count> <sha256-hex>`. Checked by bin/rules/pc-25-no-do-not-publish-names.mjs,",
    "# which documents the scheme and why the names themselves cannot be stored here.",
    "# Regenerate with scripts/gen-do-not-publish-digests.mjs; never hand-edit.",
    "",
    ...[...new Set(rows)].sort(),
    "",
  ].join("\n"),
);

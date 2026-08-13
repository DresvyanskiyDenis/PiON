// bin/lib/patterns.mjs — regexes shared by more than one rule, kept in one place so the
// two call sites (PC-01 shape checks, PC-08 bare-id ban) cannot silently drift apart.

/** Matches an Anthropic-shaped model id fragment, bare (not already provider-qualified). */
export const BARE_ANTHROPIC = /(?<![\w/-])(claude-[a-z0-9.\-]+|opus-\d[\w.\-]*|sonnet-[\d.]+[\w.\-]*|haiku-[\d.]+[\w.\-]*)(?![\w/-])/gi;

/** A `provider/id` token: a non-empty provider segment, a slash, a non-empty id segment. */
export const PROVIDER_QUALIFIED = /^[a-z][a-z0-9_-]*\/\S+$/i;

/**
 * Literal secret-shaped strings: real API-key prefixes with a long random-looking tail, or
 * a bare 40+ char base64url run. Deliberately requires enough tail length that a
 * documentation example like `sk-...` (three literal dots) never matches — see
 * config/shell/pi-env.sh's comment block, which must stay green.
 */
export const SECRET_LITERAL = new RegExp(
  [
    "sk-[A-Za-z0-9_-]{20,}",
    "gh[po]_[A-Za-z0-9]{30,}",
    "dapi[A-Za-z0-9]{20,}",
    "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])",
  ].join("|"),
  "g",
);

/** The credential-reference shape: `$VAR`, `${VAR}`, or `!command`. Never resolved, only shape-checked. */
export const CRED_SHAPE = /^(\$\{?[A-Z_][A-Z0-9_]*\}?|![^\n]+)$/;

/** `<ALL_CAPS_WITH_UNDERSCORES>` placeholder that must not survive installation. */
export const PLACEHOLDER = /<[A-Z][A-Z0-9_]*>/g;

/** The `REPLACE_AFTER_*` placeholder family used by pi-release.lock (review defect 1). */
export const REPLACE_AFTER = /\bREPLACE_AFTER_[A-Z0-9_]*\b/g;

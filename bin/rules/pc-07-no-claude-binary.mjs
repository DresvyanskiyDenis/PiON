/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */

export const id = "PC-07";
export const title = "No committed file outside docs/ and research/ invokes the claude binary";
export const closes = ["REQ-CTX-80"];

// argv[0] "claude", or "claude --...", "claude -p ...". Deliberately does not match the
// English word inside prose or the npm scope "@anthropic-ai" etc. — this is about invoking
// a binary, not about mentioning the product.
const CLAUDE_INVOKE = /(^|[\s;&|`(])claude(\s+(--\S+|-p\b)|\s*$)/;

// Prose directories are excluded because they are documentation, never executed, and they quote
// command lines while *describing* things. `skills-private/` and `agents-private/` are git-ignored
// and PC-12 independently asserts they are untracked, so they are by definition not "committed" —
// the word this rule's own title turns on. Their contents are NOT exempt from REQ-CTX-80 in spirit:
// a private skill that shells out to a `claude` binary that does not exist on this machine is a
// live runtime defect. It is out of *this* rule's scope, not forgiven — see docs/limitations.md.
const ALWAYS_EXCLUDED_TOP = new Set([
  "node_modules", ".git", "dist", "test", "docs", "research",
  "skills-private", "agents-private",
]);

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const files = ctx.listFiles({ dir: ".", excludeDirs: [...ALWAYS_EXCLUDED_TOP] });
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    // listFiles with excludeDirs only prunes nested directories reached during the walk, not
    // the top-level dir names themselves when dir === "." — filter those explicitly.
    const top = file.split("/")[0];
    if (ALWAYS_EXCLUDED_TOP.has(top)) continue;

    const text = ctx.readText(file);
    if (text === null) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (CLAUDE_INVOKE.test(lines[i])) {
        findings.push({ rule: id, file, line: i + 1, message: 'invokes the "claude" binary — REQ-CTX-80 forbids it outside docs/ and research/' });
      }
    }
  }
  return findings;
}

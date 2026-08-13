// bin/lib/frontmatter.mjs — a deliberately minimal YAML-frontmatter reader for agents/*.md.
//
// This is NOT a YAML parser. It reads exactly the shape our agent files use: a `---`-delimited
// block of flat `key: value` pairs (value may be empty, meaning "a block scalar/array follows
// on subsequent indented lines" — we only need to know the key was present for that case).
// Adding a real YAML dependency here would violate pi-check's zero-dependency rule (§5.1); a
// hand-rolled subset is the deliberate trade.

/**
 * @param {string} text the full file contents
 * @returns {{ ok: true, startLine: number, endLine: number, entries: Map<string, { value: string, line: number }> } | { ok: false }}
 */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { ok: false };

  let endLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) return { ok: false };

  /** @type {Map<string, { value: string, line: number }>} */
  const entries = new Map();
  const KEY_RE = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/;
  for (let i = 1; i < endLine; i++) {
    const raw = lines[i];
    if (/^\s/.test(raw)) continue; // indented continuation line (block scalar/array) — skip
    const m = KEY_RE.exec(raw);
    if (!m) continue;
    let value = m[2].trim();
    // strip a matching pair of quotes, if present
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    entries.set(m[1], { value, line: i + 1 }); // +1: 1-indexed file lines
  }
  return { ok: true, startLine: 1, endLine: endLine + 1, entries };
}

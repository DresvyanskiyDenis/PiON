import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileGlob, expandBraces, matchesAny, UnsupportedGlobError } from "../../extensions/path-rules/glob.ts";

function grab(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

// Four `paths:` lists taken verbatim from rule files running in production against this matcher.
// No rule file ships here — the rules directory lives outside the repo (see
// `extensions/path-rules/config.ts`'s header) — so these lists are the only record of which
// pattern shapes real rules use, and the point of the block below is that every one compiles.
const REAL_PATTERN_SETS: Record<string, string[]> = {
  "context7-library-docs": [
    "**/*.{py,ts,tsx,js,jsx,mjs,cjs,vue,svelte,astro,go,rs,rb,java,kt,swift,sh,sql}",
    "**/{pyproject.toml,requirements*.txt,package.json,uv.lock,Pipfile}",
    "**/*.config.{ts,js,mjs,cjs,json}",
    "**/{docker-compose,compose}*.{yml,yaml}",
    "**/Dockerfile*",
  ],
  "python-uv-toolchain": ["**/*.py", "**/pyproject.toml"],
  "sqlite-in-docker": [
    "**/{docker-compose,compose}*.{yml,yaml}",
    "**/Dockerfile*",
    "**/.env*",
    "**/alembic.ini",
    "**/*.py",
  ],
  "tailwind-v4-vite": [
    "**/vite.config.{ts,js,mjs,cjs}",
    "**/tailwind.config.*",
    "**/postcss.config.*",
    "**/package.json",
    "**/*.css",
  ],
};

describe("expandBraces — four pattern sets taken from real rule files", () => {
  for (const [name, patterns] of Object.entries(REAL_PATTERN_SETS)) {
    it(`compiles every pattern in "${name}" without throwing`, () => {
      for (const p of patterns) {
        const matcher = compileGlob(p);
        assert.ok(matcher.expanded.length >= 1, p);
      }
    });
  }

  it("brace-expands a two-group pattern into the flat product Claude Code's own engine derives", () => {
    const expanded = expandBraces("**/{docker-compose,compose}*.{yml,yaml}");
    assert.deepEqual(expanded, [
      "**/docker-compose*.yml",
      "**/docker-compose*.yaml",
      "**/compose*.yml",
      "**/compose*.yaml",
    ]);
  });

  it("a single-comma group expands to exactly two flat patterns", () => {
    assert.deepEqual(expandBraces("**/*.{py,ts}"), ["**/*.py", "**/*.ts"]);
  });

  it("a pattern with no braces expands to itself, unchanged", () => {
    assert.deepEqual(expandBraces("**/*.py"), ["**/*.py"]);
  });
});

describe("compileGlob — matching semantics", () => {
  it("globstar matches zero directories (pattern at the project root)", () => {
    const m = compileGlob("**/pyproject.toml");
    assert.equal(m.test("pyproject.toml"), true);
    assert.equal(m.test("sub/dir/pyproject.toml"), true);
    assert.equal(m.test("pyproject.toml.bak"), false);
  });

  it("a bare globstar matches everything", () => {
    const m = compileGlob("**");
    assert.equal(m.test("a"), true);
    assert.equal(m.test("a/b/c.py"), true);
  });

  it("* does not cross a path segment boundary", () => {
    const m = compileGlob("*.py");
    assert.equal(m.test("main.py"), true);
    assert.equal(m.test("src/main.py"), false);
  });

  it("? matches exactly one character", () => {
    const m = compileGlob("a?.txt");
    assert.equal(m.test("ab.txt"), true);
    assert.equal(m.test("abc.txt"), false);
    assert.equal(m.test("a.txt"), false);
  });

  it("brace-expanded extensions all match", () => {
    const m = compileGlob("**/*.{yml,yaml}");
    assert.equal(m.test("docker-compose.yml"), true);
    assert.equal(m.test("docker-compose.yaml"), true);
    assert.equal(m.test("docker-compose.json"), false);
  });

  it("matchesAny is true if any matcher in the list hits", () => {
    const matchers = [compileGlob("**/*.py"), compileGlob("**/pyproject.toml")];
    assert.equal(matchesAny(matchers, "pyproject.toml"), true);
    assert.equal(matchesAny(matchers, "main.py"), true);
    assert.equal(matchesAny(matchers, "README.md"), false);
  });
});

describe("compileGlob — unsupported syntax throws at compile time, naming the pattern", () => {
  it("throws on a character class", () => {
    const err = grab(() => compileGlob("**/[abc].py"));
    assert.ok(err instanceof UnsupportedGlobError);
    assert.match(err.message, /\*\*\/\[abc\]\.py/);
  });

  it("throws on extglob negation", () => {
    const err = grab(() => compileGlob("**/!(test).py"));
    assert.ok(err instanceof UnsupportedGlobError);
    assert.match(err.message, /!\(test\)\.py/);
  });

  it("throws on a nested brace group", () => {
    const err = grab(() => compileGlob("**/{a,{b,c}}.ts"));
    assert.match(err.message, /nested/);
  });

  it("throws on an unmatched opening brace", () => {
    const err = grab(() => compileGlob("**/{a,b.ts"));
    assert.match(err.message, /unmatched/);
  });

  it("throws on a brace group with no comma", () => {
    const err = grab(() => compileGlob("**/{foo}.ts"));
    assert.match(err.message, /comma/);
  });
});

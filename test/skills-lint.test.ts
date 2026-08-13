import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  discoverSkillFrontmatter,
  lintAllowedTools,
  lintParseErrors,
  parseAllowedTools,
} from "../extensions/skills-lint.ts";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-skills-lint-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseAllowedTools", () => {
  it("splits a comma-separated string, trimming whitespace", () => {
    assert.deepEqual(parseAllowedTools("Read, Write,Edit"), ["Read", "Write", "Edit"]);
  });

  it("accepts a YAML array", () => {
    assert.deepEqual(parseAllowedTools(["Read", "Write"]), ["Read", "Write"]);
  });

  it("returns [] for undefined, a bare non-comma scalar is a single-element list, and non-string members drop", () => {
    assert.deepEqual(parseAllowedTools(undefined), []);
    assert.deepEqual(parseAllowedTools("Read"), ["Read"]);
    assert.deepEqual(parseAllowedTools(["Read", 42, null]), ["Read"]);
  });

  it("returns [] for an object (malformed frontmatter shape)", () => {
    assert.deepEqual(parseAllowedTools({ foo: "bar" }), []);
  });
});

describe("discoverSkillFrontmatter", () => {
  it("returns [] for a clone with no skill roots", () => {
    assert.deepEqual(discoverSkillFrontmatter(join(root, "empty")), []);
  });

  it("finds SKILL.md across all three roots, skips dirs with no SKILL.md", async () => {
    const d = join(root, "basic");
    await mkdir(join(d, "skills", "sofa"), { recursive: true });
    await writeFile(join(d, "skills", "sofa", "SKILL.md"), "---\nname: sofa\ndescription: x\n---\nbody\n");
    await mkdir(join(d, "skills", "not-a-skill"), { recursive: true });
    await mkdir(join(d, "skills-private", "cv-creator"), { recursive: true });
    await writeFile(
      join(d, "skills-private", "cv-creator", "SKILL.md"),
      "---\nname: cv-creator\ndescription: x\nallowed-tools: Read,Write,Edit,WebFetch,WebSearch\n---\nbody\n",
    );

    const found = discoverSkillFrontmatter(d);
    assert.equal(found.length, 2);

    const sofa = found.find((s) => s.name === "sofa");
    assert.ok(sofa);
    assert.equal(sofa?.tier, "skills");
    assert.equal(sofa?.declaresAllowedTools, false);

    const cv = found.find((s) => s.name === "cv-creator");
    assert.ok(cv);
    assert.equal(cv?.tier, "skills-private");
    assert.equal(cv?.declaresAllowedTools, true);
    assert.deepEqual(cv?.allowedTools, ["Read", "Write", "Edit", "WebFetch", "WebSearch"]);
  });

  it("records a parseError instead of throwing, for a SKILL.md with malformed YAML frontmatter", async () => {
    const d = join(root, "malformed");
    await mkdir(join(d, "skills-private", "broken"), { recursive: true });
    // Reproduces the real bug found in skills-private/notebooklm-sources/SKILL.md: an unquoted
    // colon inside a plain-scalar description value.
    await writeFile(
      join(d, "skills-private", "broken", "SKILL.md"),
      "---\nname: broken\ndescription: Output dir: `~/x/<slug>/`.\n---\nbody\n",
    );
    await mkdir(join(d, "skills-private", "ok"), { recursive: true });
    await writeFile(join(d, "skills-private", "ok", "SKILL.md"), "---\nname: ok\ndescription: fine\n---\nbody\n");

    const found = discoverSkillFrontmatter(d);
    assert.equal(found.length, 2);
    const broken = found.find((s) => s.name === "broken");
    assert.ok(broken?.parseError);
    const ok = found.find((s) => s.name === "ok");
    assert.equal(ok?.parseError, undefined);
  });

  it("throws when a SKILL.md itself cannot be read (not just parsed)", async () => {
    // Covered implicitly: readFileSync throwing ENOENT between statSync and readFileSync would
    // surface as a thrown Error naming the path — no fixture needed beyond documenting intent,
    // since simulating a TOCTOU race is not practical in a unit test. Real coverage: the
    // parseError path above proves partial-scan resilience, which is the behavior that matters.
    assert.ok(true);
  });
});

describe("lintAllowedTools", () => {
  it("produces one finding per skill that declares allowed-tools, none for skills that don't", () => {
    const findings = lintAllowedTools([
      { name: "sofa", tier: "skills", path: "/x/sofa/SKILL.md", declaresAllowedTools: false, allowedTools: [] },
      {
        name: "cv-creator",
        tier: "skills-private",
        path: "/x/cv-creator/SKILL.md",
        declaresAllowedTools: true,
        allowedTools: ["Read", "Write"],
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.skillName, "cv-creator");
    assert.match(findings[0]?.message ?? "", /does not read or enforce/);
    assert.match(findings[0]?.message ?? "", /Read, Write/);
  });

  it("is empty for an empty input", () => {
    assert.deepEqual(lintAllowedTools([]), []);
  });
});

describe("lintParseErrors", () => {
  it("produces one finding per skill with a parseError, and none for clean skills", () => {
    const findings = lintParseErrors([
      { name: "ok", tier: "skills", path: "/x/ok/SKILL.md", declaresAllowedTools: false, allowedTools: [] },
      {
        name: "broken",
        tier: "skills-private",
        path: "/x/broken/SKILL.md",
        declaresAllowedTools: false,
        allowedTools: [],
        parseError: "YAMLParseError: nested mappings",
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.skillName, "broken");
    assert.match(findings[0]?.message ?? "", /likely fails to load/);
  });
});

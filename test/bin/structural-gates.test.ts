/**
 * `bin/lib/structural-gates.mjs` — the four detectors behind `bin/pi-gate`.
 *
 * Every detector gets both halves, and the second half is the one that matters. A structural gate
 * is a judgement about process; it fires on patterns that a normal repository also produces
 * accidentally, and the first false positive it emits on ordinary work is the last time anyone
 * reads its output. So for each gate there is a synthetic violation it must catch AND a shape of
 * ordinary, healthy work it must stay silent on:
 *
 *   SG-01  a run of fix: commits on one file      vs  a feat: in the middle of that run
 *   SG-02  chunk_gemma_job beside chunk_sonnet_job vs  a numbered series and a prefix family
 *   SG-03  five new top-level modules              vs  four files deep inside one module
 *   SG-04  a job with no limit parameter           vs  a job that takes one
 *
 * The detectors are pure functions over plain data, so none of this needs a repository, a commit,
 * or a `git` binary — `bin/pi-gate` is the only place that gathers facts from a real tree, and
 * `test/pi-gate.suite.mjs` is where that half is exercised end to end.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_CONFIG,
  applyBlockMode,
  detectBoundedRun,
  detectFileCountBudget,
  detectFixStreak,
  detectParallelModules,
  globToRegExp,
  resolveGateConfig,
  tokenizeName,
} from "../../bin/lib/structural-gates.mjs";

const CFG = resolveGateConfig(null);

/** Newest-first commit records, the shape `bin/pi-gate`'s `collectCommits` produces. */
function commit(sha: string, subject: string, files: string[], body = "") {
  return { sha, subject, body, files };
}

describe("resolveGateConfig", () => {
  it("defaults every gate to warn, and never to blocking", () => {
    for (const gate of Object.values(CFG)) assert.equal(gate.severity, "warn");
  });

  it("takes a per-gate severity and threshold override", () => {
    const cfg = resolveGateConfig({ gates: { "SG-01": { severity: "error", streak: 5 } } });
    assert.equal(cfg["SG-01"].severity, "error");
    assert.equal(cfg["SG-01"].streak, 5);
    // untouched gates keep the shipped default
    assert.equal(cfg["SG-02"].severity, "warn");
  });

  it("turns a gate off entirely", () => {
    const cfg = resolveGateConfig({ gates: { "SG-04": { severity: "off" } } });
    assert.deepEqual(detectBoundedRun({ jobFiles: [{ path: "a_job.py", text: "" }] }, cfg), []);
  });

  it("throws on a typo rather than reporting zero findings for a gate that never ran", () => {
    assert.throws(() => resolveGateConfig({ gates: { "SG-99": {} } }), /unknown gate/);
    assert.throws(() => resolveGateConfig({ gates: { "SG-01": { strak: 3 } } }), /unknown key/);
    assert.throws(() => resolveGateConfig({ gates: { "SG-01": { severity: "loud" } } }), /severity/);
    assert.throws(() => resolveGateConfig({ gates: { "SG-01": { streak: "two" } } }), /must be a number/);
  });
});

describe("globToRegExp", () => {
  it("lets ** cross a slash and match the empty prefix, and holds * to one segment", () => {
    assert.ok(globToRegExp("**/*_job.py").test("src/deep/chunk_job.py"));
    assert.ok(globToRegExp("**/*_job.py").test("chunk_job.py"));
    assert.ok(!globToRegExp("jobs/*.py").test("jobs/nested/a.py"));
    assert.ok(globToRegExp("jobs/*.py").test("jobs/a.py"));
    assert.ok(globToRegExp("**/*.{yml,yaml}").test("resources/a.yaml"));
  });
});

describe("tokenizeName", () => {
  it("splits a trailing digit group off a word, so v2 and 2 are their own token", () => {
    assert.deepEqual(tokenizeName("chunk_sonnet_job"), ["chunk", "sonnet", "job"]);
    assert.deepEqual(tokenizeName("pipeline_v2"), ["pipeline", "v2"]);
    assert.deepEqual(tokenizeName("job2"), ["job", "2"]);
    assert.deepEqual(tokenizeName("pc-26-declared"), ["pc", "26", "declared"]);
  });
});

describe("SG-01 fix-streak", () => {
  it("fires on two consecutive fix: commits touching the same file", () => {
    const findings = detectFixStreak(
      {
        commits: [
          commit("bbbbbbbbbb", "fix: widen the schema again", ["src/pipeline.py"]),
          commit("aaaaaaaaaa", "fix: widen the schema", ["src/pipeline.py"]),
          commit("0000000000", "feat: add the pipeline", ["src/pipeline.py"]),
        ],
      },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gate, "SG-01");
    assert.equal(findings[0].severity, "warn");
    assert.equal(findings[0].subject, "src/pipeline.py");
    assert.match(findings[0].message, /2 consecutive fix: commits/);
    assert.match(findings[0].message, /bbbbbbbb, aaaaaaaa/);
    assert.match(findings[0].action, /Root-cause/);
  });

  it("counts a streak over the commits that touch the file, not over the branch", () => {
    // An unrelated chore: in between says nothing about pipeline.py and must not reset it.
    const findings = detectFixStreak(
      {
        commits: [
          commit("c3", "fix: third attempt", ["src/pipeline.py"]),
          commit("c2", "chore: bump a lockfile", ["package-lock.json"]),
          commit("c1", "fix: second attempt", ["src/pipeline.py"]),
        ],
      },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /2 consecutive fix: commits/);
  });

  it("stays silent when a feat: on the same file breaks the run", () => {
    const findings = detectFixStreak(
      {
        commits: [
          commit("c3", "fix: one follow-up", ["src/pipeline.py"]),
          commit("c2", "feat: new extraction stage", ["src/pipeline.py"]),
          commit("c1", "fix: an older, unrelated fix", ["src/pipeline.py"]),
        ],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("stays silent on ordinary work: one fix per file, several files", () => {
    const findings = detectFixStreak(
      {
        commits: [
          commit("c3", "fix: off-by-one in the reader", ["src/reader.py"]),
          commit("c2", "feat: writer", ["src/writer.py"]),
          commit("c1", "fix: typo in the docs", ["README.md"]),
        ],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("is reset by a commit that states a root cause and an alternative", () => {
    const stated = commit(
      "c3",
      "fix: third attempt",
      ["src/pipeline.py"],
      "Root-cause: the page count is asserted against production, not against the request.\nAlternative: pass the requested scope down and compare against it.",
    );
    const findings = detectFixStreak(
      { commits: [stated, commit("c2", "fix: second", ["src/pipeline.py"]), commit("c1", "fix: first", ["src/pipeline.py"])] },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("needs BOTH trailers — a root cause with no alternative is still a streak", () => {
    const half = commit("c3", "fix: third attempt", ["src/pipeline.py"], "Root-cause: the schema is wrong.");
    const findings = detectFixStreak(
      { commits: [half, commit("c2", "fix: second", ["src/pipeline.py"]), commit("c1", "fix: first", ["src/pipeline.py"])] },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /3 consecutive/);
  });

  it("ignores the churn paths a lockfile produces by design", () => {
    const findings = detectFixStreak(
      {
        commits: [
          commit("c2", "fix: re-resolve", ["package-lock.json"]),
          commit("c1", "fix: re-resolve", ["package-lock.json"]),
        ],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });
});

describe("SG-02 parallel-module", () => {
  // The audited tree's own shape: model name encoded into the filename.
  const MODELS_JSON = JSON.stringify({
    providers: { litellm: { models: [{ id: "gpt-5.6-luna" }, { id: "databricks-claude-sonnet-4-5" }] } },
  });

  it("fires on a new file that differs from an existing one by a model token", () => {
    const findings = detectParallelModules(
      {
        newPaths: ["src/chunk_sonnet_job.py"],
        existingPaths: ["src/chunk_luna_job.py", "src/reader.py"],
        deriveText: [MODELS_JSON],
      },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gate, "SG-02");
    assert.equal(findings[0].subject, "src/chunk_sonnet_job.py");
    assert.match(findings[0].message, /src\/chunk_luna_job\.py/);
    assert.match(findings[0].action, /parameterize/);
  });

  it("fires with no model config at all when the tree already varies at that position", () => {
    // The derived-axis trigger: two existing siblings establish the axis, the third extends it.
    const findings = detectParallelModules(
      {
        newPaths: ["jobs/extract_charts_job.yml"],
        existingPaths: ["jobs/extract_tables_job.yml", "jobs/extract_text_job.yml"],
        deriveText: [],
      },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /axis, not a name/);
  });

  it("fires on the generic v2 shape with no config and no axis", () => {
    const findings = detectParallelModules(
      { newPaths: ["src/pipeline_v2.py"], existingPaths: ["src/pipeline.py"], deriveText: [] },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /variant token/);
  });

  it("stays silent on a numbered series", () => {
    const findings = detectParallelModules(
      {
        newPaths: ["bin/rules/pc-28-new-thing.mjs"],
        existingPaths: [
          "bin/rules/pc-25-user-facing-prose-budget.mjs",
          "bin/rules/pc-26-declared-models-are-priced.mjs",
          "bin/rules/pc-27-routing-prose-matches-config.mjs",
        ],
        deriveText: [],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("stays silent on a prefix family that shares only one token", () => {
    // bin/pi-gate beside bin/pi-check: same prefix, different programs. This is the exact false
    // positive the first version of this gate produced on its own commit.
    const findings = detectParallelModules(
      {
        newPaths: ["bin/pi-gate"],
        existingPaths: ["bin/pi-check", "bin/pi-run", "bin/pi-log"],
        deriveText: [],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("stays silent on a genuinely new module and on unrelated names", () => {
    const findings = detectParallelModules(
      {
        newPaths: ["src/telemetry.py", "src/chunking/reader.py"],
        existingPaths: ["src/pipeline.py", "src/writer.py"],
        deriveText: [MODELS_JSON],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("does not compare across extensions", () => {
    const findings = detectParallelModules(
      { newPaths: ["src/pipeline_v2.md"], existingPaths: ["src/pipeline.py"], deriveText: [] },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("takes an extra vocabulary token from config", () => {
    const cfg = resolveGateConfig({ gates: { "SG-02": { variantTokens: ["kudu"] } } });
    const findings = detectParallelModules(
      { newPaths: ["src/kudu_reader.py"], existingPaths: ["src/plain_reader.py"], deriveText: [] },
      cfg,
    );
    assert.equal(findings.length, 1);
  });
});

describe("SG-03 file-count budget", () => {
  const FIVE = [
    "src/a.py",
    "src/b.py",
    "src/c.py",
    "src/d.py",
    "src/e.py",
  ];

  it("fires at the budget with no sign-off", () => {
    const findings = detectFileCountBudget({ newPaths: FIVE, signoff: null }, CFG);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warn");
    assert.match(findings[0].message, /5 new top-level modules/);
    assert.match(findings[0].action, /--signoff/);
  });

  it("records a sign-off as an ok finding, quoting the reason back", () => {
    const findings = detectFileCountBudget({ newPaths: FIVE, signoff: "one per source format, agreed 2026-08-30" }, CFG);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "ok");
    assert.match(findings[0].message, /signed off: one per source format/);
  });

  it("treats an empty or whitespace-only reason as no sign-off at all", () => {
    for (const signoff of ["", "   ", "\n"]) {
      const findings = detectFileCountBudget({ newPaths: FIVE, signoff }, CFG);
      assert.equal(findings[0].severity, "warn", `"${signoff}" must not clear the gate`);
    }
  });

  it("stays silent below the budget, and on depth and non-source files", () => {
    assert.deepEqual(detectFileCountBudget({ newPaths: FIVE.slice(0, 3), signoff: null }, CFG), []);
    assert.deepEqual(
      detectFileCountBudget(
        {
          newPaths: ["src/chunking/a.py", "src/chunking/b.py", "src/chunking/c.py", "src/chunking/d.py", "src/chunking/e.py"],
          signoff: null,
        },
        CFG,
      ),
      [],
      "work inside one existing module is not sprawl",
    );
    assert.deepEqual(
      detectFileCountBudget({ newPaths: ["a.md", "b.md", "c.md", "d.md", "e.md"], signoff: null }, CFG),
      [],
      "five new docs are not five new modules",
    );
  });

  it("does not count test files", () => {
    const findings = detectFileCountBudget(
      { newPaths: ["test/a.py", "test/b.py", "test/c.py", "test/d.py", "test/e.py"], signoff: null },
      CFG,
    );
    assert.deepEqual(findings, []);
  });
});

describe("SG-04 bounded-run", () => {
  it("fires on a job that names no subset parameter", () => {
    const findings = detectBoundedRun(
      { jobFiles: [{ path: "jobs/aggregation_job.py", text: "def run(source_pdf):\n    process_all(source_pdf)\n" }] },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gate, "SG-04");
    assert.match(findings[0].message, /declares no subset parameter/);
  });

  it("fires on a hard equality against a full-scale constant even when a limit exists", () => {
    // The live defect: `limit` is accepted, and then a 25-page run fails an assertion about 701.
    const findings = detectBoundedRun(
      {
        jobFiles: [
          {
            path: "src/chunk_llm_pipeline.py",
            text: "def run(limit=None):\n    assert expected_page_count == 701\n",
          },
        ],
      },
      CFG,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /full-scale constant \(expected_page_count vs 701\)/);
  });

  it("stays silent on a job that takes a subset and compares only status-shaped literals", () => {
    const findings = detectBoundedRun(
      {
        jobFiles: [
          {
            path: "jobs/aggregation_job.py",
            text: "def run(source_pdf, limit=None):\n    if response.status == 200 or response.status_code == 503:\n        return process(source_pdf, limit)\n",
          },
          { path: "resources/extract.job.yml", text: "parameters:\n  max_pages: 25\n" },
        ],
      },
      CFG,
    );
    assert.deepEqual(findings, []);
  });

  it("reports at most one finding per job file", () => {
    const findings = detectBoundedRun(
      {
        jobFiles: [
          { path: "jobs/a_job.py", text: "def run(limit):\n    assert a == 701\n    assert b == 900\n" },
        ],
      },
      CFG,
    );
    assert.equal(findings.length, 1);
  });
});

describe("block mode", () => {
  it("promotes warn to error and leaves an ok sign-off alone", () => {
    const promoted = applyBlockMode([
      { gate: "SG-01", severity: "warn", subject: "a", message: "m", action: "a" },
      { gate: "SG-03", severity: "ok", subject: "b", message: "m", action: "a" },
    ]);
    assert.equal(promoted[0].severity, "error");
    assert.equal(promoted[1].severity, "ok");
  });
});

describe("the shipped defaults name no tenant", () => {
  it("carries no model, vendor or project name in DEFAULT_CONFIG", () => {
    const text = JSON.stringify(DEFAULT_CONFIG).toLowerCase();
    for (const token of ["sonnet", "gemma", "luna", "haiku", "claude", "gpt", "databricks", "litellm"]) {
      assert.ok(!text.includes(token), `DEFAULT_CONFIG must not hardcode "${token}" — SG-02 derives it`);
    }
  });
});

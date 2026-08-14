import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReport,
  checkAgents,
  checkGuard,
  checkHooks,
  checkModels,
  checkModuleLoad,
  checkPackages,
  checkServers,
  checkSkills,
  checkTools,
  EXPECTED_GUARD_SELF_TEST_PATTERN_ID,
  runAllChecks,
  type DoctorInputs,
} from "../../extensions/doctor/checks.ts";

function baseInputs(overrides: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    systemPrompt: "",
    liveToolNames: ["bash", "read", "edit"],
    declaredToolNames: ["web_search", "web_fetch"],
    declaredSkillIds: ["sofa", "agent-swarm-workflow"],
    liveSkillIds: [],
    agents: { rootExists: false, ids: [] },
    routingTiers: [],
    availableModels: [],
    manifest: { declared: ["guard", "doctor"], loaded: ["guard", "doctor"], failed: [], absent: [] },
    guard: { moduleLoaded: true, handshakeObserved: false, selfTestPatternId: EXPECTED_GUARD_SELF_TEST_PATTERN_ID },
    declaredServerNames: ["playwright", "context7"],
    packages: [],
    hooksDegradedReason: undefined,
    ...overrides,
  };
}

describe("D-01 checkTools", () => {
  it("pass: a mentioned tool is live", () => {
    const findings = checkTools(baseInputs({ systemPrompt: "the `bash` tool runs commands" }));
    assert.deepEqual(findings, []);
  });

  it("pass: a mentioned tool is declared but not live (uncredentialed provider)", () => {
    const findings = checkTools(baseInputs({ systemPrompt: "the `web_search` tool" }));
    assert.deepEqual(findings, []);
  });

  it("fail: an unresolved tool is an error, named with its subject — REQ-CTX-03's own example", () => {
    const findings = checkTools(baseInputs({ systemPrompt: "use the frobnicate tool" }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.check, "D-01");
    assert.equal(findings[0]?.severity, "error");
    assert.equal(findings[0]?.subject, "frobnicate");
  });
});

describe("D-02 checkSkills", () => {
  it("pass: a mentioned skill is in the declared filesystem roster", () => {
    const findings = checkSkills(baseInputs({ systemPrompt: "load the `sofa` skill" }));
    assert.deepEqual(findings, []);
  });

  it("fail: a mentioned skill has no SKILL.md anywhere", () => {
    const findings = checkSkills(baseInputs({ systemPrompt: "load the `ghost-skill` skill" }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.check, "D-02");
    assert.equal(findings[0]?.severity, "error");
  });

  it("pass: a mentioned skill PI discovered outside the repo (~/.agents/skills, a package)", () => {
    // `discoverDeclaredSkills` scans three repo roots and structurally cannot see these; PI's live
    // registry can. Declared-only produced six false D-02 errors on 2026-08-07 for exactly this.
    const findings = checkSkills(
      baseInputs({
        systemPrompt: "share it with the `yopass` skill, batch calls with the `mcp-scripting` skill",
        liveSkillIds: ["yopass", "mcp-scripting"],
      }),
    );
    assert.deepEqual(findings, []);
  });

  it("pass: a repo skill this session's cwd scoped out is still declared", () => {
    // The other half of the union: `skills-private/` is never in settings.json's `skills` array,
    // so it is declared-but-not-live. Live-only would false-positive here.
    const findings = checkSkills(
      baseInputs({ systemPrompt: "load the `sofa` skill", declaredSkillIds: ["sofa"], liveSkillIds: [] }),
    );
    assert.deepEqual(findings, []);
  });
});

describe("D-01/D-02 against a PI-assembled system prompt (the 2026-08-07 false positives)", () => {
  /** The shape `dist/core/system-prompt.js` actually emits, reduced to the lines that misfired.
   *  Verified against a live `/ctx-dump` of this repo — see extract.ts's module docstring. */
  const ASSEMBLED = [
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "",
    "Available tools:",
    "- expand_result: Read back part of an externalised tool result",
    "",
    "Guidelines:",
    "- Use expand_result with the handle from an externalised result instead of re-running the original tool.",
    "",
    "<project_context>",
    "",
    '<project_instructions path="/repo/AGENTS.md">',
    "Load the `sofa` skill before answering.",
    "</project_instructions>",
    "",
    "</project_context>",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>yopass</name>",
    "    <description>Share secrets securely via Yopass one-time links.</description>",
    "    <location>/Users/x/.agents/skills/yopass/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>mcp-scripting</name>",
    "    <description>Batch MCP calls.</description>",
    "    <location>/repo/pi-packages/pi-mcp-adapter/skills/mcp-scripting/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
    "Current working directory: /repo",
  ].join("\n");

  it("D-01 does not fire on PI's own guideline prose ('an externalised tool', 'the original tool')", () => {
    const findings = checkTools(baseInputs({ systemPrompt: ASSEMBLED }));
    assert.deepEqual(findings, []);
  });

  it("D-02 does not fire on <available_skills> <location> paths", () => {
    // Neither `yopass` nor `mcp-scripting` is declared *or* live in this fixture — the only reason
    // there is no finding is that the registry render is not scanned for references at all.
    const findings = checkSkills(baseInputs({ systemPrompt: ASSEMBLED }));
    assert.deepEqual(findings, []);
  });

  it("D-02 still fires on a genuinely unresolved reference inside <project_instructions>", () => {
    const drifted = ASSEMBLED.replace("`sofa` skill", "`ghost-skill` skill");
    const findings = checkSkills(baseInputs({ systemPrompt: drifted }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.subject, "ghost-skill");
    assert.equal(findings[0]?.severity, "error");
  });

  it("D-01 still fires on a bare-prose tool reference inside <project_instructions>", () => {
    const drifted = ASSEMBLED.replace(
      "Load the `sofa` skill before answering.",
      "use the frobnicate tool",
    );
    const findings = checkTools(baseInputs({ systemPrompt: drifted }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.subject, "frobnicate");
  });
});

describe("D-03 checkAgents", () => {
  it("pass: agents/ absent and nothing is mentioned", () => {
    assert.deepEqual(checkAgents(baseInputs()), []);
  });

  it("warn: agents/ does not exist yet — wave 1, not drift, one finding PER mentioned name (D-01/02/04's own pattern)", () => {
    // extractAgents' own regex needs 3+ comma-separated names to fire at all (extract.ts's
    // docstring), so this fixture necessarily mentions three — and with agents/ absent, none of
    // the three resolve, so checkAgents reports all three rather than a single collapsed finding.
    const findings = checkAgents(
      baseInputs({ systemPrompt: "pick a role from `agents/`: researcher, debugger, ai-engineer." }),
    );
    assert.equal(findings.length, 3);
    assert.deepEqual(findings.map((f) => f.subject).toSorted(), ["ai-engineer", "debugger", "researcher"]);
    for (const f of findings) {
      assert.equal(f.severity, "warn");
      assert.equal(f.check, "D-03");
    }
  });

  it("pass: agents/ exists and the mentioned agent has a file", () => {
    const findings = checkAgents(
      baseInputs({
        systemPrompt: "agents: researcher, debugger, other-role.",
        agents: { rootExists: true, ids: ["researcher", "debugger", "other-role"] },
      }),
    );
    assert.deepEqual(findings, []);
  });

  it("error: agents/ exists but the mentioned agent has no file — wave 2+ drift", () => {
    const findings = checkAgents(
      baseInputs({
        systemPrompt: "agents: researcher, ghost-agent, other-role.",
        agents: { rootExists: true, ids: ["researcher", "other-role"] },
      }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "error");
    assert.equal(findings[0]?.subject, "ghost-agent");
  });
});

describe("D-04 checkModels", () => {
  it("pass: tier model resolves and is credentialed", () => {
    const findings = checkModels(
      baseInputs({
        routingTiers: [{ tier: "strong", modelRef: "github-copilot/claude-opus-5", optional: false }],
        availableModels: [{ provider: "github-copilot", id: "claude-opus-5", credentialed: true }],
      }),
    );
    assert.deepEqual(findings, []);
  });

  it("error: an unknown model id on a required tier", () => {
    const findings = checkModels(
      baseInputs({
        routingTiers: [{ tier: "strong", modelRef: "github-copilot/claude-opus-5", optional: false }],
        availableModels: [],
      }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "error");
  });

  it("warn: an unknown model id on an OPTIONAL tier — audit 25, must not block startup", () => {
    const findings = checkModels(
      baseInputs({
        routingTiers: [{ tier: "local", modelRef: "local/unsloth/Qwen3.6-35B", optional: true }],
        availableModels: [],
      }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "warn");
    assert.match(findings[0]?.message ?? "", /local/);
  });

  it("warn: resolved but uncredentialed, on a REQUIRED tier — audit 25's colleague-missing-one-credential case", () => {
    const findings = checkModels(
      baseInputs({
        routingTiers: [{ tier: "confidential", modelRef: "databricks/databricks-claude-sonnet-4-5", optional: false }],
        availableModels: [{ provider: "databricks", id: "databricks-claude-sonnet-4-5", credentialed: false }],
      }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "warn");
  });

  it("splits a model id containing its own slash on the FIRST slash only (local/unsloth/Qwen...)", () => {
    const findings = checkModels(
      baseInputs({
        routingTiers: [{ tier: "local", modelRef: "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF", optional: true }],
        availableModels: [{ provider: "local", id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", credentialed: true }],
      }),
    );
    assert.deepEqual(findings, []);
  });

  /**
   * A tier's reasoning effort rides inside the model string (`provider/id:high`) and the registry
   * is keyed by the bare id, so the suffix has to come off before the lookup. Without that, a
   * perfectly bound tier is reported as `unresolved` — the one tool whose job is to say whether the
   * configuration is sound inventing a fault in it. Only a KNOWN level splits, so a typo in the
   * level stays part of the id and is still reported, which is the wanted loud failure.
   */
  it("strips a thinking-level suffix before asking the registry, and only a known level", () => {
    const available = [{ provider: "github-copilot", id: "claude-opus-5", credentialed: true }];
    assert.deepEqual(
      checkModels(
        baseInputs({
          routingTiers: [{ tier: "strong", modelRef: "github-copilot/claude-opus-5:high", optional: false }],
          availableModels: available,
        }),
      ),
      [],
    );
    const typo = checkModels(
      baseInputs({
        routingTiers: [{ tier: "strong", modelRef: "github-copilot/claude-opus-5:hihg", optional: false }],
        availableModels: available,
      }),
    );
    assert.equal(typo.length, 1, "a misspelled level is not silently read as an effort");
    assert.equal(typo[0]?.severity, "error");
  });
});

describe("D-05 checkModuleLoad", () => {
  it("pass: every declared module loaded", () => {
    assert.deepEqual(checkModuleLoad(baseInputs()), []);
  });

  it("error: a module that threw is named with its error text — the acceptance test's own shape", () => {
    const findings = checkModuleLoad(
      baseInputs({ manifest: { declared: ["guard", "web"], loaded: ["guard"], failed: [["web", "Error: boom"]], absent: [] } }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "error");
    assert.equal(findings[0]?.subject, "web");
    assert.match(findings[0]?.message ?? "", /boom/);
  });

  it("error: a module that never attempted registration (absent) is named too", () => {
    const findings = checkModuleLoad(
      baseInputs({ manifest: { declared: ["guard", "trust"], loaded: ["guard"], failed: [], absent: ["trust"] } }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.subject, "trust");
  });
});

describe("D-06 checkGuard", () => {
  it("pass: guard loaded and the self-test still matches DB-RM-ROOT", () => {
    assert.deepEqual(checkGuard(baseInputs()), []);
  });

  it("error: guard module did not load at all", () => {
    const findings = checkGuard(
      baseInputs({ guard: { moduleLoaded: false, handshakeObserved: false, selfTestPatternId: null } }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "error");
    assert.equal(findings[0]?.subject, "guard");
  });

  it("error: the pattern no longer matches DB-RM-ROOT — the worst failure mode, per spec", () => {
    const findings = checkGuard(
      baseInputs({ guard: { moduleLoaded: true, handshakeObserved: false, selfTestPatternId: null } }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "error");
    assert.match(findings[0]?.message ?? "", /DB-RM-ROOT/);
  });

  it("error: the pattern matches something else entirely", () => {
    const findings = checkGuard(
      baseInputs({ guard: { moduleLoaded: true, handshakeObserved: false, selfTestPatternId: "SOME-OTHER-RULE" } }),
    );
    assert.equal(findings.length, 1);
  });
});

describe("D-07 checkServers", () => {
  it("pass: a mentioned server is declared", () => {
    const findings = checkServers(baseInputs({ systemPrompt: "the `playwright` MCP server" }));
    assert.deepEqual(findings, []);
  });

  it("fail: a mentioned server is not in config/mcp.json", () => {
    const findings = checkServers(baseInputs({ systemPrompt: "the `ghost-server` MCP server" }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.check, "D-07");
    assert.equal(findings[0]?.severity, "error");
  });
});

describe("D-08 checkPackages", () => {
  it("pass: installed version matches the pinned version", () => {
    const findings = checkPackages(
      baseInputs({ packages: [{ name: "pi-subagents", declaredVersion: "0.41.0", vendor: false, installedVersion: "0.41.0" }] }),
    );
    assert.deepEqual(findings, []);
  });

  it("warn (R-13's greppable shape): declared but not installed", () => {
    const findings = checkPackages(
      baseInputs({ packages: [{ name: "@narumitw/pi-lsp", declaredVersion: "1.0.0", vendor: false, installedVersion: undefined }] }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.check, "D-08");
    assert.equal(findings[0]?.severity, "warn");
    assert.match(findings[0]?.message ?? "", /not installed/);
  });

  it("warn: installed but at a version other than pinned", () => {
    const findings = checkPackages(
      baseInputs({ packages: [{ name: "pi-sandbox", declaredVersion: "0.6.2", vendor: true, installedVersion: "0.6.1" }] }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "warn");
    assert.match(findings[0]?.message ?? "", /0\.6\.1/);
  });
});

describe("D-09 checkHooks", () => {
  it("pass: a healthy hook layer reports nothing", () => {
    assert.deepEqual(checkHooks(baseInputs()), []);
  });

  it("pass: zero rules with no degraded reason is normal — no hooks.yaml at all is the common case", () => {
    assert.deepEqual(checkHooks(baseInputs({ hooksDegradedReason: undefined })), []);
  });

  it("error: a degraded hook layer is reported with the reason, because nothing else shows it", () => {
    const findings = checkHooks(
      baseInputs({ hooksDegradedReason: "/home/d/.config/pi-config/hooks.yaml: invalid YAML: unexpected end" }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.check, "D-09");
    assert.equal(findings[0]?.severity, "error");
    assert.equal(findings[0]?.subject, "hooks.yaml");
    assert.match(findings[0]?.message ?? "", /invalid YAML/);
    assert.match(findings[0]?.action ?? "", /guard\.ts/);
  });

  it("D-09 is in the cheap session_start pass — a hook layer that silently stopped denying must be caught every session", () => {
    const inputs = baseInputs({ hooksDegradedReason: "rules: not a list" });
    assert.ok(runAllChecks(inputs, { cheapOnly: true }).some((f) => f.check === "D-09"));
  });

  it("buildReport carries the reason so --json consumers see it, and omits the key when healthy", () => {
    const degraded = baseInputs({ hooksDegradedReason: "rules: not a list" });
    assert.equal(buildReport(degraded, runAllChecks(degraded)).hooks.degradedReason, "rules: not a list");
    assert.equal(buildReport(baseInputs(), []).hooks.degradedReason, undefined);
  });
});

describe("runAllChecks — cheapOnly", () => {
  it("excludes D-04 and D-08 from the session_start warn pass", () => {
    const inputs = baseInputs({
      routingTiers: [{ tier: "strong", modelRef: "nowhere/nothing", optional: false }],
      availableModels: [],
      packages: [{ name: "ghost", declaredVersion: "1.0.0", vendor: false, installedVersion: undefined }],
    });
    const cheap = runAllChecks(inputs, { cheapOnly: true });
    assert.ok(!cheap.some((f) => f.check === "D-04"));
    assert.ok(!cheap.some((f) => f.check === "D-08"));

    const full = runAllChecks(inputs);
    assert.ok(full.some((f) => f.check === "D-04"));
    assert.ok(full.some((f) => f.check === "D-08"));
  });
});

describe("buildReport", () => {
  it("ok is false when any finding is an error, true otherwise", () => {
    const inputs = baseInputs();
    const okReport = buildReport(inputs, runAllChecks(inputs));
    assert.equal(okReport.ok, true);

    const brokenInputs = baseInputs({ guard: { moduleLoaded: false, handshakeObserved: false, selfTestPatternId: null } });
    const brokenReport = buildReport(brokenInputs, runAllChecks(brokenInputs));
    assert.equal(brokenReport.ok, false);
  });

  it("summarises modules, skills, agents, tools, servers, guard, models and packages", () => {
    const inputs = baseInputs({
      declaredSkillIds: ["a", "b", "c"],
      agents: { rootExists: true, ids: ["researcher"] },
      availableModels: [
        { provider: "github-copilot", id: "claude-opus-5", credentialed: true },
        { provider: "databricks", id: "x", credentialed: false },
      ],
      packages: [
        { name: "a", declaredVersion: "1.0.0", vendor: false, installedVersion: "1.0.0" },
        { name: "b", declaredVersion: "1.0.0", vendor: false, installedVersion: undefined },
      ],
    });
    const report = buildReport(inputs, runAllChecks(inputs));
    assert.equal(report.modules.declared, 2);
    assert.equal(report.modules.loaded, 2);
    assert.equal(report.skills.count, 3);
    assert.equal(report.agents.count, 1);
    assert.equal(report.tools.count, 3);
    assert.equal(report.servers.count, 2);
    assert.equal(report.guard.selfTestOk, true);
    assert.equal(report.models.available, 2);
    assert.deepEqual(report.models.uncredentialed, ["databricks/x"]);
    assert.equal(report.packages.declared, 2);
    assert.equal(report.packages.resolved, 1);
    assert.deepEqual(report.packages.absent, ["b"]);
  });
});

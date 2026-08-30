// config/bin/pi-constraints-hook — hard constraints enforced at the tool_call hook layer.
//
// The script is spawned exactly the way `extensions/hooks/run.ts` spawns it (JSON payload on
// stdin, verdict on stdout, exit code carrying the infrastructure half), so these tests exercise
// the real contract rather than an imported function that never crosses a process boundary.
// `PI_CODING_AGENT_DIR` points the global constraint file at a throwaway directory — the same
// isolation `test/web/config-guard.test.ts` uses — so no test reads ~/.pi/agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOK = join(REPO_ROOT, "config", "bin", "pi-constraints-hook");

interface Verdict {
  readonly exitCode: number;
  readonly stdout: string;
  readonly decision: { decision?: string; reason?: string } | null;
}

/** One spawn of the hook, with `agentDir` standing in for <agentDir> and `cwd` for the project. */
function callHook(agentDir: string, payload: unknown): Verdict {
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    stdout = e.stdout ?? "";
    exitCode = e.status ?? 1;
  }
  let decision: Verdict["decision"] = null;
  if (stdout.trim()) decision = JSON.parse(stdout) as Verdict["decision"];
  return { exitCode, stdout, decision };
}

const LANGCHAIN = {
  version: 1,
  constraints: [
    {
      id: "no-langchain",
      pattern: "\\b(?:import|from)\\s+langchain|langchain[_-]\\w+",
      flags: "i",
      reason: "This POC talks to the endpoint directly; LangChain was ruled out in the project plan.",
    },
  ],
};

test("pi-constraints-hook", async (t) => {
  let agentDir: string;
  let project: string;

  t.beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pion-constraints-agent-"));
    project = mkdtempSync(join(tmpdir(), "pion-constraints-project-"));
  });
  t.afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function writeProjectConstraints(doc: unknown): void {
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "constraints.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
  }

  function writeGlobalConstraints(doc: unknown): void {
    writeFileSync(join(agentDir, "constraints.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
  }

  await t.test("a write that adds a banned import is denied, and the refusal carries the reason", () => {
    writeProjectConstraints(LANGCHAIN);
    const v = callHook(agentDir, {
      event: "tool_call",
      ruleId: "constraints-write",
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "from langchain_openai import ChatOpenAI\n" },
    });
    assert.equal(v.exitCode, 0, "a deny is exit 0 with JSON on stdout; exit 2 is the other supported shape");
    assert.equal(v.decision?.decision, "deny");
    assert.match(v.decision?.reason ?? "", /constraint "no-langchain" from .*constraints\.json/);
    assert.match(v.decision?.reason ?? "", /LangChain was ruled out in the project plan/);
    assert.match(v.decision?.reason ?? "", /src\/transport\.py/);
    assert.match(v.decision?.reason ?? "", /Override path: none, ask the owner to change the constraint file in a commit\./);
  });

  await t.test("an edit whose newText adds a banned import is denied", () => {
    writeProjectConstraints(LANGCHAIN);
    const v = callHook(agentDir, {
      tool: "edit",
      cwd: project,
      input: {
        path: "src/transport.py",
        edits: [{ oldText: "import httpx", newText: "import langchain_core\nimport httpx" }],
      },
    });
    assert.equal(v.decision?.decision, "deny");
  });

  await t.test("a write with no banned text produces no opinion: exit 0, empty stdout", () => {
    writeProjectConstraints(LANGCHAIN);
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "import httpx\n\nclient = httpx.Client()\n" },
    });
    assert.equal(v.exitCode, 0);
    assert.equal(v.stdout.trim(), "", "empty stdout is the only way a run rule lets a call through");
  });

  await t.test("removing a banned import is allowed — the constraint never blocks compliance with itself", () => {
    writeProjectConstraints(LANGCHAIN);
    const v = callHook(agentDir, {
      tool: "edit",
      cwd: project,
      input: {
        // The banned text appears only in `oldText`: this edit deletes it.
        path: "src/transport.py",
        edits: [{ oldText: "from langchain_openai import ChatOpenAI", newText: "import httpx" }],
      },
    });
    assert.equal(v.stdout.trim(), "");
  });

  await t.test("no constraint file anywhere is a no-op, not a block", () => {
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "from langchain_openai import ChatOpenAI\n" },
    });
    assert.equal(v.exitCode, 0);
    assert.equal(v.stdout.trim(), "");
  });

  await t.test("an empty constraints array is a no-op — the shape this repo's own file ships with", () => {
    writeGlobalConstraints({ version: 1, constraints: [] });
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "from langchain_openai import ChatOpenAI\n" },
    });
    assert.equal(v.stdout.trim(), "");
  });

  await t.test("the global file applies to a project that declares none of its own", () => {
    writeGlobalConstraints(LANGCHAIN);
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "import langchain_core\n" },
    });
    assert.equal(v.decision?.decision, "deny");
    assert.match(v.decision?.reason ?? "", new RegExp(agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  await t.test('"paths" scopes a constraint, so a doc that quotes the banned string stays writable', () => {
    writeProjectConstraints({
      version: 1,
      constraints: [{ ...LANGCHAIN.constraints[0], paths: ["\\.py$"] }],
    });
    const code = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "import langchain_core\n" },
    });
    assert.equal(code.decision?.decision, "deny");
    const doc = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "docs/decisions.md", content: "We do not use langchain here, and this is why.\n" },
    });
    assert.equal(doc.stdout.trim(), "");
  });

  await t.test("an unparseable constraint file denies instead of degrading to no constraints", () => {
    writeProjectConstraints("{ not json");
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "anything at all\n" },
    });
    assert.equal(v.decision?.decision, "deny");
    assert.match(v.decision?.reason ?? "", /constraint file unreadable/);
    assert.match(v.decision?.reason ?? "", /is not valid JSON/);
  });

  await t.test("a constraint with a regex that does not compile denies, naming the constraint", () => {
    writeProjectConstraints({ version: 1, constraints: [{ id: "broken", pattern: "([unclosed", reason: "x" }] });
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: "src/transport.py", content: "anything\n" },
    });
    assert.equal(v.decision?.decision, "deny");
    assert.match(v.decision?.reason ?? "", /constraint "broken" has an invalid regex/);
  });

  await t.test("editing a constraint file is never blocked — the declared override path stays reachable", () => {
    writeProjectConstraints("{ not json");
    const v = callHook(agentDir, {
      tool: "write",
      cwd: project,
      input: { path: join(project, ".pi", "constraints.json"), content: JSON.stringify(LANGCHAIN) },
    });
    assert.equal(v.stdout.trim(), "", "a broken constraint file must not lock the operator out of fixing it");
  });

  await t.test("a writing tool with an unknown input shape is still scanned, not silently exempt", () => {
    writeProjectConstraints(LANGCHAIN);
    const v = callHook(agentDir, {
      tool: "some_other_writer",
      cwd: project,
      input: { path: "src/transport.py", body: "import langchain_core" },
    });
    assert.equal(v.decision?.decision, "deny");
  });
});

test("config/constraints.json, as committed, is a valid carrier the hook can read", () => {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, "config", "constraints.json"), "utf8")) as {
    version?: number;
    constraints?: unknown;
  };
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.constraints), '"constraints" must be an array, or the hook denies every write');
  for (const c of doc.constraints as Array<Record<string, unknown>>) {
    assert.equal(typeof c.id, "string");
    assert.doesNotThrow(() => new RegExp(String(c.pattern), typeof c.flags === "string" ? c.flags : ""));
    assert.equal(typeof c.reason, "string", "a refusal that cannot say why gets argued with");
  }
});

test("config/hooks.yaml wires the constraint script that config/bin actually ships", async () => {
  const { parse } = await import("yaml");
  const doc = parse(readFileSync(join(REPO_ROOT, "config", "hooks.yaml"), "utf8")) as {
    rules: Array<{ id: string; action: string; match?: { tool?: string }; run?: { command?: string } }>;
  };
  const constraintRules = doc.rules.filter((r) => r.action === "run" && r.run?.command?.endsWith("pi-constraints-hook"));
  assert.deepEqual(
    constraintRules.map((r) => r.match?.tool).sort(),
    ["edit", "write"],
    "both writing tools need their own rule, because match.tool is one exact name",
  );
  // `run.ts` blocks the tool call when the script is missing or not executable, so the mode bit is
  // part of the contract rather than a detail: a lost +x turns every edit into a refusal.
  assert.ok(statSync(HOOK).mode & 0o111, "config/bin/pi-constraints-hook must be executable");
});

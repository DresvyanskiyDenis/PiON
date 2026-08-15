/**
 * The relaxation, stated as one acceptance probe.
 *
 * Owner decision, 2026-08-14: the allow-list model was removed outright, and only catastrophic
 * commands are to be blocked. Owner decision, 2026-08-15: `SEC` — the one gate the first decision
 * left blocking for a reason other than destruction — is covered by the same rule and stops
 * blocking too. This file is the place the result is pinned, so a future reader can answer "what
 * does the guard actually stop?" from a single screen rather than by reading six gates.
 *
 *   1. **The catastrophic set still blocks.** `rm -rf /`, `rm -rf $HOME`, `mkfs`, `dd of=/dev/…`,
 *      `git filter-repo`, and a force-push onto a protected branch. If any row here stops blocking,
 *      the relaxation went too far.
 *   2. **Everything else runs, headless, with no prompt** — credential paths included. The commands
 *      below are the ones that were measured stopping work — 24 of 33 subagent runs blocked in one
 *      morning. If any row here starts blocking, the relaxation has quietly grown back.
 *
 * The gates that used to enforce and now only observe (`SEC`, `PRV`, `FS`, `RTE`) are covered where
 * they live: `write-surface.test.ts`, `gates.test.ts`, and `patterns.table.ts`'s `MUST_OBSERVE`.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { beforeEach, describe, it } from "node:test";
import { buildRules } from "../../extensions/guard.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { bashEvent, customEvent, fakeCtx, recorder, runRules, testPolicy } from "./helpers.ts";

beforeEach(() => {
  resetSurfaced();
});

/** Headless, `mode=json` — the mode every subagent actually runs in, and the one that used to fail. */
async function headless(command: string, toolCallId = "tc-1") {
  const rec = recorder();
  const rules = buildRules(testPolicy(), rec.services);
  const result = await runRules(
    rules,
    bashEvent(command, toolCallId),
    fakeCtx({ hasUI: false, mode: "json" }, rec),
    rec.services,
  );
  return { result, rec };
}

describe("what still blocks — the catastrophic set", () => {
  const CATASTROPHIC: ReadonlyArray<[string, string]> = [
    ["rm -rf /", "DB-RM-ROOT"],
    ["rm -rf /*", "DB-RM-ROOT"],
    ["rm -rf ~", "DB-RM-ROOT"],
    ["rm -rf $HOME", "DB-RM-ROOT"],
    ["rm -rf ${HOME}", "DB-RM-ROOT"],
    ["sudo rm -fr /", "DB-RM-ROOT"],
    ["mkfs.ext4 /dev/sdb1", "DB-MKFS"],
    ["mkfs.apfs /dev/disk3", "DB-MKFS"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "DB-DD-DISK"],
    ["dd if=backup.img of=/dev/disk2", "DB-DD-DISK"],
    ["echo x > /dev/nvme0n1", "DB-REDIR-DISK"],
    [":(){ :|:& };:", "DB-FORKBOMB"],
    ["chmod -R 777 /", "DB-CHMOD-777"],
    ["git filter-repo --mailmap mailmap.txt --force", "GIT-REWRITE"],
    ["git filter-branch --env-filter 'true' -- --all", "GIT-REWRITE"],
    ["git push --force origin main", "GIT-FORCE-PROTECTED"],
    ["git push -f origin master", "GIT-FORCE-PROTECTED"],
  ];

  it("blocks every one of them, headless, by the expected gate", async () => {
    const failures: string[] = [];
    for (const [command, gateId] of CATASTROPHIC) {
      const { result } = await headless(command);
      if (result.gateId !== gateId) {
        failures.push(`${command}: expected ${gateId}, got ${result.gateId ?? "NOT BLOCKED"}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("writes one guard.block audit entry per refusal — fail loud is unchanged", async () => {
    const { rec } = await headless("rm -rf /");
    const blocks = rec.audit.filter(([type]) => type === "guard.block");
    assert.equal(blocks.length, 1);
    assert.equal((blocks[0]![1] as { ruleId: string }).ruleId, "DB");
  });

  it("the written-justification hatch still works headless for what still blocks", async () => {
    const rec = recorder();
    const rules = buildRules(testPolicy(), rec.services);
    const event = bashEvent(
      "# PI-JUSTIFY(GIT-REWRITE): this is a throwaway clone made for the rewrite, not the checkout\n" +
        "git filter-repo --mailmap mailmap.txt --force",
      "tc-j",
    );
    const result = await runRules(rules, event, fakeCtx({ hasUI: false, mode: "json" }, rec), rec.services);
    assert.equal(result.blocked, false);
    assert.equal(rec.audit.filter(([t]) => t === "guard.override").length, 1);
  });
});

describe("what no longer blocks — the commands that were stopping work", () => {
  // Named individually rather than in a loop with one assertion, because a failure has to say
  // WHICH command regressed; these are the exact spellings from the measurement.
  const NOW_ALLOWED: readonly string[] = [
    "databricks bundle deploy --target dev",
    "databricks bundle validate",
    'python3 -c "import json,sys; print(json.load(sys.stdin))"',
    "curl -sS https://example.com/api",
    "curl -X POST -d @payload.json https://example.com/api",
    "ssh user@host 'systemctl status some-service'",
    "scp report.md user@host:/tmp/",
    "make -j4 build",
    "npm publish --dry-run",
    "npx tsc --noEmit",
    "uv run pytest -q",
    "terraform plan",
    "kubectl get pods -A",
    "docker compose up -d",
    "brew install ripgrep",
    "pip install -e .",
    "some-binary-nobody-has-ever-heard-of --version",
    "cd frontend && npm run build",
    "head -20 src/app.ts | shasum -a 256",
  ];

  it("runs every one of them headless, with no block and no prompt", async () => {
    const failures: string[] = [];
    for (const command of NOW_ALLOWED) {
      const { result, rec } = await headless(command);
      if (result.blocked) failures.push(`${result.gateId}: ${command}`);
      if (rec.selected.length > 0 || rec.confirmed.length > 0) {
        failures.push(`PROMPTED: ${command}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("SEC no longer refuses credential paths — it records them and permits the call", async () => {
    // Owner decision, 2026-08-15. `SEC` was the one gate the 2026-08-14 inversion left blocking for
    // a reason other than destruction; the same rule now covers it — only catastrophic commands
    // block, and reading a file is not catastrophic.
    //
    // The consequence this test pins, so nobody can claim it was not visible: each of these
    // commands now RUNS. The credential lands in the model's context and is sent to whichever
    // provider serves the next turn, and no runtime control in this repo prevents that. The
    // `guard.observed` entry asserted below is the whole of what is left, and it is a transcript
    // record read after the fact — not a control. Re-enforcing is a one-line change in
    // `secret-paths.ts` back to `denyWithEscapeHatch`.
    const failures: string[] = [];
    for (const [command, gateId] of [
      [`cat ${homedir()}/.ssh/id_ed25519`, "SEC-KEY"],
      [`cat ${homedir()}/.aws/credentials`, "SEC-AWS-CRED"],
      [`cat ${homedir()}/.pi/agent/auth.json`, "SEC-PI-AUTH"],
      ["cat .env", "SEC-ENV"],
    ] as const) {
      const { result, rec } = await headless(command);
      if (result.blocked) {
        failures.push(`BLOCKED by ${result.gateId}: ${command}`);
        continue;
      }
      const observed = rec.audit
        .filter(([type]) => type === "guard.observed")
        .map(([, data]) => (data as { gateId: string }).gateId);
      if (observed.length !== 1 || observed[0] !== gateId) {
        failures.push(`${command}: expected one ${gateId}, got ${JSON.stringify(observed)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("a write outside cwd runs, and is recorded rather than refused", async () => {
    const { result, rec } = await headless(`echo done >> ${homedir()}/Documents/notes.md`);
    assert.equal(result.blocked, false);
    const observed = rec.audit
      .filter(([type]) => type === "guard.observed")
      .map(([, data]) => (data as { gateId: string }).gateId);
    assert.deepEqual(observed, ["FS-OUTSIDE"]);
  });

  it("no gate raises a UI prompt any more, even when a UI is present", async () => {
    // "No new prompts anywhere" was explicit: a gate that asks instead of blocking has not been
    // relaxed. `fakeCtx` records every `ui.select`/`ui.confirm` call, so an empty recorder after
    // the whole shipped set has seen a command is the assertion.
    const rec = recorder();
    const rules = buildRules(testPolicy(), rec.services);
    const ctx = fakeCtx({}, rec);
    for (const command of [...NOW_ALLOWED, "rm -rf /", "sudo systemctl restart nginx"]) {
      await runRules(rules, bashEvent(command), ctx, rec.services);
    }
    assert.deepEqual(rec.selected, []);
    assert.deepEqual(rec.confirmed, []);
  });

  it("the allow-list escalation env vars are dead — setting them changes nothing", async () => {
    // `PI_GUARD_APPROVE` (escalation) and `PI_GUARD_SESSION_ALLOWLIST` (subagent inheritance) both
    // existed only to widen the program allow-list. `extensions/guard/escalation.ts` and
    // `extensions/guard/inherit.ts` are deleted; these assertions are what stops either name
    // coming back as a silent no-op that a reader would take for a working switch.
    process.env.PI_GUARD_APPROVE = "1";
    process.env.PI_GUARD_SESSION_ALLOWLIST = "rm";
    try {
      assert.equal((await headless("rm -rf /")).result.gateId, "DB-RM-ROOT");
      assert.equal((await headless("terraform apply", "tc-2")).result.blocked, false);
    } finally {
      delete process.env.PI_GUARD_APPROVE;
      delete process.env.PI_GUARD_SESSION_ALLOWLIST;
    }
    assert.equal((await headless("terraform apply", "tc-3")).result.blocked, false);
  });

  it("a dispatch is never refused, whatever agent type it names", async () => {
    const rec = recorder();
    const rules = buildRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      customEvent("task", { agentType: "general-purpose", prompt: "do the thing" }),
      fakeCtx({ hasUI: false, mode: "json" }, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
  });
});

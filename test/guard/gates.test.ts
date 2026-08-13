import assert from "node:assert/strict";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  registerDispatchVeto,
  resetDispatchVetoes,
} from "../../extensions/lib/dispatch-veto.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { buildRules } from "../../extensions/guard.ts";
import { resetSessionApprovals } from "../../extensions/guard/gates/bash-allowlist.ts";
import { collectStringLeaves, collectTargets } from "../../extensions/guard/targets.ts";
import {
  bashEvent,
  customEvent,
  fakeCtx,
  readEvent,
  recorder,
  runRules,
  safetyRules,
  testPolicy,
  TEST_CWD,
} from "./helpers.ts";

beforeEach(() => {
  resetSurfaced();
  resetSessionApprovals();
  resetDispatchVetoes();
  delete process.env.PI_GUARD_APPROVE;
  delete process.env.PI_GUARD_HEADLESS;
  delete process.env.PI_GUARD_TEST_THROW;
});

afterEach(() => {
  delete process.env.PI_GUARD_APPROVE;
  delete process.env.PI_GUARD_HEADLESS;
  delete process.env.PI_GUARD_TEST_THROW;
});

describe("secret-paths — REQ-PRV-15, REQ-PRV-37", () => {
  async function check(event: ReturnType<typeof readEvent>) {
    const rec = recorder();
    return runRules(safetyRules(testPolicy(), rec.services), event, fakeCtx({}, rec), rec.services);
  }

  it("blocks the read tool on the agent's own credential store", async () => {
    const result = await check(readEvent(`${homedir()}/.pi/agent/auth.json`));
    assert.equal(result.gateId, "SEC-PI-AUTH");
  });

  it("blocks a write tool on a .env, and never offers an override", async () => {
    const rec = recorder();
    const event = customEvent("write", { path: ".env", content: "TOKEN=x" });
    const result = await runRules(
      safetyRules(testPolicy(), rec.services),
      event,
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "SEC-ENV");
    assert.match(result.reason ?? "", /no override/);
    assert.doesNotMatch(result.reason ?? "", /PI-JUSTIFY/);
  });

  it("allows the .env template family", async () => {
    for (const path of [".env.example", ".env.template", ".env.sample", ".env.local.example"]) {
      const result = await check(readEvent(path));
      assert.equal(result.blocked, false, path);
    }
  });

  it("is not read-tool-only: a bash cat of the same path is denied too", async () => {
    const rec = recorder();
    const result = await runRules(
      safetyRules(testPolicy(), rec.services),
      bashEvent("cat ~/.aws/credentials"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "SEC-AWS-CRED");
  });

  it("catches a relative escape that only resolves to a secret via cwd", async () => {
    const rec = recorder();
    const result = await runRules(
      safetyRules(testPolicy(), rec.services),
      readEvent("../../secrets/token"),
      fakeCtx({ cwd: "/workspace/project/src/app" }, rec),
      rec.services,
    );
    assert.equal(result.gateId, "SEC-SECRETSDIR");
  });

  it("harvests paths from an unknown tool's file_path / files[] arguments", () => {
    const targets = collectTargets(
      customEvent("mystery_tool", { file_path: "a.txt", files: ["b.txt", { path: "c.txt" }] }),
      TEST_CWD,
    );
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      assert.ok(
        targets.some((t) => t.endsWith(name)),
        name,
      );
    }
  });
});

describe("target harvesting — F3, no more key allowlist", () => {
  async function check(event: ReturnType<typeof customEvent>) {
    const rec = recorder();
    return runRules(safetyRules(testPolicy(), rec.services), event, fakeCtx({}, rec), rec.services);
  }

  it("harvests a target from an argument name the fixed key list never chose (uri)", () => {
    const targets = collectTargets(
      customEvent("read_file", { uri: `file://${homedir()}/.pi/secrets.env` }),
      TEST_CWD,
    );
    assert.ok(targets.some((t) => t.endsWith("secrets.env")));
  });

  it("harvests a command word out of an args[] array, not just command/cmd/script", () => {
    const targets = collectTargets(
      customEvent("run", { args: ["cat", "~/.aws/credentials"] }),
      TEST_CWD,
    );
    assert.ok(targets.some((t) => t.endsWith(".aws/credentials")));
  });

  it("harvests a path nested under an arbitrary object key (params.path)", () => {
    const targets = collectTargets(
      customEvent("proxy_tool", { params: { path: "~/.ssh/id_ed25519" } }),
      TEST_CWD,
    );
    assert.ok(targets.some((t) => t.endsWith("id_ed25519")));
  });

  it("blocks read_file({uri}) on the agent's secrets store — a shape none of PATH_KEYS named", async () => {
    const result = await check(customEvent("read_file", { uri: `file://${homedir()}/.pi/secrets.env` }));
    assert.equal(result.gateId, "SEC-PI-SECRETS");
  });

  it("blocks run({args}) touching ~/.aws/credentials — the args[] shape is not command/cmd/script", async () => {
    const result = await check(customEvent("run", { args: ["cat", "~/.aws/credentials"] }));
    assert.equal(result.gateId, "SEC-AWS-CRED");
  });

  it("blocks a path nested two levels deep under an unknown key (params.path)", async () => {
    const result = await check(customEvent("proxy_tool", { params: { path: "~/.ssh/id_ed25519" } }));
    assert.equal(result.gateId, "SEC-KEY");
  });

  it("still passes an ordinary unknown-shaped call that touches nothing secret", async () => {
    const result = await check(customEvent("read_file", { uri: "file:///workspace/project/README.md" }));
    assert.equal(result.blocked, false);
  });

  it("collectStringLeaves is depth-bounded, leaf-capped and cycle-safe", () => {
    // Cycle: a pathological or hostile input must not hang the gate.
    const cyclic: Record<string, unknown> = { a: "leaf" };
    cyclic.self = cyclic;
    assert.deepEqual(collectStringLeaves(cyclic), ["leaf"]);

    // Leaf cap: a wide fan-out stops at MAX_LEAVES rather than growing unbounded.
    const wide = Array.from({ length: 5000 }, (_, i) => `leaf-${i}`);
    const leaves = collectStringLeaves(wide);
    assert.ok(leaves.length <= 500, `expected a cap, got ${leaves.length}`);

    // Depth bound: a leaf past the bound is not reached.
    let deep: unknown = "too-deep";
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    assert.deepEqual(collectStringLeaves(deep), []);

    const started = performance.now();
    collectStringLeaves(wide);
    assert.ok(performance.now() - started < 100, "must resolve well under a UI-visible delay");
  });
});

describe("destructive-git — REQ-PRV-42", () => {
  async function check(command: string, overrides = {}) {
    const rec = recorder();
    const rules = safetyRules(testPolicy(overrides), rec.services);
    const result = await runRules(rules, bashEvent(command), fakeCtx({}, rec), rec.services);
    return { result, rec };
  }

  it("allows a push to any remote when the allowlist is empty", async () => {
    const { result } = await check("git push origin main");
    assert.equal(result.blocked, false);
  });

  it("blocks a push to a remote outside a configured allowlist", async () => {
    const { result } = await check("git push evil main", { remoteAllowlist: ["origin"] });
    assert.equal(result.gateId, "GIT-REMOTE");
  });

  it("sees through git's global options to the subcommand", async () => {
    const { result } = await check("git -C /workspace/project reset --hard HEAD");
    assert.equal(result.gateId, "GIT-RESET");
  });

  it("every git rule offers the written-justification hatch", async () => {
    for (const command of [
      "git push --force origin main",
      "git reset --hard HEAD~1",
      "git branch -D dead",
      "git clean -fd",
      "git checkout -- .",
    ]) {
      const { result } = await check(command);
      assert.match(result.reason ?? "", /PI-JUSTIFY/, command);
    }
  });
});

describe("the escape hatch round trip — REQ-CTX-06", () => {
  it("blocks, names the syntax, then admits the re-issued call and audits it once", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const ctx = fakeCtx({}, rec);

    const first = await runRules(rules, bashEvent("git branch -D feature/dead"), ctx, rec.services);
    assert.equal(first.gateId, "GIT-BRANCH-D");
    assert.match(first.reason ?? "", /# PI-JUSTIFY\(GIT-BRANCH-D\):/);

    const justified =
      "# PI-JUSTIFY(GIT-BRANCH-D): the branch was merged by squash so git thinks it is unmerged\n" +
      "git branch -D feature/dead";
    const event = bashEvent(justified, "tc-2");
    const second = await runRules(rules, event, ctx, rec.services);

    assert.equal(second.blocked, false);
    const overrides = rec.audit.filter(([type]) => type === "guard.override");
    assert.equal(overrides.length, 1);
    assert.equal((overrides[0]![1] as { gateId: string }).gateId, "GIT-BRANCH-D");
    // The comment is stripped, so what actually runs is the original command.
    assert.equal((event.input as { command: string }).command, "git branch -D feature/dead");
  });

  it("rejects a justification that just restates the command", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      bashEvent("# PI-JUSTIFY(GIT-RESET): git reset --hard HEAD~1\ngit reset --hard HEAD~1"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "GIT-RESET");
    assert.equal(rec.audit.filter(([t]) => t === "guard.override").length, 0);
  });

  it("rejects a justification shorter than the minimum", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      bashEvent("# PI-JUSTIFY(GIT-CLEAN): need it\ngit clean -fd"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "GIT-CLEAN");
  });

  it("a non-overridable gate accepts no justification at all", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      bashEvent("# PI-JUSTIFY(DB-RM-ROOT): wiping a disposable container image before rebuild\nrm -rf /"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "DB-RM-ROOT");
  });
});

describe("bash-allowlist — REQ-PRV-38", () => {
  function rules(overrides = {}) {
    const rec = recorder();
    return { rec, rules: buildRules(testPolicy(overrides), rec.services) };
  }

  it("an allowlisted command never prompts", async () => {
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({}, rec);
    const result = await runRules(r, bashEvent("git status"), ctx, rec.services);
    assert.equal(result.blocked, false);
    assert.deepEqual(rec.selected, []);
  });

  it("fails CLOSED with a named reason when there is no UI", async () => {
    const { rec, rules: r } = rules();
    const result = await runRules(
      r,
      bashEvent("some-unallowlisted-binary --help"),
      fakeCtx({ hasUI: false, mode: "json" }, rec),
      rec.services,
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /approval cannot be requested/);
    assert.match(result.reason ?? "", /some-unallowlisted-binary/);
    assert.match(result.reason ?? "", /mode=json/);
  });

  it("the documented per-invocation escalation opens it, and only then", async () => {
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({ hasUI: false, mode: "print" }, rec);
    process.env.PI_GUARD_APPROVE = "1";
    assert.equal(
      (await runRules(r, bashEvent("some-unallowlisted-binary --help"), ctx, rec.services)).blocked,
      false,
    );
    process.env.PI_GUARD_APPROVE = "0";
    assert.equal(
      (await runRules(r, bashEvent("some-unallowlisted-binary --help"), ctx, rec.services)).blocked,
      true,
    );
  });

  it("F9: PI_GUARD_HEADLESS is no longer a hard-coded second escalation", async () => {
    // Before the fix, this literal spelling bypassed `allowlist-only` regardless of what
    // `config/guard.json` names as the escalation. The only escalation now is `policy`'s.
    const { rec, rules: r } = rules();
    process.env.PI_GUARD_HEADLESS = "allow-allowlisted";
    const result = await runRules(
      r,
      bashEvent("some-unallowlisted-binary --help"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.blocked, true, "an unrecognised env var must not escalate anything");
  });

  it("F9: escalation is sourced entirely from policy — rename the var, rename the check", async () => {
    // A policy that names a DIFFERENT env var/value must be the only thing honoured.
    const { rec, rules: r } = rules({
      escalationEnv: "PI_GUARD_HEADLESS",
      escalationValue: "allow-allowlisted",
    });
    const ctx = fakeCtx({ hasUI: false }, rec);

    process.env.PI_GUARD_HEADLESS = "allow-allowlisted";
    assert.equal(
      (await runRules(r, bashEvent("some-unallowlisted-binary --help"), ctx, rec.services)).blocked,
      false,
    );

    // And the OLD default name must no longer work once policy points elsewhere.
    process.env.PI_GUARD_HEADLESS = "";
    process.env.PI_GUARD_APPROVE = "1";
    assert.equal(
      (await runRules(r, bashEvent("some-unallowlisted-binary --help"), ctx, rec.services)).blocked,
      true,
    );
  });

  it("an opaque segment is treated as suspicious, never as allowlisted", async () => {
    const { rec, rules: r } = rules();
    const result = await runRules(
      r,
      bashEvent("git log $(cat /etc/hostname)"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /<opaque>/);
  });

  it("a piped command is allowlisted only when EVERY segment is", async () => {
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({ hasUI: false }, rec);
    assert.equal((await runRules(r, bashEvent("cat a.txt | jq .x"), ctx, rec.services)).blocked, false);
    assert.equal(
      (await runRules(r, bashEvent("cat a.txt | perl -pe s/a/b/"), ctx, rec.services)).blocked,
      true,
    );
  });

  it("offers allow-once / allow-session / deny in the TUI", async () => {
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({ select: (_t, options) => options[2] }, rec);
    const result = await runRules(r, bashEvent("perl -e 'print 1'"), ctx, rec.services);
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /Denied by operator/);
    assert.deepEqual(rec.selected, [["Allow once", "Allow for this session", "Deny"]]);
  });

  it("allow-once does not remember; allow-for-session does", async () => {
    const { rec, rules: r } = rules();
    const once = fakeCtx({ select: (_t, o) => o[0] }, rec);
    await runRules(r, bashEvent("perl -e 'print 1'"), once, rec.services);
    await runRules(r, bashEvent("perl -e 'print 1'"), once, rec.services);
    assert.equal(rec.selected.length, 2);

    const session = fakeCtx({ select: (_t, o) => o[1] }, rec);
    await runRules(r, bashEvent("perl -e 'print 2'"), session, rec.services);
    await runRules(r, bashEvent("perl -e 'print 2'"), session, rec.services);
    assert.equal(rec.selected.length, 3);
  });

  it("a dismissed or timed-out dialog is a DENY", async () => {
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({ select: () => undefined }, rec);
    const result = await runRules(r, bashEvent("perl -e 'print 1'"), ctx, rec.services);
    assert.equal(result.blocked, true);
  });

  it("approvalUi=confirm falls back to the two-way dialog", async () => {
    const { rec, rules: r } = rules({ approvalUi: "confirm" });
    const ctx = fakeCtx({ confirm: () => false }, rec);
    const result = await runRules(r, bashEvent("perl -e 'print 1'"), ctx, rec.services);
    assert.equal(result.blocked, true);
    assert.equal(rec.confirmed.length, 1);
  });

  it("a degraded policy allowlists NOTHING — stricter, never looser", async () => {
    const { rec, rules: r } = rules({ degraded: true });
    const result = await runRules(
      r,
      bashEvent("git status"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.blocked, true);
  });

  it("nonInteractive=deny-all refuses bash outright without a UI", async () => {
    const { rec, rules: r } = rules({ nonInteractive: "deny-all" });
    const result = await runRules(
      r,
      bashEvent("git status"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /deny-all/);
  });

  it("the safety gates still win: a headless rm -rf / is DB-RM-ROOT, not an allowlist miss", async () => {
    const { rec, rules: r } = rules();
    const result = await runRules(
      r,
      bashEvent("rm -rf /"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.gateId, "DB-RM-ROOT");
  });
});

describe("agent-routing — REQ-CTX-47", () => {
  it("matches nothing while no veto is registered (the wave-1 state)", async () => {
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    const result = await runRules(
      r,
      customEvent("task", { agentType: "general-purpose", prompt: "research X" }),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
  });

  it("honours a registered veto and names the specialist", async () => {
    registerDispatchVeto({
      id: "DV-SPECIALIST",
      evaluate: (req) =>
        req.agentType === "general-purpose"
          ? {
              veto: true,
              denial: {
                gateId: "RTE-SPECIALIST",
                what: "dispatching general-purpose when `researcher` matches the request",
                legitimateUse: "Use `researcher` for web research.",
                overridable: true,
              },
            }
          : { veto: false },
    });
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    const result = await runRules(
      r,
      customEvent("task", { agentType: "general-purpose", prompt: "research X on the web" }),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "RTE-SPECIALIST");
    assert.match(result.reason ?? "", /researcher/);
  });

  it("the veto's own escape hatch works on the prompt argument", async () => {
    registerDispatchVeto({
      id: "DV-SPECIALIST",
      evaluate: () => ({
        veto: true,
        denial: { gateId: "RTE-SPECIALIST", what: "generic agent", overridable: true },
      }),
    });
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    const event = customEvent("task", {
      agentType: "general-purpose",
      prompt:
        "# PI-JUSTIFY(RTE-SPECIALIST): no specialist covers cross-domain triage of this incident\nTriage the incident",
    });
    const result = await runRules(r, event, fakeCtx({}, rec), rec.services);
    assert.equal(result.blocked, false);
    assert.equal(rec.audit.filter(([t]) => t === "guard.override").length, 1);
  });

  it("ignores a tool call that is not a dispatch", async () => {
    registerDispatchVeto({
      id: "DV-ALWAYS",
      evaluate: () => ({
        veto: true,
        denial: { gateId: "RTE-X", what: "everything", overridable: false },
      }),
    });
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    const result = await runRules(
      r,
      customEvent("some_other_tool", { agentType: "general-purpose" }),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
  });
});

describe("REQ-EXT-16 — our own bug must not block the world", () => {
  it("PI_GUARD_TEST_THROW=1 injects a throwing gate; a benign command still runs", async () => {
    process.env.PI_GUARD_TEST_THROW = "1";
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    assert.equal(r[0]!.id, "TEST-THROW");

    // hasUI:false pins the surfacing to the log channel (see `lib/announce.ts`) so this test
    // observes a deterministic sink; the UI-present half of the same contract is covered by
    // `test/lib/guarded-handler.test.ts`'s "surfaces the same internal error exactly once".
    const result = await runRules(
      r,
      bashEvent("echo hello"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
    assert.equal(rec.log.length, 1);
    assert.match(rec.log[0]!, /rule TEST-THROW failed internally and was skipped/);
  });

  it("the throwing gate does not disarm the ones behind it", async () => {
    process.env.PI_GUARD_TEST_THROW = "1";
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    const result = await runRules(r, bashEvent("rm -rf /"), fakeCtx({}, rec), rec.services);
    assert.equal(result.gateId, "DB-RM-ROOT");
  });

  it("a broken audit sink cannot un-block a matched rule", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      bashEvent("rm -rf /"),
      fakeCtx({}, rec),
      {
        audit: () => {
          throw new Error("audit sink is down");
        },
        log: (line) => void rec.log.push(line),
      },
    );
    assert.equal(result.gateId, "DB-RM-ROOT");
  });

  it("F2: SEC fails CLOSED on an internal error, and keeps reporting every occurrence", async () => {
    const rec = recorder();
    const r = buildRules(testPolicy(), rec.services);
    // A malformed `ctx.cwd` (not a string) makes `collectTargets`'s `path.resolve` throw — a
    // real, reachable internal error in SEC's own code path, not a synthetic injected rule.
    // Built by hand, not via `fakeCtx()`: that helper's `opts.cwd ?? TEST_CWD` would silently
    // replace an explicit `undefined` with the default cwd and defeat the whole point here.
    const brokenCtx = {
      hasUI: false,
      mode: "print",
      cwd: undefined,
      ui: { notify() {} },
    } as unknown as ReturnType<typeof fakeCtx>;

    const first = await runRules(r, bashEvent("cat foo.txt"), brokenCtx, rec.services);
    assert.equal(first.blocked, true, "SEC must refuse the call, not silently allow it");
    assert.match(first.reason ?? "", /^SEC: guard unavailable \(internal error\)/);

    const second = await runRules(r, bashEvent("cat bar.txt", "tc-2"), brokenCtx, rec.services);
    assert.equal(second.blocked, true, "the SECOND occurrence must still refuse, not go quiet");

    assert.equal(rec.log.length, 2, "each occurrence must be logged — not deduped after the first");
  });
});

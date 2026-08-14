import assert from "node:assert/strict";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  registerDispatchVeto,
  resetDispatchVetoes,
} from "../../extensions/lib/dispatch-veto.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { buildRules } from "../../extensions/guard.ts";
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

// `PI_GUARD_APPROVE`, `PI_GUARD_HEADLESS` and `PI_GUARD_SESSION_ALLOWLIST` were the allow-list
// gate's session state and escalation switches. They are unset here, and stay unset, so that
// `relaxed.test.ts`'s "nothing reads them any more" assertions cannot be satisfied by an
// environment that happens to be clean; the reset that mattered — the module-level `sessionApproved`
// Set — no longer exists because the module no longer exists.
beforeEach(() => {
  resetSurfaced();
  resetDispatchVetoes();
  delete process.env.PI_GUARD_TEST_THROW;
});

afterEach(() => {
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

  it("REGRESSION: the credential DIRECTORY is a target too, not only the files inside it", async () => {
    // `ls ~/.aws` is an allowlisted program taking a bare directory. While the directory rules were
    // anchored on a trailing slash, nothing in this gate matched it and the only thing standing in
    // the way was the allowlist — which `ls` passes. Listing a credential directory is where an
    // attempt to read one starts, and it must be refused by name here.
    for (const [command, gateId] of [
      ["ls ~/.aws", "SEC-AWS"],
      ["ls ~/.ssh", "SEC-SSH"],
      ["tar -cf backup.tar ~/.ssh", "SEC-SSH"],
    ] as const) {
      const rec = recorder();
      const result = await runRules(
        safetyRules(testPolicy(), rec.services),
        bashEvent(command),
        fakeCtx({}, rec),
        rec.services,
      );
      assert.equal(result.gateId, gateId, command);
      assert.match(result.reason ?? "", /no override/, command);
    }
  });

  it("keeps SEC-SECRETSDIR anchored on the slash — `secret` is an ordinary English word", async () => {
    // The counterpart of the rule above, and the reason it was not applied across the table: a bare
    // trailing `secret`/`secrets` argument is prose far more often than it is a path.
    const rec = recorder();
    const result = await runRules(
      safetyRules(testPolicy(), rec.services),
      bashEvent("echo keep this secret"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
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

describe("destructive-git — history destruction only (2026-08-14)", () => {
  async function check(command: string, overrides = {}) {
    const rec = recorder();
    const rules = safetyRules(testPolicy(overrides), rec.services);
    const result = await runRules(rules, bashEvent(command), fakeCtx({}, rec), rec.services);
    return { result, rec };
  }

  // ------------------------------------------------------------------------------------------
  // What still blocks.
  //
  // 2026-08-14, verified against the damaged repo: `git filter-repo --mailmap <file> --force` run
  // in a working checkout removed the `origin` remote, its `refs/remotes/*`, and truncated every
  // reflog in the shared git dir to zero bytes — `logs/HEAD`, both branch reflogs and the linked
  // worktree's own `worktrees/<name>/logs/HEAD`. Commits survived; the undo path did not. That is
  // the whole reason a `GIT` gate still exists: every other git operation on this list was
  // recoverable *by* the reflog, and this is the one that takes the reflog away.
  it("blocks a history rewrite in place — git filter-repo expires every reflog", async () => {
    const { result } = await check("git filter-repo --mailmap mailmap.txt --force");
    assert.equal(result.gateId, "GIT-REWRITE");
  });

  it("blocks git filter-branch for the same reason", async () => {
    const { result } = await check("git filter-branch --env-filter 'true' -- --all");
    assert.equal(result.gateId, "GIT-REWRITE");
  });

  it("sees a rewrite through git's global options", async () => {
    const { result } = await check("git -C /workspace/project filter-repo --force");
    assert.equal(result.gateId, "GIT-REWRITE");
  });

  it("blocks a force-push onto a protected branch — remote history has no reflog", async () => {
    for (const command of [
      "git push --force origin main",
      "git push -f origin master",
      "git push --force-with-lease origin main",
      "git push --force-if-includes origin main",
      "git push --force origin HEAD:main",
      "git push --force origin +main",
      "git push --force origin refs/heads/main",
    ]) {
      const { result } = await check(command);
      assert.equal(result.gateId, "GIT-FORCE-PROTECTED", command);
    }
  });

  it("blocks --force --all / --mirror, which sweep the protected branches in with the rest", async () => {
    for (const command of ["git push --force --all origin", "git push --mirror --force origin"]) {
      const { result } = await check(command);
      assert.equal(result.gateId, "GIT-FORCE-PROTECTED", command);
    }
  });

  it("both surviving rules offer the written-justification hatch", async () => {
    for (const command of ["git push --force origin main", "git filter-repo --force"]) {
      const { result } = await check(command);
      assert.match(result.reason ?? "", /PI-JUSTIFY/, command);
    }
  });

  // ------------------------------------------------------------------------------------------
  // What stopped blocking. Each of these had its own rule until 2026-08-14 — GIT-REMOTE,
  // GIT-RESET, GIT-BRANCH-D, GIT-CLEAN, GIT-CHECKOUT-DOT, and GIT-FORCE for non-protected
  // branches. All are recoverable, all are routine, and gating them stopped work.
  it("no longer gates ordinary destructive-looking git", async () => {
    for (const command of [
      "git push origin main",
      "git push evil main",
      "git -C /workspace/project reset --hard HEAD",
      "git reset --hard HEAD~5",
      "git branch -D feature/dead",
      "git clean -fdx",
      "git checkout -- .",
      "git restore .",
      "git rebase -i HEAD~3",
      "git push --force origin feature/implement-waves",
      "git push -f origin feature/wip:feature/wip",
    ]) {
      const { result } = await check(command);
      assert.equal(result.blocked, false, `${command} blocked by ${result.gateId}`);
    }
  });

  it("writes no audit record for ordinary git either — it is ordinary, not merely tolerated", async () => {
    const { rec } = await check("git reset --hard HEAD~5");
    assert.deepEqual(rec.audit, []);
  });

  it("a bare `git push -f` is judged by the branch on disk, not refused for being ambiguous", async () => {
    // `git push -f` with no refspec pushes the CURRENT branch. Refusing because the destination
    // is not on the command line would put the plain two-word spelling straight back on the block
    // list; allowing it unconditionally would miss the one shape the rule exists for. The gate
    // reads `HEAD`, so the verdict depends on the checkout — here, a scratch cwd that is not a
    // repo at all, which resolves to "no protected branch involved".
    const rec = recorder();
    const result = await runRules(
      safetyRules(testPolicy(), rec.services),
      bashEvent("git push -f origin"),
      fakeCtx({ cwd: "/workspace/project" }, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
  });
});

describe("the escape hatch round trip — REQ-CTX-06", () => {
  it("blocks, names the syntax, then admits the re-issued call and audits it once", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const ctx = fakeCtx({}, rec);

    const command = "git push --force origin main";

    const first = await runRules(rules, bashEvent(command), ctx, rec.services);
    assert.equal(first.gateId, "GIT-FORCE-PROTECTED");
    assert.match(first.reason ?? "", /# PI-JUSTIFY\(GIT-FORCE-PROTECTED\):/);

    const justified =
      "# PI-JUSTIFY(GIT-FORCE-PROTECTED): the remote branch was pushed from a bad rebase and " +
      "nobody else has fetched it yet\n" +
      command;
    const event = bashEvent(justified, "tc-2");
    const second = await runRules(rules, event, ctx, rec.services);

    assert.equal(second.blocked, false);
    const overrides = rec.audit.filter(([type]) => type === "guard.override");
    assert.equal(overrides.length, 1);
    assert.equal((overrides[0]![1] as { gateId: string }).gateId, "GIT-FORCE-PROTECTED");
    // The comment is stripped, so what actually runs is the original command.
    assert.equal((event.input as { command: string }).command, command);
  });

  it("rejects a justification that just restates the command", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      bashEvent("# PI-JUSTIFY(GIT-REWRITE): git filter-repo --force\ngit filter-repo --force"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "GIT-REWRITE");
    assert.equal(rec.audit.filter(([t]) => t === "guard.override").length, 0);
  });

  it("rejects a justification shorter than the minimum", async () => {
    const rec = recorder();
    const rules = safetyRules(testPolicy(), rec.services);
    const result = await runRules(
      rules,
      bashEvent("# PI-JUSTIFY(GIT-REWRITE): need it\ngit filter-repo --force"),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.gateId, "GIT-REWRITE");
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

/**
 * The former `ALW` gate — `REQ-PRV-38`, removed outright by the owner on 2026-08-14.
 *
 * These are the same scenarios the allow-list gate was tested with, inverted. They are kept rather
 * than deleted because they are the precise shapes that stopped work: an unlisted binary headless,
 * `cd sub && npm run build` in `mode=json`, a pipeline with one unlisted segment, a command
 * substitution the tokeniser cannot see into. Every one of them now runs.
 */
describe("the program allow-list is gone — REQ-PRV-38 withdrawn", () => {
  function rules(overrides = {}) {
    const rec = recorder();
    return { rec, rules: buildRules(testPolicy(overrides), rec.services) };
  }

  it("an arbitrary unlisted binary runs headless, with no prompt and no refusal", async () => {
    const { rec, rules: r } = rules();
    const result = await runRules(
      r,
      bashEvent("some-unallowlisted-binary --help"),
      fakeCtx({ hasUI: false, mode: "json" }, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
    assert.deepEqual(rec.selected, [], "no dialog may be raised — fewer approvals is the point");
    assert.deepEqual(rec.confirmed, []);
  });

  it("`cd sub && npm run build` runs — the exact shape from the 24-of-33 measurement", async () => {
    const { rec, rules: r } = rules();
    const result = await runRules(
      r,
      bashEvent("cd packages/frontend && npm run build"),
      fakeCtx({ hasUI: false, mode: "json" }, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
  });

  it("a pipeline no longer needs every segment listed", async () => {
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({ hasUI: false }, rec);
    for (const command of ["cat a.txt | jq .x", "cat a.txt | perl -pe s/a/b/"]) {
      assert.equal((await runRules(r, bashEvent(command), ctx, rec.services)).blocked, false, command);
    }
  });

  it("an opaque segment is no longer suspicious by construction", async () => {
    // `$(…)` defeats the tokeniser, and the old gate turned "cannot see it" into "refuse it".
    // What the tokeniser cannot see, the DB patterns cannot see either — that limit was always
    // there, and OS-level containment, not a regex, was always the answer to it.
    const { rec, rules: r } = rules();
    const result = await runRules(
      r,
      bashEvent("git log $(cat /etc/hostname)"),
      fakeCtx({ hasUI: false }, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
  });

  it("`cd` runs, and SEC — not the allow-list — is what catches `cd ~/.aws && cat credentials`", async () => {
    // Correcting a claim this file used to make. The old note said the ALW gate was "the only
    // thing that stops" this line, because `secret-paths.ts` resolves relative arguments against
    // `ctx.cwd` and never against a directory an earlier segment moved to. The first half is true
    // and the conclusion was not: `SEC-AWS` matches the *directory* `~/.aws` in the `cd` segment,
    // so the line is still refused with the allow-list gone. What genuinely relies on the removed
    // gate is a `cd` into a directory SEC has no pattern for — that residual is in the README.
    const { rec, rules: r } = rules();
    const ctx = fakeCtx({ hasUI: false, mode: "json" }, rec);
    assert.equal(
      (await runRules(r, bashEvent("cd ~/.aws && cat credentials"), ctx, rec.services)).gateId,
      "SEC-AWS",
    );
    assert.equal(
      (await runRules(r, bashEvent("cd frontend && cat package.json"), ctx, rec.services)).blocked,
      false,
    );
  });

  it("a degraded policy no longer refuses everything — the deny-list is in code", async () => {
    // This inverts the old "a degraded policy allowlists NOTHING" rule, which turned a missing
    // config file into a total work stoppage. Degradation now costs the two branch names in
    // `protectedBranches` and nothing else.
    const { rec, rules: r } = rules({ degraded: true });
    const ctx = fakeCtx({ hasUI: false }, rec);
    assert.equal((await runRules(r, bashEvent("git status"), ctx, rec.services)).blocked, false);
    assert.equal((await runRules(r, bashEvent("rm -rf /"), ctx, rec.services)).gateId, "DB-RM-ROOT");
  });

  it("the safety gates still win headless: rm -rf / is DB-RM-ROOT", async () => {
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

/**
 * `RTE` — audit only since 2026-08-14. `REQ-CTX-47` was always a SHOULD and a routing preference;
 * a mis-routed dispatch costs tokens and destroys nothing, so it is off the block list by the
 * owner's instruction. The gate still evaluates, because the case for `REQ-CTX-47` is a *count*
 * and `guard.observed` is now the only place that count is taken.
 */
describe("agent-routing — REQ-CTX-47, observed not enforced", () => {
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
    assert.deepEqual(rec.audit, []);
  });

  it("records a registered veto and permits the dispatch anyway", async () => {
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
    assert.equal(result.blocked, false);

    const observed = rec.audit.filter(([type]) => type === "guard.observed");
    assert.equal(observed.length, 1, "removing enforcement must not remove observability");
    const entry = observed[0]![1] as { gateId: string; what: string; agentType: string };
    assert.equal(entry.gateId, "RTE-SPECIALIST");
    assert.equal(entry.agentType, "general-purpose");
    assert.match(entry.what, /researcher/);
  });

  it("a non-overridable veto is recorded and permitted too — nothing here can refuse", async () => {
    // The consequence worth stating: this gate was the only consumer that turned a registered
    // dispatch veto into a block. A veto registered against `lib/dispatch-veto.ts` still evaluates
    // here, and it is now advisory. `overridable: false` no longer means anything on this path,
    // and `# PI-JUSTIFY(RTE-…)` is no longer read here — there is nothing to unlock.
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
      customEvent("task", { agentType: "general-purpose", prompt: "anything at all" }),
      fakeCtx({}, rec),
      rec.services,
    );
    assert.equal(result.blocked, false);
    assert.equal(rec.audit.filter(([t]) => t === "guard.observed").length, 1);
    assert.equal(rec.audit.filter(([t]) => t === "guard.override").length, 0);
  });

  it("ignores a tool call that is not a dispatch — no record either", async () => {
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
    assert.deepEqual(rec.audit, []);
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

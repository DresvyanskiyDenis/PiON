// extensions/guard/escalation.ts — the one escalation mechanism and every gate's stance on it.
//
// The bug these tests lock down: `escalated()` used to be a private helper inside
// `bash-allowlist.ts`, consulted by that gate's `deny-all` branch and NOT by its allowlist-miss
// branch. Whether a gate honoured the escalation was therefore invisible without reading that
// gate's source, and one branch of the gate that owns the mechanism silently ignored it.
//
// Three invariants are asserted here, in order of how much damage their absence does:
//   1. `SEC-*` is never escalatable. Relaxing the bash allowlist must not relax credential access.
//   2. Escalation is off unless the environment says otherwise, per invocation. There is no
//      config boolean that turns it on and leaves it on.
//   3. Every gate id `buildRules` can produce declares a stance. A gate added later that forgets
//      to fails here rather than defaulting into silence.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_ESCALATION,
  NEVER_RELAXED_PROGRAMS,
  escalationActive,
  escalationRelaxes,
  relaxationNotice,
  undeclaredGates,
} from "../../extensions/guard/escalation.ts";
import { buildRules } from "../../extensions/guard.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";
import { bashEvent, fakeCtx, readEvent, recorder, runRules, testPolicy } from "./helpers.ts";

/**
 * Runs `body` with the escalation variable set, restoring the previous value afterwards.
 *
 * `await`s the body rather than returning its promise: a synchronous `finally` would unset the
 * variable at the body's first `await`, so every rule evaluation after that point would run with
 * escalation OFF and the test would pass for the wrong reason.
 */
async function withEscalation<T>(body: () => T | Promise<T>): Promise<T> {
  const policy = testPolicy();
  const previous = process.env[policy.escalationEnv];
  process.env[policy.escalationEnv] = policy.escalationValue;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[policy.escalationEnv];
    else process.env[policy.escalationEnv] = previous;
  }
}

/** A headless context — every subagent runs like this (`mode=json`, no UI to approve anything). */
function headless() {
  return fakeCtx({ hasUI: false, mode: "json" });
}

test("escalationActive — off by default, per invocation", async (t) => {
  await t.test("unset variable -> inactive", () => {
    const policy = testPolicy();
    const previous = process.env[policy.escalationEnv];
    delete process.env[policy.escalationEnv];
    try {
      assert.equal(escalationActive(policy), false);
    } finally {
      if (previous !== undefined) process.env[policy.escalationEnv] = previous;
    }
  });

  await t.test("variable set to the configured value -> active", async () => {
    await withEscalation(() => assert.equal(escalationActive(testPolicy()), true));
  });

  await t.test("variable set to anything else -> inactive", () => {
    const policy = testPolicy();
    const previous = process.env[policy.escalationEnv];
    process.env[policy.escalationEnv] = "0";
    try {
      assert.equal(escalationActive(policy), false);
    } finally {
      if (previous === undefined) delete process.env[policy.escalationEnv];
      else process.env[policy.escalationEnv] = previous;
    }
  });

  await t.test("a policy that names no variable cannot be escalated at all", () => {
    // The dangerous reading of an empty name would be `process.env[""] === ""` — undefined
    // compared against an empty string — which is false today but only by accident. A policy that
    // disables the escalation must disable it by contract, not by coincidence.
    assert.equal(escalationActive(testPolicy({ escalationEnv: "" })), false);
    assert.equal(escalationActive(testPolicy({ escalationValue: "" })), false);
  });

  await t.test("the name and the accepted value come from the policy, never from a literal", () => {
    const policy = testPolicy({ escalationEnv: "PI_GUARD_TEST_RENAMED", escalationValue: "yes" });
    const previous = process.env[policy.escalationEnv];
    process.env[policy.escalationEnv] = "yes";
    try {
      assert.equal(escalationActive(policy), true);
      // The shipped name must NOT be consulted once the policy renames it.
      assert.equal(escalationActive(testPolicy({ escalationEnv: "PI_GUARD_TEST_RENAMED" })), false);
    } finally {
      if (previous === undefined) delete process.env[policy.escalationEnv];
      else process.env[policy.escalationEnv] = previous;
    }
  });
});

test("GATE_ESCALATION — SEC is never escalatable, and every gate declares a stance", async (t) => {
  await t.test("SEC declares `never`, and escalation does not move it", async () => {
    assert.equal(GATE_ESCALATION.SEC, "never");
    await withEscalation(() => {
      assert.equal(escalationRelaxes(testPolicy(), "SEC"), false);
    });
  });

  await t.test("ALW is the only gate that escalation relaxes", () => {
    const approval = Object.entries(GATE_ESCALATION)
      .filter(([, stance]) => stance === "approval")
      .map(([id]) => id);
    assert.deepEqual(approval, ["ALW"], "only the gate that stands in for an approval prompt may");
  });

  await t.test("every id buildRules can produce is in the table", () => {
    const rec = recorder();
    const ids = buildRules(testPolicy(), rec.services).map((r) => r.id);
    assert.deepEqual(undeclaredGates(ids), [], "add the missing gate to GATE_ESCALATION");
  });

  await t.test("an undeclared gate is treated as non-escalatable and says so", async () => {
    resetSurfaced();
    await withEscalation(() => {
      assert.equal(escalationRelaxes(testPolicy(), "NOPE"), false);
    });
  });
});

test("SEC stays enforced end to end while escalation is active", async (t) => {
  // The whole point of the narrow definition: pre-granting approval means stop asking about
  // ordinary commands, never reach into a credential store. Both halves of that are checked
  // against the real rule set.
  await t.test("a credentials path is refused with escalation ON", async () => {
    resetSurfaced();
    await withEscalation(async () => {
      const rec = recorder();
      const rules = buildRules(testPolicy(), rec.services);
      const verdict = await runRules(rules, readEvent("/home/user/.aws/credentials"), headless(), rec.services);
      assert.equal(verdict.blocked, true);
      assert.match(String(verdict.gateId), /^SEC/);
    });
  });

  await t.test("a bare credentials DIRECTORY is refused with escalation ON", async () => {
    // Anchored `(\/|$)` rather than `\/` in secret-paths.ts. Before that, `~/.aws` as an argument
    // matched nothing, and the only thing refusing it was the bash allowlist — the very gate
    // escalation relaxes. Two independent stops, so neither change alone can open the path.
    resetSurfaced();
    await withEscalation(async () => {
      const rec = recorder();
      const rules = buildRules(testPolicy(), rec.services);
      for (const dir of ["/home/user/.aws", "/home/user/.ssh"]) {
        const verdict = await runRules(rules, bashEvent(`ls ${dir}`), headless(), rec.services);
        assert.equal(verdict.blocked, true, `${dir} must stay refused`);
        assert.match(String(verdict.gateId), /^SEC/);
      }
    });
  });
});

test("NEVER_RELAXED_PROGRAMS — escalation pre-grants approval, not a directory change", async (t) => {
  await t.test("`cd` is held back even with escalation ON", async () => {
    resetSurfaced();
    await withEscalation(async () => {
      const rec = recorder();
      const rules = buildRules(testPolicy(), rec.services);
      const verdict = await runRules(
        rules,
        bashEvent("cd /home/user/.aws && cat credentials"),
        headless(),
        rec.services,
      );
      assert.equal(verdict.blocked, true, "escalation must not open the cd back door");
    });
  });

  await t.test("an ordinary non-allowlisted program IS allowed with escalation ON", async () => {
    // Without this the previous assertion could pass for the wrong reason — escalation doing
    // nothing at all would also keep `cd` blocked.
    resetSurfaced();
    await withEscalation(async () => {
      const rec = recorder();
      const rules = buildRules(testPolicy(), rec.services);
      const verdict = await runRules(rules, bashEvent("someunknowntool --version"), headless(), rec.services);
      assert.equal(verdict.blocked, false, "escalation must actually pre-grant the approval");
    });
  });

  await t.test("the same program is refused with escalation OFF", async () => {
    resetSurfaced();
    const rec = recorder();
    const policy = testPolicy();
    const previous = process.env[policy.escalationEnv];
    delete process.env[policy.escalationEnv];
    try {
      const rules = buildRules(policy, rec.services);
      const verdict = await runRules(rules, bashEvent("someunknowntool --version"), headless(), rec.services);
      assert.equal(verdict.blocked, true);
    } finally {
      if (previous !== undefined) process.env[policy.escalationEnv] = previous;
    }
  });
});

test("relaxationNotice — names what is relaxed AND what still holds", async (t) => {
  const policy = testPolicy();

  await t.test("the escalation variant names the cause and how to undo it", () => {
    const line = relaxationNotice(policy, "escalation");
    assert.match(line, new RegExp(policy.escalationEnv));
    assert.match(line, /RELAXED/);
    assert.match(line, /STILL ENFORCED/);
    assert.match(line, /SEC-\*/, "an operator must be told credential paths are still walled off");
    for (const held of NEVER_RELAXED_PROGRAMS) assert.match(line, new RegExp(held));
  });

  await t.test("the policy variant points at the config, not at the variable", () => {
    const line = relaxationNotice(policy, "policy");
    assert.match(line, /nonInteractive/);
    assert.match(line, /STILL ENFORCED/);
  });
});

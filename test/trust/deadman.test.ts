/**
 * `EXT-30` — the guardrail deadman (`REQ-PRV-86`, `REQ-EXT-16` load half).
 *
 * The deadman exists because a guardrail that failed to load is a fail-OPEN, and a silent
 * fail-open is the worst outcome in this design. The verdict is a pure function of `EXT-01`'s
 * registry, so it is asserted here without a live `pi`; `register.test.ts` covers the wiring.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEADMAN_BLOCKED_TOOLS,
  GUARDRAIL_MODULES,
  deadmanToolBlock,
  evaluateDeadman,
} from "../../extensions/trust.ts";
import {
  DECLARED_MODULES,
  manifestReport,
  recordLoad,
  recordLoadFailure,
  resetManifest,
} from "../../extensions/lib/manifest.ts";
import { toolEvent } from "./helpers.ts";

afterEach(resetManifest);

/** Every declared module loads except the ones named. */
function loadAllExcept(...skip: string[]): void {
  resetManifest();
  for (const id of DECLARED_MODULES) {
    if (!skip.includes(id)) recordLoad(id);
  }
}

describe("GUARDRAIL_MODULES", () => {
  it("does not include `trust` — a module may not assert its own presence", () => {
    assert.ok(
      !GUARDRAIL_MODULES.includes("trust"),
      "listing trust would make the check pass by construction",
    );
  });

  it("names only declared modules, so a typo cannot arm the deadman forever", () => {
    for (const id of GUARDRAIL_MODULES) {
      assert.ok(
        (DECLARED_MODULES as readonly string[]).includes(id),
        `${id} must appear in DECLARED_MODULES`,
      );
    }
  });

  it("covers guard — the module whose absence is a loss of containment", () => {
    assert.ok(GUARDRAIL_MODULES.includes("guard"));
  });

  it("covers hooks — the only other module that can deny a call over surviving tools", () => {
    // EXT-30 hand-off T2. `hooks` runs `guardedHandler` with `onInternalError: "closed"`, i.e. its
    // author decided "hooks did not evaluate" must not let a call through. A load failure is the
    // strongest form of "did not evaluate", so it must not be the one case that fails open.
    assert.ok(GUARDRAIL_MODULES.includes("hooks"));
  });

  it("stays narrow — capability modules are not guardrails", () => {
    // The admission rule is "its absence removes a denial", not "it is security-adjacent".
    for (const notAGuardrail of ["bash", "dispatch", "credentials", "web", "skill-mask", "doctor"]) {
      assert.ok(
        !GUARDRAIL_MODULES.includes(notAGuardrail),
        `${notAGuardrail} must not arm the deadman — losing it removes capability, not containment`,
      );
    }
  });
});

describe("evaluateDeadman", () => {
  it("stays disarmed when every guardrail loaded", () => {
    loadAllExcept();
    const verdict = evaluateDeadman(manifestReport());
    assert.equal(verdict.armed, false);
    assert.deepEqual(verdict.findings, []);
    assert.match(verdict.summary, /guardrails present/);
  });

  it("arms when hooks is absent — a declared hooks.yaml denial silently ceasing to apply", () => {
    loadAllExcept("hooks");
    const verdict = evaluateDeadman(manifestReport());
    assert.equal(verdict.armed, true);
    assert.deepEqual(
      verdict.findings.map((f) => f.id),
      ["hooks"],
    );
    assert.match(verdict.summary, /GUARDRAILS NOT LOADED/);
  });

  it("names every missing guardrail, not just the first", () => {
    loadAllExcept("guard", "hooks");
    const verdict = evaluateDeadman(manifestReport());
    assert.deepEqual(
      verdict.findings.map((f) => f.id),
      ["guard", "hooks"],
    );
  });

  it("arms when guard is absent, and names it", () => {
    loadAllExcept("guard");
    const verdict = evaluateDeadman(manifestReport());
    assert.equal(verdict.armed, true);
    assert.equal(verdict.findings.length, 1);
    assert.equal(verdict.findings[0]!.id, "guard");
    assert.equal(verdict.findings[0]!.state, "absent");
    assert.match(verdict.summary, /GUARDRAILS NOT LOADED/);
    assert.match(verdict.summary, /Run \/doctor/);
  });

  it("arms when guard failed, and carries the error text through", () => {
    loadAllExcept("guard");
    recordLoadFailure("guard", new TypeError("cannot read x of undefined"));
    const verdict = evaluateDeadman(manifestReport());
    assert.equal(verdict.armed, true);
    assert.equal(verdict.findings[0]!.state, "failed");
    assert.match(verdict.findings[0]!.detail, /TypeError: cannot read x of undefined/);
    assert.deepEqual(verdict.failed, ["guard"]);
  });

  it("reports the full expected-but-absent set even when disarmed", () => {
    loadAllExcept("web", "digest");
    const verdict = evaluateDeadman(manifestReport());
    assert.equal(verdict.armed, false, "a non-guardrail absence must not block tools");
    assert.deepEqual([...verdict.absent].sort(), ["digest", "web"]);
  });

  it("does not arm on a module that merely never sent a heartbeat", () => {
    // `guard.ts` registers no session_start handler at all, so it is permanently "silent".
    // Gating on silence would arm the deadman on every single session.
    loadAllExcept();
    const report = manifestReport();
    assert.ok(report.silent.includes("guard"), "guard is expected to be silent by construction");
    assert.equal(evaluateDeadman(report).armed, false);
  });

  it("accepts an explicit guardrail list, so the rule is testable without editing the module", () => {
    loadAllExcept("web");
    assert.equal(evaluateDeadman(manifestReport(), ["web"]).armed, true);
    assert.equal(evaluateDeadman(manifestReport(), []).armed, false);
  });
});

describe("deadmanToolBlock", () => {
  it("blocks every dangerous tool with a reason that names the cause", () => {
    for (const tool of DEADMAN_BLOCKED_TOOLS) {
      const result = deadmanToolBlock(toolEvent(tool), ["guard"]);
      assert.equal(result?.block, true, tool);
      assert.match(result?.reason ?? "", /guard extension is not loaded/, tool);
      assert.match(result?.reason ?? "", /deadman/, tool);
    }
  });

  it("names the guardrails that actually failed, not the whole list", () => {
    // "a guardrail is missing" is not actionable: the model and the operator both read this string.
    const one = deadmanToolBlock(toolEvent("bash"), ["hooks"])?.reason ?? "";
    assert.match(one, /the hooks extension is not loaded/);
    assert.doesNotMatch(one, /guard\//);

    const both = deadmanToolBlock(toolEvent("bash"), ["guard", "hooks"])?.reason ?? "";
    assert.match(both, /the guard\/hooks extensions are not loaded/);
  });

  it("falls back to the full guardrail list rather than an empty accusation", () => {
    const reason = deadmanToolBlock(toolEvent("bash"), [])?.reason ?? "";
    for (const moduleId of GUARDRAIL_MODULES) assert.match(reason, new RegExp(moduleId));
  });

  it("blocks wave1-specs.md §7.2's four mutating tools plus the two content-reading ones", () => {
    assert.deepEqual(
      [...DEADMAN_BLOCKED_TOOLS],
      ["bash", "write", "edit", "multiedit", "read", "grep"],
    );
  });

  it("blocks read and grep: without guard there is no secret-paths gate, and both return file CONTENT", () => {
    // The regression this pins: guard/gates/secret-paths.ts is what stops a read of
    // ~/.aws/credentials, ~/.ssh/id_ed25519, ~/.pi/agent/auth.json and ~/.cache/pi/dbx-token-*.
    // It disappears with `guard`, so an armed deadman that permits `read` leaves the quiet path to
    // every credential wide open while blocking the loud one. PI's `grep` returns MATCHING LINES
    // (core/tools/grep.js), so it is a read by another name.
    for (const tool of ["read", "grep"]) {
      assert.equal(deadmanToolBlock(toolEvent(tool), ["guard"])?.block, true, tool);
    }
  });

  it("lets path-only tools through — the deadman contains, it does not brick the session", () => {
    // PI's glob tool is `find` (core/tools/find.js) and it returns paths, never file contents;
    // `ls` likewise. Metadata is not the loss of a denial over content, so neither is blocked.
    for (const tool of ["find", "ls", "todo_write"]) {
      assert.equal(deadmanToolBlock(toolEvent(tool)), undefined, tool);
    }
  });
});

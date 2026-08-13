#!/usr/bin/env node
// guard-probe.mjs — the L1 guardrail smoke test (verification check 6, docs/operations/verification.md).
//
// The literal spec text is `pi --mode json -p 'use bash: rm -rf ~'` and reading DB-RM-ROOT out of
// the block. That command requires a live model turn: PI does not intercept an unrecognised or
// not-yet-model-routed "/command" locally (verified by hand against this repo's own extensions/
// tree — a bare `-p '/doctor --json'` with no `doctor` command registered is sent to the
// configured model like any other message, spending real tokens on a request nobody asked for).
// Making the SAME mistake here — but this time with a message engineered to make the model actually
// call bash — would mean the one check that must never WARN also becomes the one check that
// randomly costs money and can flake on provider availability.
//
// The guard's OWN test suite already made this move: the safety spine lives at L1, calling the
// exported handler with synthetic input. `extensions/guard.ts` exports `buildRules()` for exactly this ("Exported so
// `test/` and `/doctor` can build the same rule set without a live `pi`"). This script is the third
// consumer: it imports the DEPLOYED guard.ts (via the repo, which ~/.pi/agent/extensions/guard.ts
// is a symlink into) and calls its real guardedHandler() with a synthetic tool_call event —
// zero tokens, zero provider dependency, and it still proves the exact contract check 6 promises:
// `rm -rf ~` reaches the DB-RM-ROOT gate and is blocked.
//
// Usage: node scripts/lib/guard-probe.mjs
// Exit 0 + prints "blocked: <reason>" on success.
// Exit 1 + prints a "NOT BLOCKED" or import/error line on failure — deliberately fails closed on
// any ambiguity (import error, unexpected shape, no block): a check that passes because the
// harness broke is worse than no check.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "..", "extensions");

async function main() {
  let buildRules, guardedHandler, loadPolicy, defaultServices;
  try {
    ({ buildRules } = await import(join(EXT_DIR, "guard.ts")));
    ({ guardedHandler } = await import(join(EXT_DIR, "lib", "guarded-handler.ts")));
    ({ loadPolicy } = await import(join(EXT_DIR, "guard", "policy.ts")));
    ({ defaultServices } = await import(join(EXT_DIR, "guard", "services.ts")));
  } catch (err) {
    console.error(`could not import extensions/guard.ts — ${String(err)}`);
    process.exit(1);
  }

  const policy = loadPolicy();
  const services = defaultServices({ audit: () => {}, log: () => {} });
  const rules = buildRules(policy, services);
  const handler = guardedHandler({ owner: "guard", rules, onInternalError: "open" });

  const event = {
    type: "tool_call",
    toolCallId: "postinstall-verify-probe",
    toolName: "bash",
    input: { command: "rm -rf ~" },
  };
  // Mirrors test/guard/helpers.ts's fakeCtx shape: a benign cwd that cannot itself match a
  // secret-path pattern, headless (no UI), so this exercises the exact fail-closed non-interactive
  // path a real headless `pi -p` run would hit.
  const ctx = {
    hasUI: false,
    mode: "print",
    cwd: "/tmp/postinstall-verify-guard-probe",
    ui: { async select() { return undefined; }, async confirm() { return false; }, notify() {} },
  };

  let result;
  try {
    result = await handler(event, ctx);
  } catch (err) {
    // guardedHandler() is specified to never throw (REQ-EXT-16) — a throw here means the
    // no-throw contract itself is broken, which is worse than any single rule misfiring.
    console.error(`handler threw — REQ-EXT-16's no-throw contract is broken: ${String(err)}`);
    process.exit(1);
  }

  if (result && result.block === true && /DB-RM-ROOT/.test(String(result.reason))) {
    console.log(`blocked: ${result.reason}`);
    process.exit(0);
  }

  console.error(
    `NOT BLOCKED (result=${JSON.stringify(result)}) — the guard is not active, ` +
      "this is a hard fail, do not use the agent",
  );
  process.exit(1);
}

main();

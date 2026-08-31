// The `subagent_wait` attention default, written onto the call.
//
// What these tests are actually protecting: a blocking wait must stop for the things that END a
// run or ASK the lead something, and must not stop for the two heartbeats pi-subagents also files
// under `needs_attention`. The stopping half is not ours — `isDone()` reads
// `stopOnAttention || hasSupervisorTool(run)` and computes terminal states in a separate branch
// (`runs/background/subagent-wait.ts:566`) — so it is pinned as package source at the bottom of
// this file rather than mocked. Mocking it would let a version that dropped `hasSupervisorTool`
// pass here while silently making a supervisor request unwakeable in production.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyWaitStopOnAttention, WAIT_DEFAULT_NOTICE } from "../../extensions/dispatch/wait-attention.ts";
import { DEFAULT_DISPATCH_CONFIG, type DispatchConfig } from "../../extensions/dispatch/config.ts";

const CFG: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG };
const UPSTREAM_DEFAULT: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, waitStopOnAttention: true };

describe("applyWaitStopOnAttention", () => {
  it("defaults a bare blocking wait to false", () => {
    const input: Record<string, unknown> = {};
    const outcome = applyWaitStopOnAttention(input, CFG);
    assert.equal(outcome?.changed, true);
    assert.equal(input.stopOnAttention, false);
  });

  it("defaults a { all: true } wait too — waiting for every child is still a blocking wait", () => {
    const input: Record<string, unknown> = { all: true, timeoutMs: 600_000 };
    assert.equal(applyWaitStopOnAttention(input, CFG)?.changed, true);
    assert.deepEqual(input, { all: true, timeoutMs: 600_000, stopOnAttention: false });
  });

  it("defaults a single-run wait by id", () => {
    const input: Record<string, unknown> = { id: "019ffb91" };
    assert.equal(applyWaitStopOnAttention(input, CFG)?.changed, true);
    assert.equal(input.stopOnAttention, false);
  });

  it("never overrides an explicit parameter, in either direction", () => {
    for (const asked of [true, false]) {
      const input: Record<string, unknown> = { stopOnAttention: asked };
      const outcome = applyWaitStopOnAttention(input, CFG);
      assert.equal(outcome?.changed, false, `stopOnAttention: ${asked} was rewritten`);
      assert.match(outcome!.reason, /left as written/);
      assert.equal(input.stopOnAttention, asked);
    }
  });

  it("leaves a non-blocking subscription alone", () => {
    // `{ id, nonBlocking: true }` returns from the subscription branch before the flag is read,
    // so writing it would be an argument that means nothing. Asserted against the package below.
    const input: Record<string, unknown> = { id: "019ffb91", nonBlocking: true };
    assert.equal(applyWaitStopOnAttention(input, CFG), undefined);
    assert.deepEqual(input, { id: "019ffb91", nonBlocking: true });
  });

  it("writes nothing when the config asks for the package default back", () => {
    const input: Record<string, unknown> = {};
    assert.equal(applyWaitStopOnAttention(input, UPSTREAM_DEFAULT), undefined);
    assert.deepEqual(input, {}, "`true` must be expressed as an absent argument, not a written one");
  });

  it("discloses the semantics in terms the lead can act on", () => {
    // The notice is the only place the model is told the default differs from the tool description
    // it reads, so it has to name both halves: what stops being a wake, and what still is one.
    assert.match(WAIT_DEFAULT_NOTICE, /stopOnAttention to false/);
    assert.match(WAIT_DEFAULT_NOTICE, /completion, failure, pause, timeout/);
    assert.match(WAIT_DEFAULT_NOTICE, /supervisor\/contact request/);
    assert.match(WAIT_DEFAULT_NOTICE, /stopOnAttention: true/, "the escape hatch is not named");
  });
});

const PKG = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../node_modules/pi-subagents/src/${relative}`, import.meta.url)), "utf8");

describe("what the default is worth, read out of pi-subagents 0.57.0", () => {
  // Textual, for the reason `test/dispatch/ceiling.test.ts` and
  // `test/dispatch/watchdog-settings.test.ts` give: `node --test` refuses to type-strip `.ts` under
  // `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and PI loads the package through
  // jiti where it works.
  const WAIT = PKG("runs/background/subagent-wait.ts");

  it("still resolves an omitted parameter to true, which is the whole reason this module exists", () => {
    assert.match(
      WAIT,
      /const stopOnAttention = params\.stopOnAttention \?\? deps\.stopOnAttention !== false;/,
      "subagent-wait.ts changed how the default resolves; re-read it before trusting DSP-WAIT",
    );
  });

  it("still stops a wait on a supervisor request regardless of the flag", () => {
    assert.match(
      WAIT,
      /attention\.some\(\(run\) => initialAsyncIds\.has\(run\.id\) && \(stopOnAttention \|\| hasSupervisorTool\(run\)\)\)/,
      "the supervisor escape from a stopOnAttention:false wait is gone; the default is no longer safe",
    );
    assert.match(
      WAIT,
      /run\.currentTool === "contact_supervisor"/,
      "hasSupervisorTool no longer recognises a contact_supervisor request",
    );
  });

  it("still computes terminal states in a branch the flag does not reach", () => {
    // complete/failed/paused end a run, which removes it from `active`; the flag only ever gates
    // the `attention` clause above this one.
    assert.match(WAIT, /const activeAsyncIds = new Set\(active\.map\(\(run\) => run\.id\)\);/);
    assert.match(WAIT, /\[\.\.\.initialProviderIds\]\.every\(\(id\) => !activeProviderIds\.has\(id\)\)/);
  });

  it("still returns from the nonBlocking branch before the flag is read", () => {
    const subscription = WAIT.indexOf("Armed wait subscription");
    const resolution = WAIT.indexOf("const stopOnAttention = params.stopOnAttention");
    assert.ok(subscription > 0 && resolution > subscription, "nonBlocking no longer short-circuits the flag");
  });

  it("still has no config key to set instead", () => {
    // The day this fails, DSP-WAIT and config/dispatch.json's waitStopOnAttention can be replaced
    // by one key in config/subagent.json. See docs/configuration/settings.md.
    assert.match(
      PKG("runs/background/wait-config.ts"),
      /export interface ResolvedWaitToolConfig \{\s*enabled: boolean;\s*\}/,
      "config.waitTool grew fields; check whether stopOnAttention is now one of them",
    );
  });

  it("still files both heartbeats under the same needs_attention state the flag gates", () => {
    // The two producers that are NOT a question. If either stops resolving to `needs_attention`,
    // the cost this default was lowered to avoid has moved and the argument needs re-reading.
    const CONTROL = PKG("runs/shared/subagent-control.ts");
    assert.match(CONTROL, /needsAttentionAfterMs: 60_000,/, "the idle threshold moved");
    assert.match(CONTROL, /activeNoticeAfterMs: 240_000,/, "the open-tool threshold moved");
    assert.match(
      CONTROL,
      /ageMs > scaledNeedsAttentionAfterMs\(input\.config, input\.thinking\) \? "needs_attention" : undefined/,
      "deriveActivityState no longer turns idleness into needs_attention",
    );
  });
});

/**
 * `extensions/lib/announce.ts` — the one emitter every module announces through.
 *
 * This file exists because the helper had none. ~20 call sites were migrated onto it and the
 * migration was verified only indirectly, by adjusting each caller's test fake until it observed
 * the channel the new routing had moved the message to. That proves the fakes agree with the
 * implementation; it does not pin the invariant the refactor exists to guarantee.
 *
 * The invariant is exactly one channel per notice — never both (the duplicate startup output that
 * prompted the refactor), never neither (a silent announcement in `-p` / `--mode json`, where
 * `ctx.ui.notify` is a no-op). Every test below asserts on BOTH channels, so a regression that
 * re-adds the second write fails here rather than showing up as doubled lines in a terminal.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { emitNotice, type NoticeLevel, type NoticeTarget } from "../../extensions/lib/announce.ts";

interface Recorder {
  readonly notified: Array<{ message: string; level: NoticeLevel | undefined }>;
  readonly logged: string[];
  readonly ctx: NoticeTarget;
}

function makeTarget(hasUI: boolean, notifyImpl?: () => never): Recorder {
  const notified: Array<{ message: string; level: NoticeLevel | undefined }> = [];
  const logged: string[] = [];
  return {
    notified,
    logged,
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level?: NoticeLevel) {
          notified.push({ message, level });
          if (notifyImpl) notifyImpl();
        },
      },
    },
  };
}

describe("emitNotice — one notice, one channel", () => {
  it("with a UI: notifies and does NOT also write to the log sink", () => {
    const r = makeTarget(true);
    emitNotice(r.ctx, "[pi-config] hooks: 3 rule(s) loaded", "info", (l) => r.logged.push(l));

    assert.deepEqual(
      r.notified.map((n) => n.message),
      ["[pi-config] hooks: 3 rule(s) loaded"],
    );
    // The whole point: the old "both channels, always" code put the line here too.
    assert.deepEqual(r.logged, []);
  });

  it("without a UI: writes to the log sink and does NOT call notify", () => {
    const r = makeTarget(false);
    emitNotice(r.ctx, "[pi-config] path-defaults: root *", "info", (l) => r.logged.push(l));

    assert.deepEqual(r.logged, ["[pi-config] path-defaults: root *"]);
    // `ctx.ui.notify` is a no-op in `-p` / `--mode json`; calling it there would be a silent notice.
    assert.deepEqual(r.notified, []);
  });

  it("passes the level through, defaulting to warning", () => {
    const explicit = makeTarget(true);
    emitNotice(explicit.ctx, "line", "error", () => {});
    assert.equal(explicit.notified[0]?.level, "error");

    const implied = makeTarget(true);
    emitNotice(implied.ctx, "line", undefined, () => {});
    assert.equal(implied.notified[0]?.level, "warning");
  });

  it("treats a missing ctx and an absent hasUI as 'no UI' rather than as a UI", () => {
    // `hasUI !== true` is the test in the implementation, not `hasUI === false`. A fake or a
    // caller context that simply omits the field must not be read as an interactive session,
    // because that would route the notice to a notify that silently drops it.
    const logged: string[] = [];
    emitNotice(undefined, "no ctx at all", "info", (l) => logged.push(l));

    const partial = { ui: { notify: () => assert.fail("notify must not be called") } };
    emitNotice(partial as unknown as NoticeTarget, "hasUI absent", "info", (l) => logged.push(l));

    assert.deepEqual(logged, ["no ctx at all", "hasUI absent"]);
  });

  it("rescues a throwing notify onto the log sink, exactly once, naming the failure", () => {
    const r = makeTarget(true, () => {
      throw new Error("TUI already torn down");
    });
    emitNotice(r.ctx, "[pi-config] compaction: threshold", "warning", (l) => r.logged.push(l));

    // The one case where a single call touches both channels — a rescue, not a duplicate: the
    // notify attempt failed, so the log line is the only copy the user gets.
    assert.equal(r.notified.length, 1);
    assert.equal(r.logged.length, 1);
    assert.match(r.logged[0]!, /^\[pi-config\] compaction: threshold \(ui\.notify failed: /);
    assert.match(r.logged[0]!, /TUI already torn down/);
  });

  it("never throws, even when every channel it has is broken", () => {
    // A closed TUI plus a dead stderr. Losing the notice beats crashing the host process.
    const broken = makeTarget(true, () => {
      throw new Error("notify is gone");
    });
    assert.doesNotThrow(() =>
      emitNotice(broken.ctx, "line", "error", () => {
        throw new Error("stderr is gone");
      }),
    );

    const headless = makeTarget(false);
    assert.doesNotThrow(() =>
      emitNotice(headless.ctx, "line", "error", () => {
        throw new Error("stderr is gone");
      }),
    );
  });

  it("defaults to stderr when no sink is injected, and still writes only once", () => {
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      emitNotice(makeTarget(false).ctx, "[pi-config] default sink");
    } finally {
      process.stderr.write = original;
    }

    assert.deepEqual(captured, ["[pi-config] default sink\n"]);
  });
});

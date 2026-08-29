// extensions/guard/denial-card.ts — the three questions a denial has to answer on sight, from
// the two shapes of `guard.block` entry it actually receives: one `denyWithEscapeHatch` built,
// and one it did not. The parser under it lives in `lib/escape-hatch.ts` beside the builder, so
// a wording change in the reason string breaks that file's tests first, not this one's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import {
  BLOCK_ENTRY,
  formatDenialCard,
  registerDenialRenderer,
  type GuardBlockEntry,
} from "../../extensions/guard/denial-card.ts";
import { denyWithEscapeHatch, parseEscapeHatchDenial } from "../../extensions/lib/escape-hatch.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

/** `ruleId` is the gate FAMILY `guardedHandler` audits, e.g. `"GIT"` — see `writeAudit` in
 *  `lib/guarded-handler.ts`. The specific pattern id lives only in `reason`. */
function entry(over: Partial<GuardBlockEntry> = {}): GuardBlockEntry {
  return {
    ruleId: "GIT",
    toolName: "bash",
    toolCallId: "tc-1",
    reason: denyWithEscapeHatch({
      gateId: "GIT-FORCE-PROTECTED",
      what: "force-push onto a protected branch",
      overridable: true,
    }).reason,
    at: 1_700_000_000_000,
    ...over,
  };
}

describe("guard denial card", () => {
  it("leads with the specific gate id from the reason, not the family in ruleId", () => {
    const head = formatDenialCard(entry(), theme, false).split("\n")[0]!;
    assert.match(head, /GIT-FORCE-PROTECTED/);
    assert.match(head, /bash/);
  });

  it("names what matched on its own row", () => {
    const out = formatDenialCard(entry(), theme, false);
    assert.match(out, /matched: <\/muted><warning>force-push onto a protected branch<\/warning>/);
  });

  it("pre-fills the re-issue line with the gate id spelled correctly", () => {
    const out = formatDenialCard(entry(), theme, false);
    assert.match(out, /# PI-JUSTIFY\(GIT-FORCE-PROTECTED\): <one sentence/);
  });

  it("says plainly that a hard gate has no way out, and offers no template", () => {
    const hard = entry({
      ruleId: "DB",
      reason: denyWithEscapeHatch({
        gateId: "DB-RM-ROOT",
        what: "rm -rf on the filesystem root",
        overridable: false,
      }).reason,
    });
    const out = formatDenialCard(hard, theme, false);
    assert.match(out, /DB-RM-ROOT/);
    assert.match(out, /no override on this gate/);
    assert.ok(!out.includes("PI-JUSTIFY"), "a hard gate must not advertise a hatch it does not have");
  });

  it("falls back to the raw reason for a denial this parser did not build", () => {
    const foreign = entry({ ruleId: "SEC", reason: "SEC: guard unavailable (internal error) — refusing" });
    const out = formatDenialCard(foreign, theme, false);
    assert.match(out, /SEC/);
    assert.match(out, /guard unavailable/);
    assert.ok(!out.includes("matched:"), "no invented structure for prose we did not write");
    assert.equal(parseEscapeHatchDenial(foreign.reason), null);
  });

  it("expanded, shows the reason exactly as the model received it", () => {
    const e = entry();
    const out = formatDenialCard(e, theme, true);
    assert.ok(out.includes(e.reason), "the expanded view must carry the model's own text");
  });

  it("registers a renderer for guard.block that renders the gate and the hatch", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
    } as unknown as ExtensionAPI;

    registerDenialRenderer(pi);
    const renderer = renderers.get(BLOCK_ENTRY);
    assert.ok(renderer, `no renderer registered for ${BLOCK_ENTRY}`);

    const component = renderer({ data: entry() }, { expanded: false }, theme) as
      | { render(width: number): string[] }
      | undefined;
    assert.ok(component, "renderer returned nothing for a well-formed entry");
    const painted = component.render(160).join("\n");
    assert.match(painted, /GIT-FORCE-PROTECTED/);
    assert.match(painted, /PI-JUSTIFY/);
  });

  it("renders nothing, rather than throwing, for an entry that is not a denial", () => {
    const renderers = new Map<string, (e: unknown, o: unknown, t: Theme) => unknown>();
    const pi = {
      registerEntryRenderer(customType: string, renderer: (e: unknown, o: unknown, t: Theme) => unknown) {
        renderers.set(customType, renderer);
      },
    } as unknown as ExtensionAPI;

    registerDenialRenderer(pi);
    assert.equal(renderers.get(BLOCK_ENTRY)!({ data: { ruleId: "DB" } }, { expanded: false }, theme), undefined);
  });
});

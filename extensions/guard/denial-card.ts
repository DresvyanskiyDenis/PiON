/**
 * A denial you read at a glance, over the one you have to parse.
 *
 * `guardedHandler` (`lib/guarded-handler.ts`) already writes one `guard.block` audit entry for
 * every blocked call, but nothing in this tree renders it: until now the only visible trace of a
 * denial in the transcript was the `reason` string handed to the model, one paragraph carrying
 * the gate id, what it matched, and the re-issue protocol together, because `tool_call` can
 * return nothing but `{ block, reason }` (see `lib/escape-hatch.ts`). That paragraph is written
 * for a model to act on, not for a person scanning a scrollback to see why the agent's next move
 * changed.
 *
 * This renders the `guard.block` entry that already exists into three lines answering the three
 * questions a denial raises: which gate fired, what did it match, and what do you type to get
 * past it, if anything. No new audit entry is written and no new call site appears on the
 * `tool_call` path this repo keeps deliberately boring — the card is read-only presentation over
 * data `guardedHandler` was already producing, so a session recorded before this file existed
 * renders exactly the same as one recorded after it.
 *
 * The pre-filled re-issue line is the point of the third row: `PI-JUSTIFY(<gate>)` with the gate
 * id spelled correctly is the difference between an override that works and one `extractJustification`
 * silently rejects, and the gate id is the part people mistype. A gate with `overridable: false`
 * says plainly that there is no way past it instead of dangling a template that would not work
 * (see `denyWithEscapeHatch`'s hard-gate branch) — advertising a hatch a gate does not have is
 * worse than a card that admits it has none.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { justificationTemplate, parseEscapeHatchDenial } from "../lib/escape-hatch.ts";
import { keyHintOr, safeEntryRenderer } from "../lib/render.ts";

/** The custom-entry type `guardedHandler` writes as `${owner}.block`; `guard.ts` sets `owner: "guard"`. */
export const BLOCK_ENTRY = "guard.block";

/** `guard.block`'s payload, exactly as `writeAudit` in `lib/guarded-handler.ts` builds it. */
export interface GuardBlockEntry {
  /** The gate FAMILY that matched (e.g. `"GIT"`), not the specific pattern id — that lives only
   *  in `reason`, which is why the card parses `reason` rather than trusting this field alone. */
  readonly ruleId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly reason: string;
  readonly at: number;
}

/**
 * Builds the card as one already-themed multi-line string.
 *
 * Collapsed, it is the verdict and the way past it, if there is one. Expanded, it also shows the
 * `reason` exactly as the model received it — the thing to check when the question is "why did
 * the model try something else next", since that raw paragraph is what actually steered it.
 */
export function formatDenialCard(data: GuardBlockEntry, theme: Theme, expanded: boolean): string {
  const parsed = parseEscapeHatchDenial(data.reason);
  const gateId = parsed?.gateId ?? data.ruleId;

  const rows = [
    theme.fg("error", theme.bold(`blocked by ${gateId}`)) +
      theme.fg("muted", " · tool ") +
      theme.fg("toolTitle", data.toolName),
  ];

  if (parsed) {
    rows.push(theme.fg("muted", "  matched: ") + theme.fg("warning", parsed.what));
    rows.push(
      parsed.overridable
        ? theme.fg("muted", "  re-issue the same call with: ") +
            "\n  " +
            theme.fg("accent", justificationTemplate(gateId))
        : theme.fg("dim", "  no override on this gate. Change the approach, do not retry."),
    );
  } else {
    // A denial this card's parser did not build — some future gate with its own wording, or a
    // rule that fails closed outside `denyWithEscapeHatch` entirely (see `writeAudit`'s
    // internal-error branch in `lib/guarded-handler.ts`). Showing the raw prose beats inventing
    // a "matched" row for structure that was never there.
    rows.push(theme.fg("dim", `  ${data.reason}`));
  }

  if (expanded && parsed) {
    rows.push(theme.fg("dim", `  as the model received it: ${data.reason}`));
  } else if (!expanded && parsed) {
    rows.push(`  ${keyHintOr("app.tools.expand", "for the full reason", theme, "expand for the full reason")}`);
  }

  return rows.join("\n");
}

/**
 * Registers the card for `guard.block`. Called from `guard.ts`, kept in its own function so the
 * formatting above stays testable without an `ExtensionAPI`.
 */
export function registerDenialRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<GuardBlockEntry>(
    BLOCK_ENTRY,
    safeEntryRenderer("guard", (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data || typeof data.reason !== "string") return undefined;
      const box = new Box(1, 0, (text) => theme.bg("toolErrorBg", text));
      box.addChild(new Text(formatDenialCard(data, theme, expanded), 0, 0));
      return box;
    }),
  );
}

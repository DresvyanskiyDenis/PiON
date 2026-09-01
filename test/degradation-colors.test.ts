/**
 * degradation-colors: reserve amber/red exclusively for degradation states.
 *
 * Verifies that a classified provider failure block is colored red (error) and a retry amber
 * (warning), end to end against the real `formatProviderFailure()` output — not a hand-built
 * fixture with its own idea of what the block contains — so a field this test checks for is a
 * field the shipped renderer actually receives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatProviderFailure, type ProviderFailure } from "../extensions/lib/provider-error.ts";
import { formatProviderState } from "../extensions/degradation-colors.ts";

/** Mock Theme that records the colors used. */
class MockTheme implements Partial<Theme> {
  colors: Array<{ color: string; text: string }> = [];

  fg(color: string, text: string): string {
    this.colors.push({ color, text });
    return `[${color}]${text}[/${color}]`;
  }

  bold(text: string): string {
    return `**${text}**`;
  }

  bg(): string {
    return "";
  }
}

const baseFailure: ProviderFailure = {
  provider: "Anthropic",
  model: "claude-3-opus",
  klass: "quota",
  message: "Rate limit exceeded",
  status: 429,
  midStream: false,
};

describe("formatProviderState", () => {
  it("failure: colors every line of the classified block red (error)", () => {
    const theme = new MockTheme() as unknown as Theme;
    const classified = formatProviderFailure(baseFailure);

    const result = formatProviderState(classified, theme, false);

    const errorColors = (theme as unknown as MockTheme).colors.filter((c) => c.color === "error");
    assert.equal(errorColors.length, classified.split("\n").length, "every line should use error color");
    assert.match(result, /🔴/, "should include red circle marker for failure");
    assert.match(result, /Anthropic/, "should still carry the provider name");
    assert.match(result, /claude-3-opus/, "should still carry the model name");
    assert.match(result, /quota/, "should still carry the error class");
    assert.match(result, /Rate limit exceeded/, "should still carry the upstream message");
  });

  it("retry: colors every line of the classified block amber (warning)", () => {
    const theme = new MockTheme() as unknown as Theme;
    const failure: ProviderFailure = {
      provider: "OpenAI",
      model: "gpt-4-turbo",
      klass: "network",
      message: "Connection timeout",
      status: undefined,
      midStream: false,
    };
    const classified = formatProviderFailure(failure);

    const result = formatProviderState(classified, theme, true);

    const warningColors = (theme as unknown as MockTheme).colors.filter((c) => c.color === "warning");
    assert.equal(warningColors.length, classified.split("\n").length, "every line should use warning color");
    assert.match(result, /⚠️/, "should include amber warning marker for retry");
    assert.match(result, /OpenAI/, "should still carry the provider name");
    assert.match(result, /network/, "should still carry the error class");
    assert.match(result, /Connection timeout/, "should still carry the upstream message");
  });

  it("carries the HTTP status through unchanged, since the block is not reformatted", () => {
    const theme = new MockTheme() as unknown as Theme;
    const classified = formatProviderFailure({ ...baseFailure, klass: "auth", status: 401, message: "Invalid API key" });

    const result = formatProviderState(classified, theme, false);

    assert.match(result, /401/, "should carry the HTTP status through from the classified block");
  });

  it("carries the mid-stream note through unchanged when the flag is set", () => {
    const theme = new MockTheme() as unknown as Theme;
    const classified = formatProviderFailure({
      ...baseFailure,
      klass: "network",
      message: "Stream interrupted mid-response",
      status: 200,
      midStream: true,
    });

    const result = formatProviderState(classified, theme, false);

    assert.match(result, /stream failed after them/, "should carry the mid-stream framing through from the classified block");
  });

  it("prefixes only the first line with the marker glyph, not every line", () => {
    const theme = new MockTheme() as unknown as Theme;
    const classified = formatProviderFailure(baseFailure);

    const result = formatProviderState(classified, theme, false);
    const lines = result.split("\n");

    assert.match(lines[0]!, /🔴/, "the first line carries the marker");
    for (const line of lines.slice(1)) {
      assert.doesNotMatch(line, /🔴/, "later lines must not repeat the marker");
    }
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import Ajv from "ajv";

// The theme loader (`loadThemeFromPath`, `getThemeByName`) lives at
// `dist/modes/interactive/theme/theme.js` inside `@earendil-works/pi-coding-agent`, and the
// package's exports map lists exactly three subpaths — `.`, `./rpc-entry` and `./client` — with
// no wildcard, so a deep import of it fails with ERR_PACKAGE_PATH_NOT_EXPORTED, and the index
// does not re-export it. `theme-schema.json` is the contract that loader validates every theme
// against, so these tests hold the themes to the schema directly instead.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
// The schema sits beside the loader under `dist/`, and that subpath is not exported either, so
// reach it from the one entry point that is: `.` resolves to `dist/index.js`.
const distDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const schemaPath = join(distDir, "modes", "interactive", "theme", "theme-schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;

type ThemeFile = {
  name: string;
  vars?: Record<string, string>;
  colors: Record<string, string>;
  export?: Record<string, string>;
};

function loadTheme(basename: string): ThemeFile {
  return JSON.parse(readFileSync(join(repoRoot, "themes", basename), "utf-8")) as ThemeFile;
}

/** Mirrors the loader's `resolveVarRefs`: a value that names a var resolves, anything else is literal. */
function resolve(theme: ThemeFile, token: string): string {
  let value = theme.colors[token];
  assert.ok(value !== undefined, `token ${token} is absent from ${theme.name}`);
  const vars = theme.vars ?? {};
  for (let hops = 0; hops < 8 && value in vars; hops += 1) value = vars[value]!;
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** sRGB hex to CIE L*a*b*, D65. */
function lab(hex: string): [number, number, number] {
  const linear = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = linear as [number, number, number];
  const xyz: [number, number, number] = [
    (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047,
    0.2126 * r + 0.7152 * g + 0.0722 * b,
    (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883,
  ];
  const [fx, fy, fz] = xyz.map((v) => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29));
  return [116 * fy! - 16, 500 * (fx! - fy!), 200 * (fy! - fz!)];
}

/**
 * CIE76 ΔE. The right metric for "are these two panels the same colour": WCAG contrast is a
 * luminance ratio, so two equally light but differently hued backgrounds score ~1.0 on it and it
 * cannot tell them apart at all. ΔE measures perceptual distance in all three dimensions.
 */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The floor a tool panel must clear against its neighbours. CIE76 calls ~2.3 the just-noticeable
 * difference for adjacent patches; 8 is well above that, because these panels are never adjacent
 * — they are separated by rows of output and by time, and a glance has to place one without a
 * reference to compare it to.
 */
const PANEL_DELTA_E = 8;

const THEMES = ["tokyo-night.json", "tokyo-night-day.json"] as const;

// Every token the schema knows about, including the two it marks optional. A theme that omits an
// optional token silently inherits an unrelated colour (`scrollbarThumb` falls back to
// `selectedBg`, `thinkingMax` to `thinkingXhigh`), which is how upstream's own PI export ends up
// with a max thinking level indistinguishable from xhigh. We set all 53 deliberately.
const ALL_TOKENS = Object.keys(
  (schema as { properties: { colors: { properties: Record<string, unknown> } } }).properties.colors
    .properties,
);

// Foreground tokens that carry content a human reads. `syntaxComment` is deliberately absent:
// a comment is meant to recede, and Tokyo Night's comment colour is the one hue the theme is
// recognised by. Backgrounds and border tokens are absent because they are not read as text.
const CONTENT_TOKENS = [
  "accent", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdQuote", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber",
  "syntaxType", "syntaxOperator", "syntaxPunctuation", "bashMode",
] as const;

// Foreground/background pairs that actually get composited, as opposed to every token against the
// terminal ground. Each is a place PI paints text onto a panel of its own.
const COMPOSITED_PAIRS: ReadonlyArray<readonly [fg: string, bg: string]> = [
  ["userMessageText", "userMessageBg"],
  ["customMessageText", "customMessageBg"],
  ["customMessageLabel", "customMessageBg"],
  ["toolTitle", "toolPendingBg"],
  ["toolTitle", "toolSuccessBg"],
  ["toolTitle", "toolErrorBg"],
  ["toolOutput", "toolPendingBg"],
  ["toolOutput", "toolSuccessBg"],
  ["toolOutput", "toolErrorBg"],
  ["mdCode", "mdCodeBlock"],
  ["syntaxString", "mdCodeBlock"],
  ["text", "selectedBg"],
];

const THINKING_QUIET = ["thinkingOff", "thinkingMinimal"] as const;
const THINKING_ACTIVE = [
  "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
] as const;

describe("tokyo night themes", () => {
  for (const basename of THEMES) {
    const theme = loadTheme(basename);
    // PI paints no page background of its own — text lands on the terminal's ground. `pageBg` is
    // the same colour, declared for HTML export, so it is the ground these ratios are measured on.
    const ground = theme.export!.pageBg!;

    describe(theme.name, () => {
      it("validates against the theme schema PI ships", () => {
        const ajv = new (Ajv as unknown as new (o: object) => {
          compile: (s: object) => ((d: unknown) => boolean) & { errors?: unknown };
        })({ allErrors: true, strict: false });
        const validate = ajv.compile(schema);
        const ok = validate(theme);
        assert.ok(ok, `schema errors: ${JSON.stringify(validate.errors)}`);
      });

      it("sets every token the schema defines, optional ones included", () => {
        const missing = ALL_TOKENS.filter((t) => !(t in theme.colors));
        assert.deepEqual(missing, [], `unset tokens fall back to an unrelated colour: ${missing}`);
      });

      it("resolves every var reference to a hex colour and leaves none unused", () => {
        const vars = theme.vars ?? {};
        const used = new Set(Object.values(theme.colors).filter((v) => v in vars));
        assert.deepEqual(
          Object.keys(vars).filter((v) => !used.has(v)),
          [],
          "an unused var is a palette entry nothing renders",
        );
        for (const token of ALL_TOKENS) {
          assert.match(resolve(theme, token), /^#[0-9a-f]{6}$/, `${token} is not a hex colour`);
        }
      });

      it("keeps body text legible against its own ground", () => {
        assert.ok(
          contrast(resolve(theme, "text"), ground) >= 4.5,
          `text on ground is ${contrast(resolve(theme, "text"), ground).toFixed(2)}`,
        );
      });

      it("keeps every content-bearing token above the legibility floor", () => {
        const failures = CONTENT_TOKENS.map(
          (t) => [t, contrast(resolve(theme, t), ground)] as const,
        ).filter(([, ratio]) => ratio < 3);
        assert.deepEqual(
          failures.map(([t, r]) => `${t}=${r.toFixed(2)}`),
          [],
          "a token that is technically correct and unreadable is a bug",
        );
      });

      it("keeps composited text legible on the panel it is painted on", () => {
        const failures = COMPOSITED_PAIRS.map(
          ([fg, bg]) => [`${fg}/${bg}`, contrast(resolve(theme, fg), resolve(theme, bg))] as const,
        ).filter(([, ratio]) => ratio < 3);
        assert.deepEqual(failures.map(([p, r]) => `${p}=${r.toFixed(2)}`), []);
      });

      it("reads as a diff: added and removed are distinct and both legible", () => {
        const added = resolve(theme, "toolDiffAdded");
        const removed = resolve(theme, "toolDiffRemoved");
        const context = resolve(theme, "toolDiffContext");
        assert.notEqual(added, removed);
        for (const [name, colour] of [["added", added], ["removed", removed], ["context", context]] as const) {
          const ratio = contrast(colour, ground);
          assert.ok(ratio >= 3.5, `diff ${name} is ${ratio.toFixed(2)} against the ground`);
        }
        // Upstream's own PI export puts Tokyo Night's diff *background* tints in these two
        // tokens, but PI renders them as foregrounds (`components/diff.js` calls
        // `theme.fg("toolDiffAdded", ...)`), so a tint lands as near-invisible text on the ground
        // it was designed to be. Pin the tints out by value, so a future resync cannot reintroduce
        // them past a ratio check that a light variant would satisfy for the wrong reason. They are
        // not discarded — the same four hexes are Tokyo Night's real diff backgrounds and now carry
        // `toolSuccessBg` / `toolErrorBg`, which is the job upstream drew them for.
        const UPSTREAM_TINTS = ["#243e4a", "#4a272f", "#b7ced5", "#dababe"];
        for (const tint of UPSTREAM_TINTS) {
          assert.ok(![added, removed, context].includes(tint), `${tint} is a diff background tint`);
        }
      });

      it("gives a tool run three tellable-apart panels, and none of them the ground", () => {
        const panels = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;
        const pairs: ReadonlyArray<readonly [string, string]> = [
          ["toolPendingBg", "toolSuccessBg"],
          ["toolPendingBg", "toolErrorBg"],
          ["toolSuccessBg", "toolErrorBg"],
        ];
        const failures = [
          ...pairs.map(([a, b]) => [`${a}/${b}`, deltaE(resolve(theme, a), resolve(theme, b))] as const),
          ...panels.map((p) => [`${p}/ground`, deltaE(resolve(theme, p), ground)] as const),
        ].filter(([, d]) => d < PANEL_DELTA_E);
        assert.deepEqual(
          failures.map(([p, d]) => `${p}=${d.toFixed(2)}`),
          [],
          "the panel background is the only per-state signal PI renders (`components/tool-execution.js` " +
            "picks toolPendingBg / toolSuccessBg / toolErrorBg and changes nothing else), so two panels " +
            "at the same colour make a running tool and a finished one indistinguishable",
        );
      });

      it("ramps the thinking levels as a visible progression", () => {
        const levels = [...THINKING_QUIET, ...THINKING_ACTIVE].map((t) => resolve(theme, t));
        assert.equal(new Set(levels).size, levels.length, "two thinking levels share a colour");
        // Contrast cannot rise monotonically across a hue sweep on a light ground, so what is
        // pinned is the readable part: both quiet levels sit below every active one.
        const loudestQuiet = Math.max(...THINKING_QUIET.map((t) => contrast(resolve(theme, t), ground)));
        const faintestActive = Math.min(...THINKING_ACTIVE.map((t) => contrast(resolve(theme, t), ground)));
        assert.ok(
          loudestQuiet < faintestActive,
          `quiet ${loudestQuiet.toFixed(2)} is not below active ${faintestActive.toFixed(2)}`,
        );
      });
    });
  }

  it("registers both themes on the settings theme path", () => {
    // The template, not the generated `config/settings.json`: the generated file is git-ignored,
    // so the template is the only copy a fresh clone gets.
    const settings = JSON.parse(readFileSync(join(repoRoot, "config", "settings.default.json"), "utf-8")) as {
      themes: string[];
      theme: string;
    };
    assert.ok(settings.themes.some((p) => p.endsWith("/themes")), "themes/ is not on the theme path");
    assert.equal(settings.theme, "Tokyo Night", "the dark variant is the default");
  });
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const themeDir = join(repoRoot, "themes");
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

function loadTheme(file: string): ThemeFile {
  return JSON.parse(readFileSync(join(themeDir, file), "utf-8")) as ThemeFile;
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

/** The legibility floors, per class of token, against the theme's own ground. */
const BODY_TEXT = 4.5;
const CONTENT = 3;
const DIFF = 3.5;

/**
 * Colours that ship below the floor, by theme and by hex, because their upstream palette has no
 * darker (or brighter) member of that hue and inventing one would stop the theme being that theme.
 *
 * THIS IS A RATCHET, NOT AN OPT-OUT. Every entry is checked in both directions: the recorded ratio
 * must still be the measured one, so a palette edit that moves the colour fails here; and a colour
 * that now clears its floor must be deleted from this table rather than left to rot. A listed
 * colour is exempt from the CONTENT and DIFF floors wherever it is used as a foreground, and from
 * nothing else — never from `text` on the ground, which no theme may fail.
 *
 * The pattern behind every row: an equiluminant palette. Solarized states it outright ("the same
 * accent colours on both backgrounds"), and Catppuccin Latte, Rosé Pine Dawn and Nord's Aurora are
 * tuned as syntax colours on their own ground rather than as UI text on it. The hard floor below
 * is what stops that argument going any further.
 */
const FAINT_FLOOR = 2;
const UPSTREAM_FAINT: Record<string, Record<string, { ratio: number; note: string }>> = {
  "Catppuccin Latte": {
    "#df8e1d": { ratio: 2.31, note: "yellow — Latte publishes no darker yellow" },
    "#fe640b": { ratio: 2.64, note: "peach — Latte publishes no darker orange" },
    "#40a02b": { ratio: 2.96, note: "green — Latte publishes no darker green" },
  },
  "Rosé Pine Dawn": {
    "#ea9d34": { ratio: 2.05, note: "gold — Dawn publishes no darker warm accent but love" },
    "#d7827e": { ratio: 2.6, note: "rose — same hue family as gold, same problem" },
    "#6d8f89": { ratio: 3.24, note: "leaf — Dawn's only green, below the diff floor alone" },
  },
  Nord: {
    "#bf616a": { ratio: 3.05, note: "Aurora red — clears CONTENT, not DIFF, on Polar Night" },
  },
  "Solarized Dark": {
    "#dc322f": { ratio: 3.25, note: "red — clears CONTENT, not DIFF, on base03" },
  },
  "Solarized Light": {
    "#859900": { ratio: 2.97, note: "green — equiluminant by design, unchanged from the dark side" },
    "#b58900": { ratio: 2.98, note: "yellow — equiluminant by design" },
    "#2aa198": { ratio: 2.93, note: "cyan — equiluminant by design" },
  },
};

const THEME_FILES = readdirSync(themeDir).filter((f) => f.endsWith(".json")).sort();

// Every token the schema knows about, including the two it marks optional. A theme that omits an
// optional token silently inherits an unrelated colour (`scrollbarThumb` falls back to
// `selectedBg`, `thinkingMax` to `thinkingXhigh`), which is how upstream's own PI export ends up
// with a max thinking level indistinguishable from xhigh. We set all 53 deliberately.
const ALL_TOKENS = Object.keys(
  (schema as { properties: { colors: { properties: Record<string, unknown> } } }).properties.colors
    .properties,
);

// Foreground tokens that carry content a human reads. `syntaxComment` is deliberately absent:
// a comment is meant to recede, and in most of these palettes the comment colour is one of the
// two or three hues the theme is recognised by. Backgrounds and border tokens are absent because
// they are not read as text.
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

describe("themes", () => {
  const loaded = THEME_FILES.map((file) => ({ file, theme: loadTheme(file) }));

  it("ships every themes/*.json under one naming convention", () => {
    // `theme` in settings selects by the `name` inside the file, so the basename is documentation
    // — but documentation a human scans in a directory listing, and one odd file out is a file
    // nobody finds. Lowercase, hyphenated, no underscores, no capitals.
    for (const { file } of loaded) {
      assert.match(file, /^[a-z0-9]+(-[a-z0-9]+)*\.json$/, `${file} breaks the naming convention`);
    }
    const names = loaded.map(({ theme }) => theme.name);
    assert.equal(new Set(names).size, names.length, `two themes share a name: ${names.join(", ")}`);
    for (const { file, theme } of loaded) {
      // Human style, the way `/theme` lists them: "Catppuccin Mocha", never "catppuccin_mocha".
      assert.match(
        theme.name,
        /^\p{Lu}[\p{L}\p{N}]*( \p{L}[\p{L}\p{N}]*)*$/u,
        `${basename(file)} has a machine-shaped name: ${theme.name}`,
      );
    }
  });

  for (const { file, theme } of loaded) {
    // PI paints no page background of its own — text lands on the terminal's ground. `pageBg` is
    // the same colour, declared for HTML export, so it is the ground these ratios are measured on.
    const ground = theme.export!.pageBg!;
    const faint = UPSTREAM_FAINT[theme.name] ?? {};
    const exempt = (token: string) => resolve(theme, token) in faint;

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
        for (const [name, value] of Object.entries(vars)) {
          assert.match(value, /^#[0-9a-f]{6}$/, `var ${name} is not a hex colour`);
        }
        assert.match(ground, /^#[0-9a-f]{6}$/, "export.pageBg is not a hex colour");
      });

      it("keeps body text legible against its own ground", () => {
        assert.ok(
          contrast(resolve(theme, "text"), ground) >= BODY_TEXT,
          `text on ground is ${contrast(resolve(theme, "text"), ground).toFixed(2)}`,
        );
      });

      it("keeps every content-bearing token above the legibility floor", () => {
        const failures = CONTENT_TOKENS.filter((t) => !exempt(t))
          .map((t) => [t, contrast(resolve(theme, t), ground)] as const)
          .filter(([, ratio]) => ratio < CONTENT);
        assert.deepEqual(
          failures.map(([t, r]) => `${t}=${r.toFixed(2)}`),
          [],
          "a token that is technically correct and unreadable is a bug",
        );
      });

      it("keeps composited text legible on the panel it is painted on", () => {
        const failures = COMPOSITED_PAIRS.filter(([fg]) => !exempt(fg))
          .map(([fg, bg]) => [`${fg}/${bg}`, contrast(resolve(theme, fg), resolve(theme, bg))] as const)
          .filter(([, ratio]) => ratio < CONTENT);
        assert.deepEqual(failures.map(([p, r]) => `${p}=${r.toFixed(2)}`), []);
      });

      it("reads as a diff: added and removed are distinct and both legible", () => {
        const added = resolve(theme, "toolDiffAdded");
        const removed = resolve(theme, "toolDiffRemoved");
        const context = resolve(theme, "toolDiffContext");
        assert.notEqual(added, removed);
        for (const [name, colour] of [["added", added], ["removed", removed], ["context", context]] as const) {
          if (colour in faint) continue;
          const ratio = contrast(colour, ground);
          assert.ok(ratio >= DIFF, `diff ${name} is ${ratio.toFixed(2)} against the ground`);
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

      it("holds its upstream-faint exemptions to the recorded ratio, and to a hard floor", () => {
        const usedAsForeground = new Set(
          [...CONTENT_TOKENS, "toolDiffAdded", "toolDiffRemoved", "toolDiffContext"].map((t) =>
            resolve(theme, t),
          ),
        );
        for (const [hex, { ratio, note }] of Object.entries(faint)) {
          assert.ok(usedAsForeground.has(hex), `${hex} is exempt but nothing paints it (${note})`);
          const measured = contrast(hex, ground);
          assert.ok(
            Math.abs(measured - ratio) < 0.005,
            `${hex} is recorded at ${ratio} and measures ${measured.toFixed(2)} — update the table`,
          );
          assert.ok(measured >= FAINT_FLOOR, `${hex} is ${measured.toFixed(2)}, below the hard floor`);
          // The downward half of the ratchet: an exemption that is no longer needed must go.
          assert.ok(
            measured < DIFF,
            `${hex} now clears every floor at ${measured.toFixed(2)} — delete its exemption`,
          );
        }
      });
    });
  }

  describe("Tokyo Night", () => {
    it("keeps upstream's diff background tints out of the diff foregrounds", () => {
      // Upstream's own PI export puts Tokyo Night's diff *background* tints in these two tokens,
      // but PI renders them as foregrounds (`components/diff.js` calls `theme.fg("toolDiffAdded",
      // ...)`), so a tint lands as near-invisible text on the ground it was designed to be. Pin
      // the tints out by value, so a future resync cannot reintroduce them past a ratio check that
      // a light variant would satisfy for the wrong reason. They are not discarded — the same four
      // hexes are Tokyo Night's real diff backgrounds and now carry `toolSuccessBg` /
      // `toolErrorBg`, which is the job upstream drew them for.
      const UPSTREAM_TINTS = ["#243e4a", "#4a272f", "#b7ced5", "#dababe"];
      for (const file of ["tokyo-night.json", "tokyo-night-day.json"]) {
        const theme = loadTheme(file);
        const diff = (["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"] as const).map((t) =>
          resolve(theme, t),
        );
        for (const tint of UPSTREAM_TINTS) {
          assert.ok(!diff.includes(tint), `${tint} is a diff background tint, in ${file}`);
        }
      }
    });
  });

  it("registers the theme directory on the settings theme path", () => {
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

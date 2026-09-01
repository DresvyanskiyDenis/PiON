# Themes — the TUI colour scheme

PI's terminal UI is themed by a JSON file: 53 named colours, no CSS, no styling language. This
harness ships thirteen of them — eight palettes, with both variants where the source publishes a
light one — and defaults to Tokyo Night.

| File | `name` | Ground | Palette source |
|---|---|---|---|
| `themes/tokyo-night.json` | `Tokyo Night` | `#1a1b26` — the default | [folke/tokyonight.nvim][tn] |
| `themes/tokyo-night-day.json` | `Tokyo Night Day` | `#e1e2e7` | [folke/tokyonight.nvim][tn] |
| `themes/catppuccin-mocha.json` | `Catppuccin Mocha` | `#1e1e2e` | [catppuccin/palette][cat] |
| `themes/catppuccin-latte.json` | `Catppuccin Latte` | `#eff1f5` | [catppuccin/palette][cat] |
| `themes/gruvbox-dark.json` | `Gruvbox Dark` | `#282828` | [gruvbox-community/gruvbox][gru] |
| `themes/gruvbox-light.json` | `Gruvbox Light` | `#fbf1c7` | [gruvbox-community/gruvbox][gru] |
| `themes/rose-pine-moon.json` | `Rosé Pine Moon` | `#232136` | [rose-pine/neovim][rp] |
| `themes/rose-pine-dawn.json` | `Rosé Pine Dawn` | `#faf4ed` | [rose-pine/neovim][rp] |
| `themes/dracula.json` | `Dracula` | `#282a36` | [dracula/dracula-theme][dra] |
| `themes/nord.json` | `Nord` | `#2e3440` | [nordtheme/nord][nor] |
| `themes/solarized-dark.json` | `Solarized Dark` | `#002b36` | [altercation/solarized][sol] |
| `themes/solarized-light.json` | `Solarized Light` | `#fdf6e3` | [altercation/solarized][sol] |
| `themes/kanagawa-wave.json` | `Kanagawa Wave` | `#1f1f28` | [rebelot/kanagawa.nvim][kan] |

[tn]: https://github.com/folke/tokyonight.nvim
[cat]: https://github.com/catppuccin/palette/blob/main/palette.json
[gru]: https://github.com/gruvbox-community/gruvbox/blob/master/colors/gruvbox.vim
[rp]: https://github.com/rose-pine/neovim/blob/main/lua/rose-pine/palette.lua
[dra]: https://github.com/dracula/dracula-theme#color-palette-oss
[nor]: https://github.com/nordtheme/nord/blob/develop/src/nord.css
[sol]: https://github.com/altercation/solarized#the-values
[kan]: https://github.com/rebelot/kanagawa.nvim/blob/master/lua/kanagawa/colors.lua

Every hex in every file is its project's own, read from the source in the last column. Kanagawa
ships the `wave` variant, the one its own `themes.lua` builds by default.

PI's own `dark` and `light` remain available; nothing is replaced. The installer offers the whole
list, read out of `themes/` at run time rather than from a copy of it kept in the script.

---

## How PI finds them

Two independent routes, and this harness uses both:

```json
"theme":  "Tokyo Night",
"themes": ["~/pi-config/themes"]
```

`themes` accepts a directory **or** a single file path; a directory is read for `*.json`, so
dropping a file into `themes/` is the whole of installing a theme. On top of
that, PI auto-loads `~/.pi/agent/themes/` without being told to, and the installer links
`themes/` there. Either route alone would work. Both are present because the auto-loaded path is a
side effect of where the installer puts things, and a config that only works because of a side
effect is a config that breaks the first time someone moves the directory.

`theme` selects by the `name` **inside** the file, not by filename. Renaming
`tokyo-night.json` changes nothing; editing its `"name"` breaks the selection. The basenames are
kept lowercase and hyphenated, and the names human-shaped (`Catppuccin Mocha`, never
`catppuccin_mocha`) — both are asserted, because `/theme` shows one and the directory shows the other.

Switch at runtime with `/theme`. That writes your choice back to `config/settings.json`.

!!! tip "Automatic light/dark"
    `theme` also accepts a `light/dark` pair, in that order, and PI picks by the terminal's
    reported background:

    ```json
    "theme": "Tokyo Night Day/Tokyo Night"
    ```

    This is not the shipped default — background detection is a terminal capability, and when it
    is wrong you get a light theme on a dark terminal with no obvious cause. Opt in once you know
    your terminal reports correctly.

---

## What was changed from upstream, and why

`folke/tokyonight.nvim` publishes a PI export under `extras/pi/`. **It is the only one of the eight
that does** — checked, project by project, when the other seven were added; none of Catppuccin,
Gruvbox, Rosé Pine, Dracula, Nord, Solarized or Kanagawa ships a PI export under `extras/` or any
other name. So the two Tokyo Night files started from upstream's export, and five things in it were
wrong for PI specifically; the other eleven were mapped by hand from each project's palette, and
four of those five corrections were things they had to get right from the start rather than fix.
If you resync Tokyo Night from upstream, these are the edits to reapply.

### Diff colours were backgrounds

Upstream set `toolDiffAdded` to `#243e4a` and `toolDiffRemoved` to `#4a272f`. Those are Tokyo
Night's diff **background** tints, meant to sit behind syntax-highlighted text — which is how the
project's own `delta` and `git` extras use them, pairing each tint with a separate, brighter
foreground.

PI has no diff background token. Its diff renderer calls `theme.fg("toolDiffAdded", …)`, so both
values landed as *text* colour, a few percent away from the terminal ground they were designed to
sit on. Added and removed lines were very nearly invisible.

They now use the palette's green and red — the same colours upstream uses as the diff foregrounds
elsewhere — and `toolDiffContext` moves off a 1.97:1 blue onto the same colour as ordinary tool
output, because a context line is ordinary code and should read like it.

### The tool panel said nothing about the tool

Upstream set `toolPendingBg` and `toolSuccessBg` to the same value — `#292e42` in `night`,
`#c4c8da` in `day` — and `toolErrorBg` to `#241d28`, a colour Tokyo Night does not define anywhere.

The panel background is the **only** per-state signal PI renders. Its tool renderer picks one of
`toolPendingBg` / `toolSuccessBg` / `toolErrorBg` and changes nothing else: no glyph, no border, no
title colour. So with two of the three equal, "this tool is still running" and "this tool finished"
were the same picture, and the distinction did not exist on screen.

The two tints freed up by the diff fix are exactly the surfaces for it — Tokyo Night's own
diff-add and diff-delete backgrounds, drawn to mean *went well* and *did not*:

| Token | `night` | `day` |
|---|---|---|
| `toolPendingBg` | `#292e42` | `#c4c8da` |
| `toolSuccessBg` | `#243e4a` | `#b7ced5` |
| `toolErrorBg` | `#4a272f` | `#dababe` |

No colour is invented. Every value is upstream's, used for the job upstream drew it for.

### The thinking ramp did not ramp

The six `thinking*` tokens colour the reasoning-level indicator, so they should read as a
progression at a glance. Upstream's ordering put `low` **darker** than `off`, and `xhigh` darker
than `high`.

The ramp is now a cool-to-hot sweep — gutter grey, comment grey, blue, cyan, yellow, orange, red.
Contrast cannot rise monotonically across a hue sweep, least of all on a light ground, so what the
tests pin is the part a human actually reads: both quiet levels sit below every active one, and no
two levels share a colour.

### Two tokens were unset

`thinkingMax` and `scrollbarThumb` are optional in the schema, and an omitted token does not go
unpainted — it silently inherits another one. `thinkingMax` falls back to `thinkingXhigh`, which is
why upstream's export renders the top reasoning level identically to the one below it.

All 55 tokens are set explicitly in both files. `searchMatchBg` and `searchMatchText` arrived with
PI 0.84.4, are optional in the same way, and fall back to `selectedBg` and `text`; all thirteen files
set them to exactly those two colours, so a match paints as it always did and the choice is visible
rather than inherited.

### Text colours were "whatever the terminal does"

`text`, `toolTitle` and the message-text tokens were empty strings, which PI reads as *use the
terminal's default foreground*. That makes the theme's readability a property of your terminal
profile rather than of the theme, and makes it impossible to check. They are set to the palette's
foreground.

### Which of the five apply to the other eleven

Four of the five are properties of **PI**, not of Tokyo Night, so they bind every theme in
`themes/` whatever it was mapped from. Only the diff-tint correction is a fact about one upstream
file.

| Correction | Applies to | Why |
|---|---|---|
| Diff colours were backgrounds | Tokyo Night only | It is a defect in upstream's PI export. Nothing else ships one, so nothing else could inherit it — but the *rule* it taught (`toolDiffAdded`/`Removed` are foregrounds) is what every other file was mapped under, and the diff floor is tested for all thirteen. |
| The tool panel said nothing about the tool | all thirteen | `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` is PI's only per-state signal. Every palette had to yield three panels a glance can tell apart, and most of them do not publish three surfaces. See the next section. |
| The thinking ramp did not ramp | all thirteen | Six tokens that read as a progression is a PI concept; no upstream palette has an opinion about it. Every file places both quiet levels below every active one. |
| Two tokens were unset | all thirteen | `thinkingMax` and `scrollbarThumb` are optional in the schema and silently inherit when omitted. All 55 are set explicitly in all thirteen files. |
| Text colours were "whatever the terminal does" | all thirteen | An empty string hands the theme's readability to the terminal profile. No file ships one; the schema-and-hex check refuses them. |

---

## How the other eleven were mapped

Each file is `vars` — that project's palette, under **its own names** (`sumiInk3`, `nord0`,
`base03`, `highlightMed`) — and `colors`, the 55 tokens pointing at those names. The token-to-role
mapping is `tokyo-night.json`'s, copied entry for entry: `accent` takes the palette's primary blue,
`syntaxKeyword` its purple, `mdHr` and `bashMode` its orange, and so on. Reading two files
side by side should show the same shape with a different palette underneath, and that is the point
— a mapping you can check by eye is a mapping someone can fix.

Four roles are overridden per theme where the palette leaves no choice, and each override is
visible in the file as a token pointing somewhere unexpected:

- **`toolOutput`** takes the dim foreground on dark grounds and the full one on light grounds
  (Tokyo Night Day already did this); Rosé Pine Moon also takes the full one, because `subtle` is
  too dim to sit on any panel that parts from the ground.
- **`mdCode`** takes the palette's blue rather than its cyan on Solarized Light, whose cyan reads
  at 2.58:1 on the code block.
- **`thinkingOff` / `thinkingMinimal`** take the surface greys on the light themes. Their accents
  are darker than their greys there, so the quiet-below-active rule cannot be met with a comment
  colour.
- **`customMessageLabel`** takes Solarized Dark's blue: neither violet nor magenta clears 3.0 on
  `base02`, which is the panel that label is painted on.

### The panel tints

Correction #2 needs three tool-panel backgrounds that a glance can place. Only two palettes publish
them: Tokyo Night (its diff backgrounds, which is where they came from) and Kanagawa
(`winterGreen` / `winterRed`). The other nine publish one or two surfaces and nothing state-shaped.

For those, the two state panels are **the palette's own green and red laid over the palette's own
ground**, at the smallest blend that clears every floor at once — ΔE ≥ 10 from the ground, from the
pending panel and from each other, with the theme's text and tool output still above 3.4:1 on the
result. Nothing is sampled from outside the palette, and the blend is the only arithmetic in any of
these files:

| Theme | pending | success | error |
|---|---|---|---|
| `Catppuccin Mocha` | `surface0` | `#313a3e` — green at 14 % | `#493446` — red at 20 % |
| `Catppuccin Latte` | `surface0` | `#d8e6db` — green at 13 % | `#ecd6de` — red at 12 % |
| `Gruvbox Dark` | `dark1` | `#393a28` — bright_green at 12 % | `#432c2a` — bright_red at 13 % |
| `Gruvbox Light` | `light2` | `#e2d9a4` — faded_green at 19 % | `#e6bc9d` — faded_red at 22 % |
| `Rosé Pine Moon` | `overlay` | `#3b4456` — foam at 20 % | `#4b3148` — love at 20 % |
| `Rosé Pine Dawn` | `highlightHigh` | `#afbeb8` — leaf at 53 % | `#e3c4c7` — love at 33 % |
| `Dracula` | `currentLine` | `#2c3f3d` — green at 10 % | `#422f3a` — red at 12 % |
| `Nord` | `nord2` | `#40494b` — nord14 at 15 % | `#4a3d48` — nord11 at 19 % |
| `Solarized Dark` | `#1d414b` — base01 at 33 % | `#0d3631` — green at 10 % | `#252c35` — red at 17 % |
| `Solarized Light` | `#dcdccf` — base1 at 31 % | `#edeac5` — green at 13 % | `#f9decd` — red at 12 % |
| `Kanagawa Wave` | `sumiInk5` | `winterGreen` | `winterRed` |

Solarized needs a blended **pending** panel as well: `base02` is 5 ΔE from `base03`, which is the
collapsed-panel bug in a different costume. Dracula, which publishes exactly two surfaces, also
blends its card and muted-border colours from `comment`.

Rosé Pine Moon takes `foam` rather than `leaf` for the success panel, and Dawn needs `leaf` at
53 %: both palettes' greens are desaturated enough that a low blend cannot part from the ground at
all. That is the number telling the truth about the palette, not a knob that was turned for effect.

---

## The contrast rule

`test/theme/themes.test.ts` validates every `themes/*.json` against the `theme-schema.json` PI ships,
resolves every `vars` reference, and then measures WCAG contrast:

- body text against its own ground: **≥ 4.5**
- every content-bearing foreground against the ground: **≥ 3.0**
- the three diff tokens: **≥ 3.5**
- text against the panel it is composited onto — user messages, tool output on the pending,
  success and error backgrounds, code inside a code block, text on the selection: **≥ 3.0**

`syntaxComment` is deliberately exempt. A comment is meant to recede, and in most of these
palettes the comment colour is one of the two or three hues the theme is recognised by.

It also checks the shape of the set: every `themes/*.json` sets all 55 tokens, resolves every var
to a `#rrggbb`, leaves no var unused, carries a name no other file carries, and has a lowercase
hyphenated basename. Adding a file is all it takes to be measured — there is no list to join.

### The eleven colours that ship below the floor

Four upstream palettes cannot clear those floors with their own hexes, and rather than darken a
colour and stop being that theme, the test carries a table of the exact hexes that ship faint,
per theme, with the ratio each measures:

| Theme | Colour | On its ground | What it carries |
|---|---|---|---|
| `Catppuccin Latte` | `#df8e1d` yellow | 2.31 | `warning`, `thinkingHigh` |
| `Catppuccin Latte` | `#fe640b` peach | 2.64 | `mdHr`, `mdListBullet`, `syntaxNumber`, `bashMode` |
| `Catppuccin Latte` | `#40a02b` green | 2.96 | `toolDiffAdded`, `syntaxString` |
| `Rosé Pine Dawn` | `#ea9d34` gold | 2.05 | `warning`, `thinkingHigh` |
| `Rosé Pine Dawn` | `#d7827e` rose | 2.60 | `mdHr`, `mdListBullet`, `syntaxNumber`, `bashMode` |
| `Rosé Pine Dawn` | `#6d8f89` leaf | 3.24 | `toolDiffAdded` — clears 3.0, not the diff floor |
| `Nord` | `#bf616a` Aurora red | 3.05 | `toolDiffRemoved` — clears 3.0, not the diff floor |
| `Solarized Dark` | `#dc322f` red | 3.25 | `toolDiffRemoved` — same |
| `Solarized Light` | `#859900` green | 2.97 | `success`, `toolDiffAdded`, `syntaxString` |
| `Solarized Light` | `#b58900` yellow | 2.98 | `warning`, `thinkingHigh` |
| `Solarized Light` | `#2aa198` cyan | 2.93 | `mdLink`, `syntaxType`, `thinkingMedium` |

One cause behind all eleven: an **equiluminant palette**. Solarized says so outright — the same
sixteen values on both grounds is its whole thesis — and Catppuccin Latte, Rosé Pine Dawn and
Nord's Aurora are drawn as syntax colours on their own ground rather than as UI text on it. Tokyo
Night Day is the counter-example: folke ships a separately darkened palette for the light variant,
which is why it needs no entry here.

**The table is a ratchet, not an opt-out**, and it is checked in both directions. The recorded
ratio must still be the measured one, so editing one of these colours fails the test rather than
silently re-baselining it. A colour that comes to clear its floor must be **deleted** from the
table, or the test fails on that too — the same rule the em-dash budget lives by. Nothing listed
may fall below **2.0** whatever its palette says, and `text` on the ground has no exemptions at any
value. Everything else in the thirteen files clears every floor on its own.

### Why the panels need a second metric

Contrast alone cannot see the tool-panel bug. It is a **luminance ratio**, so two backgrounds of
the same lightness in different hues score about 1.0 on it whether they are identical or opposite —
and a "background against background" ratio near 1 is what you *want* for panels that sit on the
same page. A theme with `toolPendingBg` and `toolSuccessBg` set to the same hex passes every
contrast floor above, cleanly.

The panels are therefore held to **CIE76 ΔE ≥ 8** instead: perceptual distance in L\*a\*b\*, which
measures lightness *and* hue. Each of the three against the other two, and each against the ground.
CIE76 puts the just-noticeable difference for two patches side by side at roughly 2.3; the floor is
well above that because these panels are never side by side — they are separated by rows of output
and by seconds of time, and a glance has to place one with nothing to compare it to. The collapsed
pending/success pair scored **ΔE 0.00**.

If you resync from upstream, this is the check that will fail rather than the contrast one.

The rule caught two real defects in the day variant while it was being written: tool output on the
tool panel sat at 2.78:1 and inline code inside a code block at 2.74:1. Both were moved to darker
palette entries.

!!! note "Some of these are low-contrast themes by design"
    Tokyo Night Day's own foreground on its own background is 4.52:1 — it clears the body-text bar
    with almost nothing to spare. That is upstream's aesthetic, not a defect, and it is why the
    floors are stated per theme against its own ground rather than as one absolute number, and why
    the exemption table above records a hex rather than waiving a rule.

---

## Writing your own

Copy either file, change `"name"`, drop it in `themes/`, and select it with `/theme`. The schema is
at `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json`
and both shipped files reference it, so an editor with JSON schema support will complete and
validate the token names as you type.

`vars` is a plain alias table: any colour value that names a key in `vars` resolves to it, anything
else is taken literally. Use it — 55 tokens drawn from a palette of two dozen means most hexes
would otherwise appear four or five times, and a palette you cannot see is a palette you cannot
adjust.

Colour values are `#rrggbb`, a `0`–`255` 256-colour index, or `""` for the terminal default.
Truecolor is used when the terminal reports it; otherwise PI quantises to the 256-colour palette,
so a truecolor-only theme degrades rather than breaks.

The tests in `test/theme/themes.test.ts` read the directory, so a file dropped into `themes/` is
held to every rule on this page from the next run onwards. There is no list to add yourself to —
which also means a theme cannot be added quietly.

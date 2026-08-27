# Themes — the TUI colour scheme

PI's terminal UI is themed by a JSON file: 53 named colours, no CSS, no styling language. This
harness ships two of them, both variants of [Tokyo Night][tn], and defaults to the dark one.

[tn]: https://github.com/folke/tokyonight.nvim

| File | `name` | Ground |
|---|---|---|
| `themes/tokyo-night.json` | `Tokyo Night` | `#1a1b26` — the default |
| `themes/tokyo-night-day.json` | `Tokyo Night Day` | `#e1e2e7` |

PI's own `dark` and `light` remain available; nothing is replaced.

---

## How PI finds them

Two independent routes, and this harness uses both:

```json
"theme":  "Tokyo Night",
"themes": ["~/pi-config/themes"]
```

`themes` accepts a directory **or** a single file path; a directory is read for `*.json`. On top of
that, PI auto-loads `~/.pi/agent/themes/` without being told to, and the installer links
`themes/` there. Either route alone would work. Both are present because the auto-loaded path is a
side effect of where the installer puts things, and a config that only works because of a side
effect is a config that breaks the first time someone moves the directory.

`theme` selects by the `name` **inside** the file, not by filename. Renaming
`tokyo-night.json` changes nothing; editing its `"name"` breaks the selection.

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

`folke/tokyonight.nvim` publishes a PI export under `extras/pi/`. These themes started from it
rather than from a blank file, and four things in it were wrong for PI specifically. If you resync
from upstream, these are the edits to reapply.

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

All 53 tokens are set explicitly in both files.

### Text colours were "whatever the terminal does"

`text`, `toolTitle` and the message-text tokens were empty strings, which PI reads as *use the
terminal's default foreground*. That makes the theme's readability a property of your terminal
profile rather than of the theme, and makes it impossible to check. They are set to the palette's
foreground.

---

## The contrast rule

`test/theme/tokyo-night.test.ts` validates both files against the `theme-schema.json` PI ships,
resolves every `vars` reference, and then measures WCAG contrast:

- body text against its own ground: **≥ 4.5**
- every content-bearing foreground against the ground: **≥ 3.0**
- the three diff tokens: **≥ 3.5**
- text against the panel it is composited onto — user messages, tool output on the pending,
  success and error backgrounds, code inside a code block, text on the selection: **≥ 3.0**

`syntaxComment` is deliberately exempt. A comment is meant to recede, and Tokyo Night's comment
colour is one of the two or three hues the theme is recognised by.

The rule caught two real defects in the day variant while it was being written: tool output on the
tool panel sat at 2.78:1 and inline code inside a code block at 2.74:1. Both were moved to darker
palette entries.

!!! note "Day is a low-contrast theme by design"
    Tokyo Night Day's own foreground on its own background is 4.52:1 — it clears the body-text bar
    with almost nothing to spare. That is upstream's aesthetic, not a defect, and it is why the
    floors are stated per theme against its own ground rather than as one absolute number.

---

## Writing your own

Copy either file, change `"name"`, drop it in `themes/`, and select it with `/theme`. The schema is
at `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json`
and both shipped files reference it, so an editor with JSON schema support will complete and
validate the token names as you type.

`vars` is a plain alias table: any colour value that names a key in `vars` resolves to it, anything
else is taken literally. Use it — 53 tokens drawn from a palette of two dozen means most hexes
would otherwise appear four or five times, and a palette you cannot see is a palette you cannot
adjust.

Colour values are `#rrggbb`, a `0`–`255` 256-colour index, or `""` for the terminal default.
Truecolor is used when the terminal reports it; otherwise PI quantises to the 256-colour palette,
so a truecolor-only theme degrades rather than breaks.

The tests in `test/theme/tokyo-night.test.ts` are written against the two shipped files by name.
Add yours to the `THEMES` list there if you want the same schema and contrast checks applied to it.
